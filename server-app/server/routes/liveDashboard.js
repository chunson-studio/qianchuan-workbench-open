const fs = require('fs');
const path = require('path');
const http = require('http');
const { sendJSON, getLocalDateStr, daysAgo, num } = require('../lib/utils');
const { readQcCookie, isCookieProbablyValid, resolveQcAccount } = require('../lib/cookie');
const { fetchLiveStatus, fetchLiveSessions } = require('../lib/qianchuanTabs');
const { getBoostMetricsToday } = require('../lib/metricsService');
const { judgeResumeTask, judgePostLiveTask } = require('../lib/boostGuard');
const { createTTLCache } = require('../lib/cache');
const { handleApiError } = require('../lib/handleApiError');
const { STORAGE_DIR } = require('../lib/config');
const { normalizeFunnel, normalizeChannels, buildLiveFinancialBasis } = require('../lib/decisionContext');
const { loadAccountProfile, toDecisionProfile } = require('../lib/accountProfile');
const { attachRoiGoalContract } = require('../lib/roiBasis');


const cache = createTTLCache(30 * 1000); 
const balanceCache = createTTLCache(5 * 60 * 1000); 
const _cachedAdListMap = new Map(); 

function fieldOf(value, ...keys) {
  if (!value || typeof value !== 'object') return undefined;
  for (const key of keys) if (value[key] != null) return value[key];
  return undefined;
}
function finiteValue(value) {
  const raw = typeof value === 'object' && value ? (value.value ?? value.Value ?? value.ValueStr) : value;
  if (raw == null || String(raw).trim() === '') return null;
  const n = Number(String(raw).trim().replace(/,/g, '').replace(/%$/, ''));
  return Number.isFinite(n) ? n : null;
}
function boolValue(value) {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  return null;
}
function buildPlatformRoiRecommendation(suggestion, date, retrievedAt, unavailableReason = null) {
  const source = suggestion?.data || suggestion?.Data || suggestion;
  
  
  const value = finiteValue(fieldOf(source, 'pureEcpRoi2Goal', 'pure_ecp_roi2_goal', 'pureEcpRoi2GoalValue'));
  const empty = boolValue(fieldOf(source, 'isEmpty', 'is_empty'));
  const valid = !unavailableReason
    && source && empty !== true
    && value != null && value > 0;
  return {
    date: date || null,
    net_roi_goal: valid ? value : null,
    roi_goal_basis: 'platform_net_1h',
    refresh_cycle: 'daily',
    source: 'qianchuan_plan_list_optional',
    retrieved_at: retrievedAt || null,
    data_valid: valid,
    reason: valid ? null : (unavailableReason || 'not_returned'),
  };
}

function buildEffectiveDelivery(raw, date, retrievedAt, unavailableReason = null) {
  const data = raw?.data || raw?.Data || raw || null;
  const roi = fieldOf(data, 'effectiveDeliveryPureRoiInfo', 'effective_delivery_pure_roi_info');
  const spend = fieldOf(data, 'effectiveDeliveryCostInfo', 'effective_delivery_cost_info');
  const duration = fieldOf(data, 'effectiveDeliveryProportion', 'effective_delivery_proportion');
  const roiMatch = boolValue(fieldOf(roi, 'isMatch', 'is_match'));
  const spendMatch = boolValue(fieldOf(spend, 'isMatch', 'is_match'));
  const durationMatch = boolValue(fieldOf(duration, 'isMatch', 'is_match'));
  const valid = !unavailableReason && data && roi && spend && duration && roiMatch != null && spendMatch != null && durationMatch != null;
  const numberOrNull = value => finiteValue(value);
  const suggested = numberOrNull(fieldOf(roi, 'suggestRoi', 'suggest_roi'));
  const weighted = numberOrNull(fieldOf(roi, 'weightedRoi', 'weighted_roi'));
  const cost = numberOrNull(fieldOf(spend, 'cost', 'value'));
  const proportion = numberOrNull(fieldOf(duration, 'proportion', 'value'));
  return {
    date: date || null,
    achieved: valid ? Boolean(roiMatch && spendMatch && durationMatch) : null,
    platform_status_code: finiteValue(fieldOf(data, 'roi2EffectiveDelivery', 'roi2_effective_delivery')),
    roi_goal: { achieved: valid ? roiMatch : null, weighted_value: weighted, recommended_max: suggested > 0 ? suggested : null,
      recommendation_available: suggested > 0, roi_goal_basis: 'platform_net_1h' },
    spend: { achieved: valid ? spendMatch : null, value: cost, required: 200 },
    
    
    duration: { achieved: valid ? durationMatch : null, coverage_percent: (() => {
      const raw = fieldOf(duration, 'proportion', 'value');
      if (raw == null || String(typeof raw === 'object' ? (raw.Value ?? raw.value ?? raw.ValueStr ?? '') : raw).trim() === '') return null;
      const shownPercent = /%\s*$/.test(String(typeof raw === 'object' ? (raw.Value ?? raw.value ?? raw.ValueStr ?? '') : raw));
      return shownPercent ? proportion : +(proportion * 100).toFixed(2);
    })(), required_percent: 50 },
    source: 'qianchuan_effective_delivery', source_at: retrievedAt || null,
    dataValid: Boolean(valid), reason: valid ? null : (unavailableReason || 'not_returned'),
  };
}
const _slowCache = createTTLCache(10 * 60 * 1000); 
const _effectiveDeliveryCache = createTTLCache(60 * 1000); 
const _decisionContextCache = createTTLCache(60 * 1000); 
const _dashboardCacheKeyByAccount = new Map(); 

function decisionContextFromProfile(profile) {
  const safeProfile = profile ? toDecisionProfile(profile) : null;
  return safeProfile ? {
    profile_available: true,
    profile_version: safeProfile.profile_version || null,
    calibration_status: safeProfile.status || null,
    execution_mode: safeProfile.execution_mode || 'agent_decides',
    roi_basis: safeProfile.metrics && safeProfile.metrics.roi_basis || 'unknown',
    funnel_baseline: safeProfile.funnel_baseline || null,
    channel_baseline: safeProfile.channel_baseline || null,
    sustainable_capacity: safeProfile.flow && safeProfile.flow.sustainable_capacity || null,
    sample_thresholds: safeProfile.sample_thresholds || null,
    comparability: safeProfile.comparability || null,
    profile_error: null,
  } : {
    profile_available: false,
    profile_version: null,
    calibration_status: 'missing',
    execution_mode: 'agent_decides',
    roi_basis: 'unknown',
    funnel_baseline: null,
    channel_baseline: null,
    sustainable_capacity: null,
    sample_thresholds: null,
    comparability: null,
    profile_error: { code: 'profile_missing', retryable: false },
  };
}

