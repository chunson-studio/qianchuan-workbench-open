/**
 * server/lib/chengfang.js
 * 乘方（全域升级版·推商品 mar_goal=1）数据封装。
 *
 * 背景：2026-07-30 盲区排查（tmp/chengfang_coverage_report.md）——乘方计划（自选/全店托管）
 * 不在 mar_goal=2 链路视野内，作战室/盯盘看不到其消耗。本模块提供只读接入：
 *   - getOverview：自选+托管计划列表 + 今日汇总（60s 缓存，作战室/盯盘共用）
 *   - getRoiSuggestion：官方 ROI 目标建议值（batch-get-suggestion）
 *   - getCompensateInfo：成本保障逐日状态
 *   - getProducts：托管/自选计划商品粒度归因
 *   - getServiceFeeSaved：预估减免技术服务费
 *
 * 接口依据：references/qianchuan-chengfang-api.md（2026-07-30 探针抓包，全部实测）。
  * 历史账户专用说明已从试用包移除。
 */
const { enqueue, requestAPI, statQuery } = require('./qianchuan');
const { resolveAavid } = require('./cookie');
const fs = require('fs');
const path = require('path');

const CACHE_TTL = 60 * 1000; // 60s 内存缓存（作战室轮询）
const _cache = new Map();
function cached(key, fn) {
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return Promise.resolve(hit.data);
  return fn().then(data => { _cache.set(key, { data, ts: Date.now() }); return data; });
}

// 历史账户专用说明已从试用包移除。
// 历史日数据是不变量，落盘永久复用；当日仍走 60s 内存缓存
const DISK_DIR = path.join(__dirname, '..', '..', 'cache', 'chengfang');
function diskPath(key) { return path.join(DISK_DIR, key.replace(/[^\w.-]/g, '_') + '.json'); }
function diskRead(key, d) {
  const today = new Date().toLocaleDateString('sv-SE');
  if (!d || d >= today) return null; // 当日/无日期不走历史缓存
  try {
    const p = diskPath(key);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { /* 损坏按未命中 */ }
  return null;
}
function diskWrite(key, d, data) {
  const today = new Date().toLocaleDateString('sv-SE');
  if (!d || d >= today) return;
  try {
    fs.mkdirSync(DISK_DIR, { recursive: true });
    const tmp = diskPath(key) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, diskPath(key));
  } catch (e) { console.error('[chengfang] 历史缓存写盘失败:', e.message); }
}
function cachedWithDisk(key, d, fn) {
  const disk = diskRead(key, d);
  if (disk) return Promise.resolve(disk);
  return cached(key, fn).then(data => { diskWrite(key, d, data); return data; });
}

const LIST_METRICS = [
  'stat_cost_for_roi2', 'total_prepay_and_pay_settle_overall_roi2_1h',
  'total_order_settle_amount_for_roi2_1h', 'total_order_settle_count_for_roi2_1h',
  'total_refund_order_gmv_for_roi2_1h_rate', 'total_pay_order_gmv_include_coupon_for_roi2',
];

const DSKEY = { 1: 'overall_roi_promotion_list_for_product_v2', 2: 'overall_roi_unishop_promotion_list_for_product_v2' };

function dayRange(date) {
  return { StartTime: `${date} 00:00:00`, EndTime: `${date} 23:59:59` };
}

/** 2026-08-13 乘方区间支持：start/end（end 缺省 = start 单日） */
function dateRange(start, end) {
  return { StartTime: `${start} 00:00:00`, EndTime: `${end || start} 23:59:59` };
}

/** 宽容提取嵌套 metrics 值（list-summary 扁平 camelCase / adStatsMap 结构） */
function metricVal(obj, names) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (names.some(n => k.toLowerCase() === n.toLowerCase())) {
      if (v && typeof v === 'object') {
        const f = parseFloat(String(v.value ?? v.Value ?? '').replace(/,/g, ''));
        if (!isNaN(f)) return f;
      } else {
        const f = parseFloat(String(v).replace(/,/g, ''));
        if (!isNaN(f)) return f;
      }
    }
    if (v && typeof v === 'object') {
      const r = metricVal(v, names);
      if (r !== undefined) return r;
    }
  }
  return undefined;
}

