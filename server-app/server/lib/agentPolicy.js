'use strict';

const WRITE_KEYS = {
  plan: 'allow_plan_write',
  boost: 'allow_boost_write',
  material: 'allow_material_write'
};

function checkAgentWritePolicy(policy, scope, accountId) {
  // The Agent decides whether to call a write tool. Legacy policy modes and
  // allow_* flags are data, not an additional workbench approval layer.
  if (typeof accountId !== 'string' || !accountId.trim()) {
    return { allowed: false, mode: 'agent_decides', reason: '操作必须显式指定账户' };
  }
  if (!Object.hasOwn(WRITE_KEYS, scope)) {
    return { allowed: false, mode: 'agent_decides', reason: `未知操作域：${scope}` };
  }
  return { allowed: true, mode: 'agent_decides', reason: '是否执行由调用 Agent 根据用户指令决定' };
}

function toMcpBlockResult(check, scope, action) {
  return {
    content: [{
      type: 'text',
      text: `Error: 操作参数无效（${scope}:${action}）——${check.reason}。`
    }],
    isError: true,
    structuredContent:{ok:false,code:'invalid_write_target',effect_status:'rejected',
      advertising_writes:0,retry_write:false,message:check.reason}
  };
}

// 一个广告户可以同时绑定多份直播间策略，按请求主计划唯一选取，绝不取第一份。
function resolveBoostWriteScope(policy, primaryAdId) {
  if (!policy?.boost_write_scopes) return { binding: policy?.boost_write_scope || null };
  if (!Array.isArray(policy.boost_write_scopes) || policy.boost_write_scope)
    return { code: 'write_scope_ambiguous', error: '多直播间 scope 配置不合法或与单一 scope 冲突' };
  const matches = policy.boost_write_scopes.filter(scope => {
    const plans = Array.isArray(scope?.primary_ad_id) ? scope.primary_ad_id : [scope?.primary_ad_id];
    return primaryAdId != null && plans.map(String).includes(String(primaryAdId));
  });
  if (matches.length !== 1) return { code: matches.length ? 'write_scope_ambiguous' : 'plan_outside_authorization',
    error: '必须显式指定且唯一匹配本直播间策略的主计划' };
  return { binding: matches[0] };
}

// Keep the existing MCP response shape while declaring who makes decisions.
function describeExecutionPolicy(policy, accountId) {
  const selected = policy?.account_policies ? policy.account_policies[accountId] : policy;
  const scopes = Object.fromEntries(Object.keys(WRITE_KEYS).map(scope => {
    const check = checkAgentWritePolicy(policy, scope, accountId);
    return [scope, { permitted_by_policy: check.allowed, reason: check.reason }];
  }));
  const binding = selected?.boost_write_scope;
  const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
  const knownActions = ['create', 'pause', 'resume', 'stop', 'delete', 'update_budget', 'update_duration', 'update_roi', 'update_bid', 'update_audience'];
  const actionMap = value => pick(value, knownActions);
  const projectScope = binding => binding && typeof binding === 'object' ? {
    ...pick(binding, ['primary_ad_id', 'room_id', 'session_started_at', 'allow_post_live_delete', 'allow_post_live_pause', 'carryover_task_ids']),
    ...(Object.hasOwn(binding, 'allowed_actions') ? { allowed_actions: (Array.isArray(binding.allowed_actions) ? binding.allowed_actions : []).filter(action => knownActions.includes(action)) } : {}),
    ...(binding.elimination ? { elimination: pick(binding.elimination, ['zero_order_min_cost', 'order_roi_below', 'require_paused', 'exempt_orders', 'room_floor_roi']) } : {}),
    ...(binding.concurrency ? { concurrency: pick(binding.concurrency, ['min_active_tasks', 'max_active_tasks']) } : {}),
    ...(binding.hysteresis_rules ? { hysteresis_rules: pick(binding.hysteresis_rules, ['pause_active_below', 'resume_paused_at_or_above', 'hard_stop_below', 'zero_order_gate_yuan', 'recorded_at']) } : {}),
    ...(binding.judgment_basis ? { judgment_basis: pick(binding.judgment_basis, ['primary', 'primary_field', 'recorded_at']) } : {}),
    ...(binding.budget_adjustment ? { budget_adjustment: pick(binding.budget_adjustment, ['max_increase_yuan']) } : {}),
    ...(binding.action_target_ids ? { action_target_ids: actionMap(binding.action_target_ids) } : {}),
    ...(binding.action_expires_at ? { action_expires_at: actionMap(binding.action_expires_at) } : {}),
  } : null;
  return {
    source: 'agent_capabilities',
    decision_owner: 'agent',
    configured_mode: 'agent_decides',
    effective_mode: 'agent_decides',
    global_read_only: false,
    onboarding_managed: false,
    scopes,
    boost_write_scope: projectScope(binding),
    ...(selected?.boost_write_scopes ? { boost_write_scopes: Array.isArray(selected.boost_write_scopes)
      ? selected.boost_write_scopes.map(projectScope) : [] } : {}),
    requires_live_write_precheck: true,
  };
}

module.exports = { WRITE_KEYS, checkAgentWritePolicy, toMcpBlockResult, describeExecutionPolicy, resolveBoostWriteScope };
