'use strict';

// 广告账户是凭据与限频边界，房间和开播时间才是盘面边界。
const flights = new Map();
const snapshots = new Map();
const planSnapshots = new Map();
const planFlights = new Map();
function roomError(code, message, statusCode = 409, rooms = []) {
  return Object.assign(new Error(message), { code, statusCode, details: { rooms }, advertising_writes: 0 });
}
function selectLiveRoom(status, roomId, startTime) {
  verifyLiveStatus(status);
  const rooms = Array.isArray(status?.rooms) ? status.rooms : [];
  if (!roomId && rooms.length > 1) throw roomError('live_room_required', '同一广告账户有多个直播间，必须指定 room_id', 409, rooms);
  const matches = roomId ? rooms.filter(room => String(room.roomId) === String(roomId)) : rooms;
  if (matches.length > 1) throw roomError('live_session_ambiguous', '直播场次不唯一，先核对房间与开播时间', 409, matches);
  const room = matches[0];
  if (roomId && !room) throw roomError('live_room_not_found', '指定直播间当前未在播，不会切换到其他直播间', 409, rooms);
  if (status?.isLive && (!room?.roomId || !room.startTime)) throw roomError('live_room_missing', '直播状态缺少当前场次', 502);
  if (room && !Number.isFinite(sessionTime(room.startTime))) throw roomError('live_session_invalid', '直播间开播时间无效', 502);
  if (room && startTime && sessionTime(room.startTime) !== sessionTime(startTime)) throw roomError('live_session_changed', '指定直播间已换场，不能沿用上一场数据');
  return room || null;
}
function verifyLiveStatus(status) {
  if (status?.error) throw Object.assign(new Error(status.error), {
    code: status.code || 'live_status_failed', statusCode: status.statusCode || 502, retryable: status.retryable === true,
  });
  if (typeof status?.isLive !== 'boolean' || !Array.isArray(status.rooms)
    || status.isLive !== (status.rooms.length > 0)) throw roomError('live_status_invalid', '直播状态不完整，不能判断目标场次是否结束', 502);
  for (const room of status.rooms) {
    if (!room?.roomId || !room.startTime) throw roomError('live_room_missing', '直播状态缺少当前场次', 502);
    if (!Number.isFinite(sessionTime(room.startTime))) throw roomError('live_session_invalid', '直播间开播时间无效', 502);
  }
}
function sessionTime(value) {
  if (/^\d+(?:\.\d+)?$/.test(String(value))) return Number(value) * (Number(value) < 1e12 ? 1000 : 1);
  const text = String(value || '').replace(' ', 'T');
  return Date.parse(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/.test(text) ? text + '+08:00' : text);
}
function validateRoom(accountId, roomId, startTime) {
  require('./api-helpers').validateAccount(accountId);
  if (!roomId || !/^[A-Za-z0-9_-]{1,100}$/.test(String(roomId))) throw roomError('invalid_room', '必须指定合法 room_id', 400);
  if (startTime != null && !Number.isFinite(sessionTime(startTime))) throw roomError('live_session_invalid', '直播间开播时间无效', 400);
}
async function readRoomRecord(accountId, room, signal) {
  const key = JSON.stringify([accountId, String(room.roomId), sessionTime(room.startTime)]);
  let snapshot = snapshots.get(key);
  if (!snapshot || Date.now() - snapshot.at >= 10000) {
    // 每个房间从自己的 init 核验主播，不能继承账户上另一个直播间的 anchorId。
    const board = await require('./liveBoard').fetchLiveCore(room.roomId, undefined, room.startTime, accountId, { signal });
    if (signal.aborted) throw signal.reason;
    const record = require('./liveCollector').assembleRecord(board, { ...room, anchorId: board.anchorId, status: '2' }, accountId, accountId);
    snapshot = { at: Date.now(), record };
    if (record.dataValid) {
      for (const oldKey of snapshots.keys()) {
        const [oldAccount, oldRoom] = JSON.parse(oldKey);
        if (oldAccount === accountId && oldRoom === String(room.roomId)) snapshots.delete(oldKey);
      }
      snapshots.set(key, snapshot);
      while (snapshots.size > 200) snapshots.delete(snapshots.keys().next().value);
    }
  }
  return snapshot.record;
}

