const { metricNumber } = require('./materialMetricFields');
const { fetchAllData, fetchAllDataByMaterial, normalizeApiRows, enrichRows, fetchInsight, fetchCrowd, fetchBoostTasks, fetchScript, fetchCreativeAnalysis } = require('./data');
const { storeDaily, getMissingDates, getMissingProductDates, eachDate, getDB, storeInsight, storeCrowd, storeBoostTasks, storeContent } = require('./db');
const { sleep } = require('./utils');
const { fetchBoostList } = require('./qianchuanTabs');
const { QIANCHUAN_ACCOUNTS } = require('./config');
const { defaultAccountId } = require('./api-helpers');
const creativeVideoLibrary = require('./creativeVideoLibrary');

/**
 * 按区间拉取全部素材的每日明细数据（新方案，速度快10倍+）
 * 一次请求拿到所有素材在区间内每天的明细，然后按日期拆分写入数据库
 *
 * @param {string} startDate - 起始日期 YYYY-MM-DD
 * @param {string} endDate - 结束日期 YYYY-MM-DD
 * @param {string} accountId - 账号ID
 * @param {object} [opts] - { skipDeep: 跳过深度数据（秒级留存/画像/脚本），补历史空洞时为提速用 }
 * @returns {Promise<number>} 写入的总条数
 */
async function fetchRange(startDate, endDate, accountId = defaultAccountId(), opts = {}) {
  console.log(`[range-fetch] 拉取 ${startDate}~${endDate} (${accountId})`);
  const result = await fetchAllDataByMaterial(startDate, endDate, accountId);

  let totalStored = 0;
  const dates = [];

  if (!result || !result.rows || result.rows.length === 0) {
    // 直播素材为空≠当天无消耗（2026-07-26 事故：消耗全在 marketing_goal=1 推商品，
    // 早退导致商品卡采集被跳过、误判真空写入 __EMPTY__ 永久空洞）
    console.log(`[range-fetch] ${startDate}~${endDate} 直播素材无数据（继续商品卡/追投采集）`);
  } else {
    // 按日期分组
    const byDate = {};
    for (const row of result.rows) {
      const day = row.Dimensions?.stat_time_day?.ValueStr;
      if (!day) continue;
      if (!byDate[day]) byDate[day] = [];
      byDate[day].push(row);
    }

    console.log(`[range-fetch] 拆分为 ${Object.keys(byDate).length} 天，开始写入...`);

    dates.push(...Object.keys(byDate).sort());
    for (const date of dates) {
      const dayRows = byDate[date];
      const normalized = normalizeApiRows(dayRows);
      const enriched = enrichRows(normalized, date, date);
      enriched.forEach(r => {
        if (!r._lifecycle) {
          const map = { cold: 'learning', active: 'growth', declining: 'declining' };
          r._lifecycle = map[r._stage] || 'stable';
        }
      });
      // 历史账户专用说明已从试用包移除。
      const activeRows = enriched.filter(r => r['状态'] === '投放中');
      if (activeRows.length !== enriched.length) {
        console.log(`[range-fetch] ${date} 过滤非在投素材 ${enriched.length - activeRows.length} 条（仅保留在投）`);
      }
      const stored = storeDaily(date, activeRows, accountId);
      totalStored += stored;
    }

    console.log(`[range-fetch] 完成 · ${dates.length}天 · ${totalStored}条`);

    // 补充追投数据
    for (const date of dates) {
      await supplementBoostData(date, accountId);
    }
  }

  // 商品卡（推商品/乘方）素材采集：同表按 marketing_goal=1 隔离存储（2026-07-22 探针接入）
  // 注意：无论直播素材是否为空都要跑——消耗可能全在推商品口径（2026-07-27 修复早退）
  try {
    const pStored = await fetchProductRange(startDate, endDate, accountId);
    if (pStored > 0) console.log(`[range-fetch] 商品卡素材写入 ${pStored} 条`);
    totalStored += pStored;
  } catch (e) {
    console.error('[range-fetch] 商品卡采集失败（不影响直播数据）:', e.message);
  }

  // 拉取深度数据（秒级留存/人群画像/追投任务/脚本/创意元素）；补历史空洞时可跳过提速
  if (!opts.skipDeep && dates.length) {
    await fetchDeepData(startDate, endDate, accountId, result.materialList);
  }

  return totalStored;
}

