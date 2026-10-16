'use strict';
const { readConfig } = require('./accountRegistry');
const { CONFIG_PATH } = require('./config');
const { readJsonBody, sendJSON, requireWriteAuth, getLocalDateStr } = require('./utils');
const { checkAgentWritePolicy } = require('./agentPolicy');
const { finiteNumber } = require('./dataContract');
const { boostStatus } = require('./writeReceipt');
const WRITE_ROUTES = new Set(['/api/campaign/status', '/api/campaign/budget', '/api/material/delete', '/api/material/rename',
  '/api/material/add', '/api/boost-create', '/api/boost-delete', '/api/flow-control', '/api/pending-ops/approve']);
const LIVE_READ_FAILURE = Symbol('live-read-failure');
const LIVE_READ_STATUS = Object.assign(Object.create(null), {
  cookie_expired: [401, false], upstream_bad_request: [400, false], upstream_forbidden: [403, false],
  upstream_locked: [423, true], rate_limited: [429, true], upstream_unavailable: [502, true],
  upstream_parse_error: [502, false], upstream_bad_response: [502, false], upstream_http_error: [502, false],
  upstream_timeout: [504, true], queue_timeout: [504, true], queue_wait_timeout: [504, true],
  exec_timeout: [504, true], request_timeout: [504, true], request_cancelled: [504, true],
  collector_board_timeout: [504, true], collector_intraday_timeout: [504, true],
  live_verification_failed: [403, false],
});
const LIVE_READ_COMPONENTS = new Set(['live_status', 'qianchuan_upstream', 'qianchuan_queue', 'http']);

// Preserve machine-readable read failures without exposing upstream messages,
// response bodies, credentials or arbitrary details through the write guard.
function liveReadFailure(value) {
  const input = value && typeof value === 'object' ? value : { error: value };
  let code = input.code;
  if (code === 'cookie_not_found' || input.message === 'cookie_expired' || input.error === 'cookie_expired'
      || input.message === 'cookie_not_found' || input.error === 'cookie_not_found') code = 'cookie_expired';
  if (typeof code !== 'string' || !LIVE_READ_STATUS[code]) {
    const httpStatus = Number.isInteger(input.statusCode) ? input.statusCode : null;
    code = ({ 401: 'cookie_expired', 403: 'upstream_forbidden', 423: 'upstream_locked',
      429: 'rate_limited', 504: 'upstream_timeout' })[httpStatus]
      || (httpStatus >= 500 && httpStatus < 600
        ? 'upstream_unavailable' : 'live_verification_failed');
  }
  const [statusCode, retryable] = LIVE_READ_STATUS[code];
  const message = code === 'cookie_expired' ? 'cookie_expired'
    : code === 'request_cancelled' ? '在播状态读取已取消，本次未写入'
    : statusCode === 504 ? '在播状态读取超时，本次未写入' : '在播状态读取失败，本次未写入';
  const error = Object.assign(new Error(message), {
    [LIVE_READ_FAILURE]: true, code, statusCode, advertising_writes: 0,
    retryable: typeof input.retryable === 'boolean' ? input.retryable : retryable,
    component: LIVE_READ_COMPONENTS.has(input.component) ? input.component : 'live_status',
  });
  const timeout = input.timeoutMs ?? input.timeout_ms;
  if (Number.isSafeInteger(timeout) && timeout > 0 && timeout <= 86400000) error.timeoutMs = timeout;
  return error;
}

