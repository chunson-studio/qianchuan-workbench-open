
const fs = require('fs');
const path = require('path');
const { fetchLiveStatus, fetchLiveSessions, fetchBoostTaskReport, fetchLiveMaterials } = require('./qianchuanTabs');
const { fetchLiveBoard, fetchLiveCore, fetchBoardModule, fetchFlowTotals } = require('./liveBoard');
const { MaterialChanges, materialFrame } = require('./materialChanges');
const materialChanges = new MaterialChanges();
const { componentTimes, mergeCoreRecord } = require('./liveFreshness');
const { qcError } = require('./qianchuan');
const { getLocalDateStr } = require('./utils');
const { SCHEDULER, QIANCHUAN_ACCOUNTS, CACHE_DIR } = require('./config');
const { aggregateFunnelRows, evaluateFunnel } = require('./materialFunnel');
const { loadStableFunnelContext, shiftDate } = require('./materialFunnelStore');
const { normalizeChannels, buildLiveFinancialBasis } = require('./decisionContext');
const { getDB } = require('./db');



const latestByAccount = {};  
const latestLiveStates = {}; 


const flowSamplesByAccount = new Map();
const boardFlights = new Map();
const coreFlights = new Map();
const latestCoreByAccount = new Map();
const onDemandFlights = new Map();
const trendFlights = new Map();
const trendReads = new Map();
const endedReadFlights = new Map();
const endedReadAttempts = new Map();


async function ensureEndedWatch(accountId, room, options = {}) {
  if (!room?.roomId || !room.startTime || !room.endTime || String(room.status) !== '4' || latestLiveStates[accountId]?.isLive !== false) return;
  const key = makeSessionKey(accountId, room);
  const cacheFile = path.join(CACHE_DIR, 'ended-board', `${accountId}.json`);
  if (latestByAccount[accountId]?.sessionKey !== key) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (cached.sessionKey === key && cached.record?.dataValid) latestByAccount[accountId] = cached;
    } catch {}
  }
  if (options.restoreOnly) return;
  const previous = endedReadAttempts.get(accountId);
  if (endedReadFlights.get(accountId)?.key === key) return endedReadFlights.get(accountId).promise.catch(() => {});
  if (previous?.key === key && Date.now() - previous.at < 300000) return;
  endedReadAttempts.set(accountId, { key, at: Date.now() });
  return singleFlight(endedReadFlights, accountId, key, 25000, 'ended_snapshot', async signal => {
    const init = await fetchBoardModule('init', room.roomId, null, room.startTime, accountId, room.endTime, signal);
    const anchorId = init.rows?.[0]?.Dimensions?.room_with_anchor_id?.Value;
    if (!anchorId) throw qcError('core_anchor_missing', '终场数据缺少主播标识');
    const names = { metrics: 'commonMetricCard', trend: 'totalTrend', funnel: 'funnelModule', channels: 'sourceChannel' };
    const parts = await Promise.all(Object.entries(names).map(async ([key, name]) => [key,
      await fetchBoardModule(name, room.roomId, anchorId, room.startTime, accountId, room.endTime, signal)]));
    if (signal.aborted) throw signal.reason;
    if (latestLiveStates[accountId]?.isLive !== false) throw qcError('stale_session_result', '已重新开播，丢弃旧场次回补');
    const record = assembleRecord({ init, ...Object.fromEntries(parts) }, { ...room, anchorId }, accountId, accountId);
    if (!record.dataValid) throw qcError('core_data_invalid', '终场数据不完整');
    const snapshot = { record, sessionKey: key, fetchedAt: record.component_times.core.source_at,
      decisions: { redList: [], blackList: [], potentialList: [] } };
    latestByAccount[accountId] = snapshot;
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    require('./api-helpers').writeJsonAtomic(cacheFile, snapshot);
  }).catch(() => {});
}
const insightFlights = new Map();
const insightReads = new Map();

async function ensureLiveInsights(accountId) {
  if (process.env.QC_DISABLE_BACKGROUND !== '1') return;
  await ensureLiveWatch(accountId);
  const latest = latestByAccount[accountId];
  if (latestLiveStates[accountId]?.isLive !== true || !latest?.record?.room?.anchor_id) return;
  const key = latest.sessionKey;
  if (insightFlights.get(accountId)?.key === key) return insightFlights.get(accountId).promise.catch(() => {});
  let state = insightReads.get(accountId);
  if (!state || state.key !== key) {
    state = { key, at: 0, parts: {} };
    insightReads.set(accountId, state);
  }
  if (Date.now() - state.at < 60000) return;
  state.at = Date.now();
  const room = latest.record.room;
  return singleFlight(insightFlights, accountId, key, 15000, 'on_demand_insights', async signal => {
    await Promise.all(['funnelModule', 'sourceChannel'].map(async name => {
      const part = await fetchBoardModule(name, room.room_id, room.anchor_id, room.start_time, accountId, null, signal);
      if (signal.aborted) throw signal.reason;
      if (latestByAccount[accountId]?.sessionKey !== key) throw qcError('stale_session_result', '漏斗渠道采集期间场次已变化');
      state.parts[name === 'funnelModule' ? 'funnel' : 'channels'] = part;
    }));
  }).catch(() => {});
}
const flowReadFlights = new Map();
const flowReadAttempts = new Map();

async function ensureLiveFlow(accountId) {
  if (process.env.QC_DISABLE_BACKGROUND !== '1') return;
  await ensureLiveWatch(accountId);
  const latest = latestByAccount[accountId];
  if (latestLiveStates[accountId]?.isLive !== true || !latest?.record?.dataValid || !latest.record.room?.anchor_id) return;
  const key = latest.sessionKey;
  if (flowReadFlights.get(accountId)?.key === key) return flowReadFlights.get(accountId).promise.catch(() => {});
  const previous = flowReadAttempts.get(accountId);
  if (previous?.key === key && Date.now() - previous.at < 60000) return;
  flowReadAttempts.set(accountId, { key, at: Date.now() });
  return singleFlight(flowReadFlights, accountId, key, 12000, 'on_demand_flow', async signal => {
    const totals = await fetchFlowTotals(latest.record.room, accountId, signal);
    if (signal.aborted) throw signal.reason;
    if (latestByAccount[accountId]?.sessionKey !== key) throw qcError('stale_session_result', '流速采样期间场次已变化');
    const assist = metricValueOrNull(totals, 'stat_cost_for_roi2_assist');
    if (assist == null) throw qcError('flow_split_missing', '追投累计消耗缺失，不能补零');
    
    recordFlowSample(accountId, key, { ...latest.record.live_metrics, assistCost: assist }, new Date().toISOString());
  }).catch(() => {});
}


async function ensureLiveTrend(accountId) {
  if (process.env.QC_DISABLE_BACKGROUND !== '1') return;
  await ensureLiveWatch(accountId);
  const latest = latestByAccount[accountId];
  if (latestLiveStates[accountId]?.isLive !== true || !latest?.record?.room?.anchor_id) return;
  const key = latest.sessionKey;
  if (trendFlights.get(accountId)?.key === key) return trendFlights.get(accountId).promise.catch(() => {});
  let state = trendReads.get(accountId);
  if (!state || state.sessionKey !== key) {
    state = { sessionKey: key, attemptedAt: 0, trend: [], sourceAt: null, error: null };
    trendReads.set(accountId, state);
  }
  if (Date.now() - state.attemptedAt < 60000) return;
  state.attemptedAt = Date.now();
  const room = latest.record.room;
  return singleFlight(trendFlights, accountId, key, 12000, 'on_demand_trend', async signal => {
    const part = await fetchBoardModule('totalTrend', room.room_id, room.anchor_id, room.start_time, accountId, null, signal);
    if (signal.aborted) throw signal.reason;
    if (latestByAccount[accountId]?.sessionKey !== key) throw qcError('stale_session_result', '趋势采集期间场次已变化');
    state.trend = mapTrendRows(part.rows || []);
    state.sourceAt = part.source_at;
    state.error = null;
  }).catch(error => {
    state.error = { code: error.code || 'upstream_error', component: 'trend', message: error.message };
  });
}

function mapTrendRows(rows) {
  return rows.map(r => ({
    time: dv(r.Dimensions, 'stat_time_5_minute'),
    gmvSettle: metricValueOrNull(r.Metrics, 'total_order_settle_amount_realtime_for_roi2_1h'),
    cost: metricValueOrNull(r.Metrics, 'stat_real_cost_for_roi2'),
    netDataValid: metricValid(r.Metrics, 'total_order_settle_amount_realtime_for_roi2_1h'),
    costDataValid: metricValid(r.Metrics, 'stat_real_cost_for_roi2'),
  })).sort((a, b) => String(a.time).localeCompare(String(b.time)));
}
const onDemandAttempts = new Map();
const intradayFlights = new Map();
const collectorRuntime = { startedAt: null, intervalMs: null, accounts: {} };
let activeCollector = null;
const BOARD_DEADLINE_MS = 55 * 1000;
const INTRADAY_DEADLINE_MS = 90 * 1000;
const WATCHDOG_INTERVAL_MS = 30 * 1000;
const WATCHDOG_RECOVERY_COOLDOWN_MS = 2 * 60 * 1000;
const FLOW_SAMPLE_KEEP_MS = 6 * 60 * 60 * 1000;
const FLOW_SAMPLE_MAX = 900;

const NON_RESTARTABLE_CODES = new Set([
  'cookie_expired', 'rate_limited', 'upstream_locked', 'upstream_bad_request',
  'upstream_unavailable', 'upstream_forbidden', 'upstream_timeout', 'queue_timeout', 'db_busy', 'SQLITE_BUSY',
]);

function isCollectorQuietHour(date = new Date()) {
  const hour = date.getHours();
  return hour >= 22 || hour < 7;
}

function getStartupTickOptions(date = new Date()) {
  return {
    ignoreQuietHours: true,
    
    
    statusOnly: isCollectorQuietHour(date),
  };
}

