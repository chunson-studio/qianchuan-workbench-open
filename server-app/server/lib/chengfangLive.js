'use strict';

// 2026-09-20 从千川「乘方 > 直播」实际请求核验。与商品乘方、普通全域分开取数。
const { enqueue, requestAPI } = require('./qianchuan');
const { resolveAavid } = require('./cookie');
const { getLocalDateStr } = require('./utils');
const DATASET = 'overall_roi_promotion_list_for_live_v2';
const METRICS = [
  'total_prepay_and_pay_settle_overall_roi2_1h', 'stat_cost_for_overall_roi2',
  'total_order_settle_amount_for_roi2_1h', 'total_order_settle_count_for_roi2_1h',
  'total_pay_order_gmv_include_coupon_for_roi2', 'stat_cost',
];

function failure(code, message, statusCode = 502) {
  return Object.assign(new Error(message), { code, statusCode });
}
function metric(value) {
  if (value && typeof value === 'object') {
    if (value.controlType === 0 || value.valueStr === '-') return null;
    value = value.value;
  }
  return value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
}
function metrics(m = {}) {
  return {
    cost: metric(m.statCostForOverallRoi2),
    advertising_cost: metric(m.statCost),
    roi: metric(m.totalPrepayAndPaySettleOverallRoi21H),
    net_gmv: metric(m.totalOrderSettleAmountForRoi21H),
    orders: metric(m.totalOrderSettleCountForRoi21H),
    payment_gmv: metric(m.totalPayOrderGmvIncludeCouponForRoi2),
  };
}
function filter(start, end) {
  return { AdlabScene: 1, MarGoal: 2, SmartBidType: 0, IsOverallRoi: 1,
    DataTimeRange: { StartTime: `${start} 00:00:00`, EndTime: `${end} 23:59:59` } };
}
function validateResult(result) {
  if (Number(result?.status_code ?? result?.code ?? -1) !== 0) {
    throw failure('chengfang_live_rejected', '千川乘方直播读取未通过');
  }
  if (!result.data || typeof result.data !== 'object') throw failure('chengfang_live_schema', '乘方直播返回结构缺失');
  if (Object.keys(result.data.moduleErrors || {}).length) throw failure('chengfang_live_partial', '乘方直播部分模块读取失败');
  return result;
}

