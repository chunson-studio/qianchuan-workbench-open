const cents = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
  && Number.isSafeInteger(Math.round(value * 100)) ? Math.round(value * 100) : null;
const yuan = value => value === null ? null : value / 100;
const sameDay = window => /^\d{4}-\d{2}-\d{2}$/.test(window?.start ?? '') && window.start === window.end;

// Input: verified single-day pool; budget and cost in yuan; task IDs as strings.
// Output: official limits and estimated releasable funds. No browser or file writes.
export function calculateCostControlBudget({pool, task_ids = null}) {
  if (!pool || !Array.isArray(pool.tasks)) throw Error('task_pool_required');
  if (task_ids !== null && (!Array.isArray(task_ids) || task_ids.some(id => typeof id !== 'string' || !/^\d+$/.test(id))))
    throw Error('invalid_task_ids');
  const issues = [...(pool.issues ?? [])];
  if (!sameDay(pool.window)) issues.push('single_day_required');
  if (pool.complete !== true) issues.push('incomplete_pool');
  const ids = task_ids === null
    ? [...new Set(pool.tasks.filter(t => t.type === '控成本追投' && !t.status?.includes('已删除')).map(t => t.task_id))]
    : [...new Set(task_ids)];
  const tasks = ids.map(task_id => {
    const matches = pool.tasks.filter(t => t.task_id === task_id), errors = [];
    if (typeof task_id !== 'string' || !/^\d+$/.test(task_id)) errors.push('invalid_task_id');
    if (matches.length !== 1) errors.push(matches.length ? 'duplicate_task_id' : 'task_not_found');
    const task = matches.length === 1 ? matches[0] : null;
    const budget = cents(task?.budget), cost = cents(task?.cost);
    if (task) {
      if (task.type !== '控成本追投') errors.push('not_cost_control');
      if (!sameDay(task.window) || task.window.start !== pool.window?.start) errors.push('task_window_mismatch');
      if (budget === null || cost === null) errors.push('task_budget_or_cost_unknown');
    }
    const releasable = errors.length ? null : task.status?.includes('已删除') ? 0 : Math.max(0, budget - cost);
    issues.push(...errors.map(error => `${error}:${task_id}`));
    return {task_id, budget: yuan(budget), cost: yuan(cost), releasable_budget: yuan(releasable)};
  });
  const releasable = issues.length ? null : tasks.reduce((sum, task) => sum + cents(task.releasable_budget), 0);
  const total = cents(pool.daily_budget), available = cents(pool.remaining_budget);
  if (total === null || available === null) issues.push('official_budget_unknown');
  let estimated = releasable !== null && total !== null && available !== null ? available + releasable : null;
  if (total !== null && available !== null && (available > total || estimated > total)) {
    issues.push('budget_snapshot_inconsistent');
    estimated = null;
  }
  return {
    window: pool.window, scope: task_ids === null ? 'read_pool' : 'selected_tasks',
    daily_budget: yuan(total), remaining_budget: yuan(available), tasks,
    releasable_budget: yuan(releasable), estimated_remaining_budget: yuan(estimated),
    complete: issues.length === 0, issues: [...new Set(issues)]
  };
}