function readDecisionContext(account) {
  const cached = _decisionContextCache.get(account);
  if (cached) return cached;
  let context;
  try {
    context = decisionContextFromProfile(loadAccountProfile(account));
  } catch (error) {
    context = {
      profile_available: false,
      profile_version: null,
      calibration_status: 'invalid',
      execution_mode: 'agent_decides',
      roi_basis: 'unknown',
      funnel_baseline: null,
      channel_baseline: null,
      sustainable_capacity: null,
      sample_thresholds: null,
      comparability: null,
      
      profile_error: { code: 'profile_unavailable', retryable: true },
    };
  }
  _decisionContextCache.set(account, context);
  return context;
}





const REPLAY_DIR = path.join(STORAGE_DIR, 'replay');
const _todaySessCache = new Map(); 
async function getTodaySessions(account, today, signal, cacheOnly = false) {
  const hit = _todaySessCache.get(account);
  if (hit && hit.date === today && Date.now() - hit.ts < 5 * 60 * 1000) return hit.sessions;
  const safeAccount = /^[a-zA-Z0-9_-]+$/.test(account) ? account : 'unknown';
  const fp = path.join(REPLAY_DIR, `sessions_${safeAccount}_${today}.json`);
  let sessions = null, fresh = false, refreshFailed = false;
  try {
    const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
    if (j && j.ok && Array.isArray(j.sessions)) sessions = j.sessions;
    fresh = fs.statSync(fp).mtimeMs > Date.now() - 10 * 60 * 1000;
  } catch {  }
  if (cacheOnly) return sessions || (hit?.date === today ? hit.sessions : []);
  if (!sessions || !fresh) {
    try {
      const r = await fetchLiveSessions(today, { accountId: account, signal });
      if (r && !r.error && Array.isArray(r.sessions)) {
        sessions = r.sessions.map(s => ({ ...s, account }));
        try { require('../lib/api-helpers').writeJsonAtomic(fp, { ok: true, account, date: today, sessions }); } catch {  }
      } else refreshFailed = true;
    } catch (e) { refreshFailed = true;  }
  }
  sessions = sessions || [];
  
  if (!refreshFailed || fresh) _todaySessCache.set(account, { ts: Date.now(), date: today, sessions });
  return sessions;
}


function getCollectorData(account) {
  try {
    const { getLatestWatch } = require('../lib/liveCollector');
    const all = getLatestWatch();
    const found = all.find(a => a.accountId === account);
    
    
    if (found) return found;
  } catch (e) {  }
  return null;
}



const INTERNAL_REFRESH = Symbol('dashboard_background_refresh');
const slowRefreshFlights = new Map();
function refreshSlowSnapshot(account) {
  if (slowRefreshFlights.has(account)) return slowRefreshFlights.get(account);
  const flight = (async () => {
    let result;
    const response = { writeHead() {}, end(text) { result = JSON.parse(text); } };
    await handleLiveDashboard({ [INTERNAL_REFRESH]: true, signal: AbortSignal.timeout(55000) }, response,
      new URL(`http://localhost/api/live-dashboard?account=${encodeURIComponent(account)}`));
    return result;
  })().finally(() => slowRefreshFlights.delete(account));
  slowRefreshFlights.set(account, flight);
  return flight;
}

const endedRefreshFlights = new Map();
function refreshEndedSnapshot(account) {
  if (endedRefreshFlights.has(account)) return endedRefreshFlights.get(account);
  const flight = (async () => {
    const ended = (await getTodaySessions(account, getLocalDateStr()))
      .filter(room => String(room.status) === '4' && room.endTime)
      .sort((a, b) => String(b.startTime).localeCompare(String(a.startTime)))[0];
    if (ended) await require('../lib/liveCollector').ensureEndedWatch(account, ended);
  })().catch(() => {}).finally(() => endedRefreshFlights.delete(account));
  endedRefreshFlights.set(account, flight);
  return flight;
}


