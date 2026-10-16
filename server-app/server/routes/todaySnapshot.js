const { doFetchAndProcess, enrichRows } = require('../lib/data');
const { getBaselineForToday, updateLifecyclePhase } = require('../lib/db');
const { attachLifecycle } = require('../lib/lifecycle');
const { readQcCookie, isCookieProbablyValid } = require('../lib/cookie');
const { sendJSON, getLocalDateStr, formatDate, num } = require('../lib/utils');
const { createTTLCache } = require('../lib/cache');
const { defaultAccountId } = require('../lib/api-helpers');

const memCache = createTTLCache(30 * 1000); 
const baselineCache = createTTLCache(24 * 60 * 60 * 1000); 


const ACTION_NAMES = {
  boost_roi:   '开控成本追投',   
  boost_open:  '开放量追投',     
  pause_boost: '关追投',         
  raise_roi:   '调高目标投入产出比', 
  lower_roi:   '调低目标投入产出比', 
  delist:      '下架素材',       
  watch:       '观察不动',       
};

function getWindowDates() {
  const today = getLocalDateStr();
  const todayDate = new Date(`${today}T00:00:00`);
  const yesterdayDate = new Date(todayDate);
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const start30Date = new Date(todayDate);
  start30Date.setDate(start30Date.getDate() - 30);
  return {
    today,
    yesterday: formatDate(yesterdayDate),
    start30: formatDate(start30Date),
  };
}


function getBaselineWithCache(account) {
  const cached = baselineCache.get(account);
  if (cached) {
    return cached;
  }
  const { today, yesterday, start30 } = getWindowDates();
  const data = getBaselineForToday(today, account);
  baselineCache.set(account, data);
  return data;
}

function computeAverages(hist) {
  const cost30 = hist.reduce((s, r) => s + num(r.cost), 0);
  const gmv30 = hist.reduce((s, r) => s + num(r.gmv), 0);
  const netGmv30 = hist.reduce((s, r) => s + num(r.net_gmv), 0);
  const basicCost30 = hist.reduce((s, r) => s + num(r.basic_cost), 0);
  const baseNetGmv30 = hist.reduce((s, r) => s + num(r.net_gmv) - num(r.additional_net_gmv), 0);
  const orders30 = hist.reduce((s, r) => s + num(r.orders), 0);

  const last7 = hist.slice(-7);
  const cost7 = last7.reduce((s, r) => s + num(r.cost), 0);
  const gmv7 = last7.reduce((s, r) => s + num(r.gmv), 0);
  const netGmv7 = last7.reduce((s, r) => s + num(r.net_gmv), 0);
  const basicCost7 = last7.reduce((s, r) => s + num(r.basic_cost), 0);
  const baseNetGmv7 = last7.reduce((s, r) => s + num(r.net_gmv) - num(r.additional_net_gmv), 0);
  const orders7 = last7.reduce((s, r) => s + num(r.orders), 0);

  const len7 = last7.length || 1;
  const len30 = hist.length || 1;
  return {
    avgCost7d: cost7 / len7,
    avgRoi7d: cost7 > 0 ? gmv7 / cost7 : 0,
    avgNetRoi7d: cost7 > 0 ? netGmv7 / cost7 : 0,
    avgBaseNetRoi7d: basicCost7 > 0 ? baseNetGmv7 / basicCost7 : 0,
    avgOrders7d: orders7 / len7,
    avgCost30d: cost30 / len30,
    avgRoi30d: cost30 > 0 ? gmv30 / cost30 : 0,
    avgNetRoi30d: cost30 > 0 ? netGmv30 / cost30 : 0,
    avgBaseNetRoi30d: basicCost30 > 0 ? baseNetGmv30 / basicCost30 : 0,
    avgOrders30d: orders30 / len30,
  };
}

