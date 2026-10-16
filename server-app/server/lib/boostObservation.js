'use strict';
const { finiteNumber: n, timestamp } = require('./dataContract');
const { baseline, deltaValues } = require('./materialChanges');

function materialLinks(text) {
  try {
    // Embedded JSON carries 19 digit IDs as numbers. Preserve digits before JSON.parse.
    const rows = JSON.parse(String(text || '[]').replace(/("MaterialID"\s*:\s*)(\d+)/g, '$1"$2"'));
    if (!Array.isArray(rows)) return { material_ids: [], material_link_complete: false };
    const ids = rows.map(r => r.MaterialID).filter(id => typeof id === 'string' && /^\d+$/.test(id));
    return { material_ids: [...new Set(ids)], material_link_complete: rows.length > 0 && ids.length === rows.length,
      material_link_source: 'assist_material_infos.MaterialID' };
  } catch { return { material_ids: [], material_link_complete: false }; }
}

function stopReason(task) {
  const status = String(task.status || '');
  const code = /任务预算不足|预算耗尽/.test(status) ? 'task_budget_exhausted'
    : /计划组超出预算|计划预算不足/.test(status) ? 'plan_budget_exhausted'
    : /未开播/.test(status) ? 'room_offline'
    : /已删除|素材删除/.test(status) ? 'deleted'
    : /已结束|已完成/.test(status) ? 'ended'
    : /暂停/.test(status) ? 'manual_or_operator_paused'
    : /投放中|调控中/.test(status) ? null : 'unknown_status';
  return { code, raw_status: task.status || null, source: 'platform_status',
    system_stopped: ['task_budget_exhausted', 'plan_budget_exhausted', 'room_offline'].includes(code) ? true
      : code === 'unknown_status' ? null : false };
}

function freshnessOf(value, now) {
  const at = timestamp(value);
  if (!at) return { value: 'unavailable', age_ms: null };
  const age = now - Date.parse(at);
  if (age < 0) return { value: 'future', age_ms: age };
  return { value: age > 90000 ? 'stale' : 'fresh', age_ms: age };
}

class BoostObservation {
  constructor() { this.accounts = new Map(); }
  enrich(account, tasks, { sessionKey, now = Date.now(), complete, excluded = [] } = {}) {
    let state = this.accounts.get(account);
    if (!state || state.sessionKey !== sessionKey) state = { sessionKey, history: new Map(), previous: new Map() };
    const current = new Map(tasks.map(t => [String(t.id), t]));
    const exits = [...state.previous.keys()].filter(id => !current.has(id)).map(id => {
      const found = excluded.find(t => t.id === id);
      return { id, status: found?.status || null, reason: found?.reason || (complete ? 'not_returned_not_proof_of_end' : 'list_incomplete'),
        confirmed_ended: !!found && /已结束|已完成|已删除|素材删除/.test(found.status) };
    });
    for (const t of tasks) {
      const at = timestamp(t.metrics_source_at), key = String(t.id), frames = state.history.get(key) || [];
      const parameterFreshness = freshnessOf(t.parameters_source_at, now);
      const metricsFreshness = t.metrics_freshness_override || freshnessOf(t.metrics_source_at, now);
      const row = { source_at: at, scope: t.window?.scope || 'unknown', query_window: t.window,
        spend: n(t.cost), payment_orders: n(t.order_count), net_gmv: n(t.net_gmv) };
      const before = at && baseline(frames, at);
      t.recent_changes = deltaValues(row, before);
      t.recent_changes.session_key = sessionKey || null;
      if (!sessionKey) { t.recent_changes.data_valid = false; t.recent_changes.reason = 'session_unknown'; }
      if (at && now - Date.parse(at) > 90000) { t.recent_changes.data_valid = false; t.recent_changes.reason = 'source_stale'; }
      if (['unknown', 'unavailable', 'future', 'stale'].includes(metricsFreshness.value)) {
        t.recent_changes.data_valid = false;
        t.recent_changes.reason = 'metrics_not_current_live_evidence';
      }
      if (at && (!frames.length || Date.parse(at) > Date.parse(frames.at(-1).source_at))) frames.push(row);
      state.history.set(key, frames.filter(f => Date.parse(f.source_at) >= now - 90 * 60000).slice(-120));
      t.stop_reason = stopReason(t);
      t.parameters_freshness = parameterFreshness;
      t.metrics_freshness = metricsFreshness;
      t.missing_fields = ['bid_mode', 'budget', 'parameters_source_at', 'metrics_source_at', 'net_roi', 'order_count']
        .filter(k => t[k] == null || t[k] === 'unknown');
      if (parameterFreshness.value === 'stale' || parameterFreshness.value === 'future') t.missing_fields.push('parameters_source_stale');
      if (metricsFreshness.value === 'stale' || metricsFreshness.value === 'future' || metricsFreshness.value === 'unknown') t.missing_fields.push('metrics_source_stale');
      if (t.bid_mode === 'manual_bid' && t.bid == null) t.missing_fields.push('bid');
      if (t.bid_mode === 'roi' && t.roi_goal == null) t.missing_fields.push('roi_goal');
      if (!t.material_link_complete) t.missing_fields.push('material_links');
      if (t.budget_remaining == null) t.missing_fields.push('budget_remaining');
      if (!t.recent_changes.data_valid) t.missing_fields.push('recent_window');
      t.audit_ready = t.missing_fields.length === 0;
      if (t.missing_fields.length) t.supplement = { tool: 'manage_boost', action: 'detail', target_id: t.id, primary_ad_id: t.primary_ad_id,
        start: t.window?.start, end: t.window?.end, unavailable: ['session_attribution'] };
    }
    // Keep missing IDs until a platform status explains the exit, including a partial list.
    for (const exit of exits) if (exit.confirmed_ended) state.previous.delete(exit.id);
    for (const [id, t] of current) state.previous.set(id, t);
    this.accounts.delete(account); this.accounts.set(account, state);
    while (this.accounts.size > 50) this.accounts.delete(this.accounts.keys().next().value);
    return { returned: tasks.length, list_complete: complete === true, truncated: complete !== true,
      audit_ready: tasks.filter(t => t.audit_ready).length, missing_task_fields: tasks.filter(t => !t.audit_ready).map(t => ({ id: t.id, fields: t.missing_fields })),
      exits, no_tasks_confirmed: complete === true && tasks.length === 0 && exits.length === 0 };
  }
}
module.exports = { materialLinks, stopReason, BoostObservation };