function assessCollectorWatch(watch, options = {}) {
  const quietHours = options.quietHours === true;
  if (!watch) {
    return {
      ready: false,
      code: 'collector_not_started',
      state: 'unavailable',
      retryable: true,
      restart_recommended: true,
    };
  }

  if (watch.cookieExpired === true) {
    return {
      ready: false,
      code: 'cookie_expired',
      state: 'auth_required',
      retryable: false,
      restart_recommended: false,
    };
  }

  const errorCodes = [
    watch.liveStateError,
    ...(watch.errors || []).map(error => typeof error === 'string' ? error : error && error.code),
  ].filter(Boolean);
  const nonRestartable = errorCodes.find(code => NON_RESTARTABLE_CODES.has(code));
  if (nonRestartable) {
    return {
      ready: false,
      code: nonRestartable,
      state: 'degraded',
      retryable: nonRestartable !== 'cookie_expired' && nonRestartable !== 'upstream_bad_request',
      restart_recommended: false,
    };
  }

  
  if (quietHours && watch.isLive === false && watch.liveCheckedAt) {
    return {
      ready: true,
      code: 'offline_quiet',
      state: 'offline',
      retryable: false,
      restart_recommended: false,
    };
  }

  if (watch.status_stale === true || !watch.liveCheckedAt) {
    return {
      ready: false,
      code: 'collector_status_stale',
      state: 'stale',
      retryable: true,
      restart_recommended: true,
    };
  }

  if (watch.isLive !== true) {
    return {
      ready: true,
      code: 'offline',
      state: 'offline',
      retryable: false,
      restart_recommended: false,
    };
  }

  if (watch.requires_room_selection === true) {
    return { ready: false, code: 'live_room_required', state: 'room_selection_required',
      retryable: false, restart_recommended: false };
  }

  if (watch.collecting === true && (watch.fetchedAt == null || watch.data_stale === true)) {
    return {
      ready: false,
      code: 'collector_collecting',
      state: 'recovering',
      retryable: true,
      restart_recommended: false,
    };
  }

  if (watch.data_stale === true || !watch.fetchedAt || watch.dataValid !== true) {
    return {
      ready: false,
      code: watch.data_stale === true ? 'collector_data_stale' : 'collector_data_unavailable',
      state: 'stale',
      retryable: true,
      restart_recommended: true,
    };
  }

  return {
    ready: true,
    code: 'ready',
    state: 'live',
    retryable: false,
    restart_recommended: false,
  };
}

function makeSessionKey(accountId, room) {
  return `${accountId || '_default'}|${room?.roomId ?? ''}|${room?.startTime ?? ''}`;
}

function resetFlowSamples(accountId, sessionKey = null) {
  if (!accountId) return;
  if (sessionKey == null) flowSamplesByAccount.delete(accountId);
  else flowSamplesByAccount.set(accountId, { sessionKey, samples: [] });
}

function recordFlowSample(accountId, sessionKey, liveMetrics, sampledAt = new Date().toISOString()) {
  const metrics = liveMetrics || {};
  if (!accountId || !sessionKey || metrics.costDataValid !== true) return false;
  if (metrics.cost == null || metrics.assistCost == null) return false;
  const totalCost = Number(metrics.cost);
  const rawAssistCost = Number(metrics.assistCost);
  if (!Number.isFinite(totalCost) || totalCost < 0 || !Number.isFinite(rawAssistCost) || rawAssistCost < 0) return false;
  const ts = Date.parse(sampledAt);
  if (!Number.isFinite(ts)) return false;

  let state = flowSamplesByAccount.get(accountId);
  if (!state || state.sessionKey !== sessionKey) {
    state = { sessionKey, samples: [] };
    flowSamplesByAccount.set(accountId, state);
  }

  
  
  const rawWentBack = Number.isFinite(state.lastTotalCost) && (
    totalCost < state.lastTotalCost - 0.5 || rawAssistCost < state.lastRawAssistCost - 0.5
  );
  if (rawWentBack) {
    state.samples = [];
  }
  const assistCost = rawAssistCost;
  const basicCost = totalCost - rawAssistCost;

  const last = state.samples[state.samples.length - 1];
  if (last && last.ts === ts) state.samples[state.samples.length - 1] = { ts, at: sampledAt, totalCost, basicCost, assistCost };
  else state.samples.push({ ts, at: sampledAt, totalCost, basicCost, assistCost });

  try {
    const db = getDB();
    db.prepare(`
      INSERT OR REPLACE INTO live_flow_samples
        (account_id, session_key, sample_time, total_cost, assist_cost)
      VALUES (?, ?, ?, ?, ?)
    `).run(accountId, sessionKey, sampledAt, totalCost, rawAssistCost);
    db.prepare('DELETE FROM live_flow_samples WHERE sample_time < ?')
      .run(new Date(ts - FLOW_SAMPLE_KEEP_MS).toISOString());
  } catch (error) {
    console.warn(`[flow-samples] 持久化失败，继续使用内存采样: ${error.message}`);
  }

  state.lastTotalCost = totalCost;
  state.lastRawAssistCost = rawAssistCost;

  const cutoff = ts - FLOW_SAMPLE_KEEP_MS;
  state.samples = state.samples.filter(sample => sample.ts >= cutoff).slice(-FLOW_SAMPLE_MAX);
  return true;
}

function singleFlight(map, accountId, key, timeoutMs, component, task) {
  const existing = map.get(accountId);
  if (existing && existing.key === key) return existing.promise;
  if (existing && !existing.controller.signal.aborted) {
    existing.controller.abort(qcError('session_changed', '直播场次已切换，取消旧采集', {
      statusCode: 409, retryable: true, component,
    }));
  }

  const controller = new AbortController();
  const timeoutError = qcError(`${component}_timeout`, `${component} 超过 ${timeoutMs}ms`, {
    statusCode: 504, retryable: true, timeoutMs, component,
  });
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  timer.unref?.();
  let abortListener;
  const abortPromise = new Promise((_, reject) => {
    abortListener = () => reject(controller.signal.reason || timeoutError);
    controller.signal.addEventListener('abort', abortListener, { once: true });
  });
  const entry = { key, controller, startedAt: Date.now(), promise: null };
  const promise = Promise.race([
    Promise.resolve().then(() => task(controller.signal)),
    abortPromise,
  ]).then(result => {
    const state = collectorRuntime.accounts[accountId] || (collectorRuntime.accounts[accountId] = {});
    state.components = state.components || {};
    state.components[component] = { lastSuccessAt: new Date().toISOString(), lastError: null };
    state.lastSuccessAt = new Date().toISOString();
    state.lastError = null;
    return result;
  }).catch(err => {
    const state = collectorRuntime.accounts[accountId] || (collectorRuntime.accounts[accountId] = {});
    state.components = state.components || {};
    state.components[component] = { ...state.components[component], lastErrorAt: new Date().toISOString(),
      lastError: { component, code: err.code || `${component}_error`, error: err.message } };
    state.lastErrorAt = new Date().toISOString();
    state.lastError = { component, code: err.code || `${component}_error`, error: err.message };
    throw err;
  }).finally(() => {
    clearTimeout(timer);
    if (abortListener) controller.signal.removeEventListener('abort', abortListener);
    if (map.get(accountId) === entry) map.delete(accountId);
  });
  entry.promise = promise;
  map.set(accountId, entry);
  return promise;
}

function runBoardSingleFlight(accountId, room, task, timeoutMs = BOARD_DEADLINE_MS) {
  return singleFlight(boardFlights, accountId, makeSessionKey(accountId, room), timeoutMs, 'collector_board', task);
}

function collectCoreSession(room, accountId, accountName) {
  const key = makeSessionKey(accountId, room);
  return singleFlight(coreFlights, accountId, key, 20000, 'collector_core', async signal => {
    const account = QIANCHUAN_ACCOUNTS.find(a => a.id === accountId);
    const board = await fetchLiveCore(room.roomId, room.anchorId || account?.anchorId, room.startTime, accountId, { signal });
    const record = assembleRecord(board, room, accountName, accountId);
    if (signal.aborted) throw signal.reason;
    const live = latestLiveStates[accountId];
    if (live?.isLive !== true || makeSessionKey(accountId, live) !== key) {
      throw qcError('stale_session_result', '核心采集期间场次或直播状态已变化', { component: 'collector_core' });
    }
    if (!record.dataValid) throw qcError('core_data_invalid', '核心金额字段缺失，保留旧值及原采集时间', { component: 'collector_core' });
    latestCoreByAccount.set(accountId, { record, sessionKey: key, fetchedAt: record.component_times.core.source_at });
    return record;
  });
}


function applyLiveStatus(accountId, status, checkedAt) {
  const room = status.rooms.length === 1 ? status.rooms[0] : null;
  latestLiveStates[accountId] = {
    isLive: status.isLive, checkedAt,
    roomId: room ? String(room.roomId) : null, startTime: room?.startTime || null,
    available_rooms: status.rooms,
  };
  if (status.rooms.length > 1) {
    
    delete latestByAccount[accountId];
    latestCoreByAccount.delete(accountId);
  }
  return room;
}



