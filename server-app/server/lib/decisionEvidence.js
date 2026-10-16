'use strict';

// 只在读取边界裁掉退役分数；磁盘中的原始历史记录保持不变。
const FACT_KEYS = ['target_at', 'before_snapshot_id', 'after_snapshot_id', 'before_source_at', 'after_source_at',
  'after_lag_ms', 'before_metrics', 'after_metrics', 'before_financial_basis', 'after_financial_basis',
  'before_metrics_scope', 'after_metrics_scope', 'verified_operation_ids'];
function publicOutcome(outcome) {
  if (!outcome || typeof outcome !== 'object') return null;
  const source = outcome.details || {};
  const details = {};
  for (const key of FACT_KEYS) if (source[key] !== undefined) details[key] = source[key];
  details.causal_attribution = false;
  const observed = Boolean(details.before_snapshot_id && details.after_snapshot_id && details.before_metrics && details.after_metrics);
  return {
    status: observed ? 'observed' : 'unavailable',
    reason: observed ? null : outcome.status === 'unavailable' ? outcome.reason : 'legacy_evidence_missing',
    details,
  };
}
function publicRound(round) {
  const { outcome_score, outcome, ...rest } = round;
  return { ...rest, outcome: publicOutcome(outcome) };
}
const RETIRED_LESSON_IDS = new Set(['rule_win_rates', 'extracted_patterns']);
function isRetiredLesson(id) { return RETIRED_LESSON_IDS.has(String(id || '').replace(/\.(md|json)$/i, '')); }
module.exports = { publicOutcome, publicRound, isRetiredLesson };