// 状态查询必须能描述目标场次结束；结束后不再依赖当前直播指标可读。
async function readRoomWatch(accountId, roomId, options = {}) {
  validateRoom(accountId, roomId, options.startTime);
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(25000)]) : AbortSignal.timeout(25000);
  const status = await require('./qianchuanTabs').fetchLiveStatus(accountId, { signal, priority: 1 });
  verifyLiveStatus(status);
  const checkedAt = new Date().toISOString();
  const matching = status.rooms.filter(room => String(room.roomId) === String(roomId));
  const room = matching.length ? selectLiveRoom(status, roomId) : null;
  const changed = room && options.startTime && sessionTime(room.startTime) !== sessionTime(options.startTime);
  const start = room?.startTime || options.startTime;
  const canonicalStart = start ? new Date(sessionTime(start) + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ') : null;
  const base = { accountId, accountName: accountId, isLive: !!room,
    status: changed ? 'session_changed' : room ? 'live' : options.startTime ? 'ended' : 'not_live',
    room: { room_id: String(roomId), start_time: room?.startTime || options.startTime || null },
    session_key: canonicalStart ? `${accountId}|${roomId}|${canonicalStart}` : null,
    fetchedAt: checkedAt, liveCheckedAt: checkedAt, dataValid: true, partial: false, stale: false, errors: [],
    live_metrics: null, source_type: 'live_status', available_rooms: status.rooms };
  if (!room || changed) return base;
  const record = await readRoomRecord(accountId, room, signal);
  return { ...base, session_key: record.session_key, fetchedAt: record.collected_at,
    live_metrics: record.live_metrics, dataValid: record.dataValid, partial: !record.dataValid,
    stale: Date.now() - Date.parse(record.collected_at) > 30000, errors: record.errors || [], source_type: 'room_core' };
}

async function readRoomDashboard(accountId, roomId, options = {}) {
  const { getAccountParams } = require('./api-helpers');
  validateRoom(accountId, roomId, options.startTime);
  const { fetchLiveStatus } = require('./qianchuanTabs');
  // 包含调用方的场次约束，旧场请求不能合并到新场请求。
  const requestKey = JSON.stringify([accountId, String(roomId), options.startTime || null]);
  let flight = flights.get(requestKey);
  if (!flight) {
    flight = (async () => {
      const signal = AbortSignal.timeout(25000);
      const status = await fetchLiveStatus(accountId, { signal, priority: 1 });
      const room = selectLiveRoom(status, roomId, options.startTime);
      const liveCheckedAt = new Date().toISOString();
      const record = await readRoomRecord(accountId, room, signal);
      return { record, room, liveCheckedAt };
    })().finally(() => { if (flights.get(requestKey) === flight) flights.delete(requestKey); });
    flights.set(requestKey, flight);
  }
  const { record, room, liveCheckedAt } = await flight;
  const metrics = record.live_metrics;
  const params = getAccountParams(accountId, { roomId });
  const planData = await readRoomPlan(accountId, record);
  return {
    ok: true, account: accountId, room_id: String(roomId), server_time: new Date().toISOString(),
    session_key: record.session_key, fetchedAt: record.collected_at, liveCheckedAt,
    source_type: 'room_core', component_times: record.component_times,
    dataValid: record.dataValid, stale: Date.now() - Date.parse(record.collected_at) > 30000,
    partial: true,
    live: { isLive: true, rooms: [{ ...room, cost: metrics.cost }] },
    live_metrics: metrics,
    today: record.dataValid ? { cost: metrics.cost, gmv: metrics.gmv, roi: metrics.roi,
      netGmv: metrics.gmvSettle, netRoi: metrics.roiSettle, orderCount: metrics.orders,
      orderCountPay: metrics.ordersPay, roi_basis: { roi: 'payment', netRoi: 'platform_net_1h' }, settlement_window: '1h' } : null,
    thresholds: params, break_even_roi: params.break_even_roi, target_roi: params.target_roi, target_roi_basis: params.target_roi_basis,
    decision_context: { scope: { account_id: accountId, room_id: String(roomId), session_key: record.session_key },
      metrics: { break_even_roi: params.break_even_roi }, operating: { target_roi: params.target_roi, target_roi_basis: params.target_roi_basis } },
    financial_basis: require('./decisionContext').buildLiveFinancialBasis(),
    ...planData,
    errors: [...(record.errors || []), ...(planData.errors || [])],
    materials_top: [], riskAlerts: [], suggestions: [],
    missing_components: [...(!planData.plan ? ['plan'] : []), ...(!planData.boost_data_valid ? ['boost'] : []), 'materials', 'funnel', 'channels'],
  };
}

