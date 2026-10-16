/**
 * 实时素材列表（投放管理页 → 素材tab）
  * 历史账户专用说明已从试用包移除。
 *
 * 特点：当天实时数据（延迟几分钟），可筛选投放中素材，按计划(anchor)维度
 * 与 /api/materials/now 的区别：now 是全局 T+1 汇总，live 是当天实时按抖音号
 */

const { fetchLiveMaterials, fetchLiveMaterialsOptional } = require('../lib/qianchuanTabs');
const { resolveQcAccount } = require('../lib/cookie');
const { readQcCookie, isCookieProbablyValid } = require('../lib/cookie');
const { sendJSON, getLocalDateStr } = require('../lib/utils');
const { createTTLCache } = require('../lib/cache');
const { QIANCHUAN_ACCOUNTS } = require('../lib/config');
const { defaultAccountId } = require('../lib/api-helpers');

const memCache = createTTLCache(60 * 1000); // 1 分钟缓存（实时数据，短缓存）

function isCompleteMaterialBatch(rowCount, totalCount) {
  const rows = Number(rowCount);
  const total = Number(totalCount);
  return Number.isFinite(rows) && rows >= 0 && Number.isFinite(total) && total >= 0 && rows >= total;
}

async function handleMaterialsLive(req, res, url) {
  const accountId = url.searchParams.get('account') || defaultAccountId();
  // 2026-08-11 修复：refresh=true/yes/on 与 1 等价（此前只认 '1'，导致 refresh=true 命中缓存）
  const refreshParam = (url.searchParams.get('refresh') || '').toLowerCase();
  const refresh = ['1', 'true', 'yes', 'on'].includes(refreshParam);
  const status = url.searchParams.get('status') || '1';  // 默认投放中；all=全部状态（回升作废护栏等场景需要含当日已暂停素材）
  const pageSize = parseInt(url.searchParams.get('pageSize')) || 10;
  const today = getLocalDateStr();
  const startDate = url.searchParams.get('start') || url.searchParams.get('startDate') || url.searchParams.get('date') || today;
  const endDate = url.searchParams.get('end') || url.searchParams.get('endDate') || startDate;

  // Cookie 校验
  if (!isCookieProbablyValid(readQcCookie(accountId))) {
    return sendJSON(res, { ok: false, error: 'cookie_expired', hint: 'Cookie 已失效，请先刷新' }, 401);
  }

  // 查找账号的 anchorId
  const acc = QIANCHUAN_ACCOUNTS.find(a => a.id === accountId);
  if (!acc || !acc.anchorId) {
    return sendJSON(res, { ok: false, error: 'anchor_id_missing', hint: `账号 ${accountId} 未配置 anchorId，请在 config.json 的 qianchuan_accounts 中添加 "anchorId" 字段` }, 400);
  }

  const key = `${accountId}|${status}|${pageSize}|${startDate}|${endDate}`;
  const mem = memCache.get(key);
  if (!refresh && mem) {
    console.log(`[materials-live] ✓ 内存缓存命中 (${accountId})`);
    return sendJSON(res, { ok: true, ...mem, from_cache: true });
  }

  console.log(`[materials-live] 拉取实时素材 ${accountId} anchor=${acc.anchorId} ${startDate}~${endDate} status=${status}`);

  try {
    const t0 = Date.now();

    // 1. 拉素材统计数据
    const result = await fetchLiveMaterials(acc.anchorId, {
      accountId,
      startDate,
      endDate,
      status,
      pageSize,
    });

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    if (!result.rows || result.rows.length === 0) {
      const empty = { meta: { total: 0, overallROI: '—', startDate, endDate, elapsed }, rows: [], server_time: new Date().toISOString() };
      memCache.set(key, empty);
      return sendJSON(res, { ok: true, ...empty });
    }

    // 2. 并发拉补充信息（审核状态/追投状态）
    const materialIds = result.rows
      .map(r => r.dimensions.materialId)
      .filter(id => id && id !== '0' && id !== '-2');

    let optionalMap = {};
    if (materialIds.length > 0) {
      try {
        optionalMap = await fetchLiveMaterialsOptional(acc.anchorId, materialIds, accountId);
      } catch (e) {
        console.log(`[materials-live] 补充信息拉取失败(非致命): ${e.message}`);
      }
    }

    // 3. 合并数据，输出简化格式
    const rows = result.rows.map(r => {
      const d = r.dimensions;
      const m = r.metrics;
      const opt = optionalMap[d.materialId] || optionalMap[String(d.materialId)] || {};

      // 解析视频播放信息
      let videoInfo = {};
      try {
        if (typeof d.roi2MaterialVideoPlayInfo === 'string') {
          videoInfo = JSON.parse(d.roi2MaterialVideoPlayInfo);
        }
      } catch {}

      return {
        material_id: d.materialId,
        material_name: d.roi2MaterialVideoName,
        upload_time: d.roi2MaterialUploadTime,
        video_type: d.roi2MaterialVideoType,
        status: d.roi2MaterialStatus,
        show_status: d.roi2MaterialShowStatus,
        tags: (() => { try { return JSON.parse(d.materialTagList || '[]'); } catch { return []; } })(),
        video_id: videoInfo.VideoId || '',
        video_duration: videoInfo.VideoDuration || 0,
        // 投放指标
        show_count: m.liveShowCountForRoi2V2 ?? 0,
        click_count: m.liveWatchCountForRoi2V2 ?? 0,
        click_rate: m.liveCvrRateForRoi2V2 ?? 0,
        convert_rate: m.liveConvertRateForRoi2V2 ?? 0,
        order_count: m.totalPayOrderCountForRoi2 ?? 0,
        gmv: m.totalPayOrderGmvIncludeCouponForRoi2 ?? 0,
        gmv_rate: m.totalPayOrderGmvRateForRoi2 ?? 0,
        cost: m.statCostForRoi2 ?? 0,
        cost_rate: m.costRateForRoi2 ?? 0,
        basic_cost: m.basicStatCostForRoi2V2 ?? 0,
        roi: m.totalPrepayAndPayOrderRoi2 ?? 0,
        order_cost: m.totalCostPerPayOrderForRoi2 ?? 0,
        real_pay: m.totalPayOrderGmvForRoi2 ?? 0,
        ecpm: m.totalEcpmForRoi2 ?? 0,
        cpc: m.totalCpcForRoi2 ?? 0,
        coupon: m.totalPayOrderCouponAmountForRoi2 ?? 0,
        subsidy: m.totalEcomPlatformSubsidyAmountForRoi2 ?? 0,
        // 净成交（qianchuanTabs camel key 的 `_1h` 固定为 `1H`，大小写不可混用）
        settle_roi: m.totalPrepayAndPaySettleRoi21H ?? null,
        settle_amount: m.totalOrderSettleAmountForRoi21H ?? 0,
        settle_count: m.totalOrderSettleCountForRoi21H ?? 0,
        settle_cost: m.totalCostPerPayOrderSettleForRoi21H ?? 0,
        settle_rate: m.totalOrderSettleAmountRateForRoi21H ?? 0,
        refund_rate: m.totalRefundOrderGmvForRoi21HRate ?? 0,
        overall_roi: m.totalPrepayAndPaySettleOverallRoi21H ?? 0,
        net_data_valid:
          Object.prototype.hasOwnProperty.call(m, 'totalOrderSettleAmountForRoi21H') &&
          m.totalOrderSettleAmountForRoi21H != null && m.totalOrderSettleAmountForRoi21H !== '' &&
          Number.isFinite(Number(m.totalOrderSettleAmountForRoi21H)) &&
          Object.prototype.hasOwnProperty.call(m, 'totalOrderSettleCountForRoi21H') &&
          m.totalOrderSettleCountForRoi21H != null && m.totalOrderSettleCountForRoi21H !== '' &&
          Number.isFinite(Number(m.totalOrderSettleCountForRoi21H)),
        // 追投调控
        boost_cost: m.additionalDeliveryStatCostForRoi2Assist ?? 0,
        boost_order_count: m.additionalDeliveryTotalPayOrderCountForRoi2Assist ?? 0,
        boost_gmv: m.additionalDeliveryTotalPayOrderGmvIncludeCouponForRoi2Assist ?? 0,
        boost_roi: m.additionalDeliveryTotalPrepayAndPayOrderRoi2Assist ?? 0,
        boost_settle_amount: m.additionalDeliveryTotalOrderSettleAmountForRoi21HAssist ?? 0,
        boost_settle_roi: m.additionalDeliveryTotalPrepayAndPaySettleRoi21HAssist ?? 0,
        boost_refund_rate: m.additionalDeliveryTotalRefundOrderGmvForRoi21HRateAssist ?? 0,
        // 补充信息
        audit_status: opt.materialAuditStatus,
        is_frozen: opt.isFrozen,
        has_audit_suggest: opt.hasAuditSuggest,
        aggregate_aid: opt.aggregateAid,
        can_material_heat: opt.canMaterialHeat && opt.canMaterialHeat.enable,
      };
    });

    // 汇总
    const summary = {
      total: result.totalCount || rows.length,
      totalCost: rows.reduce((s, r) => s + (Number(r.cost) || 0), 0),
      totalGMV: rows.reduce((s, r) => s + (Number(r.gmv) || 0), 0),
      totalSettle: rows.reduce((s, r) => s + (Number(r.settle_amount) || 0), 0),
      totalBoostCost: rows.reduce((s, r) => s + (Number(r.boost_cost) || 0), 0),
    };
    summary.overallROI = summary.totalCost > 0
      ? (summary.totalSettle / summary.totalCost).toFixed(2)
      : '—';

    console.log(`[materials-live] ✓ ${rows.length} 条素材（共${result.totalCount}条），${elapsed}s`);

    const out = {
      meta: {
        ...summary,
        startDate,
        endDate,
        window: `${startDate} 00:00:00 ~ ${endDate} 23:59:59`,
        elapsed: `${elapsed}s`,
        account: accountId,
        anchor_id: acc.anchorId,
      },
      rows,
      server_time: new Date().toISOString(),
    };

    memCache.set(key, out);

    // 历史账户专用说明已从试用包移除。
    // 安全修复：小 pageSize 的人工查询是局部页，严禁写成“最新完整批次”污染 MHS 排名/差分。
    const totalAvailable = Number(result.totalCount) || rows.length;
    const minimumCompleteBatch = totalAvailable;
    const totalCountReliable = result.totalCountReliable === true;
    if (refresh && totalCountReliable && isCompleteMaterialBatch(rows.length, minimumCompleteBatch)) {
      try {
        const { upsertSnapshots } = require('../lib/intradayStore');
        const list = rows.map(r => ({
          account_id: accountId,
          material_id: String(r.material_id),
          stat_date: today,
          material_name: r.material_name || '',
          status: r.status != null ? String(r.status) : '',
          cost: +r.cost || 0,
          net_gmv_1h: +r.settle_amount || 0,
          net_roi_1h: r.settle_roi,
          orders: Math.round(+r.settle_count || 0),
          refund_rate: +r.refund_rate || 0,
          boost_cost: +r.boost_cost || 0,
          boost_settle_roi: +r.boost_settle_roi || 0,
          net_data_valid: r.net_data_valid === true,
        })).filter(x => x.material_id);
        if (list.length) upsertSnapshots(list);
      } catch (e) {
        console.log(`[materials-live] 盘中快照落盘失败(非致命): ${e.message}`);
      }
    } else if (refresh) {
      const reason = totalCountReliable ? `${rows.length}/${minimumCompleteBatch}` : 'totalCount不可验证';
      console.log(`[materials-live] 跳过局部/不可验证批次快照落盘: ${reason}`);
    }

    return sendJSON(res, { ok: true, ...out });
  } catch (e) {
    console.log(`[materials-live] ✗ ${e.message}`);
    return sendJSON(res, { ok: false, error: e.message }, 500);
  }
}

module.exports = handleMaterialsLive;
module.exports.isCompleteMaterialBatch = isCompleteMaterialBatch;
