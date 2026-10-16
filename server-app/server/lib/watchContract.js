'use strict';

const { finiteNumber: number, buildDataMeta, buildSnapshotId } = require('./dataContract');

// Keep the existing contract entry point, but ROI is supplied by upstream, never recomputed.
function reconcileFinancial(metrics, basis = {}, window = 'unknown') {
  const values = { ...metrics };
  const checks = {};
  for (const [roi, amount, expectedBasis] of [['payment_roi', 'payment_gmv', 'payment'], ['net_roi', 'net_gmv', 'platform_net_1h']]) {
    const raw = number(metrics[roi]);
    const roiBasis = basis[roi] || expectedBasis, amountBasis = basis[amount] || expectedBasis;
    const basisConflict = (roi === 'payment_roi' && roiBasis !== 'payment')
      || (roi === 'net_roi' && roiBasis === 'payment');
    const reason = raw == null ? 'roi_missing' : roiBasis === 'unknown' ? 'roi_basis_unknown'
      : basisConflict ? 'roi_basis_mismatch' : null;
    checks[roi] = {
      roi_basis: roiBasis, amount_basis: amountBasis, window,
      raw_value: raw, value_source: 'upstream',
      data_valid: reason == null, reason,
    };
    // 缺失值不补算；金额、消耗缺失或不闭合，不改写平台已返回的 ROI（包括真实 0）。
    values[roi] = raw;
  }
  return { values, checks };
}

function componentMeta(sourceAt, valid, window, generatedAt, options = {}) {
  const meta = buildDataMeta({ sourceAt, dataValid: valid, generatedAt,
    staleAfterMs: options.staleAfterMs ?? 90000, partial: options.partial, stale: options.stale });
  return { source_at: meta.source_at, age_ms: meta.age_ms, window,
    data_valid: valid === true && meta.source_at != null && !meta.stale,
    freshness: meta.freshness, ...(options.reason ? { reason: options.reason } : {}) };
}

function contentVersion(value) {
  return buildSnapshotId({}, value || {});
}

function snapshotEvidence(summary) {
  return Object.fromEntries(['live', 'components', 'financial_checks', 'financial_basis', 'metrics_scope',
    'engagement', 'missing_components', 'plan_binding', 'plan', 'boosts', 'boost_coverage', 'materials', 'material_changes', 'alerts', 'funnel', 'channels', 'decision_context', 'context_version', 'threshold']
    .filter(key => summary[key] !== undefined).map(key => [key, summary[key]]));
}

module.exports = { reconcileFinancial, componentMeta, contentVersion, snapshotEvidence };