// ═══ 商品卡素材采集（2026-07-22 探针发现）═══
// 历史账户专用说明已从试用包移除。
// 该数据集按日分页拉取（Limit 100），映射为 rowToDaily 兼容行，marketing_goal=1 隔离存储。
// 注意：全店托管约 30% 消耗是店铺维度非素材归因，素材级合计 < home-split 推商品口径属正常现象。
const PRODUCT_MAT_DATASET = 'overall_roi_promotion_matrial_tab_video_product';
const PRODUCT_MAT_METRICS = [
  'stat_cost_for_overall_roi2', 'total_prepay_and_pay_settle_overall_roi2_1h',
  'total_cost_per_pay_order_settle_for_overall_roi2_1h', 'total_order_settle_amount_for_roi2_1h',
  'stat_cost_for_roi2', 'total_order_settle_count_for_roi2_1h',
  'total_order_real_settle_amount_for_roi2_1h', 'total_order_settle_amount_rate_for_roi2_1h',
  'total_refund_order_gmv_for_roi2_1h_rate', 'total_pay_order_gmv_include_coupon_for_roi2',
  'total_pay_order_gmv_for_roi2', 'total_pay_order_count_for_roi2',
];

function mapProductRow(row) {
  const dv = k => (row.Dimensions && row.Dimensions[k] && (row.Dimensions[k].ValueStr ?? row.Dimensions[k].Value)) ?? '';
  const mv = k => metricNumber((row.Metrics || {})[k]);
  const payOrders = mv('total_pay_order_count_for_roi2');
  return {
    '素材ID': String(dv('material_id')),
    '素材名称': dv('roi2_material_video_name') || String(dv('material_id')),
    '视频类型': '商品卡',
    '视频时长': '',
    '创建时间': String(dv('roi2_material_upload_time')).slice(0, 10),
    '来源': '商品卡(乘方/全域)',
    '标签': dv('material_tag_list'),
    '状态': '正常',
    // 消耗口径（2026-08-01 审计 P0 实锤）：本数据集是 overall（全域/乘方）口径，OrderBy 用的就是 stat_cost_for_overall_roi2，
    // 映射此前却取 stat_cost_for_roi2（直播计划口径）——纯商品卡素材 cost=0 漏记，双投素材把直播消耗错记到商品卡行（串渠道）。
    // overall 优先（全域计划消耗=商品卡行语义），roi2 兜底兼容字段缺失
    '整体消耗(元)': mv('stat_cost_for_overall_roi2') ?? mv('stat_cost_for_roi2'),
    '整体成交金额(元)': mv('total_pay_order_gmv_include_coupon_for_roi2'),
    '不含券支付金额(元)': mv('total_pay_order_gmv_for_roi2'),
    '净成交金额(元)': mv('total_order_settle_amount_for_roi2_1h'),
    '1h结算金额': mv('total_order_settle_amount_for_roi2_1h'),
    '整体成交订单数': payOrders,
    '净成交订单数': mv('total_order_settle_count_for_roi2_1h'),
    '1h退款率': mv('total_refund_order_gmv_for_roi2_1h_rate'),
    '1h结算ROI': mv('total_prepay_and_pay_settle_overall_roi2_1h'),
    marketing_goal: 1,
  };
}

async function fetchProductDaily(date, accountId) {
  const { statQuery } = require('./qianchuan');
  const { resolveAavid } = require('./cookie');
  const aavid = resolveAavid(accountId);
  const allRows = [];
  for (let offset = 0; offset < 2000; offset += 100) {
    const body = {
      DataSetKey: PRODUCT_MAT_DATASET,
      Metrics: PRODUCT_MAT_METRICS,
      Filters: { ConditionRelationshipType: 1, Conditions: [
        { Field: 'query_type', Operator: 7, Values: ['all'] },
        { Field: 'advertiser_id', Operator: 7, Values: [aavid] },
        { Field: 'roi2_material_type_v3', Operator: 7, Values: ['1001'] },
        { Field: 'marketing_goal', Operator: 7, Values: ['1'] },
        { Field: 'roi2_material_video_type', Operator: 7, Values: ['11'] },
      ]},
      StartTime: `${date} 00:00:00`, EndTime: `${date} 23:59:59`,
      PageParams: { Limit: 100, Offset: offset },
      OrderBy: [{ Type: 2, Field: 'stat_cost_for_overall_roi2' }],
      Dimensions: ['material_id', 'roi2_material_status', 'roi2_material_video_type', 'roi2_material_video_name', 'roi2_material_video_play_info', 'material_tag_list', 'roi2_material_show_status', 'roi2_material_upload_time'],
      reqFrom: 'uni-prom-creative-tab-list',
    };
    const r = await statQuery(body, 3, accountId);
    const rows = (r && r.data && r.data.StatsData && r.data.StatsData.Rows) || [];
    allRows.push(...rows);
    if (rows.length < 100) break;
    await sleep(300);
  }
  return allRows;
}

