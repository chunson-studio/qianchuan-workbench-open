// 历史文件名保留以兼容总览路由。这里只提供显式账户 HTTP 读取。
// 本地浏览器通道使用 tools/lib/playwright-browser-adapter.cjs。
const fsPromises = require('node:fs/promises');
const path = require('node:path');
const { CACHE_DIR } = require('./config');
const collectTasks = new Map();

// 纯 HTTP 版本：用 statQuery 调 home_cost_uni_prom，不再启动浏览器
async function fetchOverviewHTTP(start, end, accountId, opts = {}) {
  const { statQuery, statQueryDirect } = require('./qianchuan');
  const sq = opts.skipQueue ? statQueryDirect : statQuery;
  const account = require('./config').QIANCHUAN_ACCOUNTS.find(a => a.id === accountId);
  if (!account?.aavid) throw Object.assign(new Error('总览读取需要显式有效账户'), { code: 'account_required' });
  const aavid = account.aavid;
  const body = {
    reqFrom: 'content_uni_data',
    DataSetKey: 'home_cost_uni_prom',
    Filters: { ConditionRelationshipType: 1, Conditions: [
      { Field: 'ignore_zero_dimension', Operator: 7, Values: ['on'] },
      { Field: 'advertiser_id', Operator: 7, Values: [aavid] },
      { Field: 'fill_stat_time', Operator: 7, Values: ['on'] },
      { Field: 'adlab_mode_fork', Operator: 7, Values: ['1'] },
      { Field: 'query_self_data', Operator: 7, Values: ['off'] },
    ] },
    Dimensions: ['stat_time_hour'],
    StartTime: start + ' 00:00:00',
    EndTime: end + ' 23:59:59',
    Metrics: [
      'stat_cost_for_roi2', 'total_prepay_and_pay_settle_roi2_1h',
      'total_order_settle_amount_for_roi2_1h', 'total_order_settle_count_for_roi2_1h',
      'total_order_settle_amount_rate_for_roi2_1h', 'total_prepay_and_pay_order_roi2',
      'total_pay_order_gmv_include_coupon_for_roi2',
    ],
    Extra: { refer: 'ecp,7345401917394190374,7345401917394141222,home_cost_uni_prom' },
  };
  const result = await sq(body, 3, accountId);
  const totals = result && result.data && result.data.StatsData && result.data.StatsData.Totals;
  if (!totals) throw new Error('overview HTTP 响应无 Totals');
  const METRIC_LABELS = {
    'stat_cost_for_roi2': '整体消耗(元)', 'total_prepay_and_pay_settle_roi2_1h': '净成交ROI',
    'total_order_settle_amount_for_roi2_1h': '净成交金额(元)', 'total_order_settle_count_for_roi2_1h': '净成交订单数',
    'total_order_settle_amount_rate_for_roi2_1h': '净成交金额结算率', 'total_prepay_and_pay_order_roi2': '整体支付ROI',
    'total_pay_order_gmv_include_coupon_for_roi2': '整体成交金额(元)',
  };
  const kpiRaw = {};
  for (const [k, v] of Object.entries(METRIC_LABELS)) {
    if (totals[k] && totals[k].ValueStr != null) kpiRaw[v] = totals[k].ValueStr;
  }
  const outData = {
    start, end, aavid, fetched_at: new Date().toISOString(), source: 'http', kpi_raw: kpiRaw,
    row: { Dimensions: { advertiser_id: aavid }, Metrics: Object.fromEntries(Object.entries(METRIC_LABELS).map(([k, v]) => [k, parseFloat(String(kpiRaw[v] || '').replace(/[%,]/g, '')) || null])) },
  };
  // 写盘保持兼容（overview 路由会读文件）
  const outPath = path.join(CACHE_DIR, `overview_${start.replace(/-/g, '')}_${end.replace(/-/g, '')}_${accountId || 'def'}.json`);
  await fsPromises.writeFile(outPath, JSON.stringify(outData, null, 2), 'utf8').catch(() => {});
  return outData;
}

function runFetchOverview(start, end, accountId, opts = {}) {
  const key = `${start}~${end}~${accountId || ''}~${opts.skipQueue ? 'direct' : 'queue'}`;
  if (collectTasks.has(key)) return collectTasks.get(key);

  const promise = fetchOverviewHTTP(start, end, accountId, opts);
  collectTasks.set(key, promise);
  promise.then(() => collectTasks.delete(key), () => collectTasks.delete(key));
  return promise;
}

module.exports = { runFetchOverview };
