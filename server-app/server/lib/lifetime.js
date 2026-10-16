const { enqueue, statQuery } = require('./qianchuan');
const { resolveQcAccount, resolveAavid } = require('./cookie');
const { num, toVal, getLocalDateStr } = require('./utils');
const { createTTLCache } = require('./cache');

const LIFETIME_METRICS = [
  { api: 'stat_cost_for_roi2', label: '整体消耗(元)' },
  { api: 'total_pay_order_gmv_include_coupon_for_roi2', label: '整体成交金额(元)' },
  { api: 'total_order_settle_amount_for_roi2_1h', label: '净成交金额(元)' },
  { api: 'total_order_settle_count_for_roi2_1h', label: '净成交订单数' },
  { api: 'live_show_count_for_roi2_v2', label: '整体展现次数' },
  { api: 'live_watch_count_for_roi2_v2', label: '整体点击次数' },
  { api: 'total_pay_order_count_for_roi2', label: '整体成交订单数' },
];
const LIFETIME_METRIC_KEYS = LIFETIME_METRICS.map(m => m.api);

async function fetchMaterialCreateTime(materialId, accountId) {
  const aavid = resolveAavid(accountId);
  const today = getLocalDateStr();
  const body = {
    DataSetKey: 'roi2_video_material_analysis',
    Dimensions: ['material_id', 'material_create_time_v2'],
    Metrics: ['stat_cost_for_roi2'],
    Filters: {
      ConditionRelationshipType: 1,
      Conditions: [
        { Field: 'advertiser_id', Operator: 7, Values: [aavid] },
        { Field: 'marketing_goal', Operator: 7, Values: ['2'] },
        { Field: 'adlab_mode_fork', Operator: 7, Values: ['1'] },
        { Field: 'material_type', Operator: 7, Values: ['3'] },
        { Field: 'material_id', Operator: 7, Values: [String(materialId)] }
      ]
    },
    StartTime: '2024-01-01 00:00:00',
    EndTime: today + ' 23:59:59',
    PageParams: { Offset: 0, Limit: 1 }
  };
  // statQuery 内部已走 enqueue 队列，外包一层会造成队列重入死锁（2026-08-13 深夜定位）
  const result = await statQuery(body, 3, accountId);
  if (!result) throw new Error('create_time_query_failed');
  const rows = (result.data && result.data.StatsData && result.data.StatsData.Rows) || [];
  if (!rows.length) throw new Error('material_not_found');
  const ct = toVal(rows[0].Dimensions && rows[0].Dimensions.material_create_time_v2);
  if (!ct || ct === '-') throw new Error('create_time_missing');
  return ct.split(' ')[0];
}

async function fetchMaterialLifetimeRows(materialId, startDate, endDate, accountId) {
  const aavid = resolveAavid(accountId);
  const body = {
    DataSetKey: 'roi2_video_material_analysis',
    Dimensions: ['material_id', 'stat_time_day'],
    Metrics: LIFETIME_METRIC_KEYS,
    Filters: {
      ConditionRelationshipType: 1,
      Conditions: [
        { Field: 'advertiser_id', Operator: 7, Values: [aavid] },
        { Field: 'marketing_goal', Operator: 7, Values: ['2'] },
        { Field: 'adlab_mode_fork', Operator: 7, Values: ['1'] },
        { Field: 'material_type', Operator: 7, Values: ['3'] },
        { Field: 'material_id', Operator: 7, Values: [String(materialId)] }
      ]
    },
    StartTime: startDate + ' 00:00:00',
    EndTime: endDate + ' 23:59:59',
    OrderBy: [{ Field: 'stat_time_day', Type: 1 }]
  };
  let allRows = [];
  let offset = 0;
  const pageSize = 200;
  for (let page = 0; page < 5; page++) {
    body.PageParams = { Offset: offset, Limit: pageSize };
    // statQuery 内部已走 enqueue 队列，不再外包（防队列重入死锁，2026-08-13 深夜定位）
    const result = await statQuery(body, 3, accountId);
    if (!result) break;
    const sd = result.data && result.data.StatsData;
    const rows = (sd && sd.Rows) || [];
    const total = parseInt(sd && sd.TotalCount) || rows.length;
    allRows = allRows.concat(rows);
    const fetched = offset + rows.length;
    if (fetched >= total || rows.length < pageSize) break;
    offset = fetched;
  }
  return allRows;
}