async function fetchTodaySnapshotData(account = defaultAccountId()) {
  const cached = memCache.get(account);
  if (cached) {
    return { ...cached, _fromCache: true };
  }

  if (!isCookieProbablyValid(readQcCookie(account))) {
    throw new Error('cookie_expired');
  }

  const { today, yesterday, start30 } = getWindowDates();

  
  
  
  const { runFetchOverview } = require('../lib/browser');
  const [baseline, liveResult, overviewResult] = await Promise.all([
    Promise.resolve().then(() => getBaselineWithCache(account)),
    doFetchAndProcess(today, today, account, { skipQueue: true }),
    runFetchOverview(today, today, account, { skipQueue: true }),
  ]);

  const baseAggregates = baseline.aggregates;
  const histories = baseline.histories;

  const accountCostBase = baseAggregates.reduce((s, r) => s + num(r['整体消耗(元)']), 0);
  const accountGmvBase = baseAggregates.reduce((s, r) => s + num(r['整体成交金额(元)']), 0);
  
  
  enrichRows(baseAggregates, start30, yesterday);

  
  baseAggregates.forEach(r => {
    const hist = histories[r['素材ID']] || [];
    const last7 = hist.slice(-7);
    const cost7 = last7.reduce((s, h) => s + num(h.cost), 0);
    const netGmv7 = last7.reduce((s, h) => s + num(h.net_gmv), 0);
    r._avgNetRoi7d = cost7 > 0 ? netGmv7 / cost7 : 0;
  });

  attachLifecycle(baseAggregates, histories, start30, yesterday, { cost: accountCostBase, gmv: accountGmvBase });

  const baseMap = new Map();
  baseAggregates.forEach(r => baseMap.set(r['素材ID'], r));

  const liveRows = (liveResult && liveResult.data) || [];

  
  const ov = overviewResult?.kpi_raw || {};
  const parseNum = (s) => parseFloat(String(s || '').replace(/[%,]/g, '')) || 0;
  const accountCostToday = parseNum(ov['整体消耗(元)']);
  const accountGmvToday = accountCostToday > 0 && parseNum(ov['整体支付ROI']) > 0
    ? accountCostToday * parseNum(ov['整体支付ROI']) : 0;
  const accountNetGmvToday = parseNum(ov['净成交金额(元)']);
  const accountRoiToday = parseNum(ov['整体支付ROI']);
  const accountNetRoiToday = parseNum(ov['净成交ROI']);
  const accountOrdersToday = parseNum(ov['净成交订单数']);
  
  const accountBasicCostToday = liveRows.reduce((s, r) => s + num(r['基础消耗(元)']), 0);
  const accountAdditionalNetGmvToday = liveRows.reduce((s, r) => s + num(r['追投净成交金额(元)']), 0);
  const accountBaseNetRoiToday = accountBasicCostToday > 0
    ? (accountNetGmvToday - accountAdditionalNetGmvToday) / accountBasicCostToday
    : 0;

  const rows = [];
  liveRows.forEach(r => {
    if (r['状态'] === '已删除') return;

    const id = r['素材ID'];
    const base = baseMap.get(id) || {};
    const hist = histories[id] || [];
    const avgs = computeAverages(hist);

    const todayCost = num(r['整体消耗(元)']);
    const todayGmv = num(r['整体成交金额(元)']);
    const todayNetGmv = num(r['净成交金额(元)']);
    const todayBasicCost = num(r['基础消耗(元)']);
    const todayAdditionalCost = num(r['追投调控消耗(元)']);
    const todayAdditionalNetGmv = num(r['追投净成交金额(元)']);
    const todayOrders = num(r['整体成交订单数']);
    const todayROI = todayCost > 0 ? todayGmv / todayCost : 0;
    const todayNetROI = todayCost > 0 ? todayNetGmv / todayCost : 0;
    const todayBaseNetROI = todayBasicCost > 0
      ? (todayNetGmv - todayAdditionalNetGmv) / todayBasicCost
      : 0;

    avgs.spendRatioTodayVs7d = avgs.avgCost7d > 0 ? todayCost / avgs.avgCost7d : 0;
    avgs.roiRatioTodayVs7d = avgs.avgRoi7d > 0 && todayROI > 0 ? todayROI / avgs.avgRoi7d : 0;
    avgs.netRoiRatioTodayVs7d = avgs.avgNetRoi7d > 0 && todayNetROI > 0 ? todayNetROI / avgs.avgNetRoi7d : 0;
    avgs.baseNetRoiRatioTodayVs7d = avgs.avgBaseNetRoi7d > 0 && todayBaseNetROI > 0
      ? todayBaseNetROI / avgs.avgBaseNetRoi7d
      : 0;

    rows.push({
      materialId: id,
      materialName: r['素材名称'] || base['素材名称'] || '',
      createdAt: r['创建时间'] || base['创建时间'] || '',
      status: r['状态'],
      todayCost,
      todayROI,
      todayNetGmv,
      todayNetROI,
      todayBasicCost,
      todayAdditionalCost,
      todayAdditionalNetGmv,
      todayBaseNetROI,
      todayOrders,
      todayRefundRate: num(r['1h退款率']),
      ...avgs,
      lifecycle: base._lifecycle || 'stable',
      lifecycleName: base._lifecycleName || '稳定期',
      lifecycleClass: base._lifecycleClass || 'phase-stable',
      decaySignals: base._decaySignals || {},
      isSeeding: !!(base._isSeeding || r._action === 'boost_roi' || r._action === 'boost_open'),
      
      
      role: base._action || r._action || 'watch',
      roleName: ACTION_NAMES[base._action || r._action || 'watch'] || '观察不动',
      tier: base._stage || r._stage || 'active',
      ageDays: base._ageDays || r._days || 1,
    });

    
    if (today && base._lifecycle) {
      updateLifecyclePhase(id, today, base._lifecycle, account);
    }
  });

  const riskAlerts = [];

  const result = {
    ok: true,
    today,
    account: {
      cost: accountCostToday,
      gmv: accountGmvToday,
      roi: accountRoiToday,
      netGmv: accountNetGmvToday,
      netRoi: accountNetRoiToday,
      basicCost: accountBasicCostToday,
      baseNetRoi: accountBaseNetRoiToday,
      orders: accountOrdersToday || 0,
      data_source: 'home_cost_uni_prom',
    },
    riskAlerts,
    rows,
    server_time: new Date().toISOString(),
  };

  memCache.set(account, result);
  return result;
}

function handleTodaySnapshot(req, res, url) {
  const account = url.searchParams.get('account') || defaultAccountId();
  (async () => {
    try {
      const result = await fetchTodaySnapshotData(account);
      const { _fromCache, ...payload } = result;
      return sendJSON(res, { ...payload, from_cache: _fromCache || false, account_id: account });
    } catch (e) {
      if (e.message === 'cookie_expired') return sendJSON(res, { ok: false, error: 'cookie_expired' }, 401);
      console.error('[today-snapshot] ✗', e.message);
      console.error('[today-snapshot] stack:', e.stack || 'N/A');
      console.error('[today-snapshot] type:', e.constructor && e.constructor.name || typeof e);
      return sendJSON(res, { ok: false, error: e.message }, 500);
    }
  })().catch(err => {
    console.error(`[todaySnapshot] 未捕获异常: ${err.message}`, err);
    if (!res.headersSent) sendJSON(res, { error: 'internal_server_error', message: err.message }, 500);
  });
}

module.exports = { handleTodaySnapshot, fetchTodaySnapshotData };