async function fetchProductRange(startDate, endDate, accountId = defaultAccountId()) {
  let total = 0;
  for (const date of eachDate(startDate, endDate)) {
    const rows = await fetchProductDaily(date, accountId);
    const mapped = rows.length ? rows.map(mapProductRow).filter(r => r['素材ID'] && r['素材ID'] !== '0') : [];
    // 双渠道共存（v6 起主键含 marketing_goal）：同一视频同日直播/商品各行一行，互不覆盖
    if (mapped.length) {
      total += storeDaily(date, mapped, accountId, 1);
    } else {
      // 空日写 __EMPTY__ 空标记（goal=1）：getMissingProductDates 判已采，兜底不反复补采（2026-07-30）
      storeDaily(date, [], accountId, 1);
    }
    await sleep(200);
  }
  return total;
}

/**
 * 拉取素材深度数据（秒级留存/人群画像/追投任务/脚本/创意元素）
 * 指标合并后每个素材约10次请求；请求间隔由 config.json request_interval 控制
 */
async function fetchDeepData(startDate, endDate, accountId, materialList) {
  if (!materialList || materialList.length === 0) return;

  // 历史账户专用说明已从试用包移除。
  const ACTIVE_STATUS = new Set(['0', '1', 'DELIVERY_OK']);
  const activeList = materialList.filter(mat => {
    const st = mat.Dimensions?.roi2_material_status?.ValueStr ?? mat.Dimensions?.roi2_material_status?.Value;
    return ACTIVE_STATUS.has(String(st));
  });
  if (activeList.length === 0) return;
  if (activeList.length !== materialList.length) {
    console.log(`[deep-fetch] 过滤非在投素材 ${materialList.length - activeList.length} 条，仅深度拉取在投 ${activeList.length} 条`);
  }
  materialList = activeList;

  console.log(`\n[deep-fetch] 开始拉取 ${materialList.length} 个素材的深度数据...`);
  const t0 = Date.now();
  let count = 0;

  for (const mat of materialList) {
    const materialId = mat.Dimensions?.material_id?.ValueStr || mat.Dimensions?.material_id?.Value;
    if (!materialId || materialId === '-' || materialId === '-2') continue;
    // 跳过 AIGC::xx 等聚合伪素材：深度接口对其恒返回 status_code=2，会白耗 5 轮×15s 限频重试
    if (!/^\d+$/.test(String(materialId))) continue;

    const createTime = mat.Dimensions?.material_create_time_v2?.ValueStr || '';
    // 历史账户专用说明已从试用包移除。
    // 不再跟随回填 startDate——否则单日回填会把"单日累计"写进 click/drop_count，
    // 与30天累计混存同字段，前端整体点击/流失数口径漂移（对不上千川后台）
    const e29 = new Date(endDate + 'T00:00:00'); e29.setDate(e29.getDate() - 29);
    let matStartDate = `${e29.getFullYear()}-${String(e29.getMonth() + 1).padStart(2, '0')}-${String(e29.getDate()).padStart(2, '0')}`;
    const m = createTime.match(/(\d{4}-\d{2}-\d{2})/);
    if (m && m[1] > matStartDate) matStartDate = m[1];

    const pct = Math.round((count / materialList.length) * 100);
    const elapsed = Date.now() - t0;
    const avg = elapsed / (count + 1);
    const remaining = Math.round(avg * (materialList.length - count - 1) / 1000);
    process.stdout.write(`\r  [deep-fetch] ${pct}% (${count+1}/${materialList.length}) · ${materialId} · 剩余${remaining}s   `);

    try {
      // 1. 秒级留存
      const insight = await fetchInsight(materialId, matStartDate, endDate, accountId);
      storeInsight(accountId, materialId, endDate, insight);

      // 2. 人群画像
      const crowd = await fetchCrowd(materialId, matStartDate, endDate, accountId);
      storeCrowd(accountId, materialId, endDate, crowd);

      // 3. 追投任务明细
      const tasks = await fetchBoostTasks(materialId, matStartDate, endDate, accountId);
      storeBoostTasks(accountId, materialId, endDate, tasks);

      // 4. 创意元素拆解（先拉，拿到material_uri/vid）
      // 5. 脚本拆解（用vid调接口）
      const creative = await fetchCreativeAnalysis(materialId, accountId);
      let script = null;
      let scriptVid = creative && creative.materialUri;
      if (!scriptVid) {
        const rawMaterial = await creativeVideoLibrary.fetchRawByMaterialId(accountId, materialId).catch(() => null);
        scriptVid = rawMaterial && ((rawMaterial.videoUrl && rawMaterial.videoUrl.uri) || rawMaterial.itemId);
      }
      if (scriptVid) {
        script = await fetchScript(scriptVid, accountId);
      }
      storeContent(accountId, materialId, endDate, script, creative);
    } catch (e) {
      console.log(`\n  [deep-fetch] ${materialId} 失败: ${e.message}`);
    }

    count++;
  }

  const elapsed = Math.round((Date.now() - t0) / 1000);
  console.log(`\n  [deep-fetch] 完成 · ${count}个素材 · 耗时${elapsed}s`);
}