async function ensureLiveWatch(accountId) {
  if (process.env.QC_DISABLE_BACKGROUND !== '1') return;
  const account = QIANCHUAN_ACCOUNTS.find(a => a.id === accountId);
  if (!account) throw qcError('invalid_account', '账户不存在', { statusCode: 400 });
  const flight = onDemandFlights.get(accountId);
  if (flight) return flight.promise.catch(() => {});
  const previous = onDemandAttempts.get(accountId);
  if (previous && Date.now() - previous.at < (previous.ok ? (latestLiveStates[accountId]?.isLive === false ? 30000 : 10000) : previous.retryAfterMs || 5000)) return;
  const attempt = { at: Date.now(), ok: false };
  onDemandAttempts.set(accountId, attempt);
  return singleFlight(onDemandFlights, accountId, 'read', 25000, 'on_demand_core', async signal => {
    let status;
    try {
      status = await fetchLiveStatus(accountId, { signal, priority: 1 });
      require('./liveRoomContext').verifyLiveStatus(status);
    } catch (error) {
      if (!signal.aborted) {
        
        latestLiveStates[accountId] = { ...latestLiveStates[accountId], isLive: null, error: error.message,
          available_rooms: error.details?.rooms || [] };
      }
      throw error;
    }
    if (signal.aborted) throw signal.reason;
    const checkedAt = new Date().toISOString();
    const selected = applyLiveStatus(accountId, status, checkedAt);
    if (selected) {
      const room = { ...selected, status: '2' };
      const key = makeSessionKey(accountId, room);
      if (latestByAccount[accountId]?.sessionKey !== key) {
        latestByAccount[accountId] = buildSessionSkeleton(room, accountId);
        latestCoreByAccount.delete(accountId);
      }
      
      room.anchorId = account.anchorId || latestByAccount[accountId]?.record?.room?.anchor_id;
      const board = await fetchLiveCore(room.roomId, room.anchorId, room.startTime, accountId, { signal });
      if (signal.aborted) throw signal.reason;
      const record = assembleRecord(board, { ...room, anchorId: board.anchorId }, account.name, accountId);
      if (!record.dataValid) throw qcError('core_data_invalid', '核心金额字段缺失，保留上次可信值和采集时间');
      latestByAccount[accountId] = { record, sessionKey: key, fetchedAt: record.collected_at,
        decisions: { redList: [], blackList: [], potentialList: [] } };
    }
    attempt.ok = true;
    attempt.at = Date.now();
  }).catch(error => {
    
    attempt.at = Date.now();
    attempt.retryAfterMs = ['cookie_expired', 'upstream_forbidden', 'rate_limited'].includes(error.code) ? 60000 : 5000;
  });
}


function mv(m, key) {
  const v = m && m[key];
  if (!v) return 0;
  const n = Number(v.Value);
  return isFinite(n) ? n : 0;
}
function metricValid(m, key) {
  const cell = m && m[key];
  if (!cell) return false;
  const raw = cell.Value != null ? cell.Value : cell.value;
  return raw != null && raw !== '' && Number.isFinite(Number(raw));
}
function metricValueOrNull(m, key) {
  if (!metricValid(m, key)) return null;
  const cell = m[key];
  return Number(cell.Value != null ? cell.Value : cell.value);
}
function dv(d, key) {
  const v = d && d[key];
  if (!v) return '';
  return v.ValueStr || v.Value || '';
}

function pad2(n) { return String(n).padStart(2, '0'); }
function nowDateStr() {
  const d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}
function nowTimeStr() {
  const d = new Date();
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}