async function handleLiveDashboard(req, res, url) {
  const account = url.searchParams.get('account') || url.searchParams.get('accountId');
  if (!account) return sendJSON(res, { ok: false, error: '缺少 account 参数' }, 400);
  
  const { validateAccount } = require('../lib/api-helpers');
  try { validateAccount(account); } catch (e) {
    return sendJSON(res, { ok: false, error: e.message + '（合法账号见 config.qianchuan_accounts）' }, 400);
  }
  const requestedRoom = url.searchParams.get('room_id') || url.searchParams.get('roomId');
  if ((!requestedRoom && url.searchParams.has('start_time')) ||
      (url.searchParams.has('room_id') && url.searchParams.has('roomId') && url.searchParams.get('room_id') !== url.searchParams.get('roomId')))
    return sendJSON(res, { ok: false, code: 'invalid_room_scope', error: '场次时间必须绑定唯一 room_id' }, 400);
  if (requestedRoom) {
    try {
      const dashboard = await require('../lib/liveRoomContext').readRoomDashboard(account, requestedRoom,
        { startTime: url.searchParams.get('start_time') || undefined });
      return sendJSON(res, dashboard);
    } catch (error) { return require('../lib/handleApiError').handleApiError(res, error); }
  }

  
  
  const slimDashboard = (result, account) => {
    const decisionContext = result.decision_context || readDecisionContext(account);
    const mats = result.materials_top || [];
    const seen = new Set();
    const materials = [];
    for (const m of [...mats.filter(x => x.orders > 0), ...mats.slice(0, 5)]) {
      if (!m || seen.has(m.material_id)) continue;
      seen.add(m.material_id);
      materials.push(m);
      if (materials.length >= 8) break;
    }
    return {
      ok: true, account, slim: true,
      server_time: result.server_time || new Date().toISOString(),
      session_key: result.session_key || null,
      fetchedAt: result.fetchedAt || null,
      component_times: result.component_times || null,
      liveCheckedAt: result.liveCheckedAt || null,
      boost_source_at: result.boost_source_at || null,
      boost_data_valid: result.boost_data_valid === true,
      boost_window: result.boost_window || null,
      boost_truncated: result.boost_truncated === true,
      boost_coverage: result.boost_coverage || null,
      age_ms: result.age_ms ?? null,
      stale: result.stale === true,
      dataValid: result.dataValid === true,
      partial: result.partial === true,
      errors: result.errors || [],
      source: result.source_type || result.today_source || null,
      live: result.live ? {
        isLive: result.live.isLive,
        rooms: (result.live.rooms || []).map(r => ({ roomId: r.roomId, startTime: r.startTime, cost: r.cost })),
      } : null,
      today: result.today || null,
      financial_basis: buildLiveFinancialBasis(),
      funnel: normalizeFunnel(result.funnel, {
        sourceAt: result.fetchedAt || null,
        window: 'current_session',
        baseline: decisionContext.funnel_baseline,
      }),
      channels: normalizeChannels(result.channels || (Array.isArray(result.source) ? result.source : []), {
        sourceAt: result.fetchedAt || null,
        window: 'current_session',
        baseline: decisionContext.channel_baseline,
      }),
      decision_context: decisionContext,
      balance: result.balance || null,
      break_even_roi: result.break_even_roi ?? null,
      riskAlerts: result.riskAlerts || [],
      suggestions: (result.suggestions || []).slice(0, 6),
      decisions: result.decisions ? {
        redList: result.decisions.redList || [],
        blackList: result.decisions.blackList || [],
        potentialList: (result.decisions.potentialList || []).slice(0, 3),
        aigc: result.decisions.aigc || null,
      } : null,
      plan: result.plan ? {
        source_at: result.plan.source_at || null,
        action_limits: require('../lib/actionLimits').safeActionLimits(account, result.plan.primary_ad_id),
        primary_ad_id: result.plan.primary_ad_id,
        plan_type: result.plan.plan_type || null,
        roi_goal: result.plan.roi_goal, budget: result.plan.budget,
        roi_goal_basis: result.plan.roi_goal_basis || 'unknown',
        platform_recommendation: result.plan.platform_recommendation || null,
        effective_delivery: result.plan.effective_delivery || null,
        flow_control: result.plan.flow_control || null,
        boost_count: result.plan.boost_count, boost_max: result.plan.boost_max,
        quota_left: result.plan.quota_left, quota_exceeded: result.plan.quota_exceeded,
      } : null,
      boost_summary: result.boost_summary || null,
      boost_tasks: (result.boost_tasks || []).map(t => ({
        ...require('../lib/mcpClean').slimBoostTask(t),
        id: t.id, name: t.name, status: t.status, roi_goal: t.roi_goal,
        roi_goal_basis: t.roi_goal_basis || 'unknown',
        roi_basis_source: t.roi_basis_source || null,
        optimization: t.optimization || null,
        budget: t.budget, cost: t.cost, net_roi: t.net_roi, order_count: t.order_count,
        metric_roi_basis: t.metric_roi_basis || { roi: 'payment', net_roi: 'platform_net_1h' },
        settlement_window: t.settlement_window || { net_roi: '1h' },
      })),
      materials_top: materials,
      context: result.context || null,
    };
  };

  const slimMode = url.searchParams.get('slim') === '1';

  try {  

  await require('../lib/liveReadService').readLiveSnapshot(account);
  const selection = getCollectorData(account);
  if (selection?.requires_room_selection || selection?.errors?.some(error => error.code === 'live_room_required'))
    return sendJSON(res, { ok: false, code: 'live_room_required', error: '同一广告账户有多个直播间，必须指定 room_id', rooms: selection.available_rooms || [] }, 409);
  if (getCollectorData(account)?.isLive === false) {
    const known = (await getTodaySessions(account, getLocalDateStr(), undefined, true))
      .filter(room => String(room.status) === '4' && room.endTime)
      .sort((a, b) => String(b.startTime).localeCompare(String(a.startTime)))[0];
    if (known) await require('../lib/liveCollector').ensureEndedWatch(account, known, { restoreOnly: true });
    const endedRefresh = refreshEndedSnapshot(account);
    if (!getCollectorData(account)?.fetchedAt) await endedRefresh;
  }
  const cacheCollector = getCollectorData(account);
  const currentSessionKey = cacheCollector?.session_key || null;
  
  const dashboardCacheKey = `${account}|${currentSessionKey || 'offline'}`;
  const previousDashboardKey = _dashboardCacheKeyByAccount.get(account);
  if (previousDashboardKey && previousDashboardKey !== dashboardCacheKey) cache.delete(previousDashboardKey);
  _dashboardCacheKeyByAccount.set(account, dashboardCacheKey);

  
  const cached = cache.get(dashboardCacheKey);
  if (cached && !req[INTERNAL_REFRESH]) {
    const fresh = require('../lib/liveFreshness').refreshDashboardCore(cached, cacheCollector);
    if (slimMode) return sendJSON(res, { ...slimDashboard(fresh, account), from_cache: true });
    return sendJSON(res, { ...fresh, from_cache: true });
  }

  
  const forceFull = req[INTERNAL_REFRESH] === true;

  
  
  if (!forceFull) {
  const collectorData0 = getCollectorData(account);
  if (collectorData0 && (process.env.QC_DISABLE_BACKGROUND === '1' || collectorData0.status !== 'no_data' || collectorData0.isLive === false)) {
    const decisionContext = readDecisionContext(account);
    
    const fastResult = {
      ok: true,
      account,
      server_time: new Date().toISOString(),
      session_key: collectorData0.session_key || null,
      fetchedAt: collectorData0.fetchedAt || null,
      component_times: collectorData0.component_times || null,
      liveCheckedAt: collectorData0.liveCheckedAt || null,
      age_ms: collectorData0.age_ms ?? null,
      stale: collectorData0.stale === true,
      status_stale: collectorData0.status_stale === true,
      data_stale: collectorData0.data_stale === true,
      dataValid: collectorData0.dataValid === true,
      partial: collectorData0.partial === true,
      errors: collectorData0.errors || [],
      source_type: collectorData0.source_type || 'collector_memory',
      from_fast_path: true,
      collecting: !!collectorData0.collecting, 
      live: collectorData0.room ? {
        isLive: collectorData0.isLive,
        rooms: [{
          roomId: collectorData0.room.room_id || collectorData0.room.roomId || '',
          roomName: collectorData0.room.room_name || collectorData0.room.roomName || '',
          startTime: collectorData0.room.start_time || collectorData0.room.startTime || '',
          endTime: collectorData0.room.end_time || null,
          cost: collectorData0.live_metrics ? collectorData0.live_metrics.cost : null,
        }],
      } : { isLive: typeof collectorData0.isLive === 'boolean' ? collectorData0.isLive : null, rooms: [] },
      live_metrics: collectorData0.live_metrics || null,
      today: collectorData0.dataValid === true && collectorData0.live_metrics ? {
        cost: Number(collectorData0.live_metrics.cost),
        gmv: collectorData0.live_metrics.gmv != null ? Number(collectorData0.live_metrics.gmv) : null,
        roi: collectorData0.live_metrics.roi != null ? Number(collectorData0.live_metrics.roi) : null,
        netGmv: Number(collectorData0.live_metrics.gmvSettle),
        netRoi: collectorData0.live_metrics.roiSettle != null ? Number(collectorData0.live_metrics.roiSettle) : null,
        orderCount: Number(collectorData0.live_metrics.orders),
        orderCountPay: collectorData0.live_metrics.ordersPay != null ? +collectorData0.live_metrics.ordersPay : null,
        roi_basis: { roi: 'payment', netRoi: 'platform_net_1h' },
        settlement_window: '1h',
      } : null,
      balance: null,
      boost_tasks: [],
      boost_summary: { total_cost: 0, total_gmv: 0, total_roi: 0, count: 0 },
      materials_top: collectorData0.materialsTop ? collectorData0.materialsTop.map(m => ({ ...m })) : [],
      source: collectorData0.source || [], 
      channels: normalizeChannels(collectorData0.channels || collectorData0.source || [], {
        sourceAt: collectorData0.fetchedAt || null,
        window: 'current_session',
        baseline: decisionContext.channel_baseline,
      }),
      riskAlerts: collectorData0.riskAlerts || [],
      suggestions: [],
      decisions: collectorData0.decisions || { redList: [], blackList: [], potentialList: [] },
      plan: null,
      funnel: normalizeFunnel(collectorData0.funnel, {
        sourceAt: collectorData0.fetchedAt || null,
        window: 'current_session',
        baseline: decisionContext.funnel_baseline,
      }),
      financial_basis: buildLiveFinancialBasis(),
      decision_context: decisionContext,
      account_info: (() => { const a = resolveQcAccount(account); return a ? { aavid: a.aavid || '', anchorId: a.anchorId || '' } : null; })(),
      thresholds: { break_even_roi: require('../lib/api-helpers').getAccountParams(account).break_even_roi },
    };

    
    
    const _arTs = global.__dashAsyncRefreshTs || (global.__dashAsyncRefreshTs = {});
    if (collectorData0.isLive == null || (_arTs[account] && Date.now() - _arTs[account] < 300000)) {  }
    else {
      _arTs[account] = Date.now();
      void refreshSlowSnapshot(account).then(j => {
        if (!j?.ok) console.warn(`[dash-async] ${account} 完整刷新未完成`);
      }).catch(e => console.warn(`[dash-async] ${account} 刷新失败: ${e.code || 'upstream_error'}`));
    }

    
    
    
    try {
      const prevBal = balanceCache.get(account);
      if (prevBal) fastResult.balance = { ...prevBal };
    } catch (e) {}
    try {
      
      
      const prevFull = cache.get(dashboardCacheKey) || _slowCache.get(account);
      
      
      
      const sameSession = prevFull && prevFull.session_key && prevFull.session_key === fastResult.session_key;
      if (sameSession) {
        for (const key of ['boost_source_at', 'boost_data_valid', 'boost_window', 'boost_truncated', 'boost_coverage']) fastResult[key] = prevFull[key];
        if (prevFull.plan) fastResult.plan = prevFull.plan;
        if (prevFull.boost_tasks && prevFull.boost_tasks.length) fastResult.boost_tasks = prevFull.boost_tasks;
        if (prevFull.boost_summary && prevFull.boost_summary.count) fastResult.boost_summary = prevFull.boost_summary;
        if (!fastResult.balance && prevFull.balance) fastResult.balance = prevFull.balance;
        if (prevFull.chengfang) fastResult.chengfang = prevFull.chengfang;  
        if (prevFull.uni_product) fastResult.uni_product = prevFull.uni_product;  
      } else if (prevFull && fastResult.session_key) {
        fastResult.boost_data_valid = false;
        fastResult.boost_window = { scope: 'current_session', session_key: fastResult.session_key };
        fastResult.boost_coverage = { complete: false, reason: 'slow_cache_session_mismatch' };
      }
    } catch (e) {}
    
    
    if (!fastResult.chengfang) {
      try {
        const cfLib = require('../lib/chengfang');
        const peeked = cfLib.buildDashboardSection(cfLib.peekOverviewCache(account));
        if (peeked) fastResult.chengfang = peeked;
      } catch (e) {}
    }
    
    if (!fastResult.uni_product) {
      try {
        const cfLib = require('../lib/chengfang');
        const peeked = cfLib.buildUniProductSection(cfLib.peekUniProductCache(account));
        if (peeked) fastResult.uni_product = peeked;
      } catch (e) {}
    }

    
    
    try {
      const todayStr = getLocalDateStr();
      const sessions = await getTodaySessions(account, todayStr, req.signal, true);
      if (!fastResult.today && collectorData0.isLive === false && !collectorData0.collecting) {
        const valid = sessions.filter(s => +s.cost > 0);
        if (valid.length) {
          const cost = valid.reduce((a, s) => a + (+s.cost || 0), 0);
          const netGmv = valid.reduce((a, s) => a + (+s.netGmv || 0), 0);
          fastResult.today = {
            cost: +cost.toFixed(2), gmv: null, roi: null,
            netGmv: +netGmv.toFixed(2),
            netRoi: null, 
            orderCount: null, orderCountPay: null,
            roi_basis: { roi: 'unknown', netRoi: 'platform_net_1h' },
            settlement_window: '1h',
          };
          fastResult.today_source = 'sessions';
        }
      } else {
        fastResult.today_source = 'live_board';
      }
      const sorted = [...sessions].sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)));
      const liveIdx = sorted.findIndex(s => String(s.status) === '2');
      fastResult.today_sessions = {
        count: sorted.length,
        live_index: liveIdx >= 0 ? liveIdx + 1 : null,
        ended_count: sorted.filter(s => String(s.status) !== '2').length,
        list: sorted.map(s => ({ roomId: s.roomId, startTime: s.startTime, endTime: s.endTime, status: s.status, cost: s.cost, netRoi: s.netRoi })),
      };
    } catch (e) {  }

    const fresh = require('../lib/liveFreshness').refreshDashboardCore(fastResult, getCollectorData(account));
    return sendJSON(res, slimMode ? slimDashboard(fresh, account) : fresh);
  }
  } 

  
  

  if (!isCookieProbablyValid(readQcCookie(account))) {
    return sendJSON(res, { ok: false, error: 'cookie_expired' }, 401);
  }

  const today = getLocalDateStr();
  const decisionContext = readDecisionContext(account);
  const result = {
    ok: true,
    account,
    server_time: new Date().toISOString(),
    session_key: cacheCollector?.session_key || null,
    fetchedAt: cacheCollector?.fetchedAt || null,
    liveCheckedAt: cacheCollector?.liveCheckedAt || null,
    age_ms: cacheCollector?.age_ms ?? null,
    stale: cacheCollector?.stale === true,
    dataValid: cacheCollector?.dataValid === true,
    partial: false,
    errors: [],
    source_type: cacheCollector?.source_type || 'dashboard_aggregate',
    live: null,
    live_metrics: null,
    today: null,
    balance: null,
    boost_tasks: [],
    boost_summary: { total_cost: 0, total_gmv: 0, total_roi: 0, count: 0 },
    materials_top: [],
    riskAlerts: [],
    suggestions: [],
    decisions: { redList: [], blackList: [], potentialList: [] },
    plan: null,
    funnel: null,
    channels: null,
    financial_basis: buildLiveFinancialBasis(),
    decision_context: decisionContext,
  };

  try {
    
    const collectorData = getCollectorData(account);
    if (collectorData && collectorData.room) {
      result.live = {
        isLive: typeof collectorData.isLive === 'boolean' ? collectorData.isLive : null,
        rooms: [{
          roomId: collectorData.room.room_id,
          roomName: collectorData.room.room_name,
          startTime: collectorData.room.start_time,
          cost: collectorData.live_metrics ? collectorData.live_metrics.cost : null,
        }],
      };
      
      if (collectorData.live_metrics) {
        result.live_metrics = { ...collectorData.live_metrics };
      }
      result.session_key = collectorData.session_key || result.session_key;
      result.fetchedAt = collectorData.fetchedAt || null;
      result.liveCheckedAt = collectorData.liveCheckedAt || null;
      result.age_ms = collectorData.age_ms ?? null;
      result.stale = collectorData.stale === true;
      result.dataValid = collectorData.dataValid === true;
      result.partial = collectorData.partial === true;
      result.errors.push(...(collectorData.errors || []));
      
      if (collectorData.materialsTop) {
        result.materials_top = collectorData.materialsTop.map(m => ({ ...m }));
      }
      
      if (collectorData.funnel) result.funnel = normalizeFunnel(collectorData.funnel, {
        sourceAt: collectorData.fetchedAt || null,
        window: 'current_session',
        baseline: decisionContext.funnel_baseline,
      });
      
      if (collectorData.source) result.source = collectorData.source;
      result.channels = normalizeChannels(collectorData.channels || collectorData.source || [], {
        sourceAt: collectorData.fetchedAt || null,
        window: 'current_session',
        baseline: decisionContext.channel_baseline,
      });
      
      const acc = resolveQcAccount(account);
      if (acc) result.account_info = { aavid: acc.aavid || '', anchorId: acc.anchorId || '' };
    } else {
      
      const liveStatus = await fetchLiveStatus(account, { signal: req.signal });
      if (liveStatus.error) {
        const err = new Error(liveStatus.error);
        err.code = liveStatus.code;
        err.statusCode = liveStatus.statusCode;
        err.retryable = liveStatus.retryable;
        throw err;
      }
      result.live = { isLive: liveStatus.isLive, rooms: liveStatus.rooms || [] };
      result.liveCheckedAt = new Date().toISOString();
    }
    if (result.live.isLive === false) {
      result.suggestions.push({ level: 'info', msg: '当前未在直播，无需操盘' });
    }
    
    if (!result.materials_top) result.materials_top = [];
    if (!result.riskAlerts) result.riskAlerts = [];
  } catch (e) {
    if (e.code === 'cookie_expired' || e.message === 'cookie_expired') throw e;  
    result.live = { isLive: null, error: e.message };
    result.live_metrics = null;
    result.materials_top = [];
    result.riskAlerts = [];
    result.partial = true;
    result.errors.push({ component: 'live_status', code: e.code || 'live_status_error', error: e.message });
  }

  
  try { const c0 = getCollectorData(account); result.collecting = !!(c0 && c0.collecting); } catch (e) { result.collecting = false; }

  
  
  
  try {
    if (result.dataValid === true && result.live_metrics && result.live_metrics.cost != null) {
      const m = result.live_metrics;
      result.today = {
        cost: num(m.cost),
        gmv: num(m.gmv),
        roi: num(m.roi),
        netGmv: num(m.gmvSettle),
        netRoi: num(m.roiSettle),
        orderCount: num(m.orders),
        orderCountPay: m.ordersPay != null ? num(m.ordersPay) : null, 
        settleRate: m.gmv > 0 ? +(num(m.gmvSettle) / num(m.gmv) * 100).toFixed(1) : 0,
        roi_basis: { roi: 'payment', netRoi: 'platform_net_1h' },
        settlement_window: '1h',
      };
      result.today_source = 'live_board'; 
    } else {
      
      
      const sessions = await getTodaySessions(account, today, req.signal);
      const valid = sessions.filter(s => +s.cost > 0);
      if (valid.length && !result.collecting) { 
        const cost = valid.reduce((a, s) => a + (+s.cost || 0), 0);
        const netGmv = valid.reduce((a, s) => a + (+s.netGmv || 0), 0);
        result.today = {
          cost: +cost.toFixed(2),
          gmv: null,
          roi: null,
          netGmv: +netGmv.toFixed(2),
          netRoi: null, 
          orderCount: null,
          orderCountPay: null,
          roi_basis: { roi: 'unknown', netRoi: 'platform_net_1h' },
          settlement_window: '1h',
        };
        result.today_source = 'sessions'; 
      }
    }
  } catch (e) {
    result.today = { error: e.message };
    result.partial = true;
    result.errors.push({ component: 'today', code: e.code || 'today_error', error: e.message });
  }

  
  try {
    const sessions = await getTodaySessions(account, today, req.signal);
    const sorted = [...sessions].sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)));
    const liveIdx = sorted.findIndex(s => String(s.status) === '2');
    result.today_sessions = {
      count: sorted.length,
      live_index: liveIdx >= 0 ? liveIdx + 1 : null, 
      ended_count: sorted.filter(s => String(s.status) !== '2').length,
      list: sorted.map(s => ({ roomId: s.roomId, startTime: s.startTime, endTime: s.endTime, status: s.status, cost: s.cost, netRoi: s.netRoi })),
    };
  } catch (e) {  }

  
  
  try {
    const { getCachedAvgOrderPrice } = require('../lib/doudian');
    await getCachedAvgOrderPrice(account).catch(() => null);
  } catch (e) {
    
  }

  
  
  
  try {
    const th = require('../lib/liveCollector').buildThresholds(account);
    if (th) {
      result.thresholds = th;
      if (result.today) {
        result.today.break_even_roi = th.break_even_roi;
        if (th.avg_order_price) result.today.avg_order_price = th.avg_order_price;
      }
    }
  } catch (e) {
    console.warn('[liveDashboard] 阈值计算失败:', e.message);
  }

  
  try {
    const cachedBal = balanceCache.get(account);
    if (cachedBal) {
      result.balance = { ...cachedBal }; 
    } else {
      const { getAccountBalance } = require('../lib/qianchuan');
      const balResult = await getAccountBalance(account);
      const infos = balResult && balResult.data && balResult.data.balanceInfos;
      if (infos && Object.keys(infos).length) {
        const main = infos['1'];
        result.balance = { total_yuan: main ? parseInt(main.total) / 100000 : 0 };
        balanceCache.set(account, result.balance);
      } else {
        
        result.balance = null;
        result.balance_error = balResult && balResult.message ? balResult.message : '余额拉取异常';
      }
    }
  } catch (e) {
    
    result.balance = null;
    result.balance_error = e.message;
    result.partial = true;
    result.errors.push({ component: 'balance', code: e.code || 'balance_error', error: e.message });
  }

  
  try {
    if (result.balance && typeof result.balance.total_yuan === 'number') {
      const { aggregateByDate } = require('../lib/db');
      const rows7 = aggregateByDate(daysAgo(7), daysAgo(1), account);
      const sum7 = rows7.reduce((s, r) => s + num(r.cost), 0);
      result.balance.days_left = (rows7.length > 0 && sum7 > 0)
        ? +(result.balance.total_yuan / (sum7 / rows7.length)).toFixed(1)
        : null;
    }
  } catch (e) {
    if (result.balance) result.balance.days_left = null;
  }

  

  
  
  
  
  
  try {
    
    const {
      fetchUniPromPlanOptional,
      fetchUniPromPlanRecommendations,
      fetchEffectiveDeliveryInfo,
    } = require('../lib/qianchuanTabs');
    const todayStr = today;
    let adInfos;
    let suggestedRoi2GoalMap = {};
    let optionalAdInfos = [];
    let planOptionalRetrievedAt = null;
    let planOptionalError = null;
    const cachedEntry = _cachedAdListMap.get(account);
    
    
    const ADLIST_TTL_MS = 60 * 1000;
    if (cachedEntry && cachedEntry.date === todayStr && (Date.now() - (cachedEntry.fetchedAt || 0)) < ADLIST_TTL_MS) {
      adInfos = cachedEntry.adInfos;
      suggestedRoi2GoalMap = cachedEntry.suggestedRoi2GoalMap || {};
      optionalAdInfos = cachedEntry.optionalAdInfos || [];
      planOptionalRetrievedAt = cachedEntry.planOptionalRetrievedAt || null;
      planOptionalError = cachedEntry.planOptionalError || null;
    } else {
      const adList = await require('../lib/chengfangLive').fetchLivePlanList(today, today, account);
      adInfos = (adList && adList.data && adList.data.adInfos) || [];
      suggestedRoi2GoalMap = (adList && adList.data && adList.data.suggestedRoi2GoalMap) || {};
      const sessionId = adList && adList.data
        && (adList.data.sessionId || adList.data.SessionID || adList.data.sessionID);
      planOptionalRetrievedAt = new Date().toISOString();
      if (Object.keys(suggestedRoi2GoalMap).length > 0) {
        planOptionalError = null;
      } else {
        try {
          const recommendationResult = await fetchUniPromPlanRecommendations(today, today, account);
          suggestedRoi2GoalMap = (recommendationResult && recommendationResult.data
            && recommendationResult.data.suggestedRoi2GoalMap) || {};
        } catch (recommendationError) {
          planOptionalError = recommendationError.code || 'recommendation_unavailable';
        }
      }
      if (sessionId) {
        try {
          const optional = await fetchUniPromPlanOptional(sessionId, account);
          optionalAdInfos = (optional && optional.data && optional.data.adInfos) || [];
          if (Object.keys(suggestedRoi2GoalMap).length === 0) {
            suggestedRoi2GoalMap = (optional && optional.data && optional.data.suggestedRoi2GoalMap) || {};
          }
          if (Object.keys(suggestedRoi2GoalMap).length > 0) planOptionalError = null;
        } catch (optionalError) {
          if (!planOptionalError) planOptionalError = optionalError.code || 'optional_unavailable';
        }
      }
      
      for (const [k, v] of _cachedAdListMap) {
        if (v.date !== todayStr) _cachedAdListMap.delete(k);
      }
      
      if (adInfos.length > 0) _cachedAdListMap.set(account, {
        date: todayStr,
        adInfos,
        suggestedRoi2GoalMap,
        optionalAdInfos,
        planOptionalRetrievedAt,
        planOptionalError,
        fetchedAt: Date.now(),
      });
    }

    

    
    const boostMetrics = await getBoostMetricsToday(account, {
      sessionKey: result.session_key,
      adInfos,
      fetchMaterialDetail: !!(result.live && result.live.isLive),
      isLive: !!(result.live && result.live.isLive), 
      today,
    });
    result.boost_tasks = boostMetrics.tasks;
    result.boost_source_at = boostMetrics.source_at;
    result.boost_data_valid = boostMetrics.data_valid;
    result.boost_window = boostMetrics.window;
    result.boost_truncated = boostMetrics.truncated;
    result.boost_coverage = boostMetrics.coverage;
    result.boost_summary = boostMetrics.summary;
    for (const material of result.materials_top || []) {
      const id = String(material.material_id || material.id || '');
      const linked = result.boost_tasks.filter(task =>
        (id && [task.material_id, ...(task.material_ids || [])].some(value => value != null && String(value) === id))
        || (task.material_name && task.material_name === material.name));
      const running = linked.some(task => /投放中|追投中/.test(task.status || ''));
      const stopped = linked.length > 0 && linked.every(task => /暂停|删除|结束/.test(task.status || ''));
      material.heat_status_verified = boostMetrics.data_valid === true && (running || stopped);
      if (material.heat_status_verified) {
        if (running) material.heatStatus = '追投中';
        else if (material.heatStatus === '追投中') material.heatStatus = '追投已停';
        material.heat_status_source = 'current_boost_tasks';
      }
    }
    const quotaInUseBudget = boostMetrics.quota.in_use;
    const quotaPausedDeletedCost = boostMetrics.quota.paused_deleted_cost;

    
    const boostMaterials = (result.materials_top || []).filter(m => m.heatStatus === '追投中');
    if (boostMaterials.length > 0) {
      result.boost_materials = boostMaterials;
    }

    result.strategy_status = 'not_included';

    
    
    try {
      const todayCostForPlan = (result.today && num(result.today.cost)) || 0;
      const plans = adInfos || [];
      
      
      const configuredPlanId = resolveQcAccount(account)?.primary_ad_id;
      const activePlans = plans.filter(ad => ad.adDeliveryName === '投放中');
      const mainAd = configuredPlanId ? plans.find(ad => String(ad.id) === String(configuredPlanId))
        : activePlans.length === 1 ? activePlans[0] : plans.length === 1 ? plans[0] : null;
      const mainBudgetMicro = mainAd?.budget == null ? null : Number(mainAd.budget);
      const budget = Number.isFinite(mainBudgetMicro) ? +(mainBudgetMicro / 100000).toFixed(2) : null;
      const roiGoal = mainAd ? num(mainAd.ecpRoi2Goal) : null;
      const roiGoalContract = attachRoiGoalContract(mainAd);
      const recommendation = buildPlatformRoiRecommendation(
        mainAd && suggestedRoi2GoalMap[String(mainAd.id)],
        todayStr,
        planOptionalRetrievedAt,
        planOptionalError,
      );
      recommendation.current_roi_goal = roiGoal;
      recommendation.meets_recommendation = roiGoalContract.roi_goal_basis === 'platform_net_1h' && recommendation.data_valid && Number.isFinite(roiGoal)
        ? roiGoal <= recommendation.net_roi_goal
        : null;
      const effectiveCacheKey = `${account}:${mainAd && mainAd.id}`;
      let effectiveDelivery = _effectiveDeliveryCache.get(effectiveCacheKey);
      if (!effectiveDelivery) {
        const effectiveRetrievedAt = new Date().toISOString();
        try {
          const accountConfig = resolveQcAccount(account);
          const response = await fetchEffectiveDeliveryInfo(
            mainAd && mainAd.id,
            accountConfig && accountConfig.anchorId,
            account,
          );
          effectiveDelivery = buildEffectiveDelivery(response, todayStr, effectiveRetrievedAt);
        } catch (effectiveError) {
          effectiveDelivery = buildEffectiveDelivery(
            null,
            todayStr,
            effectiveRetrievedAt,
            effectiveError.code || 'effective_delivery_unavailable',
          );
        }
        _effectiveDeliveryCache.set(effectiveCacheKey, effectiveDelivery);
      }
      const otherPlans = plans.filter(ad => ad !== mainAd)
        .map(ad => ({ name: String(ad.name || ''), roi_goal: num(ad.ecpRoi2Goal), budget: +(num(ad.budget) / 100000).toFixed(2) }));

      let quotaLeft = null;
      let quotaDetail = null;
      let quotaSource = null;
      
      
      try {
        const { fetchBoostQuota } = require('../lib/qianchuan');
        const q = await fetchBoostQuota(mainAd.id, account, { marGoal: num(mainAd.marGoal) || 2 });
        quotaLeft = q.left;
        quotaDetail = { daily: q.total, in_use: q.in_use, used_cost: q.deleted_cost, current_budget: q.current_budget, current_cost: q.current_cost };
        quotaSource = 'api';
      } catch (e) {
        try {
          const { aggregateByDate } = require('../lib/db');
          const rows14 = aggregateByDate(daysAgo(14), daysAgo(1), account);
          
          const activeRows = rows14.filter(r => num(r.cost) > 0);
          const sum14 = activeRows.reduce((s, r) => s + num(r.cost), 0);
          if (activeRows.length > 0 && sum14 > 0) {
            const avg14 = sum14 / activeRows.length;
            const dailyQuota = +(avg14 * 0.3).toFixed(2);
            quotaLeft = Math.max(0, +(dailyQuota - quotaInUseBudget - quotaPausedDeletedCost).toFixed(2));
            quotaDetail = { daily: dailyQuota, in_use: +quotaInUseBudget.toFixed(2), used_cost: +quotaPausedDeletedCost.toFixed(2) };
            quotaSource = 'estimate';
          }
        } catch (e2) {  }
      }

      
      let quotaExceeded = false;
      try {
        const opLog = require('../lib/operationLog');
        const recentFails = opLog.query({ accountId: account, action: 'create_boost', limit: 10 });
        const now = Date.now();
        quotaExceeded = recentFails.some(l => !l.success && (now - new Date(l.ts).getTime()) < 3600000
          && l.result_msg && /额度|预算不足|daily.?budget|exceed|超限|不足/i.test(l.result_msg));
      } catch (e) {  }

      result.plan = {
        source_at: planOptionalRetrievedAt,
        primary_ad_id: mainAd && mainAd.id != null ? String(mainAd.id) : null,
        plan_type: mainAd?.plan_type || (mainAd ? 'uni_live' : null),
        budget,
        spent_pct: (budget && budget > 0) ? +(todayCostForPlan / budget * 100).toFixed(1) : null,
        roi_goal: roiGoal,
        roi_goal_basis: roiGoalContract.roi_goal_basis,
        roi_basis_source: roiGoalContract.roi_basis_source,
        platform_recommendation: recommendation,
        effective_delivery: effectiveDelivery,
        flow_control: (() => {
          const optionalPlan = optionalAdInfos.find(item => String(item.id) === String(mainAd && mainAd.id));
          return require('./flowControl').parseFlowControlState(optionalPlan || mainAd);
        })(),
        boost_count: result.boost_tasks.length,
        
        boost_max: null,
        quota_left: quotaLeft,
        quota_detail: quotaDetail,
        quota_source: quotaSource, 
        quota_exceeded: quotaExceeded, 
        plan_count: plans.length,
        other_plans: otherPlans.length ? otherPlans : undefined, 
      };
    } catch (e) {
      result.plan = null;
    }

  } catch (e) {
    if (e.code === 'cookie_expired' || e.message === 'cookie_expired') throw e;  
    result.boost_error = e.message;
    result.partial = true;
    result.errors.push({ component: 'boost_tasks', code: e.code || 'boost_error', error: e.message });
  }

  result.decisions={redList:[],blackList:[],potentialList:[],strategy_status:'not_included'};

  
  
  
  try {
    const memBase = path.join(__dirname, '..', '..', 'agent-memory');
    let contextPath = path.join(memBase, account, 'context.json');
    if (!fs.existsSync(contextPath)) {
      contextPath = path.join(memBase, 'context.json');
    }
    if (fs.existsSync(contextPath)) {
      const prev = JSON.parse(fs.readFileSync(contextPath, 'utf8'));
      const changes = {};
      if (prev.today && result.today) {
        if (prev.today.cost != null) changes.cost_delta = result.today.cost - prev.today.cost;
        if (prev.today.netRoi != null && result.today.netRoi != null) changes.roi_delta = +(result.today.netRoi - prev.today.netRoi).toFixed(2);
      }
      
      if (prev.boost_tasks && result.boost_tasks.length > 0) {
        changes.boost_changes = [];
        for (const t of result.boost_tasks) {
          const prevTask = prev.boost_tasks.find(p => p.id === t.id);
          if (prevTask) {
            changes.boost_changes.push({
              task_id: t.id,
              name: t.name,
              cost_delta: t.cost - (prevTask.cost || 0),
              roi_delta: t.roi !== 0 || prevTask.roi !== 0 ? +(t.roi - prevTask.roi).toFixed(2) : 0,
            });
          }
        }
      }
      changes.prev_time = prev.time || null;
      result.context = changes;  
    } else {
      result.context = { msg: '首轮运行，无历史对比数据' };
    }
  } catch (e) {
    result.context = { error: e.message };
  }

  

  
  Object.assign(result, require('../lib/liveFreshness').refreshDashboardCore(result, getCollectorData(account)));
  
  if (!result.partial && (result.live?.isLive === false || result.dataValid === true)) {
    cache.set(dashboardCacheKey, result);
  }
  
  const previousSlow = _slowCache.get(account) || {};
  const nextSlow = previousSlow.session_key === result.session_key ? { ...previousSlow } : {};
  nextSlow.session_key = result.session_key;
  if (result.plan) nextSlow.plan = result.plan;
  if (Array.isArray(result.boost_tasks) && !result.boost_error) nextSlow.boost_tasks = result.boost_tasks;
    if (!result.boost_error) for (const key of ['boost_source_at', 'boost_data_valid', 'boost_window', 'boost_truncated', 'boost_coverage']) nextSlow[key] = result[key];
  if (result.boost_summary && !result.boost_error) nextSlow.boost_summary = result.boost_summary;
  if (result.balance && !result.balance_error) nextSlow.balance = result.balance;
  if (result.chengfang && !result.chengfang.error) nextSlow.chengfang = result.chengfang;
  if (result.uni_product && !result.uni_product.error) nextSlow.uni_product = result.uni_product;
  _slowCache.set(account, nextSlow);

  
  if (slimMode) {
    return sendJSON(res, slimDashboard(result, account));
  }

  return sendJSON(res, { ...result, from_cache: false });

  } catch (e) {
    return handleApiError(res, e);
  }
}