// 网页与 MCP 经过同一权限边界；localhost 身份不等于账户投放授权。
function checkHttpWritePolicy(config, pathname, data = {}) {
  const deny = (code, error) => ({ allowed: false, code, error });
  if (!data || typeof data !== 'object' || Array.isArray(data)) return deny('invalid_json', '请求必须是 JSON 对象');
  if (data.accountId && data.account_id && data.accountId !== data.account_id) return deny('account_conflict', 'accountId 与 account_id 不一致');
  const id = data.accountId || data.account_id;
  if (!id || !config.qianchuan_accounts?.some(a => a.id === id)) return deny('account_required', '写操作必须指定已配置的账户');
  const policy = config.agent_policy?.account_policies
    ? config.agent_policy.account_policies[id] || {} : config.agent_policy || {};
  const scope = pathname.startsWith('/api/boost-') || (pathname.startsWith('/api/campaign/') && data.assistTaskId)
    ? 'boost' : pathname.startsWith('/api/campaign/') || pathname === '/api/flow-control' ? 'plan' : 'material';
  const basic = checkAgentWritePolicy(config.agent_policy, scope, id);
  if (!basic.allowed) return deny('account_write_not_enabled', basic.reason);
  let actions = [];
  if (pathname === '/api/boost-create') actions = ['create'];
  else if (pathname === '/api/boost-delete') actions = ['delete'];
  else if (pathname === '/api/campaign/status') actions = [({ 1: 'resume', 2: 'pause', 6: 'stop' })[data.status]].filter(Boolean);
  else if (pathname === '/api/campaign/budget') actions = Object.entries({
    budget: 'update_budget', durationSeconds: 'update_duration', roiGoal: 'update_roi', bid: 'update_bid', audienceTemplate: 'update_audience',
  }).filter(([field]) => data[field] != null).map(([, operation]) => operation);
  // 组合修改逐项授权；action 仅表示单一动作，不能借组合请求取得单项特殊增额许可。
  const action = actions.length === 1 ? actions[0] : undefined;
  const selectedScope = scope === 'boost' ? require('./agentPolicy').resolveBoostWriteScope(policy, data.primaryAdId) : { binding: null };
  if (selectedScope.code) return deny(selectedScope.code, selectedScope.error);
  const binding = selectedScope.binding;
  if (binding) {
    if (!actions.length || !Array.isArray(binding.allowed_actions) || actions.some(operation => !binding.allowed_actions.includes(operation))) return deny('action_outside_authorization', '该追投动作不在本次授权范围');
    for (const operation of actions) {
      const actionTargets = binding.action_target_ids?.[operation];
      if (actionTargets && (!Array.isArray(actionTargets) || !actionTargets.map(String).includes(String(data.assistTaskId)))) return deny('target_outside_authorization', '该动作只授权于指定追投任务');
      if (binding.action_expires_at?.[operation] && !(Date.parse(binding.action_expires_at[operation]) > Date.now())) return deny('action_authorization_expired', '该动作的临时授权已到期');
    }
    if (!binding.primary_ad_id || !binding.room_id || !binding.session_started_at) return deny('write_scope_incomplete', '追投授权缺少主计划或场次绑定');
    // 支持单个主计划或主计划数组
    const boundPlanIds = Array.isArray(binding.primary_ad_id)
      ? binding.primary_ad_id.map(String)
      : [String(binding.primary_ad_id)];
    const requestPlanId = String(data.primaryAdId || (action === 'delete' ? boundPlanIds[0] : ''));
    if (!boundPlanIds.includes(requestPlanId)) return deny('plan_outside_authorization', '主计划不在本次授权范围');
    if (data.assistTaskId && (policy.protected_object_ids || []).map(String).includes(String(data.assistTaskId))) return deny('protected_object', '该追投对象已被保护');
  }
  return { allowed: true, accountId: id, scope, action, actions, binding };
}