function createService({ request = requestAPI, queue = enqueue, aavidFor = resolveAavid, now = Date.now } = {}) {
  const cache = new Map(), flights = new Map();
  function shared(key, fn) {
    const hit = cache.get(key);
    if (hit && now() - hit.at < 60000) return Promise.resolve(hit.value);
    if (flights.has(key)) return flights.get(key);
    const flight = Promise.resolve().then(fn).then(value => {
      cache.set(key, { at: now(), value });
      if (cache.size > 100) cache.delete(cache.keys().next().value);
      return value;
    }).finally(() => flights.delete(key));
    flights.set(key, flight);
    return flight;
  }
  async function read(account, endpoint, body) {
    const aavid = aavidFor(account);
    return validateResult(await queue(signal => request('POST',
      `/ad/api/pmc/v1/uni-promotion/ad/${endpoint}?aavid=${encodeURIComponent(aavid)}`,
      body, account, signal), account, { label: `chengfang_live_${endpoint}`, timeoutMs: 25000 }));
  }
  function fetchPlanList(start, end, account) {
    return shared(`list:${account}:${aavidFor(account)}:${start}:${end}`, async () => {
      const rows = new Map(), stats = {}, rooms = {};
      for (let page = 1; page <= 20; page++) {
        const result = await read(account, 'list-required', { UseNewChain: true, Params: {
          DiscardTotalNum: true, NeedRequestOptional: true, ListAdsModules: [10, 4, 20, 7],
          OrderBy: { Field: 'create_time', Type: 2 }, PageParams: { Page: page, PageSize: 50 },
          AdFilter: filter(start, end), Metrics: METRICS, SophonxDataSetKey: DATASET,
          Dimensions: ['dynamic_external_action'],
        } });
        const list = result.data.adInfos;
        if (!Array.isArray(list)) throw failure('chengfang_live_schema', '乘方直播计划列表缺失');
        let added = 0;
        for (const ad of list) {
          if (!/^\d+$/.test(String(ad.id)) || (typeof ad.id === 'number' && !Number.isSafeInteger(ad.id)) ||
              String(ad.advId) !== String(aavidFor(account)) || Number(ad.marGoal) !== 2 || Number(ad.adlabScene) !== 1) {
            throw failure('chengfang_live_identity', '乘方直播计划身份或类型不匹配');
          }
          if (!rows.has(String(ad.id))) added++;
          rows.set(String(ad.id), { ...ad, plan_type: 'chengfang_live',
            roi_goal_basis: 'chengfang_comprehensive' });
        }
        Object.assign(stats, result.data.adStatsMap || {});
        Object.assign(rooms, result.data.adRoomInfoMap || {});
        if (list.length < 50) return { status_code: 0, fetched_at: new Date(now()).toISOString(),
          data: { adInfos: [...rows.values()], adStatsMap: stats, adRoomInfoMap: rooms } };
        if (!added) throw failure('chengfang_live_pagination', '乘方直播分页重复，列表不完整');
      }
      throw failure('chengfang_live_truncated', '乘方直播计划超过读取上限，列表不完整');
    });
  }
  function fetchSummary(start, end, account) {
    return shared(`summary:${account}:${aavidFor(account)}:${start}:${end}`, async () => {
      const { DataTimeRange, ...base } = filter(start, end);
      const result = await read(account, 'list-summary', {
        DiscardTotalNum: true, NeedRequestOptional: true, Metrics: METRICS,
        SophonxDataSetKey: DATASET, Dimensions: ['dynamic_external_action'],
        AdFilter: { ...base, AdlabMode: 1, ...DataTimeRange },
      });
      const m = result.data.totalMetrics?.metrics;
      if (!m) throw failure('chengfang_live_schema', '乘方直播汇总指标缺失');
      return metrics(m);
    });
  }
  async function getOverview(account, start = getLocalDateStr(), end = start, adId) {
    const list = await fetchPlanList(start, end, account);
    let plans = list.data.adInfos.map(ad => ({
      id: String(ad.id), name: ad.name || '', status: ad.adDeliveryName || null,
      mar_goal: 2, plan_type: 'chengfang_live', roi_goal_basis: 'chengfang_comprehensive',
      roi_goal: metric(ad.ecpRoi2Goal), budget: metric(ad.budget) == null ? null : metric(ad.budget) / 100000,
      ...metrics(list.data.adStatsMap[ad.id]?.metrics),
      rooms: (list.data.adRoomInfoMap[ad.id] || []).map(r => ({ room_id: String(r.id),
        anchor_id: r.anchor?.id == null ? null : String(r.anchor.id), anchor_name: r.anchor?.name || null })),
    }));
    if (adId) {
      plans = plans.filter(p => p.id === String(adId));
      if (!plans.length) throw failure('chengfang_live_plan_not_found', '该账户下未找到指定乘方直播计划', 404);
    }
    // 累计 ROI 取平台原值，不用支付 GMV / 综合成本冒充综合营销 ROI。
    const summary = adId ? Object.fromEntries(Object.keys(metrics()).map(k => [k, plans[0][k]]))
      : await fetchSummary(start, end, account);
    return { account, date: start === end ? start : `${start}~${end}`, range: { start, end },
      mar_goal: 2, plan_type: 'chengfang_live', has_chengfang: plans.length > 0,
      roi_basis: 'chengfang_comprehensive', cost_basis: 'comprehensive_marketing_cost',
      net_settlement_window: '1h', source: DATASET, fetched_at: list.fetched_at,
      data_valid: true, plans, summary };
  }
  return { fetchPlanList, getOverview };
}

const service = createService();
// 仅只读调用方使用合并列表；不改变现有平台写操作的计划查询范围。
const liveListCache = new Map();
function fetchLivePlanList(start, end, account) {
  const key = `${account}:${start}:${end}`;
  const hit = liveListCache.get(key);
  if (hit && Date.now() - hit.at < 60000) return hit.promise;
  const sourceAt = new Date().toISOString();
  const promise = Promise.all([
    require('./qianchuanTabs').fetchUniPromAdList(start, end, account),
    service.fetchPlanList(start, end, account),
  ]).then(([standard, chengfang]) => {
    validateResult(standard);
    if (!Array.isArray(standard.data.adInfos)) throw failure('live_plan_schema', '全域直播计划列表缺失');
    const rows = new Map(standard.data.adInfos.map(ad => [String(ad.id), ad]));
    chengfang.data.adInfos.forEach(ad => rows.set(String(ad.id), ad));
    return { ...standard, fetched_at: sourceAt, data: { ...standard.data, adInfos: [...rows.values()],
      adStatsMap: { ...standard.data.adStatsMap, ...chengfang.data.adStatsMap },
      adRoomInfoMap: { ...standard.data.adRoomInfoMap, ...chengfang.data.adRoomInfoMap } } };
  }).catch(error => { liveListCache.delete(key); throw error; });
  liveListCache.set(key, { promise, at: Date.now() });
  if (liveListCache.size > 100) liveListCache.delete(liveListCache.keys().next().value);
  return promise;
}
module.exports = { ...service, fetchLivePlanList, _test: { createService, metric, metrics } };
