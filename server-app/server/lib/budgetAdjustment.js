'use strict';
function checkBudgetAdjustment({budget, expectedBudget, current, boost, authorization, accountId, primaryAdId, assistTaskId}) {
  const fail = (code, message, statusCode = 400) => { throw Object.assign(new Error(message), {
    code, statusCode, skipOpLog:true, advertising_writes:0,
    details:{expected_budget:expectedBudget ?? null,current_budget:current,requested_budget:budget},
  }); };
  if (!Number.isFinite(current) || current <= 0) fail('target_parameter_unavailable', '当前预算不可核验', 423);
  if (expectedBudget !== undefined && Math.abs(current - expectedBudget) > 0.00001) fail('budget_conflict', '预算已被其他操作修改，本次未写入；重新读取后重新判断', 409);
  const increase = budget - current;
  if (Math.abs(increase) / current <= 0.5 + 1e-9) return;
  const binding = authorization?.binding;
  const boundPlans = Array.isArray(binding?.primary_ad_id) ? binding.primary_ad_id.map(String) : [String(binding?.primary_ad_id ?? '')];
  const boundTasks = binding?.action_target_ids?.update_budget;
  const targetBindingMatches = boundTasks === undefined || (Array.isArray(boundTasks) && boundTasks.map(String).includes(String(assistTaskId)));
  const scopedAuthorization = authorization?.allowed === true && authorization.scope === 'boost'
    && authorization.action === 'update_budget' && authorization.accountId === accountId
    && boundPlans.includes(String(primaryAdId))
    && Array.isArray(binding?.allowed_actions) && binding.allowed_actions.includes('update_budget')
    && Boolean(binding?.room_id) && Boolean(binding?.session_started_at) && targetBindingMatches;
  const allowed = binding?.budget_adjustment?.max_increase_yuan;
  // 只放行本场显式授权的追投增额；请求体不能自行抬高护栏。
  if (boost && scopedAuthorization && expectedBudget !== undefined && increase > 0
    && typeof allowed === 'number' && Number.isFinite(allowed) && allowed > 0 && increase <= allowed + 1e-9) return;
  fail('budget_increase_not_authorized', '预算变化超过50%；追投增加须有本场 budget_adjustment.max_increase_yuan 授权及 expected_budget，不会自动拆单或缩小金额');
}
module.exports = {checkBudgetAdjustment};