async function verifyBoostScope(check, data, readers = require('./qianchuanTabs')) {
  if (!check.binding) return;
  const fail = (code, message) => { throw Object.assign(new Error(message), { code, statusCode:403, advertising_writes:0 }); };
  const binding = check.binding;
  let live;
  try { live = await readers.fetchLiveStatus(check.accountId); }
  catch (error) { throw liveReadFailure(error); }
  // A failed read is never evidence that the authorized session has ended.
  if (!live || typeof live !== 'object' || Array.isArray(live) || live.error != null) throw liveReadFailure(live);
  const postLiveDeleteAuthorized = check.action === 'delete' && binding.allow_post_live_delete === true &&
    binding.action_target_ids?.delete?.map(String).includes(String(data.assistTaskId));
  const postLivePauseAuthorized = check.action === 'pause' && binding.allow_post_live_pause === true &&
    Array.isArray(binding.action_target_ids?.pause) &&
    binding.action_target_ids.pause.map(String).includes(String(data.assistTaskId)) &&
    Date.parse(binding.action_expires_at?.pause) > Date.now();
  let scopedPostLiveDelete = postLiveDeleteAuthorized && live.isLive === false;
  let scopedPostLivePause = false;
  const scopeTime = value => {
    if (value == null || value === '') return NaN;
    if (/^\d+(?:\.\d+)?$/.test(String(value))) return Number(value)<1e12 ? Number(value)*1000 : Number(value);
    const text=String(value).replace(' ','T');
    return Date.parse(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/.test(text) ? text+'+08:00' : text);
  };
  const startMs=scopeTime(binding.session_started_at);
  if (!Number.isFinite(startMs)) fail('write_scope_incomplete', '场次起始时间无效');
  const room=live.rooms?.find(r=>String(r.roomId)===String(binding.room_id));
  // An account may still have another live room after this bound session ends.
  // Absence alone is not proof: require the exact session's completed record.
  if ((!scopedPostLiveDelete && postLiveDeleteAuthorized && !room && live.isLive === true) ||
      (postLivePauseAuthorized && (live.isLive === false || (!room && live.isLive === true)))) {
    const history = await readers.fetchLiveSessions(getLocalDateStr(new Date(startMs)), { accountId: check.accountId });
    const matches = history?.sessions?.filter(item => String(item.roomId) === String(binding.room_id)
      && scopeTime(item.startTime) === startMs);
    const ended = matches?.length === 1 ? matches[0] : null;
    const endMs = scopeTime(ended?.endTime);
    const endedVerified = !history?.error && history?.data_valid !== false && String(ended?.status) === '4'
      && Number.isFinite(endMs) && endMs > startMs && endMs <= Date.now();
    scopedPostLiveDelete = postLiveDeleteAuthorized && endedVerified;
    scopedPostLivePause = postLivePauseAuthorized && endedVerified && Date.parse(binding.action_expires_at?.pause) > Date.now();
  }
  if (!scopedPostLiveDelete && !scopedPostLivePause && (!live.isLive || !room || scopeTime(room.startTime ?? room.start_time)!==startMs))
    fail('session_outside_authorization', '已下播或直播场次已变化，本次授权不适用于其他场次');
  const boundPlanIds = Array.isArray(binding.primary_ad_id)
    ? binding.primary_ad_id.map(String)
    : [String(binding.primary_ad_id)];
  // 使用请求中指定的主计划，如果未指定则用第一个授权计划
  const requestPlanId = data.primaryAdId ? String(data.primaryAdId) : boundPlanIds[0];
  if (!boundPlanIds.includes(requestPlanId)) fail('plan_outside_authorization', '主计划不在本次授权范围');
  // 底线只限制新建，不阻碍暂停。读取同一房间、同一开播时间的净成交口径。
  if (check.action === 'create' && binding.elimination?.room_floor_roi != null) {
    const floor = binding.elimination.room_floor_roi;
    if (typeof floor !== 'number' || !Number.isFinite(floor) || floor < 0)
      fail('invalid_room_floor_roi', 'room_floor_roi 必须是非负数');
    const sessions = await readers.fetchLiveSessions(getLocalDateStr(new Date(startMs)), { accountId: check.accountId });
    const matches = sessions?.sessions?.filter(item => String(item.roomId) === String(binding.room_id)
      && scopeTime(item.startTime) === startMs);
    const current = matches?.length === 1 ? matches[0] : null;
    const roi = finiteNumber(current?.netRoi);
    if (sessions?.error || sessions?.data_valid === false || String(current?.status) !== '2' || roi == null || roi < 0)
      fail('room_roi_unavailable', '本场净成交 ROI 未取得，不能判断新建底线');
    if (roi < floor) fail('room_floor_roi_breached', '本场净成交 ROI 低于新建底线');
  }
  const needsCapacity = ['create', 'resume'].includes(check.action) && binding.concurrency?.max_active_tasks != null;
  if (check.action === 'create' && !needsCapacity) return;
  if (check.action !== 'create' && !data.assistTaskId) fail('target_required', '必须指定追投任务 ID');
  const list = await readers.fetchBoostList(requestPlanId, getLocalDateStr(new Date(startMs)), getLocalDateStr(), check.accountId, { includeAllStatus: true });
  if ((list?.status_code ?? list?.code) !== 0) fail('target_verification_failed', '追投归属暂不可核验，本次未写入');
  if (scopedPostLivePause && !(Date.parse(binding.action_expires_at?.pause) > Date.now()))
    fail('action_authorization_expired', '下播暂停的限时授权已到期，本次未写入');
  if (needsCapacity) {
    const { min_active_tasks: minimum, max_active_tasks: maximum } = binding.concurrency;
    if (!Number.isSafeInteger(maximum) || maximum < 0 || (minimum != null && (!Number.isSafeInteger(minimum) || minimum < 0 || minimum > maximum)))
      fail('invalid_concurrency_limit', '追投数量范围必须是非负整数，且下限不大于上限');
    if (list.truncated !== false || list.data_valid === false || !Array.isArray(list.data?.adInfos))
      fail('boost_capacity_unavailable', '追投列表未完整核验，不能增加在投任务');
    const tasks = list.data.adInfos, ids = new Set();
    const inactive = task => [2, 6].includes(boostStatus(task)) || ['已完成', '已结束', '投放结束', '已删除', '已终止', '已停止'].includes(task.adDeliveryName);
    for (const task of tasks) {
      if (!task.id || ids.has(String(task.id)) || (boostStatus(task) !== 1 && !inactive(task)))
        fail('boost_capacity_unavailable', '追投列表存在重复、缺失身份或未知状态，不能计算上限');
      ids.add(String(task.id));
    }
    // 2026-09-30：未回读暴露只在本场范围内阻断新建/恢复。
    // 跨场次的历史 unconfirmed 行（create_boost 的 duration_seconds 平台不回读，永远无法确认）
    // 不再永久阻断该主计划；但本场自己的未回读请求仍必须阻断，防重复提交。
    const exposureFn = readers.getUnconfirmedBoostExposure || require('./operationLog').getUnconfirmedBoostExposure;
    const p2 = n => String(n).padStart(2, '0');
    const scopeDate = new Date(startMs);
    const sinceTs = `${scopeDate.getFullYear()}-${p2(scopeDate.getMonth() + 1)}-${p2(scopeDate.getDate())} `
      + `${p2(scopeDate.getHours())}:${p2(scopeDate.getMinutes())}:${p2(scopeDate.getSeconds())}`;
    const pending = exposureFn(check.accountId, requestPlanId, { sinceTs });
    if (pending.some(item => !item.target_id || !ids.has(String(item.target_id))))
      fail('boost_exposure_unconfirmed', '该计划存在尚未回读的创建或恢复请求，请先核验原请求');
    const legacy = exposureFn(check.accountId, requestPlanId).filter(item => !(String(item.ts) >= sinceTs));
    if (legacy.length) {
      console.warn(`[onboarding-guard] ${check.accountId}/${requestPlanId} 已跳过 ${legacy.length} 条早于本场（${sinceTs}）的未回读历史行：${legacy.map(i => i.id).join(',')}`);
    }
    const alreadyActive = check.action === 'resume' && tasks.some(task => String(task.id) === String(data.assistTaskId) && boostStatus(task) === 1);
    if (!alreadyActive && tasks.filter(task => boostStatus(task) === 1).length >= maximum)
      fail('concurrency_limit_exceeded', '该主计划已达到在投任务上限');
  }
  if (check.action === 'create') return;
  const task = list.data?.adInfos?.find(t => String(t.id) === String(data.assistTaskId));
  if (!task) fail('target_not_in_list', '当前列表未找到该任务，不能据此断言越权或已删除；先只读核对，本次未写入');
  const createdAt = Number(task.createTime) * 1000;
  // 默认仍按开播时间隔离；同日旧任务只能通过本场显式 ID 清单接管。
  const chinaDate = ms => new Date(ms + 8 * 3600000).toISOString().slice(0, 10);
  const carryover = Number.isFinite(createdAt) && createdAt < startMs
    && chinaDate(createdAt) === chinaDate(startMs) && Array.isArray(binding.carryover_task_ids)
    && binding.carryover_task_ids.map(String).includes(String(task.id));
  if (!Number.isFinite(createdAt) || (createdAt < startMs && !carryover) || createdAt > Date.now()) fail('target_outside_session', '任务不属于本场，且未列入本场同日接管清单');
  for (const action of check.actions || [check.action]) {
    const operation = ({ pause: 'pause', stop: 'finish', delete: 'delete', update_budget: 'edit',
      update_roi: 'edit', update_bid: 'edit', update_audience: 'edit', update_duration: 'edit' })[action];
    const permission = task.assistTaskInfoMap?.['2']?.operation?.[operation];
    if (permission?.editable === false) fail('upstream_action_blocked', permission.reason || '千川当前不允许该动作');
  }
  if (check.action === 'delete' && scopedPostLiveDelete &&
      boostStatus(task) !== 2 && String(task.adDeliveryName || '') !== '关联直播间未开播')
    fail('post_live_delete_status_invalid', '下播清理仅限已暂停或因直播结束而停止投放的指定任务');
  if (check.action === 'delete' && binding.elimination) {
    const metrics = list.data?.adStatsMap?.[String(task.id)]?.metrics;
    const decision = checkBoostElimination(metrics, binding.elimination);
    if (!decision.allowed) fail(decision.code, decision.error);
    if (binding.elimination.require_paused && boostStatus(task) !== 2) fail('pause_before_delete', '先暂停并在下一轮核验，不能直接删除仍在投的任务');
  }
}