function assembleRecord(board, room, accountName, accountId) {
  const initRow = board.init && board.init.rows && board.init.rows[0];
  const initDims = (initRow && initRow.Dimensions) || {};

  
  const metricRow = board.metrics && board.metrics.rows && board.metrics.rows[0];
  const mm = (metricRow && metricRow.Metrics) || {};
  const cost = mv(mm, 'stat_cost_for_roi2');
  
  
  
  const materialGroups = board.materials || {};
  const assistTotals = ['video', 'live', 'carousel']
    .map(kind => materialGroups[kind] && materialGroups[kind].totals)
    .filter(totals => metricValid(totals, 'stat_cost_for_roi2_assist'));
  const assistCost = assistTotals.length
    ? assistTotals.reduce((sum, totals) => sum + mv(totals, 'stat_cost_for_roi2_assist'), 0)
    : mv(mm, 'stat_cost_for_roi2_assist');
  
  
  
  
  
  const live_metrics = {
    gmv: mv(mm, 'total_pay_order_gmv_realtime_for_roi2'),                      
    gmvSettle: mv(mm, 'total_order_settle_amount_realtime_for_roi2_1h'),       
    netDataValid:
      metricValid(mm, 'total_order_settle_amount_realtime_for_roi2_1h') &&
      metricValid(mm, 'total_order_settle_count_realtime_for_roi2_1h'),
    costDataValid: metricValid(mm, 'stat_cost_for_roi2'),
    cost,                                                                       
    basicCost: Math.max(0, cost - assistCost),                                  
    assistCost,                                                                 
    roi: mv(mm, 'total_prepay_and_pay_order_realtime_roi2'),                   
    roiSettle: mv(mm, 'total_prepay_and_pay_settle_realtime_roi2_1h'),         
    online: mv(mm, 'room_pack_online_user_count'),                             
    watchUcount: mv(mm, 'live_watch_ucount_for_roi2'),                         
    gpm: mv(mm, 'total_live_pay_order_gpm_realtime_for_roi2'),                 
    orders: mv(mm, 'total_order_settle_count_realtime_for_roi2_1h'),          
    ordersPay: mv(mm, 'total_pay_order_count_realtime_for_roi2'),             
    watchToPayRate: mv(mm, 'live_watch_to_pay_rate_for_roi2'),                
    showToWatchRate: mv(mm, 'total_show_to_watch_rate_for_roi2'),             
    orderCost: mv(mm, 'total_cost_per_pay_order_settle_realtime_for_roi2_1h'),
    roiBasis: { roi: 'payment', roiSettle: 'platform_net_1h' },
    settlementWindow: '1h',
    financialBasis: buildLiveFinancialBasis(),
  };

  
  const trendRows = (board.trend && board.trend.rows) || [];
  const trend = mapTrendRows(trendRows);

  
  const funnelRow = board.funnel && board.funnel.rows && board.funnel.rows[0];
  const fm = (funnelRow && funnelRow.Metrics) || {};
  const funnelKeys = {
    show: 'live_show_count_for_roi2',
    watch: 'live_watch_count_for_roi2',
    click: 'live_product_click_count_for_roi2',
    order: 'total_pay_order_count_for_roi2',
    showToWatchRate: 'total_show_to_watch_rate_for_roi2',
    watchToClickRate: 'total_watch_to_product_click_rate_for_roi2',
    watchToPayRate: 'total_watch_to_pay_rate_realtime_for_roi2',
    clickToPayRate: 'total_product_click_to_pay_rate_realtime_for_roi2',
  };
  const funnelFieldValidity = Object.fromEntries(
    Object.entries(funnelKeys).map(([name, key]) => [name, metricValid(fm, key)]),
  );
  const funnelValidCount = Object.values(funnelFieldValidity).filter(Boolean).length;
  const funnel = {
    show: metricValueOrNull(fm, funnelKeys.show),
    watch: metricValueOrNull(fm, funnelKeys.watch),
    click: metricValueOrNull(fm, funnelKeys.click),
    order: metricValueOrNull(fm, funnelKeys.order),
    showToWatchRate: metricValueOrNull(fm, funnelKeys.showToWatchRate),
    watchToClickRate: metricValueOrNull(fm, funnelKeys.watchToClickRate),
    watchToPayRate: metricValueOrNull(fm, funnelKeys.watchToPayRate),
    clickToPayRate: metricValueOrNull(fm, funnelKeys.clickToPayRate),
    fieldValidity: funnelFieldValidity,
    dataValid: funnelValidCount === Object.keys(funnelKeys).length,
    dataQuality: funnelValidCount === 0
      ? 'unavailable'
      : (funnelValidCount === Object.keys(funnelKeys).length ? 'complete' : 'partial'),
    missing: Object.entries(funnelFieldValidity).filter(([, valid]) => !valid).map(([name]) => name),
    source_at: board.funnel?.source_at || board.fetched_at || null,
    window: 'current_session',
  };

  
  const channelRows = (board.channels && board.channels.rows) || [];
  const source = channelRows.map(r => {
    const channel = dv(r.Dimensions, 'combined_first_compass_entrance_code');
    const watchValid = metricValid(r.Metrics, 'total_live_watch_cnt_for_roi2');
    const payAmountValid = metricValid(r.Metrics, 'total_live_pay_amt_for_roi2');
    return {
      channel,
      watch: metricValueOrNull(r.Metrics, 'total_live_watch_cnt_for_roi2'),
      pay: metricValueOrNull(r.Metrics, 'total_live_pay_amt_for_roi2'),
      
      
      dataValid: !!channel && (watchValid || payAmountValid),
      fieldValidity: { watch: watchValid, pay: payAmountValid },
    };
  }).sort((a, b) => (b.pay == null ? -Infinity : b.pay) - (a.pay == null ? -Infinity : a.pay));
  const channels = normalizeChannels(source, {
    sourceAt: board.channels?.source_at || board.fetched_at || null,
    window: 'current_session',
  });

  
  const matNameKeys = { video: 'roi2_material_video_name', carousel: 'roi2_material_image_agg_name', live: 'room_name' };
  
  
  const materialMetric = (metrics, key) => {
    const cell = metrics && metrics[key];
    const raw = cell && typeof cell === 'object' ? (cell.Value ?? cell.value ?? cell.ValueStr) : cell;
    if (raw == null || String(raw).trim() === '') return null;
    const parsed = Number(String(raw).trim().replace(/,/g, '').replace(/%$/, ''));
    return Number.isFinite(parsed) ? parsed : null;
  };
  function enrichMatRows(rows, nameKey) {
    return (rows || []).map(r => {
      const d = r.Dimensions || {};
      const m = r.Metrics || {};
      const c = mv(m, 'stat_cost_for_roi2');
      const ac = mv(m, 'stat_cost_for_roi2_assist');
      return {
        material_id: dv(d, 'material_id'),
        name: dv(d, nameKey) || dv(d, 'material_id'),
        type: dv(d, 'roi2_material_type_mix_v3'),
        heatStatus: dv(d, 'material_heat_status_v2'),
        status: dv(d, 'roi2_material_status'),
        uploadTime: dv(d, 'roi2_material_upload_time'),
        cost: c,
        basicCost: Math.max(0, c - ac),
        assistCost: ac,
        gmv: mv(m, 'total_pay_order_gmv_include_coupon_realtime_for_roi2'),
        gmvSettle: mv(m, 'total_order_settle_amount_realtime_for_roi2_1h'),
        roi: mv(m, 'total_prepay_and_pay_order_realtime_roi2'),
        roiSettle: mv(m, 'total_prepay_and_pay_settle_realtime_roi2_1h'),
        orders: mv(m, 'total_pay_order_count_realtime_for_roi2'),
        cvr: mv(m, 'total_pay_order_gmv_include_coupon_rate_realtime_for_roi2'),
        shows: mv(m, 'live_show_count_for_roi2_v2'),
        clicks: materialMetric(m, 'live_watch_count_for_roi2_v2'),
        cpc: materialMetric(m, 'total_cpc_for_roi2'),
        clickRate: materialMetric(m, 'live_cvr_rate_for_roi2_v2'),
        convertRate: mv(m, 'live_convert_rate_for_roi2_v2'),
      };
    });
  }
  const materials = {
    video: enrichMatRows(board.materials && board.materials.video && board.materials.video.rows, matNameKeys.video),
    live: enrichMatRows(board.materials && board.materials.live && board.materials.live.rows, matNameKeys.live),
    carousel: enrichMatRows(board.materials && board.materials.carousel && board.materials.carousel.rows, matNameKeys.carousel),
  };

  
  
  const riskAlerts = [];

  const now = new Date();
  const session = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日${pad2(now.getHours())}时${pad2(now.getMinutes())}分`;
  const outputMetrics = { ...live_metrics };
  
  const optionalCore = { gmv: 'total_pay_order_gmv_realtime_for_roi2', roi: 'total_prepay_and_pay_order_realtime_roi2',
    roiSettle: 'total_prepay_and_pay_settle_realtime_roi2_1h', online: 'room_pack_online_user_count',
    watchUcount: 'live_watch_ucount_for_roi2', gpm: 'total_live_pay_order_gpm_realtime_for_roi2',
    ordersPay: 'total_pay_order_count_realtime_for_roi2', watchToPayRate: 'live_watch_to_pay_rate_for_roi2',
    showToWatchRate: 'total_show_to_watch_rate_for_roi2', orderCost: 'total_cost_per_pay_order_settle_realtime_for_roi2_1h' };
  for (const [name, key] of Object.entries(optionalCore)) outputMetrics[name] = metricValueOrNull(mm, key);
  if (board.core_only) {
    outputMetrics.basicCost = null;
    outputMetrics.assistCost = null;
    outputMetrics.splitDataValid = false;
  }
  if (!outputMetrics.netDataValid) {
    outputMetrics.gmvSettle = null;
    outputMetrics.roiSettle = null;
    outputMetrics.orders = null;
    outputMetrics.orderCost = null;
  }
  if (!outputMetrics.costDataValid) {
    outputMetrics.cost = null;
    outputMetrics.basicCost = null;
    outputMetrics.assistCost = null;
    outputMetrics.roi = null;
  }
  const dataValid = outputMetrics.netDataValid === true && outputMetrics.costDataValid === true;

  return {
    session,
    session_key: makeSessionKey(accountId, room),
    account: accountName || '',
    room: {
      room_id: room.roomId,
      room_name: room.roomName || dv(initDims, 'room_name'),
      anchor_id: dv(initDims, 'room_with_anchor_id') || room.anchorId || '',
      start_time: room.startTime || dv(initDims, 'room_start_time'),
      end_time: room.endTime || dv(initDims, 'room_end_time') || null,
      status: (() => {
        
        const s = room.status != null ? room.status : dv(initDims, 'room_status');
        if (s === 2 || s === '2') return '直播中';
        if (s === 4 || s === '4') return '已结束';
        return null; 
      })(),
    },
    live_metrics: outputMetrics,
    dataValid,
    partial: board.partial === true,
    errors: board.errors || [],
    source_type: 'live_board',
    component_times: componentTimes(board),
    trend,
    funnel,
    source,
    channels,
    materials,
    material_frame: board.core_only ? null : materialFrame(board, room, makeSessionKey(accountId, room)),
    riskAlerts,
    collected_at: board.metrics?.source_at || board.fetched_at || new Date().toISOString(),
  };
}


function fmt(n) {
  if (n === null || n === undefined) return '--';
  const x = Number(n);
  if (!isFinite(x)) return '--';
  if (Math.abs(x) >= 10000) return (x / 10000).toFixed(2) + 'w';
  return Number.isInteger(x) ? x.toLocaleString() : x.toFixed(2);
}
function pct(n) {
  const x = Number(n);
  if (!isFinite(x)) return '--';
  return x.toFixed(2) + '%';
}


async function collectLive(room, accountId, accountName, signal) {
  
  const board = await fetchLiveBoard(room.roomId, undefined, room.startTime, accountId, undefined, { signal });
  if (board.partial || !board.dataValid) {
    const err = qcError('board_partial', '直播大屏子模块失败，保留上一成功帧', {
      statusCode: 502, retryable: true, component: 'collector_board',
    });
    err.errors = board.errors || [];
    throw err;
  }
  const record = assembleRecord(board, room, accountName, accountId);
  if (!record.dataValid) {
    const err = qcError('board_data_invalid', '直播大屏核心金额字段缺失，拒绝覆盖成功缓存', {
      statusCode: 502, retryable: true, component: 'collector_board',
    });
    err.errors = [{ component: 'commonMetricCard', code: 'missing_core_metrics', error: '净成交或消耗字段缺失' }];
    throw err;
  }
  return { record };
}




function scanDecisionsFromLive() { return {redList:[],blackList:[],potentialList:[],strategy_status:'not_included'}; }


async function scanDecisions(accountId) {
  return scanDecisionsFromLive(accountId);
}



const { checkBoostStopLoss } = require('./boostGuard');


function collectSession(room, accountId, accountName) {
  const expectedSessionKey = makeSessionKey(accountId, room);
  return runBoardSingleFlight(accountId, room, async signal => {
    const r = await collectLive(room, accountId, accountName, signal);
    if (signal.aborted) throw signal.reason;
    const live = latestLiveStates[accountId];
    if (live && live.isLive && makeSessionKey(accountId, { roomId: live.roomId, startTime: live.startTime }) !== expectedSessionKey) {
      throw qcError('stale_session_result', '旧场次采集结果已丢弃', {
        statusCode: 409, retryable: true, component: 'collector_board',
      });
    }
    if (live && live.isLive && r.record.room) r.record.room.status = '直播中';
    r.record.collecting = false;
    const sampledAt = r.record.collected_at || new Date().toISOString();
    recordFlowSample(accountId, expectedSessionKey, r.record.live_metrics, sampledAt);
    materialChanges.ingest(accountId, r.record.material_frame);
    
    latestByAccount[accountId] = {
      record: r.record,
      decisions: { redList: [], blackList: [], potentialList: [], error: null },
      fetchedAt: r.record.collected_at,
      sessionKey: expectedSessionKey,
    };
    const decisions = scanDecisionsFromLive(accountId);
    r.record.decisions = decisions;
    latestByAccount[accountId].decisions = decisions;
    return r;
  });
}

async function collectAndAdvise(room, accountId, accountName) {
  const r = await collectSession(room, accountId, accountName);


  checkBoostStopLoss(accountId, accountName).catch(e => console.error(`[boostGuard] ${accountName} 巡检异常:`, e.message));
  
  const { checkMaterialBleeding } = require('./boostGuard');
  checkMaterialBleeding(accountId, accountName, latestByAccount[accountId] && latestByAccount[accountId].record).catch(e => console.error(`[bleedGate] ${accountName} 评估异常:`, e.message));

  
  const { checkFlowGuard } = require('./flowGuard');
  checkFlowGuard(accountId, accountName, latestByAccount[accountId] && latestByAccount[accountId].record).catch(e => console.error(`[flowGuard] ${accountName} 巡检异常:`, e.message));
  return r;
}


async function collectEndedSession(roomId, accountId, accountName) {
  const today = nowDateStr();
  let sess = await fetchLiveSessions(today, { status: '4', accountId });
  let s = (sess.sessions || []).find(x => x.roomId === roomId);
  if (!s) {
    
    const y = new Date();
    y.setDate(y.getDate() - 1);
    const yesterday = y.getFullYear() + '-' + pad2(y.getMonth() + 1) + '-' + pad2(y.getDate());
    sess = await fetchLiveSessions(yesterday, { status: '4', accountId });
    s = (sess.sessions || []).find(x => x.roomId === roomId);
  }
  if (!s) {
    console.warn(`[liveCollector] ${accountName || accountId} 未找到已结束场次 ${roomId}（今昨两天均无），终值补采跳过`);
    return null;
  }
  const board = await fetchLiveBoard(roomId, undefined, s.startTime, accountId, s.endTime);
  const record = assembleRecord(board, { roomId, roomName: s.roomName, startTime: s.startTime, endTime: s.endTime, status: '4' }, accountName, accountId);
  record.session += '_终值';
  return { record };
}


async function collectOnce(accountId, opts = {}) {
  
  const acc = QIANCHUAN_ACCOUNTS.find(a => a.id === accountId);
  if (!acc) throw new Error(`未知账号: ${accountId}`);
  const accountName = acc.name;
  const aid = acc.id;

  if (opts.roomId) {
    const r = await collectEndedSession(opts.roomId, aid, accountName);
    if (!r) return { ok: false, error: '未找到该房间已结束场次' };
    
    latestByAccount[aid] = { record: r.record, decisions: { redList: [], blackList: [], potentialList: [], error: null }, fetchedAt: new Date().toISOString() };
    materialChanges.ingest(aid, r.record.material_frame);
    const decisions = scanDecisionsFromLive(aid);
    r.record.decisions = decisions;
    latestByAccount[aid].decisions = decisions;
    return { ok: true, status: 'ended', session: r.record.session, record: r.record };
  }

  const status = await fetchLiveStatus(aid);
  if (status.error) return { ok: false, error: status.error };
  const checkedAt = new Date().toISOString();
  if (!status.isLive) {
    latestLiveStates[aid] = { isLive: false, checkedAt, roomId: null, startTime: null };
    return { ok: true, status: 'idle', rooms: [] };
  }
  const room = require('./liveRoomContext').selectLiveRoom(status);
  latestLiveStates[aid] = {
    isLive: true, checkedAt, roomId: String(room.roomId), startTime: room.startTime || null,
  };
  if (latestByAccount[aid]?.record?.session_key !== makeSessionKey(aid, room)) {
    latestByAccount[aid] = buildSessionSkeleton(room, aid);
    latestCoreByAccount.delete(aid);
    resetFlowSamples(aid, makeSessionKey(aid, room));
  }
  collectCoreSession(room, aid, accountName).catch(() => {});
  const r = await collectAndAdvise(room, aid, accountName);
  return { ok: true, status: 'live', session: r.record.session, record: r.record };
}



const REFLOW_WINDOW_MS = 2 * 3600 * 1000;
const REFLOW_INTERVAL_MS = 15 * 60 * 1000;




function buildSessionSkeleton(room, accountId) {
  const sessionKey = makeSessionKey(accountId, room);
  return {
    record: {
      room: {
        room_id: room.roomId, roomId: room.roomId,
        room_name: room.roomName, roomName: room.roomName,
        start_time: room.startTime, startTime: room.startTime,
        status: '直播中',
      },
      session: null,
      session_key: sessionKey,
      collecting: true,
      dataValid: false,
      partial: false,
      errors: [],
      trend: [],
      live_metrics: {
        online: null, watchUcount: null, gpm: null,
        cost: null, basicCost: null, assistCost: null,
        gmv: null, gmvSettle: null, roi: null, roiSettle: null, orders: null,
        netDataValid: false, costDataValid: false,
        roiBasis: { roi: 'payment', roiSettle: 'platform_net_1h' },
        settlementWindow: '1h',
        financialBasis: buildLiveFinancialBasis(),
      },
      riskAlerts: [],
      decisions: { redList: [], blackList: [], potentialList: [] },
      materials: { video: [], live: [], carousel: [] },
      funnel: null,
      source: [],
      channels: null,
    },
    decisions: { redList: [], blackList: [], potentialList: [], error: null },
    fetchedAt: null,
    createdAt: new Date().toISOString(),
    sessionKey,
  };
}

function mapIntradayMaterialRow(r, accountId, statDate) {
  const d = (r && r.dimensions) || {};
  const m = (r && r.metrics) || {};
  
  
  const netAmountRaw = m.totalOrderSettleAmountForRoi21H;
  const netOrdersRaw = m.totalOrderSettleCountForRoi21H;
  const hasNetAmount = Object.prototype.hasOwnProperty.call(m, 'totalOrderSettleAmountForRoi21H') &&
    netAmountRaw != null && netAmountRaw !== '' && Number.isFinite(Number(netAmountRaw));
  const hasNetOrders = Object.prototype.hasOwnProperty.call(m, 'totalOrderSettleCountForRoi21H') &&
    netOrdersRaw != null && netOrdersRaw !== '' && Number.isFinite(Number(netOrdersRaw));
  return {
    account_id: accountId,
    material_id: d.materialId != null ? String(d.materialId) : '',
    stat_date: statDate,
    material_name: d.roi2MaterialVideoName || '',
    status: d.roi2MaterialStatus != null ? String(d.roi2MaterialStatus) : '',
    cost: +(m.statCostForRoi2 || 0),
    net_gmv_1h: +(m.totalOrderSettleAmountForRoi21H || 0),
    net_roi_1h: m.totalPrepayAndPaySettleRoi21H != null && m.totalPrepayAndPaySettleRoi21H !== '' &&
      Number.isFinite(Number(m.totalPrepayAndPaySettleRoi21H)) ? Number(m.totalPrepayAndPaySettleRoi21H) : null,
    orders: Math.round(+(m.totalOrderSettleCountForRoi21H || 0)),
    refund_rate: +(m.totalRefundOrderGmvForRoi21HRate || 0),
    boost_cost: +(m.additionalDeliveryStatCostForRoi2Assist || 0),
    boost_settle_roi: +(m.additionalDeliveryTotalPrepayAndPaySettleRoi21HAssist || 0),
    shows: Math.round(+(m.liveShowCountForRoi2V2 || 0)),
    clicks: Math.round(+(m.liveWatchCountForRoi2V2 || 0)),
    cpc: +(m.totalCpcForRoi2 || 0),
    click_rate: +(m.liveCvrRateForRoi2V2 || 0),
    convert_rate: +(m.liveConvertRateForRoi2V2 || 0),
    net_data_valid: hasNetAmount && hasNetOrders,
  };
}

function startLiveCollector() {
  if (activeCollector) return activeCollector;
  const intervalMs = (SCHEDULER && SCHEDULER.statusIntervalMs) || 5 * 60 * 1000;
  const running = {};      
  const lastRoom = {};     
  const wasLive = {};      
  const liveState = latestLiveStates;
  let timer = null;
  let watchdogTimer = null;
  let watchdogRunning = false;
  const watchdogLastRecovery = {};
  collectorRuntime.startedAt = collectorRuntime.startedAt || new Date().toISOString();
  collectorRuntime.intervalMs = intervalMs;
  collectorRuntime.watchdog = {
    ...(collectorRuntime.watchdog || {}),
    state: 'active',
    interval_ms: WATCHDOG_INTERVAL_MS,
    recovery_cooldown_ms: WATCHDOG_RECOVERY_COOLDOWN_MS,
  };

  
  
  const FAST_BOARD_MS = 30 * 1000;            
  const CORE_MS = 10 * 1000;
  const INTRADAY_LIVE_MS = 5 * 60 * 1000;     
  const INTRADAY_IDLE_MS = 30 * 60 * 1000;    
  const intradayLast = {};                    
  let fastTimer = null;
  let coreTimer = null;

  
  async function collectIntraday(accountId, signal) {
    try {
      const acc = (QIANCHUAN_ACCOUNTS || []).find(a => a.id === accountId);
      if (!acc || !acc.anchorId) return;
      const today = getLocalDateStr();
      const pageSize = 500;
      let offset = 0;
      let expectedTotal = null;
      let totalCountReliable = true;
      const byId = new Map();
      for (let page = 0; page < 20; page++) {
        const result = await fetchLiveMaterials(acc.anchorId, {
          accountId, startDate: today, endDate: today, status: 'all', pageSize, offset, signal,
        });
        const pageRows = (result && result.rows) || [];
        if (!(result && result.totalCountReliable === true)) totalCountReliable = false;
        const reported = Number(result && result.totalCount);
        if (Number.isFinite(reported)) expectedTotal = reported;
        for (const r of pageRows) {
          const id = r && r.dimensions && r.dimensions.materialId;
          if (id != null && id !== '') byId.set(String(id), r);
        }
        offset += pageRows.length;
        if (!pageRows.length || (expectedTotal != null && offset >= expectedTotal) || pageRows.length < pageSize) break;
      }
      
      if (!totalCountReliable) {
        console.log(`[intraday] ${accountId} 上游未返回可信 totalCount，跳过落盘`);
        return;
      }
      if (expectedTotal != null && byId.size < expectedTotal) {
        console.log(`[intraday] ${accountId} 批次不完整 ${byId.size}/${expectedTotal}，跳过落盘`);
        return;
      }
      const rows = [...byId.values()];
      if (!rows.length) return;
      const { upsertSnapshots } = require('./intradayStore');
      const list = rows.map(r => mapIntradayMaterialRow(r, accountId, today)).filter(x => x.material_id);
      upsertSnapshots(list);
      console.log(`[intraday] ${accountId} 完整快照落盘 ${list.length}/${expectedTotal == null ? list.length : expectedTotal} 条`);
    } catch (e) {
      if (e.code === 'cookie_expired' || e.message === 'cookie_expired') throw e; 
      console.log(`[intraday] ${accountId} 快照采集失败(静默): ${e.message}`);
    }
  }

  
  async function collectIntradayIfDue(accountId, isLive) {
    const gap = isLive ? INTRADAY_LIVE_MS : INTRADAY_IDLE_MS;
    if (Date.now() - (intradayLast[accountId] || 0) < gap) return;
    intradayLast[accountId] = Date.now();
    const key = `${accountId}|intraday|${getLocalDateStr()}`;
    await singleFlight(
      intradayFlights,
      accountId,
      key,
      INTRADAY_DEADLINE_MS,
      'collector_intraday',
      signal => collectIntraday(accountId, signal),
    );
  }

  
  async function fastBoard(accountId, accountName) {
    const room = lastRoom[accountId];
    if (!room || !room.roomId) return;
    try {
      const r = await collectSession(room, accountId, accountName);
      const detected = liveState[accountId];
      const recordRoomId = r.record && r.record.room && r.record.room.room_id;
      const roomEnded = r.record && r.record.room && r.record.room.status === '已结束';
      const roomMismatch = detected && detected.roomId && recordRoomId &&
        String(detected.roomId) !== String(recordRoomId);
      if (roomEnded || roomMismatch) {
        console.log(`[liveCollector] ${accountName} 快刷结果与状态探针冲突，丢弃大屏状态判断`);
        return;
      }
    } catch (e) {
      if (e.code === 'cookie_expired' || e.message === 'cookie_expired') throw e;
      console.error(`[liveCollector] ${accountName} 30s快刷失败(静默): ${e.message}`);
    }
  }

  function coreTickAll() {
    if (isCollectorQuietHour()) return;
    for (const acc of QIANCHUAN_ACCOUNTS || []) {
      const ls = liveState[acc.id], room = lastRoom[acc.id];
      if (ls?.isLive !== true || !room?.startTime || makeSessionKey(acc.id, ls) !== makeSessionKey(acc.id, room)) continue;
      collectCoreSession(room, acc.id, acc.name).catch(() => {});
    }
  }

  function fastTickAll() {
    
    const h = new Date().getHours();
    if (h >= 22 || h < 7) return;
    for (const acc of (QIANCHUAN_ACCOUNTS || [])) {
      const ls = liveState[acc.id];
      if (!ls?.isLive || !ls.roomId) continue; 
      const room = lastRoom[acc.id];
      if (!room || (ls.roomId && String(ls.roomId) !== String(room.roomId))) continue;
      fastBoard(acc.id, acc.name).catch(e => {
        if (e.message !== 'cookie_expired') console.error(`[liveCollector] ${acc.name} 快刷异常:`, e.message);
      });
      collectIntradayIfDue(acc.id, true).catch(() => {});
    }
  }

  
  async function recollectEnded(accountId, accountName, prev, tag) {
    try {
      const r = await collectEndedSession(prev.roomId, accountId, accountName);
      if (r) {
        materialChanges.ingest(accountId, r.record.material_frame);
        latestByAccount[accountId] = {
          record: r.record,
          decisions: { redList: [], blackList: [], potentialList: [], error: null },
          fetchedAt: new Date().toISOString(),
        };
        const decisions = scanDecisionsFromLive(accountId);
        r.record.decisions = decisions;
        latestByAccount[accountId].decisions = decisions;
        const m = r.record.live_metrics;
        console.log(`[liveCollector] ${accountName} ${tag} ${prev.roomId} 净ROI=${fmt(m.roiSettle)} 消耗=${fmt(m.cost)}`);
      }
    } catch (e) {
      
      if (e.message === 'cookie_expired') throw e;
      console.error(`[liveCollector] ${accountName} ${tag}失败: ${e.message}`);
    }
  }

  async function tick(accountId, accountName, options = {}) {
    const statusOnly = options.statusOnly === true;
    if (running[accountId]) { console.log(`[liveCollector] ${accountName} 上一轮仍在采，跳过`); return; }
    running[accountId] = true;
    const runtime = collectorRuntime.accounts[accountId] || (collectorRuntime.accounts[accountId] = {});
    runtime.tickStartedAt = new Date().toISOString();
    runtime.running = true;
    try {
      const status = await fetchLiveStatus(accountId);
      try {
        require('./liveRoomContext').verifyLiveStatus(status);
      } catch (error) {
        liveState[accountId] = { ...liveState[accountId], isLive: null, error: error.message,
          available_rooms: [], probeFailedAt: new Date().toISOString() };
        throw error;
      }
      const checkedAt = new Date().toISOString();
      runtime.lastStatusSuccessAt = checkedAt;
      if (latestByAccount[accountId] && latestByAccount[accountId].cookieExpired) {
        delete latestByAccount[accountId].cookieExpired;
      }
      const room = applyLiveStatus(accountId, status, checkedAt);
      if (status.rooms.length > 1) {
        runtime.lastError = null;
        return;
      }
      if (status.isLive) {
        const prev = lastRoom[accountId];
        const isNewSession = !prev || String(prev.roomId) !== String(room.roomId) ||
          String(prev.startTime || '') !== String(room.startTime || '');
        if (isNewSession) {
          
          
          latestByAccount[accountId] = buildSessionSkeleton(room, accountId);
          latestCoreByAccount.delete(accountId);
          resetFlowSamples(accountId, makeSessionKey(accountId, room));
        }
        
        
        lastRoom[accountId] = { roomId: room.roomId, startTime: room.startTime, roomName: room.roomName };
        wasLive[accountId] = true;
        collectCoreSession(room, accountId, accountName).catch(() => {});
        if (statusOnly) {
          
          console.log(`[liveCollector] ${accountName} 夜间启动状态探测：直播中，继续恢复场次数据`);
        }
        const r = await collectAndAdvise(room, accountId, accountName);
        
        const m = r.record.live_metrics;
        const d = r.record.decisions;
        console.log(`[liveCollector] ${accountName} 📡 直播中${isNewSession ? '(新场次)' : ''} ${room.roomName.slice(0, 16)} 净ROI=${fmt(m.roiSettle)} 消耗=${fmt(m.cost)} 建议:红榜${d.redList.length}/黑榜${d.blackList.length}`);
      } else {
        
        runtime.lastError = null;
        if (statusOnly) {
          console.log(`[liveCollector] ${accountName} 夜间启动状态探测：未在直播`);
          return;
        }
        
        collectIntradayIfDue(accountId, false).catch(() => {});
        
        if (wasLive[accountId] && lastRoom[accountId]) {
          const prev = lastRoom[accountId];
          console.log(`[liveCollector] ${accountName} 检测到下播，补采终值 ${prev.roomId}`);
          await recollectEnded(accountId, accountName, prev, '终值已采');
          wasLive[accountId] = false;
          
          prev.endedAt = Date.now();
          prev.lastReflowAt = Date.now();
        } else if (lastRoom[accountId] && lastRoom[accountId].endedAt) {
          const prev = lastRoom[accountId];
          if (Date.now() - prev.endedAt >= REFLOW_WINDOW_MS) {
            lastRoom[accountId] = null;
            console.log(`[liveCollector] ${accountName} 未在播，跳过 (${nowTimeStr()})`);
          } else if (Date.now() - (prev.lastReflowAt || 0) >= REFLOW_INTERVAL_MS) {
            prev.lastReflowAt = Date.now();
            await recollectEnded(accountId, accountName, prev, '回流补采');
          } else {
            console.log(`[liveCollector] ${accountName} 未在播，跳过 (${nowTimeStr()})`);
          }
        } else {
          console.log(`[liveCollector] ${accountName} 未在播，跳过 (${nowTimeStr()})`);
        }
      }
    } catch (e) {
      runtime.lastErrorAt = new Date().toISOString();
      runtime.lastError = { code: e.code || 'collector_error', error: e.message };
      if (e.code === 'cookie_expired' || e.message === 'cookie_expired') {
        console.error(`[liveCollector] ${accountName} Cookie 已失效，暂停采集（需刷新 cookie 后自动恢复）`);
        
        if (!latestByAccount[accountId]) {
          latestByAccount[accountId] = { record: null, decisions: { redList: [], blackList: [], potentialList: [], error: 'cookie_expired' }, fetchedAt: null };
        }
        latestByAccount[accountId].cookieExpired = true;
        
        
      } else {
        console.error(`[liveCollector] ${accountName} tick 异常: ${e.message}`);
      }
    } finally {
      running[accountId] = false;
      runtime.running = false;
      runtime.tickFinishedAt = new Date().toISOString();
    }
  }

  function tickAll(options = {}) {
    
    if (isCollectorQuietHour() && options.ignoreQuietHours !== true) {
      
      return;
    }
    const list = QIANCHUAN_ACCOUNTS && QIANCHUAN_ACCOUNTS.length ? QIANCHUAN_ACCOUNTS : [];
    for (const acc of list) {
      tick(acc.id, acc.name, { statusOnly: options.statusOnly === true })
        .catch(e => console.error(`[liveCollector] tick ${acc.id} 异常:`, e.message));
    }
  }

  function currentWatch(accountId) {
    return getLatestWatch().find(item => item.accountId === accountId) || null;
  }

  async function recoverAccount(accountId, options = {}) {
    const acc = (QIANCHUAN_ACCOUNTS || []).find(item => item.id === accountId);
    if (!acc) {
      return {
        ok: false,
        ready: false,
        code: 'invalid_account',
        component: 'collector',
        retryable: false,
        restart_recommended: false,
      };
    }

    const before = currentWatch(accountId);
    const beforeHealth = assessCollectorWatch(before, { quietHours: isCollectorQuietHour() });
    if (beforeHealth.ready && options.force !== true) {
      return { ok: true, ready: true, action: 'none', account_id: accountId, health: beforeHealth, watch: before };
    }

    const runtime = collectorRuntime.accounts[accountId] || (collectorRuntime.accounts[accountId] = {});
    runtime.lastRecoveryAttemptAt = new Date().toISOString();
    runtime.recoveryAttempts = (runtime.recoveryAttempts || 0) + 1;

    
    
    const flight = boardFlights.get(accountId);
    if (flight && !flight.controller.signal.aborted) {
      flight.controller.abort(qcError('collector_recovery_abort', '自愈取消陈旧采集', {
        statusCode: 409, retryable: true, component: 'collector_board',
      }));
      await Promise.race([
        flight.promise.catch(() => null),
        new Promise(resolve => setTimeout(resolve, 1000)),
      ]);
    }

    const waitUntil = Date.now() + 2000;
    while (running[accountId] && Date.now() < waitUntil) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (running[accountId]) {
      const health = assessCollectorWatch(currentWatch(accountId), { quietHours: isCollectorQuietHour() });
      return {
        ok: false,
        ready: false,
        action: 'collector_busy',
        account_id: accountId,
        health: { ...health, code: 'collector_busy', restart_recommended: false },
      };
    }

    await tick(accountId, acc.name, { statusOnly: false });
    const watch = currentWatch(accountId);
    const health = assessCollectorWatch(watch, { quietHours: isCollectorQuietHour() });
    if (health.ready) {
      runtime.lastRecoverySuccessAt = new Date().toISOString();
      runtime.recoverySuccesses = (runtime.recoverySuccesses || 0) + 1;
    } else {
      runtime.lastRecoveryFailureAt = new Date().toISOString();
      runtime.recoveryFailures = (runtime.recoveryFailures || 0) + 1;
    }
    return {
      ok: health.ready,
      ready: health.ready,
      action: 'collector_recollect',
      account_id: accountId,
      health,
      watch,
    };
  }

  async function watchdogOnce() {
    if (watchdogRunning) return;
    watchdogRunning = true;
    collectorRuntime.watchdog = collectorRuntime.watchdog || {};
    collectorRuntime.watchdog.last_check_at = new Date().toISOString();
    try {
      const quietHours = isCollectorQuietHour();
      for (const acc of (QIANCHUAN_ACCOUNTS || [])) {
        const watch = currentWatch(acc.id);
        const health = assessCollectorWatch(watch, { quietHours });
        if (health.ready || health.restart_recommended !== true) continue;
        if (Date.now() - (watchdogLastRecovery[acc.id] || 0) < WATCHDOG_RECOVERY_COOLDOWN_MS) continue;
        watchdogLastRecovery[acc.id] = Date.now();
        const result = await recoverAccount(acc.id);
        collectorRuntime.watchdog.last_action_at = new Date().toISOString();
        collectorRuntime.watchdog.last_account_id = acc.id;
        collectorRuntime.watchdog.last_result = result.health || null;
      }
    } catch (error) {
      collectorRuntime.watchdog.last_error_at = new Date().toISOString();
      collectorRuntime.watchdog.last_error = error.message;
      console.error(`[liveCollector] watchdog 自愈失败: ${error.message}`);
    } finally {
      watchdogRunning = false;
    }
  }

  
  
  tickAll(getStartupTickOptions());
  timer = setInterval(tickAll, intervalMs);
  timer.unref();
  
  fastTimer = setInterval(fastTickAll, FAST_BOARD_MS);
  fastTimer.unref();
  coreTimer = setInterval(coreTickAll, CORE_MS);
  coreTimer.unref();
  watchdogTimer = setInterval(() => watchdogOnce().catch(() => {}), WATCHDOG_INTERVAL_MS);
  watchdogTimer.unref();
  console.log(`[liveCollector] 已启动，每 ${intervalMs / 1000}s 检测一次直播状态（账号: ${(QIANCHUAN_ACCOUNTS || []).map(a => a.name).join('/')}）；核心 10s / 完整大屏 30s 独立采集`);

  
  function getLiveStates() { return latestLiveStates; }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    if (fastTimer) { clearInterval(fastTimer); fastTimer = null; }
    if (coreTimer) { clearInterval(coreTimer); coreTimer = null; }
    if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
    collectorRuntime.watchdog = { ...(collectorRuntime.watchdog || {}), state: 'stopped' };
    for (const entry of boardFlights.values()) {
      if (!entry.controller.signal.aborted) entry.controller.abort(qcError('collector_stopped', 'collector 已停止', { component: 'collector_board' }));
    }
    for (const entry of intradayFlights.values()) {
      if (!entry.controller.signal.aborted) entry.controller.abort(qcError('collector_stopped', 'collector 已停止', { component: 'collector_intraday' }));
    }
    for (const entry of coreFlights.values()) {
      if (!entry.controller.signal.aborted) entry.controller.abort(qcError('collector_stopped', 'collector 已停止', { component: 'collector_core' }));
    }
    activeCollector = null;
  }
  activeCollector = { stop, tickAll, collectOnce, getLiveStates, recoverAccount, watchdogOnce };
  return activeCollector;
}




function buildThresholds(accountId) { const p=require('./api-helpers').getAccountParams(accountId); return {avg_order_price:p.avg_order_price??null,break_even_roi:p.break_even_roi??null,price_source:'user_config',strategy_status:'not_included'}; }


function todayMaterialMap(accountId) {
  const latest = latestByAccount[accountId];
  const rec = latest && latest.record;
  const mats = rec && rec.materials ? [...(rec.materials.video || []), ...(rec.materials.carousel || [])] : [];
  const map = {};
  for (const m of mats) {
    if (!m.material_id) continue;
    const cur = map[m.material_id] || { cost: 0, gmv: 0, net: 0, orders: 0 };
    cur.cost += +m.cost || 0;
    cur.gmv += +m.gmv || 0;       
    cur.net += +m.gmvSettle || 0; 
    cur.orders += +m.orders || 0;
    map[m.material_id] = cur;
  }
  return map;
}

function getLatestWatch() {
  const accounts = QIANCHUAN_ACCOUNTS && QIANCHUAN_ACCOUNTS.length ? QIANCHUAN_ACCOUNTS : [];
  const todayStr = getLocalDateStr();
  const now = Date.now();
  const statusIntervalMs = (SCHEDULER && SCHEDULER.statusIntervalMs) || 5 * 60 * 1000;
  const statusStaleAfterMs = statusIntervalMs * 2 + 30 * 1000;
  return accounts.map(acc => {
    let latest = latestByAccount[acc.id];
    const ls = latestLiveStates[acc.id] || null;
    latest = mergeCoreRecord(latest, latestCoreByAccount.get(acc.id), ls);
    const requiresRoomSelection = ls?.isLive === true && (ls.available_rooms?.length || 0) > 1;
    if (requiresRoomSelection) latest = null;
    const insights = insightReads.get(acc.id);
    if (latest?.record && insights?.key === latest.sessionKey) {
      const room = latest.record.room;
      const aux = assembleRecord({ ...insights.parts }, { roomId: room.room_id, startTime: room.start_time }, acc.name, acc.id);
      const record = { ...latest.record, component_times: { ...latest.record.component_times } };
      for (const name of ['funnel', 'channels']) {
        if (insights.parts[name] && (!record.component_times[name]?.source_at || Date.parse(insights.parts[name].source_at) >= Date.parse(record.component_times[name].source_at))) {
          record[name] = aux[name];
          record.component_times[name] = aux.component_times[name];
          if (name === 'channels') record.source = aux.source;
        }
      }
      latest = { ...latest, record };
    }
    if (latest?.record?.component_times?.core?.source_at) latest = { ...latest, fetchedAt: latest.record.component_times.core.source_at };
    const runtime = collectorRuntime.accounts[acc.id] || {};
    const liveCheckedAgeMs = ls && ls.checkedAt ? Math.max(0, now - Date.parse(ls.checkedAt)) : null;
    const fetchedAgeMs = latest && latest.fetchedAt ? Math.max(0, now - Date.parse(latest.fetchedAt)) : null;
    const statusStale = typeof ls?.isLive !== 'boolean' || liveCheckedAgeMs == null ||
      liveCheckedAgeMs > (process.env.QC_DISABLE_BACKGROUND === '1' ? (ls?.isLive === false ? 45000 : 30000) : statusStaleAfterMs);
    const dataStale = !!(ls && ls.isLive) && (fetchedAgeMs == null || fetchedAgeMs > 30 * 1000);
    const flight = boardFlights.get(acc.id);
    const runtimeErrors = [];
    if (runtime.lastError && (!latest?.fetchedAt || !runtime.lastErrorAt || Date.parse(runtime.lastErrorAt) >= Date.parse(latest.fetchedAt))) {
      runtimeErrors.push(runtime.lastError);
    }
    
    
    if (latest && latest.record && !(ls && ls.isLive)) {
      const recDate = String((latest.record.room && (latest.record.room.start_time || latest.record.room.startTime)) || '').slice(0, 10)
        || (latest.fetchedAt ? getLocalDateStr(new Date(latest.fetchedAt)) : '');
      if (recDate && recDate < todayStr) latest = null;
    }
    const thresholds = buildThresholds(acc.id);
    
    const cookieExpired = !!(latest && latest.cookieExpired);
    
    
    
    if (!latest || !latest.record) {
      return {
        accountId: acc.id,
        accountName: acc.name,
        status: requiresRoomSelection ? 'multiple_live_rooms' : 'no_data',
        requires_room_selection: requiresRoomSelection,
        available_rooms: ls?.available_rooms || [],
        fetchedAt: null,
        session_key: ls?.roomId && ls?.startTime ? makeSessionKey(acc.id, ls) : null,
        isLive: typeof ls?.isLive === 'boolean' ? ls.isLive : null,
        liveCheckedAt: (ls && ls.checkedAt) || null,
        age_ms: null,
        live_checked_age_ms: liveCheckedAgeMs,
        stale: statusStale || dataStale,
        status_stale: statusStale,
        data_stale: dataStale,
        dataValid: false,
        partial: runtimeErrors.length > 0,
        errors: runtimeErrors,
        source_type: 'collector_memory',
        source: [],
        detectedRoomId: (ls && ls.roomId) || null,
        detectedRoomStartTime: (ls && ls.startTime) || null,
        liveStateError: (ls && ls.error) || null,
        collecting: !!flight,
        room: null,
        live_metrics: {
          online: null, watchUcount: null, gpm: null, cost: null, gmv: null,
          gmvSettle: null, roi: null, roiSettle: null, orders: null,
          netDataValid: false, costDataValid: false,
          roiBasis: { roi: 'payment', roiSettle: 'platform_net_1h' },
          settlementWindow: '1h',
          financialBasis: buildLiveFinancialBasis(),
        },
        riskAlerts: [],
        decisions: { redList: [], blackList: [], potentialList: [] },
        materialsTop: [],
        funnel: null,
        channels: null,
        thresholds,
        cookieExpired,
      };
    }
    const metrics = { ...(latest.record.live_metrics || {}) };
    if (metrics.netDataValid !== true) {
      metrics.gmvSettle = null;
      metrics.roiSettle = null;
      metrics.orders = null;
      metrics.orderCost = null;
    }
    if (metrics.costDataValid !== true) {
      metrics.cost = null;
      metrics.basicCost = null;
      metrics.assistCost = null;
      metrics.roi = null;
    }
    const dataValid = latest.record.dataValid === true ||
      (metrics.netDataValid === true && metrics.costDataValid === true);
    const errors = [...(latest.record.errors || []), ...runtimeErrors];
    return {
      accountId: acc.id,
      accountName: acc.name,
      status: 'live_or_ended',
      available_rooms: ls?.available_rooms || [],
      requires_room_selection: false,
      fetchedAt: latest.fetchedAt,
      session_key: latest.sessionKey || latest.record.session_key || makeSessionKey(acc.id, {
        roomId: latest.record.room?.room_id,
        startTime: latest.record.room?.start_time,
      }),
      isLive: typeof ls?.isLive === 'boolean' ? ls.isLive : null,
      liveCheckedAt: (ls && ls.checkedAt) || null,
      age_ms: fetchedAgeMs,
      live_checked_age_ms: liveCheckedAgeMs,
      stale: statusStale || dataStale,
      status_stale: statusStale,
      data_stale: dataStale,
      dataValid,
      partial: latest.record.partial === true || errors.length > 0,
      errors,
      source_type: latest.record.source_type || 'collector_memory',
      detectedRoomId: (ls && ls.roomId) || null,
      detectedRoomStartTime: (ls && ls.startTime) || null,
      liveStateError: (ls && ls.error) || null,
      collecting: !dataValid && (!!latest.record.collecting || !!flight || coreFlights.has(acc.id)),
      room: latest.record.room,
      live_metrics: metrics,
      component_times: latest.record.component_times || null,
      riskAlerts: latest.record.riskAlerts || [],
      decisions: latest.decisions,
      funnel: latest.record.funnel || null,
      source: latest.record.source || [], 
      channels: latest.record.channels || normalizeChannels(latest.record.source || [], {
        sourceAt: latest.fetchedAt,
        window: 'current_session',
      }),
      materialsTop: (latest.record.materials.video || []).slice(0, 5).map(m => ({
        material_id: m.material_id,
        name: m.name, cost: m.cost, roiSettle: m.roiSettle, orders: m.orders, heatStatus: m.heatStatus,
        shows: m.shows, clicks: m.clicks, cpc: m.cpc, clickRate: m.clickRate,
      })),
      thresholds,
      cookieExpired,
    };
  });
}

function getCollectorStatus() {
  const now = Date.now();
  const flights = {};
  for (const [accountId, entry] of boardFlights.entries()) {
    flights[accountId] = { session_key: entry.key, age_ms: now - entry.startedAt };
  }
  const intraday = {};
  const core = {};
  for (const [accountId, entry] of coreFlights.entries()) {
    core[accountId] = { session_key: entry.key, age_ms: now - entry.startedAt };
  }
  for (const [accountId, entry] of intradayFlights.entries()) {
    intraday[accountId] = { key: entry.key, age_ms: now - entry.startedAt };
  }
  return {
    started_at: collectorRuntime.startedAt,
    interval_ms: collectorRuntime.intervalMs,
    accounts: collectorRuntime.accounts,
    board_in_flight: flights,
    core_in_flight: core,
    core_interval_ms: 10000,
    intraday_in_flight: intraday,
    watchdog: collectorRuntime.watchdog || {
      interval_ms: WATCHDOG_INTERVAL_MS,
      recovery_cooldown_ms: WATCHDOG_RECOVERY_COOLDOWN_MS,
      state: activeCollector ? 'active' : 'not_started',
    },
  };
}

function getCollectorHealth(accountId) {
  const watch = getLatestWatch().find(item => item.accountId === accountId) || null;
  const health = assessCollectorWatch(watch, { quietHours: isCollectorQuietHour() });
  return { account_id: accountId, ...health, watch };
}

async function getCollectorRoomHealth(accountId, roomId, options = {}) {
  if (!roomId || !options.startTime) throw Object.assign(new Error('指定恢复场次须同时提供房间和开播时间'), {
    code: 'session_binding_required', statusCode: 400, retryable: false,
  });
  
  
  const watch = await require('./liveRoomContext').readRoomWatch(accountId, roomId, options);
  if (watch.status === 'session_changed') return { account_id: accountId, ready: false,
    code: 'live_session_changed', state: 'session_changed', retryable: false,
    restart_recommended: false, watch };
  const health = assessCollectorWatch({ ...watch, data_stale: watch.stale === true }, { quietHours: false });
  return { account_id: accountId, ...health, watch };
}

async function recoverCollectorAccount(accountId, options = {}) {
  if (options.roomId !== undefined || options.startTime !== undefined) {
    
    
    const health = await getCollectorRoomHealth(accountId, options.roomId, options);
    return { ok: health.ready, ready: health.ready, action: 'room_recollect', account_id: accountId,
      health, watch: health.watch };
  }
  const collector = activeCollector || startLiveCollector();
  return collector.recoverAccount(accountId, options);
}


function getLatestMaterialsAll(accountId) {
  try {
    const latest = latestByAccount[accountId];
    if (!latest || !latest.record || !latest.record.materials) return [];
    const m = latest.record.materials;
    return [...(m.video || []), ...(m.live || []), ...(m.carousel || [])];
  } catch (e) {
    return [];
  }
}

function getLatestMaterialChanges(accountId, options = {}) {
  return materialChanges.build(accountId, options);
}



function getLatestTrend(accountId) {
  try {
    const latest = latestByAccount[accountId];
    if (!latest || !latest.record) return { trend: [], flowSamples: [], room: null, session: null, fetchedAt: null };
    const r = latest.record;
    const cached = trendReads.get(accountId);
    const sameSession = cached?.sessionKey === latest.sessionKey;
    const useCached = sameSession && cached.sourceAt && (!r.component_times?.trend?.source_at || Date.parse(cached.sourceAt) >= Date.parse(r.component_times.trend.source_at));
    const trend = (useCached ? cached.trend : r.trend || []).map(p => ({
      time: p.time,
      cost: p.cost,
      gmvSettle: p.gmvSettle,
      netDataValid: p.netDataValid === true,
      costDataValid: p.costDataValid === true,
      roi: p.cost > 0 && p.gmvSettle != null ? +(p.gmvSettle / p.cost).toFixed(3) : null,
    }));
    const flowState = flowSamplesByAccount.get(accountId);
    const inMemory = flowState && flowState.sessionKey === latest.sessionKey
      ? flowState.samples.map(sample => ({ ...sample }))
      : [];
    let persisted = [];
    try {
      persisted = getDB().prepare(`
        SELECT sample_time, total_cost, assist_cost
        FROM live_flow_samples
        WHERE account_id = ? AND session_key = ? AND sample_time >= ?
        ORDER BY sample_time ASC
      `).all(accountId, latest.sessionKey, new Date(Date.now() - FLOW_SAMPLE_KEEP_MS).toISOString())
        .map(row => ({
          ts: Date.parse(row.sample_time),
          at: row.sample_time,
          totalCost: Number(row.total_cost),
          assistCost: Number(row.assist_cost),
          basicCost: Number(row.total_cost) - Number(row.assist_cost),
        }));
    } catch (error) {
      console.warn(`[flow-samples] 读取持久化基线失败，继续使用内存采样: ${error.message}`);
    }
    const merged = new Map();
    for (const sample of [...persisted, ...inMemory]) merged.set(sample.ts, sample);
    const flowSamples = [...merged.values()].sort((a, b) => a.ts - b.ts);
    return { trend, flowSamples, room: r.room || null, session: r.session || null,
      errors: sameSession && cached.error ? [cached.error] : [],
      fetchedAt: useCached ? cached.sourceAt : r.component_times?.trend?.source_at || null };
  } catch (e) {
    return { trend: [], flowSamples: [], room: null, session: null, fetchedAt: null };
  }
}

function clearAccountCache(accountId) {
  
  const safeId = String(accountId || '');
  if (!/^[A-Za-z0-9_-]{2,50}$/.test(safeId)) return 0;
  const root = path.resolve(CACHE_DIR);
  let removed = 0;
  const isOwned = name => name === safeId || name.includes(`_${safeId}_`) || name.endsWith(`_${safeId}.json`) || name.startsWith(`${safeId}_`);
  function visit(dir, depth) {
    if (depth > 5) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const target = path.resolve(dir, entry.name);
      if (!target.startsWith(root + path.sep)) continue;
      if (entry.isDirectory()) {
        if (entry.name === safeId) {
          try { fs.rmSync(target, { recursive: true, force: true }); removed++; } catch {}
        } else {
          visit(target, depth + 1);
        }
      } else if (isOwned(entry.name)) {
        try { fs.rmSync(target, { force: true }); removed++; } catch {}
      }
    }
  }
  visit(root, 0);
  return removed;
}

async function evictAccountRuntime(accountId) {
  require('./liveReadService').stopLiveReader(accountId);
  for (const flights of [boardFlights, coreFlights, intradayFlights, onDemandFlights, trendFlights, flowReadFlights, insightFlights]) {
    const entry = flights.get(accountId);
    if (entry && !entry.controller.signal.aborted) {
      entry.controller.abort(qcError('account_archived', '账号已移出，停止采集', { statusCode: 409, component: 'collector' }));
    }
    flights.delete(accountId);
  }
  delete latestByAccount[accountId];
  onDemandAttempts.delete(accountId);
  trendReads.delete(accountId);
  insightReads.delete(accountId);
  flowReadAttempts.delete(accountId);
  latestCoreByAccount.delete(accountId);
  materialChanges.clear(accountId);
  delete latestLiveStates[accountId];
  delete collectorRuntime.accounts[accountId];
  flowSamplesByAccount.delete(accountId);
  return { cache_entries_removed: clearAccountCache(accountId) };
}

module.exports = {
  startLiveCollector,
  collectOnce,
  collectLive,
  collectCoreSession,
  collectEndedSession,
  assembleRecord,
  mapIntradayMaterialRow,
  getLatestWatch,
  ensureLiveWatch,
  todayMaterialMap,
  getLatestMaterialsAll,
  getLatestMaterialChanges,
  getLatestTrend,
  ensureLiveTrend,
  ensureLiveInsights,
  ensureEndedWatch,
  ensureLiveFlow,
  getCollectorStatus,
  getCollectorHealth,
  getCollectorRoomHealth,
  recoverCollectorAccount,
  assessCollectorWatch,
  makeSessionKey,
  recordFlowSample,
  resetFlowSamples,
  runBoardSingleFlight,
  buildSessionSkeleton,
  buildThresholds,
  clearAccountCache,
  evictAccountRuntime,
  isCollectorQuietHour,
  getStartupTickOptions,
};