function aggregateLifetime(rows, startDate, endDate, createTime) {
  const dailyMap = new Map();
  let totalCost = 0, totalGmv = 0, totalNetGmv = 0, totalNetOrders = 0;
  let totalShows = 0, totalClicks = 0, totalOrders = 0;
  rows.forEach(r => {
    const dims = r.Dimensions || {};
    const metrics = r.Metrics || {};
    const date = toVal(dims.stat_time_day);
    if (!date || date === '-') return;
    const day = {
      cost: num(toVal(metrics.stat_cost_for_roi2)),
      gmv: num(toVal(metrics.total_pay_order_gmv_include_coupon_for_roi2)),
      netGmv: num(toVal(metrics.total_order_settle_amount_for_roi2_1h)),
      netOrders: num(toVal(metrics.total_order_settle_count_for_roi2_1h)),
      shows: num(toVal(metrics.live_show_count_for_roi2_v2)),
      clicks: num(toVal(metrics.live_watch_count_for_roi2_v2)),
      orders: num(toVal(metrics.total_pay_order_count_for_roi2)),
    };
    totalCost += day.cost;
    totalGmv += day.gmv;
    totalNetGmv += day.netGmv;
    totalNetOrders += day.netOrders;
    totalShows += day.shows;
    totalClicks += day.clicks;
    totalOrders += day.orders;
    dailyMap.set(date, day);
  });

  const daily = [];
  const s = new Date(startDate + 'T00:00:00');
  const e = new Date(endDate + 'T00:00:00');
  for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
    const ds = getLocalDateStr(d);
    const v = dailyMap.get(ds) || { cost: 0, gmv: 0, netGmv: 0, netOrders: 0, shows: 0, clicks: 0, orders: 0 };
    daily.push({
      date: ds,
      cost: +v.cost.toFixed(2),
      gmv: +v.gmv.toFixed(2),
      netGmv: +v.netGmv.toFixed(2),
      netOrders: v.netOrders,
      shows: v.shows,
      clicks: v.clicks,
      orders: v.orders,
      roi: v.cost > 0 ? +(v.gmv / v.cost).toFixed(2) : 0,
      netRoi: v.cost > 0 ? +(v.netGmv / v.cost).toFixed(2) : 0,
      ctr: v.shows > 0 ? +(v.clicks / v.shows * 100).toFixed(2) : 0,
      cvr: v.clicks > 0 ? +(v.orders / v.clicks * 100).toFixed(2) : 0,
    });
  }

  const safeDiv = (a, b, fix = 2) => b > 0 ? +(a / b).toFixed(fix) : 0;
  return {
    create_time: createTime,
    start: startDate,
    end: endDate,
    days: daily.length,
    totals: {
      cost: +totalCost.toFixed(2),
      gmv: +totalGmv.toFixed(2),
      netGmv: +totalNetGmv.toFixed(2),
      netOrders: totalNetOrders,
      roi: safeDiv(totalGmv, totalCost),
      netRoi: safeDiv(totalNetGmv, totalCost),
      ctr: safeDiv(totalClicks * 100, totalShows),
      cvr: safeDiv(totalOrders * 100, totalClicks),
    },
    daily
  };
}

const lifetimeCache = createTTLCache(10 * 60 * 1000);
function getLifetimeCacheKey(materialId, startDate, endDate) {
  return `${materialId}|${startDate}|${endDate}`;
}

async function getMaterialLifetime(materialId, createTime, endDate, accountId) {
  const today = getLocalDateStr();
  let startDate = createTime;
  if (!startDate) {
    startDate = await fetchMaterialCreateTime(materialId, accountId);
  }
  startDate = startDate.split(' ')[0];
  if (!endDate || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    endDate = today;
  }
  if (endDate < startDate) endDate = startDate;

  const cacheKey = getLifetimeCacheKey(materialId, startDate, endDate) + (accountId ? '|' + accountId : '');
  const cached = lifetimeCache.get(cacheKey);
  if (cached) {
    console.log(`[lifetime] cache hit ${materialId}`);
    return cached;
  }

  const rows = await fetchMaterialLifetimeRows(materialId, startDate, endDate, accountId);
  const result = aggregateLifetime(rows, startDate, endDate, startDate);

  lifetimeCache.set(cacheKey, result);
  return result;
}

module.exports = {
  LIFETIME_METRICS,
  LIFETIME_METRIC_KEYS,
  getMaterialLifetime,
};