async function fetchDate(date, accountId = defaultAccountId()) {
  console.log(`[daily-fetch] 拉取 ${date} (${accountId})`);
  const result = await fetchAllData(date, date, accountId);
  let stored = 0;
  if (!result || !result.rows || result.rows.length === 0) {
    // 2026-08-01 审计 P0：原早退 return 0——直播素材为空时 supplementBoostData 与 fetchProductRange 被跳过，
    // 与 2026-07-26 fetchRange 事故同根（消耗可能全在推商品口径，商品卡被连锁漏采）
    console.log(`[daily-fetch] ${date} 直播素材无数据（继续商品卡/追投采集）`);
    storeDaily(date, [], accountId);
  } else {
    const normalized = normalizeApiRows(result.rows);
    // 计算 tier / role / lifecycle 快照，便于历史回溯
    const enriched = enrichRows(normalized, date, date);
    // lifecycle_phase降级：enrichRows只算_stage，attachLifecycle需要历史数据且开销大
    // 回填场景用_stage近似（cold→learning, active→growth/stable, declining→declining）
    enriched.forEach(r => {
      if (!r._lifecycle) {
        const map = { cold: 'learning', active: 'growth', declining: 'declining' };
        r._lifecycle = map[r._stage] || 'stable';
      }
    });
    // 历史账户专用说明已从试用包移除。
    const activeRows = enriched.filter(r => r['状态'] === '投放中');
    if (activeRows.length !== enriched.length) {
      console.log(`[daily-fetch] ${date} 过滤非在投素材 ${enriched.length - activeRows.length} 条（仅保留在投）`);
    }
    stored = storeDaily(date, activeRows, accountId);
    console.log(`[daily-fetch] ${date} 写入 ${stored} 条`);

    // 补充追投成交数据（素材日报API不返回追投成交，需单独拉boost-list；直播空日无载体，对齐 fetchRange 跳过）
    await supplementBoostData(date, accountId);
  }

  // 商品卡（推商品/乘方）素材单日采集：与 fetchRange 同款——backfillDates/昨日重写/23:00 调度全走 fetchDate，
  // 无论直播素材是否为空都要跑（消耗可能全在推商品口径）
  try {
    const pStored = await fetchProductRange(date, date, accountId);
    if (pStored > 0) console.log(`[daily-fetch] ${date} 商品卡素材写入 ${pStored} 条`);
  } catch (e) {
    console.error(`[daily-fetch] ${date} 商品卡采集失败（不影响直播数据）:`, e.message);
  }

  return stored;
}