/** 拉单视图计划列表（list-required，NeedRequestOptional+ListAdsModules 才有 adStatsMap） */
async function fetchViewList(accountId, shopView, start, end) {
  const aavid = resolveAavid(accountId);
  const body = {
    _origin_ajax_: 1,
    UseNewChain: true,
    Params: {
      DiscardTotalNum: true,
      NeedRequestOptional: true,
      SophonxDataSetKey: DSKEY[shopView],
      AdFilter: {
        MarGoal: 1, AdlabScene: 1, SmartBidType: 0, IsOverallRoi: 1,
        DataTimeRange: dateRange(start, end),
        UniPromShopFilter: { UniPromShopView: shopView },
      },
      OrderBy: { Field: 'create_time', Type: 2 },
      PageParams: { Page: 1, PageSize: 50 },
      ListAdsModules: [10, 4, 20],
      Metrics: LIST_METRICS,
      Dimensions: ['dynamic_external_action'],
    },
    aavid,
  };
  return enqueue(() => requestAPI('POST', `/ad/api/pmc/v1/uni-promotion/ad/list-required?aavid=${aavid}`, body, accountId), accountId);
}

/** 拉单视图汇总（list-summary，扁平 camelCase totalMetrics） */
async function fetchViewSummary(accountId, shopView, start, end) {
  const aavid = resolveAavid(accountId);
  const body = {
    DiscardTotalNum: true, NeedRequestOptional: true,
    SophonxDataSetKey: DSKEY[shopView],
    AdFilter: {
      MarGoal: 1, AdlabMode: 1, AdlabScene: 1, SmartBidType: 0, IsOverallRoi: 1,
      ...dateRange(start, end),
      UniPromShopFilter: { UniPromShopView: shopView },
    },
    Metrics: LIST_METRICS,
    Dimensions: ['dynamic_external_action'],
  };
  return enqueue(() => requestAPI('POST', `/ad/api/pmc/v1/uni-promotion/ad/list-summary?aavid=${aavid}`, body, accountId), accountId);
}

/** 官方 ROI 目标建议值（batch-get-suggestion）。plan 需含 id/uniPromShopId/authorId */
async function fetchRoiSuggestion(accountId, plan) {
  const aavid = resolveAavid(accountId);
  const body = {
    getSuggestedRoiGoalInputs: [{
      adId: String(plan.id),
      authorId: String(plan.authorId || ''),
      marGoal: 1,
      isUniPromShop: !!plan.uniPromShopId,
      deepExternalAction: 576,
      blockProductList: [],
      overallROICostItems: [3, 4],
      adlabScene: 1,
    }],
    aavid,
  };
  const r = await enqueue(() => requestAPI('POST', `/ad/api/creation/v1/roi2-goal/batch-get-suggestion?aavid=${aavid}`, body, accountId), accountId);
  const out = r && r.data && r.data.getSuggestedRoiGoalOutputs && r.data.getSuggestedRoiGoalOutputs[0];
  if (!out) return null;
  const h = out.overallRoiHistoryData || {};
  return {
    suggest_roi: out.ecpRoi2Goal,
    agile_roi_7d: out.sevenDayAgileGoal,
    roi_range: [out.roi2LowerBound, out.roi2UpperBound],
    competition: out.competitionValue,
    category: out.categoryNameForCompetition,
    history: {
      overall_roi: h.overallRoi, gmv: h.pureGmv, cost: h.overallCost,
      commission: h.commissionAmount, settle_pass_rate: h.passRate,
    },
  };
}

/** 成本保障逐日状态。返回今日状态 {status, reason}（2=生效中 4=核实中），无则 null */
async function fetchCompensateToday(accountId, adId, todayEpochSec) {
  const aavid = resolveAavid(accountId);
  const r = await enqueue(() => requestAPI('POST', `/ad/api/pmc/v1/compensate/get_list_uni_prom_compensate_info?aavid=${aavid}`, { AdID: String(adId) }, accountId), accountId);
  const infos = (r && r.data && r.data.infos) || [];
  const today = infos.find(i => String(i.compensateTime) === String(todayEpochSec));
  if (!today || !today.compensateStatusInfo) return null;
  return { status: today.compensateStatusInfo.compensateStatus, reason: today.compensateStatusInfo.reason };
}

