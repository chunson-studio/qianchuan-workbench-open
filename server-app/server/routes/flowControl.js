const { sendJSON, readJsonBody, requireWriteAuth, handleApiError, getLocalDateStr, checkBodyKeys } = require('../lib/utils');
const { fetchUniPromAdList } = require('../lib/qianchuanTabs');
const { createFlowControlTask } = require('../lib/qianchuan');
const { validateAccount } = require('../lib/api-helpers');
const { executeWithReceipt } = require('../lib/writeReceipt');
const { withTargetWriteLock } = require('../lib/targetWriteLock');
const opLog = require('../lib/operationLog');

function parseFlowControlState(plan) {
  const info = plan && plan.interfereToolInfo || {};
  const task = plan && plan.assistTaskInfoMap && plan.assistTaskInfoMap['1'] || null;
  const budgetRaw = task?.budget == null ? NaN : Number(task.budget);
  const startSeconds = task?.startTime == null ? NaN : Number(task.startTime);
  const endSeconds = task?.endTime == null ? NaN : Number(task.endTime);
  const create = task?.operation?.create;
  const createAllowed = typeof create?.editable === 'boolean' ? create.editable : null;
  const active = !!(task && task.operation && task.operation.finish && task.operation.finish.editable === true)
    || Number(info.interfereToolStatusForStrategy) === 1;
  return {
    available: !!plan,
    active,
    task_id: task && task.id != null ? String(task.id) : null,
    budget: Number.isFinite(budgetRaw) ? +(budgetRaw / 100000).toFixed(2) : null,
    start_time: info.startTime || (Number.isFinite(startSeconds) ? new Date(startSeconds * 1000).toISOString() : null),
    end_time: info.endTime || (Number.isFinite(endSeconds) ? new Date(endSeconds * 1000).toISOString() : null),
    status_for_show: info.interfereToolStatusForShow ?? null,
    status_for_strategy: info.interfereToolStatusForStrategy ?? null,
    create_allowed: createAllowed,
    create_block_reason: createAllowed === false ? create.reason || create.message || create.tip || 'upstream_create_disallowed'
      : createAllowed == null ? 'create_permission_unknown' : null,
    finish_available: !!(task && task.operation && task.operation.finish && task.operation.finish.editable === true),
    stop_supported: false,
    can_end_early: false,
    stop_block_reason: 'stop_endpoint_not_integrated',
    roi_changed: false,
    source: 'uni_promotion.plan_required_module_29_or_optional.assistTaskInfoMap.1',
  };
}

async function readFlowControlState(accountId, primaryAdId) {
  const today = getLocalDateStr();
  const required = await fetchUniPromAdList(today, today, accountId);
  const requiredPlans = required && required.data && Array.isArray(required.data.adInfos) ? required.data.adInfos : [];
  const requiredPlan = requiredPlans.find(item => String(item.id) === String(primaryAdId));
  if (!requiredPlan) {
    const error = new Error(`主计划 ${primaryAdId} 不存在或当前账号不可见`);
    error.statusCode = 404;
    throw error;
  }
  return {
    ok: true,
    account_id: accountId,
    primary_ad_id: String(primaryAdId),
    plan_status: requiredPlan.status == null ? null : requiredPlan.status,
    flow_control: parseFlowControlState(requiredPlan),
    fetched_at: new Date().toISOString(),
  };
}

async function handleFlowControl(req, res, url) {
  const accountId = url.searchParams.get('account') || url.searchParams.get('accountId');
  const primaryAdIdQuery = url.searchParams.get('primaryAdId') || url.searchParams.get('primary_ad_id');
  if (!accountId) return sendJSON(res, { ok: false, error: 'Missing account/accountId' }, 400);
  try { validateAccount(accountId); } catch (error) { return sendJSON(res, { ok: false, error: error.message }, 400); }

  try {
    if (req.method === 'GET') {
      if (!primaryAdIdQuery) return sendJSON(res, { ok: false, error: 'Missing primaryAdId' }, 400);
      return sendJSON(res, await readFlowControlState(accountId, primaryAdIdQuery));
    }
    if (req.method !== 'POST') return sendJSON(res, { ok: false, error: 'Method Not Allowed' }, 405);
    if (!requireWriteAuth(req, res)) return;
    const { data, error } = await readJsonBody(req);
    if (error) return sendJSON(res, { ok: false, error: error.message }, error.status);
    const bodyCheck = checkBodyKeys(data, ['accountId', 'account_id', 'primaryAdId', 'primary_ad_id', 'budget', 'durationMinutes', 'source'], '/api/flow-control');
    if (!bodyCheck.ok) return sendJSON(res, { ok: false, error: bodyCheck.error }, 400);
    const bodyAccount = data.accountId || data.account_id;
    const primaryAdId = data.primaryAdId || data.primary_ad_id || primaryAdIdQuery;
    if (bodyAccount !== accountId) return sendJSON(res, { ok: false, error: 'URL 与 body 的 accountId 不一致' }, 400);
    if (!primaryAdId) return sendJSON(res, { ok: false, error: 'Missing primaryAdId' }, 400);
    const budget = Number(data.budget);
    const durationMinutes = data.durationMinutes == null ? 30 : Number(data.durationMinutes);
    if (!Number.isFinite(budget) || budget < 100 || budget > 5000) {
      return sendJSON(res, { ok: false, error: '一键控量预算须为 100~5000 元' }, 400);
    }
    if (durationMinutes !== 30) {
      return sendJSON(res, { ok: false, error: 'flow_control_duration_not_captured：当前仅支持已验证的30分钟' }, 400);
    }

    return await withTargetWriteLock(accountId, primaryAdId, async () => {
    const before = await readFlowControlState(accountId, primaryAdId);
    if (before.flow_control.active || before.flow_control.create_allowed !== true) {
      const active = before.flow_control.active;
      return sendJSON(res, { ok: false,
        code: active ? 'flow_control_already_active' : before.flow_control.create_allowed === false ? 'flow_control_create_disallowed' : 'flow_control_permission_unknown',
        error: active ? '已有进行中的一键控量任务，禁止重复创建' : before.flow_control.create_block_reason,
        source: 'upstream_permission', readback: before.flow_control }, 423);
    }

    const receipt = await executeWithReceipt({
      write: () => createFlowControlTask(primaryAdId, budget, durationMinutes * 60, accountId),
      read: async () => {
        const state = (await readFlowControlState(accountId, primaryAdId)).flow_control;
        return { ...state, duration_minutes: state.start_time && state.end_time
          ? (new Date(state.end_time) - new Date(state.start_time)) / 60000 : null };
      },
      before: before.flow_control, requested: { active: true, budget, duration_minutes: durationMinutes },
      logEntry: { action: 'start_flow_control', account_id: accountId, primary_ad_id: String(primaryAdId),
        target_type: 'flow_control', target_id: String(primaryAdId), params: { budget, duration_minutes: durationMinutes, roi_changed: false },
        source: opLog.normalizeSource(data.source) },
    });
    return sendJSON(res, { ...receipt, stop_supported: false, can_end_early: false }, receipt.ok ? 200 : (receipt.http_status || 502));
    });

  } catch (error) {
    return handleApiError(res, error);
  }
}

module.exports = handleFlowControl;
module.exports.parseFlowControlState = parseFlowControlState;
module.exports.readFlowControlState = readFlowControlState;