/**
 * 保留调用兼容性，不再向原始财务字段写入缺少素材归因的摊分值。
 */
async function supplementBoostData(date, accountId) {
  // 汇总GMV按消耗摊分不能证明素材归因；只使用data.js的精确上游字段。
  return { updated: 0, reason: 'material_attribution_required', date, account_id: accountId };
}

async function backfillDates(dates, options = {}) {
  const { onProgress, accountId } = options;
  const aid = accountId || defaultAccountId();
  let total = 0;
  let completed = 0;

  // 串行执行，避免并发绕过限频队列
  const BATCH = 1;
  for (let i = 0; i < dates.length; i += BATCH) {
    const batch = dates.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(date => fetchDate(date, aid))
    );
    for (let j = 0; j < results.length; j++) {
      const date = batch[j];
      const r = results[j];
      if (r.status === 'fulfilled') {
        total += r.value;
      } else {
        const errMsg = r.reason?.message || r.reason;
        console.log(`[daily-fetch] ${date} 拉取失败:`, errMsg);
        // cookie_expired 时停止剩余批次，避免全部日期报错
        if (errMsg === 'cookie_expired') {
          console.log(`[daily-fetch] cookie_expired，中止回填（已完成 ${completed} 天）`);
          return total;
        }
      }
      completed++;
      if (onProgress) onProgress({ date, index: i + j, totalDates: dates.length, count: r.status === 'fulfilled' ? r.value : 0, total });
    }
  }
  return total;
}

async function backfillRange(start, end, options = {}) {
  const aid = options.accountId || defaultAccountId();
  let total = 0;
  const missing = getMissingDates(start, end, aid);
  if (missing.length === 0) {
    console.log(`[daily-fetch] ${start}~${end} 无缺失日期`);
  } else {
    console.log(`[daily-fetch] ${start}~${end} 缺失 ${missing.length} 天:`, missing.join(', '));
    total = await backfillDates(missing, { ...options, accountId: aid });
  }
  // 商品卡（mg=1）缺失单独判定：getMissingDates 只按 stat_date 判存在（不分渠道），
  // 历史账户专用说明已从试用包移除。
  const productMissing = getMissingProductDates(start, end, aid);
  if (productMissing.length) {
    console.log(`[daily-fetch] ${aid} 商品卡缺失 ${productMissing.length} 天:`, productMissing.join(', '));
    for (const d of productMissing) {
      try { await fetchProductRange(d, d, aid); }
      catch (e) { console.error(`[daily-fetch] ${aid} 商品卡补采 ${d} 失败:`, e.message); }
    }
  }
  return total;
}

/**
 * 夜间任务：刷新近7天活跃（有消耗）的 top20 素材的深度数据
 */
async function refreshDeepData(endDate, accounts) {
  const { getDB } = require('./db');
  const db = getDB();

  const d = new Date(endDate + 'T00:00:00');
  d.setDate(d.getDate() - 6);
  const start7d = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  for (const acc of accounts) {
    try {
      const rows = db.prepare(`
        SELECT material_id, MAX(created_at) as create_time, SUM(cost) as total_cost
        FROM material_daily
        WHERE account_id = ? AND stat_date >= ? AND stat_date <= ? AND marketing_goal = 2 AND cost > 0
        GROUP BY material_id
        ORDER BY total_cost DESC
        LIMIT 20
      `).all(acc.id, start7d, endDate);

      if (rows.length === 0) {
        console.log(`[night-task] ${acc.id} 近7天无直播消耗素材，跳过深度数据刷新`);
        continue;
      }

      console.log(`[night-task] ${acc.id} 深度数据刷新: 获取到 ${rows.length} 个 top 素材`);

      const materialList = rows.map(r => ({
        Dimensions: {
          material_id: { ValueStr: String(r.material_id) },
          material_create_time_v2: { ValueStr: r.create_time || '' }
        }
      }));

      await fetchDeepData(endDate, endDate, acc.id, materialList);
    } catch (e) {
      console.error(`[night-task] 深度数据刷新失败 ${acc.id}:`, e.message);
    }
  }
}

module.exports = {
  _test: { mapProductRow, supplementBoostData },
  fetchDate,
  fetchRange,
  backfillDates,
  backfillRange,
  fetchProductRange,
  refreshDeepData,
};