function checkBoostElimination(metrics, rule) {
  const cell = value => value && typeof value === 'object'
    ? Number(value.controlType) === 0 ? null : finiteNumber(value.value ?? value.Value) : finiteNumber(value);
  const cost = cell(metrics?.statCostForRoi2Assist);
  const orders = cell(metrics?.totalPayOrderCountForRoi2Assist);
  const roi = cell(metrics?.totalPrepayAndPayOrderRoi2Assist);
  if (cost == null || cost < 0 || orders == null || !Number.isInteger(orders) || orders < 0 || (orders > 0 && (roi == null || roi < 0))) {
    return { allowed: false, code: 'elimination_data_unavailable', error: '消耗、成交或支付 ROI 缺失，禁止按零值删除' };
  }
  // 豁免门槛（可选字段）：订单数达到该值的任务不按淘汰线删除（成本保障门槛已达成）。
  if (rule.exempt_orders != null && orders >= Number(rule.exempt_orders)) {
    return { allowed: false, code: 'performing_boost_protected', error: `已出 ${orders} 单达到豁免门槛 ${rule.exempt_orders}，不按淘汰线删除（要动先报用户）` };
  }
  if ((orders === 0 && cost >= rule.zero_order_min_cost) || (orders > 0 && roi < rule.order_roi_below)) return { allowed: true };
  return { allowed: false, code: 'performing_boost_protected', error: '最新数据未触发淘汰线：有成交且支付 ROI 达标或尚未达到试错金额，禁止删除' };
}

