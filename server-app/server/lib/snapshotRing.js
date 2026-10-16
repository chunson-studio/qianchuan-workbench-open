'use strict';

const { diffMetrics } = require('./dataContract');
const { contentVersion } = require('./watchContract');

class SnapshotRing {
  constructor(options = {}) {
    this.ttlMs = Number.isFinite(+options.ttlMs) ? +options.ttlMs : 2 * 60 * 60 * 1000;
    this.maxPerAccount = Number.isFinite(+options.maxPerAccount) ? +options.maxPerAccount : 24;
    this.maxAccounts = Number.isFinite(+options.maxAccounts) ? +options.maxAccounts : 50;
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.byAccount = new Map();
  }

  prune() {
    const cutoff = this.now() - this.ttlMs;
    for (const [accountId, records] of this.byAccount) {
      const kept = records.filter(record => record.storedAt >= cutoff);
      if (kept.length) this.byAccount.set(accountId, kept);
      else this.byAccount.delete(accountId);
    }
    while (this.byAccount.size > this.maxAccounts) {
      this.byAccount.delete(this.byAccount.keys().next().value);
    }
  }

  put(summary) {
    const accountId = summary && summary.meta && summary.meta.account_id;
    const snapshotId = summary && summary.snapshot_id;
    if (!accountId || !snapshotId) return false;
    this.prune();
    const records = this.byAccount.get(accountId) || [];
    const filtered = records.filter(record => record.summary.snapshot_id !== snapshotId);
    filtered.push({ storedAt: this.now(), summary });
    this.byAccount.set(accountId, filtered.slice(-this.maxPerAccount));
    return true;
  }

  get(accountId, snapshotId) {
    if (!accountId || !snapshotId) return null;
    this.prune();
    const records = this.byAccount.get(String(accountId)) || [];
    const record = records.find(item => item.summary.snapshot_id === snapshotId);
    return record ? record.summary : null;
  }

  delta(summary, previousSnapshotId) {
    const accountId = summary && summary.meta && summary.meta.account_id;
    const previous = this.get(accountId, previousSnapshotId);
    this.put(summary);
    if (!previous) return { ...summary, mode: 'summary', delta_available: false, reset_reason: 'snapshot_not_found' };
    if (previous.meta.session_key !== summary.meta.session_key) {
      return { ...summary, mode: 'summary', delta_available: false, reset_reason: 'session_changed' };
    }
    if (previous.meta.schema_version !== summary.meta.schema_version) {
      return { ...summary, mode: 'summary', delta_available: false, reset_reason: 'schema_changed' };
    }
    const key = item => item.alert_id || contentVersion(item);
    const previousAlertCodes = new Set((previous.alerts || []).map(key));
    const currentAlertCodes = new Set((summary.alerts || []).map(key));
    const previousMaterialIds = new Set((previous.materials || []).map(item => String(item.material_id)));
    const currentMaterialIds = new Set((summary.materials || []).map(item => String(item.material_id)));
    const meta = summary.meta || {};
    return {
      ok: summary.ok,
      mode: 'delta',
      snapshot_id: summary.snapshot_id,
      previous_snapshot_id: previousSnapshotId,
      // 可信状态每轮都保留；业务绝对值已存在于调用方持有的上一快照，不再重复整包。
      meta: {
        schema_version: meta.schema_version,
        account_id: meta.account_id,
        session_key: meta.session_key,
        generated_at: meta.generated_at,
        source_at: meta.source_at,
        age_ms: meta.age_ms,
        freshness: meta.freshness,
        data_valid: meta.data_valid,
        stale: meta.stale,
        partial: meta.partial,
        errors: meta.errors || [],
      },
      changes: diffMetrics(previous.metrics, summary.metrics),
      // Safety and status fields are absolute on every delta; no cached true can hide live end.
      live: summary.live,
      components: summary.components,
      financial_checks: summary.financial_checks,
      financial_basis: summary.financial_basis,
      metrics_scope: summary.metrics_scope,
      plan: summary.plan,
      boosts: summary.boosts,
      boost_coverage: summary.boost_coverage,
      // Full compact component carries both top-N and explicit missing/pending objects.
      ...(summary.material_changes ? { material_changes: summary.material_changes } : {}),
      boost_exits: (previous.boosts || []).filter(t => !(summary.boosts || []).some(c => String(c.id) === String(t.id))).map(t =>
        (summary.boost_coverage?.exits || []).find(e => String(e.id) === String(t.id)) || {
          id: t.id, confirmed_ended: false, reason: summary.boost_coverage?.list_complete === true ? 'not_returned_not_proof_of_end' : 'list_incomplete' }),
      funnel: summary.funnel,
      channels: summary.channels,
      context_version: summary.context_version,
      threshold: summary.threshold,
      ...(previous.context_version !== summary.context_version ? { decision_context: summary.decision_context } : {}),
      alerts: (summary.alerts || []).filter(item => !previousAlertCodes.has(key(item))),
      cleared_alert_ids: (previous.alerts || []).filter(item => !currentAlertCodes.has(key(item))).map(key),
      cleared_alert_codes: (previous.alerts || []).filter(item => !currentAlertCodes.has(key(item))).map(item => item.code),
      updated_materials: (summary.materials || []).filter(item => previousMaterialIds.has(String(item.material_id)) &&
        contentVersion(item) !== contentVersion((previous.materials || []).find(p => String(p.material_id) === String(item.material_id)))),
      material_entries: (summary.materials || []).filter(item => !previousMaterialIds.has(String(item.material_id))),
      removed_material_ids: summary.material_changes ? [] : (previous.materials || []).filter(item => !currentMaterialIds.has(String(item.material_id))).map(item => String(item.material_id)),
      delta_available: true,
    };
  }
}

module.exports = { SnapshotRing };