/** 计划商品粒度归因（ad/product/list，Top10 按消耗降序） */
async function fetchProducts(accountId, adId, date) {
  const aavid = resolveAavid(accountId);
  const body = {
    marGoal: 1,
    dataSetKey: 'overall_roi_promotion_prodcut_tab',
    startTime: `${date} 00:00:00`, endTime: `${date} 23:59:59`,
    page: 1, pageSize: 10,
    orderByType: 2, orderByField: 'stat_cost_for_overall_roi2',
    adProductBlockStatus: '0,1,2,4',
    adId: String(adId),
    metrics: 'stat_cost_for_overall_roi2,total_prepay_and_pay_settle_overall_roi2_1h,total_order_settle_amount_for_roi2_1h,total_pay_order_gmv_include_coupon_for_roi2',
    needTotalMetrics: true, needAwemeUserInfo: false,
    aavid,
  };
  const r = await enqueue(() => requestAPI('POST', `/ad/api/pmc/v1/ad/product/list?aavid=${aavid}`, body, accountId), accountId);
  const infos = (r && r.data && r.data.adProductInfos) || [];
  return infos.map(p => ({
    product_id: p.productInfo && p.productInfo.id,
    name: p.productInfo && p.productInfo.name,
    price: p.productInfo && p.productInfo.price ? +p.productInfo.price / 100 : null,
    image: p.productInfo && p.productInfo.image && p.productInfo.image.urlList && p.productInfo.image.urlList[0],
    cost: metricVal(p, ['stat_cost_for_overall_roi2', 'statCostForOverallRoi2']),
    roi: metricVal(p, ['total_prepay_and_pay_settle_overall_roi2_1h', 'totalPrepayAndPaySettleOverallRoi21H']),
    gmv: metricVal(p, ['total_pay_order_gmv_include_coupon_for_roi2', 'totalPayOrderGmvIncludeCouponForRoi2']),
  })).filter(p => p.product_id);
}

/** 预估减免技术服务费（statQuery，DataSetKey common_overall_roi2_live_product_service_fee） */
async function fetchServiceFeeSaved(accountId, date) {
  const aavid = resolveAavid(accountId);
  const body = {
    Dimensions: [],
    StartTime: `${date} 00:00:00`, EndTime: `${date} 23:59:59`,
    DataSetKey: 'common_overall_roi2_live_product_service_fee',
    Metrics: ['estimated_savings_in_platform_service_fee'],
    reqFrom: 'estimated_saving_service_fee', // 调用方标识（references/qianchuan-chengfang-api.md:69，千川统计用，此前缺失）
    Filters: {
      ConditionRelationshipType: 1,
      Conditions: [
        { Field: 'advertiser_id', Operator: 7, Values: [aavid] },
        { Field: 'pricing_category', Operator: 7, Values: ['2'] },
        { Field: 'marketing_goal', Operator: 7, Values: ['1'] },
        { Field: 'ecp_app_id', Operator: 7, Values: ['1'] },
        { Field: 'campaign_type', Operator: 7, Values: ['1'] },
        { Field: 'adlab_mode', Operator: 7, Values: ['1'] },
        { Field: 'adlab_scene_fork', Operator: 7, Values: ['1'] },
        { Field: 'is_overall_roi', Operator: 7, Values: ['1'] },
      ],
    },
  };
  const r = await statQuery(body, 2, accountId);
  const rows = r && r.data && r.data.StatsData && r.data.StatsData.Rows;
  if (!rows || !rows.length) return 0;
  return metricVal(rows[0].Metrics, ['estimated_savings_in_platform_service_fee']) || 0;
}

function extractPlans(listResult, viewLabel) {
  const data = (listResult && listResult.data) || {};
  const statsMap = data.adStatsMap || {};
  return (data.adInfos || []).map(a => {
    const id = String(a.id || '');
    const stats = statsMap[id] || {};
    return {
      id,
      name: a.name || '(无名计划)',
      view: viewLabel,                       // self=自选商品 / shop=全店托管
      roi_goal: a.ecpRoi2Goal,
      status: a.adDeliveryName || (a.optStatus === 1 ? '投放中' : '已暂停'),
      uni_shop_id: a.uniPromShopId || null,
      product_num: a.uniPromShopProductNum ? +a.uniPromShopProductNum : null,
      author_id: (a.creativeSetting && a.creativeSetting.iesCoreUserId) || null,
      cost: metricVal(stats, ['statCostForRoi2', 'stat_cost_for_roi2']) ?? 0,
      roi: metricVal(stats, ['totalPrepayAndPaySettleOverallRoi21H', 'total_prepay_and_pay_settle_overall_roi2_1h']) ?? null,
      gmv: metricVal(stats, ['totalPayOrderGmvIncludeCouponForRoi2', 'total_pay_order_gmv_include_coupon_for_roi2']) ?? 0,
    };
  });
}

/**
 * 乘方总览（作战室/盯盘共用）：自选+托管计划列表、今日汇总、单计划 ROI 建议/成本保障。
 * 60s 缓存；无乘方计划的账号返回 has_chengfang=false（前端据此隐藏卡片）。
 */