async function enforceOnboardingGuard(req, res, url) {
  if (!WRITE_ROUTES.has(url.pathname) || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true;
  if (!requireWriteAuth(req, res)) return false;
  const parsed = await readJsonBody(req);
  if (parsed.error) { sendJSON(res, { ok: false, code: 'invalid_json' }, 400); return false; }
  const config = readConfig(CONFIG_PATH);
  const check = checkHttpWritePolicy(config, url.pathname, parsed.data);
  if (!check.allowed) {
    sendJSON(res, { ok: false, code: check.code, error: check.error, advertising_writes: 0 }, 403);
    return false;
  }
  if (check.binding && check.action === 'delete' && !parsed.data.primaryAdId) {
    const plans = Array.isArray(check.binding.primary_ad_id) ? check.binding.primary_ad_id : [check.binding.primary_ad_id];
    if (plans.length !== 1) {
      sendJSON(res, {ok:false,code:'primary_plan_required',error:'多个授权主计划时必须显式指定 primaryAdId',effect_status:'rejected',advertising_writes:0},400);
      return false;
    }
    parsed.data.primaryAdId = String(plans[0]);
  }
  if (check.scope === 'boost') {
    try {
      require('./boostExecutionOwner').assertBoostExecutionOwner(req, check.accountId, parsed.data.primaryAdId);
      require('./browserBoostRequests').assertNoUnknownBrowserRequest(check.accountId, parsed.data.primaryAdId);
      require('./browserBoostRequests').assertBrowserRequestIdUnused(check.accountId,parsed.data.requestId);
    }
    catch (error) { sendJSON(res, {ok:false,code:error.code,error:error.message,effect_status:'rejected',advertising_writes:0},409); return false; }
  }
  try { await verifyBoostScope(check, parsed.data); }
  catch (error) {
    const readFailure = error[LIVE_READ_FAILURE] === true;
    sendJSON(res, { ok: false, code: error.code || 'write_scope_verification_failed', error: error.message,
      ...(readFailure ? { component: error.component, retryable: error.retryable,
        timeout_ms: error.timeoutMs || null, partial: false, errors: [] } : {}),
      effect_status:'rejected',retry_write:false,next_step:'只读核对账户、场次和目标状态后重新判断',advertising_writes: 0 }, readFailure ? error.statusCode : 403);
    return false;
  }
  if (check.binding && check.action === 'delete') {
    const deleteBoundPlanIds = Array.isArray(check.binding.primary_ad_id)
      ? check.binding.primary_ad_id.map(String)
      : [String(check.binding.primary_ad_id)];
    if (!parsed.data.primaryAdId) parsed.data.primaryAdId = deleteBoundPlanIds[0];
  }
  req._qcWriteAuthorization = check;
  return true;
}
// 数量预检与提交共用主计划锁；仅对同一服务进程内的请求互斥。
async function runGuardedWrite(req, res, url, handler) {
  const run = async () => { if (await enforceOnboardingGuard(req, res, url)) return handler(req, res, url); };
  if (!WRITE_ROUTES.has(url.pathname) || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return run();
  if (!requireWriteAuth(req, res)) return;
  const { data, error } = await readJsonBody(req);
  if (error || !data || typeof data !== 'object') return run();
  const account = data.accountId || data.account_id;
  const boost = url.pathname.startsWith('/api/boost-') || (url.pathname.startsWith('/api/campaign/') && data.assistTaskId);
  if (!boost || !account || !data.primaryAdId) return run();
  return require('./targetWriteLock').withTargetWriteLock(account, `boost-scope:${data.primaryAdId}`, run);
}
module.exports = { enforceOnboardingGuard, runGuardedWrite, WRITE_ROUTES, checkHttpWritePolicy, verifyBoostScope, checkBoostElimination };