// 房间来源于本户当前在播状态，主播来源于该房间 init。只匹配平台明确的房间关系，
// 或 roomId=0 时的同主播关系；账户默认计划、旧授权和名称均不能替代这条证据链。
function selectRoomPlan(result, { advertiserId, roomId, anchorId }) {
  if (Number(result?.status_code ?? result?.code) !== 0 || result.truncated === true
    || !Array.isArray(result?.data?.adInfos) || Object.keys(result.data.moduleErrors || {}).length) {
    throw roomError('room_plan_list_unavailable', '主计划列表不完整，暂不能核验房间归属', 502);
  }
  const matches = new Map();
  for (const ad of result.data.adInfos) {
    if (String(ad.advId) !== String(advertiserId) || Number(ad.marGoal) !== 2
      || !/^\d+$/.test(String(ad.id)) || (typeof ad.id === 'number' && !Number.isSafeInteger(ad.id))) continue;
    const relations = result.data.adRoomInfoMap?.[ad.id];
    if (!Array.isArray(relations)) continue;
    const exact = relations.some(r => String(r.id) === String(roomId)
      && (!r.anchor?.id || !anchorId || String(r.anchor.id) === String(anchorId)));
    const byAnchor = anchorId && relations.some(r => (!r.id || String(r.id) === '0')
      && String(r.anchor?.id) === String(anchorId));
    if (exact || byAnchor) matches.set(String(ad.id), { ad, source: exact ? 'platform_room' : 'platform_anchor' });
  }
  if (matches.size !== 1) return { ad: null, source: null,
    reason: matches.size ? 'primary_plan_ambiguous' : 'primary_plan_not_found',
    candidates: [...matches.keys()] };
  return { ...matches.values().next().value, reason: null, candidates: [...matches.keys()] };
}

function missingRoomPlan(reason, binding, errors = []) {
  return { plan: null, plan_binding: binding || null, boost_tasks: [], boost_summary: null,
    boost_data_valid: false, boost_source_at: null, boost_window: null, boost_truncated: false,
    boost_coverage: { complete: false, list_complete: false, returned: 0, reason }, errors };
}