async function getOverview(accountId, start, end) {
  const s = start || new Date().toLocaleDateString('sv-SE');
  const e = end || s;
  const isRange = s !== e;
  return cachedWithDisk(`ov:${accountId}:${s}_${e}`, e, async () => {
    const todayEpochSec = Math.floor(new Date(s + 'T00:00:00').getTime() / 1000);
    const [selfList, selfSum, shopList, shopSum] = await Promise.all([
      fetchViewList(accountId, 1, s, e).catch(e => ({ __err: e.message })),
      fetchViewSummary(accountId, 1, s, e).catch(e => ({ __err: e.message })),
      fetchViewList(accountId, 2, s, e).catch(e => ({ __err: e.message })),
      fetchViewSummary(accountId, 2, s, e).catch(e => ({ __err: e.message })),
    ]);

    const plans = [
      ...extractPlans(selfList.__err ? null : selfList, 'self'),
      ...extractPlans(shopList.__err ? null : shopList, 'shop'),
    ];
    const errors = [selfList.__err, shopList.__err].filter(Boolean);

    // 汇总（list-summary 扁平 camelCase）
    const sumOf = s => (s && !s.__err && s.data) ? {
      cost: metricVal(s.data, ['statCostForRoi2']) || 0,
      roi: metricVal(s.data, ['totalPrepayAndPaySettleOverallRoi21H']) ?? null,
      gmv: metricVal(s.data, ['totalPayOrderGmvIncludeCouponForRoi2']) || 0,
      orders: metricVal(s.data, ['totalOrderSettleCountForRoi21H']) || 0,
      refund_rate: metricVal(s.data, ['totalRefundOrderGmvForRoi21HRate']) ?? null,
    } : { cost: 0, roi: null, gmv: 0, orders: 0, refund_rate: null };
    const selfS = sumOf(selfSum), shopS = sumOf(shopSum);
    const summary = {
      cost: +(selfS.cost + shopS.cost).toFixed(2),
      gmv: +(selfS.gmv + shopS.gmv).toFixed(2),
      orders: selfS.orders + shopS.orders,
      roi: (selfS.cost + shopS.cost) > 0 ? +(((selfS.gmv + shopS.gmv) / (selfS.cost + shopS.cost)).toFixed(2)) : null,
      self: selfS, shop: shopS,
    };

    // 单计划增强：ROI 建议值（区间查询跳过单日成本保障——按日结算的判定，区间无意义）
    for (const p of plans) {
      try {
        const sug = await fetchRoiSuggestion(accountId, { id: p.id, authorId: p.author_id, uniPromShopId: p.uni_shop_id });
        if (sug) p.suggestion = sug;
      } catch (e) { p.suggestion_error = e.message; }
      if (!isRange) {
        try {
          const comp = await fetchCompensateToday(accountId, p.id, todayEpochSec);
          if (comp) p.compensate = comp;
        } catch (e) { /* 成本保障缺失不阻断 */ }
      }
    }

    // 服务费减免（账号维度，单日接口——区间查询跳过）
    let serviceFeeSaved = 0;
    if (!isRange) {
      try { serviceFeeSaved = await fetchServiceFeeSaved(accountId, s); } catch (e) { /* 忽略 */ }
    }

    return {
      account: accountId, date: isRange ? `${s}~${e}` : s, range: { start: s, end: e },
      has_chengfang: plans.length > 0,
      plans, summary, service_fee_saved: serviceFeeSaved,
      errors: errors.length ? errors : undefined,
    };
  });
}

/**
 * 计划商品归因 Top 榜（托管/自选计划商品粒度消耗）。30s 缓存。
 */
async function getProductsTop(accountId, adId, date) {
  const d = date || new Date().toLocaleDateString('sv-SE');
  return cachedWithDisk(`prod:${accountId}:${adId}:${d}`, d, () => fetchProducts(accountId, adId, d));
}

/**
 * 同步 peek 总览缓存（不触发网络）：liveDashboard 快速路径兜底用——
 * 服务重启后慢缓存（prevFull）为空时，乘方段仍能从本模块 60s 缓存补齐，作战室卡片不丢。
 * 未命中/已过期返回 null。
 */
function peekOverviewCache(accountId, date) {
  const d = date || new Date().toLocaleDateString('sv-SE');
  const hit = _cache.get(`ov:${accountId}:${d}`);
  return (hit && Date.now() - hit.ts < CACHE_TTL) ? hit.data : null;
}