function invalidatePlanCache(accountId) {
  if (!accountId) return;
  _cachedAdListMap.delete(accountId);
  _effectiveDeliveryCache.clear();
  const dashboardKey = _dashboardCacheKeyByAccount.get(accountId);
  if (dashboardKey) cache.delete(dashboardKey);
  cache.delete(accountId); 
  _dashboardCacheKeyByAccount.delete(accountId);
  _slowCache.delete(accountId);
  require('../lib/metricsService').invalidateBoostMetrics(accountId);
  const refreshTimes = global.__dashAsyncRefreshTs;
  if (refreshTimes) delete refreshTimes[accountId];
}



function peekPlanCache(accountId) {
  const dashboardKey = _dashboardCacheKeyByAccount.get(accountId);
  const full = dashboardKey ? cache.get(dashboardKey) : null;
  if (full && full.plan) return full.plan;
  const slow = _slowCache.get(accountId);
  return slow && slow.plan ? slow.plan : null;
}

module.exports = handleLiveDashboard;
module.exports.refreshEndedSnapshot = refreshEndedSnapshot;
module.exports.invalidatePlanCache = invalidatePlanCache;
module.exports.peekPlanCache = peekPlanCache;
module.exports._internal = { decisionContextFromProfile, buildPlatformRoiRecommendation, buildEffectiveDelivery };