async function collectRoomPlan(accountId, record, today) {
  const { resolveAavid } = require('./cookie');
  const { attachRoiGoalContract } = require('./roiBasis');
  const { parseTask, metricValueOrNull: value } = require('./boostTaskContract');
  const { fetchBoostList, fetchBoostSummary } = require('./qianchuanTabs');
  const identity = { account_id: accountId, room_id: record.room.room_id, session_key: record.session_key,
    start_time: record.room.start_time, anchor_id: record.room.anchor_id || null };
  let binding = { ...identity, primary_ad_id: null, data_valid: false, source_at: null };
  let plan = null;
  try {
    const plans = await require('./chengfangLive').fetchLivePlanList(today, today, accountId);
    const selected = selectRoomPlan(plans, { advertiserId: resolveAavid(accountId),
      roomId: identity.room_id, anchorId: identity.anchor_id });
    binding = { ...binding, source_at: plans.fetched_at || null, source: selected.source,
      primary_ad_id: selected.ad ? String(selected.ad.id) : null,
      data_valid: !!selected.ad, reason: selected.reason, candidates: selected.candidates };
    if (!selected.ad) return missingRoomPlan(selected.reason, binding);
    const ad = selected.ad, id = String(ad.id);
    const rawBudget = value(ad.budget);
    plan = { id, primary_ad_id: id, name: ad.name || '', status: ad.adDeliveryName || null,
      plan_type: ad.plan_type || 'uni_live', source_at: plans.fetched_at || null,
      roi_goal: value(ad.ecpRoi2Goal), ...attachRoiGoalContract(ad),
      budget: rawBudget == null ? null : rawBudget / 100000, spent_pct: null,
      budget_scope: 'unknown', boost_count: null, boost_max: null, quota_left: null };
    const [list, summaryResult] = await Promise.all([
      fetchBoostList(id, today, today, accountId, { includeAllStatus: true, marGoal: 2 }),
      fetchBoostSummary(id, today, today, accountId, { includeAllStatus: true, marGoal: 2 }).catch(() => null),
    ]);
    if (Number(list?.status_code ?? list?.code) !== 0 || !Array.isArray(list?.data?.adInfos))
      throw roomError('boost_list_unavailable', '追投列表暂不可用，任务数量未知', 502);
    const sourceAt = list.source_at || null;
    const window = { start: today, end: today, scope: 'daily' };
    const tasks = list.data.adInfos.map(task => parseTask(task, ad, list, {
      accountId, sourceAt, start: today, end: today, sessionKey: record.session_key, sessionStartTime: record.room.start_time,
    }));
    const complete = list.truncated !== true && !Object.keys(list.data.moduleErrors || {}).length;
    const metrics = Number(summaryResult?.status_code ?? summaryResult?.code) === 0
      ? summaryResult?.data?.totalMetrics?.metrics : null;
    return { plan: { ...plan, boost_count: complete ? tasks.length : null }, plan_binding: binding,
      boost_tasks: tasks, boost_data_valid: complete, boost_source_at: sourceAt, boost_window: window,
      boost_truncated: !complete,
      boost_coverage: { complete, list_complete: complete, returned: tasks.length, truncated: !complete,
        primary_ad_id: id, scope: 'primary_plan', status_scope: 'platform_default_without_active_filter',
        reason: complete ? null : 'boost_list_incomplete' },
      boost_summary: metrics ? { count: tasks.length, total_cost: value(metrics.statCostForRoi2Assist),
        total_gmv: value(metrics.totalPayOrderGmvForRoi2Assist), total_roi: value(metrics.totalPrepayAndPayOrderRoi2Assist),
        metric_roi_basis: { total_roi: 'payment' }, window } : null,
      errors: complete ? [] : [{ component: 'boost', code: 'boost_list_incomplete', retryable: true }] };
  } catch (error) {
    const reason = error.code || 'room_plan_unavailable';
    return { ...missingRoomPlan(reason, binding, [{ component: plan ? 'boost' : 'plan', code: reason, retryable: true }]), plan };
  }
}

async function readRoomPlan(accountId, record) {
  const today = require('./utils').getLocalDateStr();
  const key = JSON.stringify([accountId, record.session_key, record.room.anchor_id, today]);
  const cached = planSnapshots.get(key);
  if (cached && Date.now() - cached.at < 30000) return cached.value;
  if (!planFlights.has(key)) {
    const flight = collectRoomPlan(accountId, record, today).then(value => {
      planSnapshots.set(key, { at: Date.now(), value });
      while (planSnapshots.size > 200) planSnapshots.delete(planSnapshots.keys().next().value);
      return value;
    }).finally(() => planFlights.delete(key));
    planFlights.set(key, flight);
  }
  // 附加模块变慢不能一直挡住核心读数；在途请求仅源于此次读取，不开启轮询。
  let timer;
  try {
    return await Promise.race([planFlights.get(key), new Promise(resolve => {
      timer = setTimeout(() => resolve(missingRoomPlan('room_plan_loading', null)), 8000);
    })]);
  } finally { clearTimeout(timer); }
}

module.exports = { verifyLiveStatus, selectLiveRoom, readRoomDashboard, readRoomWatch, selectRoomPlan };