/**
 * overview → liveDashboard 乘方段（精简形状）：完整流程与快速路径兜底共用，
 * 避免两处转换逻辑漂移（2026-07-30 抽公共）。
 */
function buildDashboardSection(cf) {
  if (!cf) return null;
  return cf.has_chengfang
    ? {
        has_chengfang: true,
        summary: cf.summary,
        service_fee_saved: cf.service_fee_saved,
        plans: cf.plans.map(p => ({
          id: p.id, name: p.name, view: p.view, status: p.status,
          roi_goal: p.roi_goal, cost: p.cost, roi: p.roi, gmv: p.gmv,
          suggest_roi: p.suggestion && p.suggestion.suggest_roi,
          compensate_status: p.compensate && p.compensate.status,
        })),
      }
    : { has_chengfang: false };
}

/* ═══════════════ 全域商品计划（标准 uni-promotion，mar_goal=1，非乘方）═══════════════
 * 历史账户专用经营说明已从试用包移除。
   作战室商品卡区块要"全域+乘方"双源展示。与乘方 getOverview 同模式：60s 缓存 + peek + build 段。
   指标直接用 fetchUniPromAdList 自带 metrics（含 cost/ROI/GMV/orders 四项）。 */

/** 全域商品计划列表 + 今日汇总（60s 内存缓存 + 历史日落盘缓存）。返回 { account, date, has_plans, plans, summary } */
async function getUniProductOverview(accountId, date) {
  const d = date || new Date().toLocaleDateString('sv-SE');
  return cachedWithDisk(`uni:${accountId}:${d}`, d, async () => {
    const { fetchUniPromAdList } = require('./qianchuanTabs'); // 延迟 require 防循环依赖
    const r = await fetchUniPromAdList(d, d, accountId, { marGoal: 1 });
    const infos = (r && r.data && r.data.adInfos) || [];
    const statsMap = (r && r.data && r.data.adStatsMap) || {};
    const plans = infos.map(ad => {
      const m = (statsMap[String(ad.id)] && statsMap[String(ad.id)].metrics) || null;
      const cost = metricVal(m, ['statCostForRoi2']) || 0;
      const gmv = metricVal(m, ['totalPayOrderGmvIncludeCouponForRoi2']) || 0;
      return {
        id: String(ad.id), name: ad.name || '', status: ad.adDeliveryName || '',
        roi_goal: ad.ecpRoi2Goal != null ? +ad.ecpRoi2Goal : null,
        budget: ad.budget != null ? +ad.budget / 100000 : null, // 微→元
        cost, gmv,
        orders: metricVal(m, ['totalPayOrderCountForRoi2']) || 0,
        roi: cost > 0 ? +(gmv / cost).toFixed(2) : null,
      };
    })
      // 挡掉 4/5 月的老死计划：只留投放中或今日有消耗的；按消耗降序，封顶 8 条
      .filter(p => p.status === '投放中' || p.cost > 0)
      .sort((a, b) => b.cost - a.cost)
      .slice(0, 8);
    const summary = {
      cost: +plans.reduce((a, p) => a + p.cost, 0).toFixed(2),
      gmv: +plans.reduce((a, p) => a + p.gmv, 0).toFixed(2),
      orders: plans.reduce((a, p) => a + p.orders, 0),
      roi: null,
    };
    summary.roi = summary.cost > 0 ? +(summary.gmv / summary.cost).toFixed(2) : null;
    return { account: accountId, date: d, has_plans: plans.length > 0, plans, summary };
  });
}

/** 同步 peek 全域商品计划缓存（不触发网络）：liveDashboard 快速路径冷启动兜底用 */
function peekUniProductCache(accountId, date) {
  const d = date || new Date().toLocaleDateString('sv-SE');
  const hit = _cache.get(`uni:${accountId}:${d}`);
  return (hit && Date.now() - hit.ts < CACHE_TTL) ? hit.data : null;
}

/** uniProductOverview → liveDashboard uni_product 段（对齐 buildDashboardSection 的精简形状） */
function buildUniProductSection(ov) {
  if (!ov) return null;
  return ov.has_plans
    ? { has_plans: true, summary: ov.summary, plans: ov.plans }
    : { has_plans: false };
}

module.exports = { getOverview, getProductsTop, fetchRoiSuggestion, fetchCompensateToday, peekOverviewCache, buildDashboardSection, getUniProductOverview, peekUniProductCache, buildUniProductSection };
