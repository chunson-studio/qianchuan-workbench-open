'use strict';

// Keep the platform's counts and rates together. A numeric rate alone does not
// establish whether it is a ratio or a percent; payment orders are not its denominator.
function rawCell(cell) {
  if (cell == null || typeof cell === 'boolean') return null;
  if (typeof cell === 'object') {
    if (cell.controlType != null && Number(cell.controlType) === 0) return null;
    return cell.value ?? cell.Value ?? cell.ValueStr ?? null;
  }
  return cell;
}
function nonnegative(value) {
  if (value == null || typeof value === 'boolean' || String(value).trim() === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  const text = String(value).trim().replace(/,/g, '');
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) && number >= 0 ? number : null;
}
function platformRate(cell) {
  const raw = rawCell(cell);
  const explicitPercent = typeof raw === 'string' && raw.trim().endsWith('%');
  const declared = cell && typeof cell === 'object' ? cell.unit : null;
  const conflict = explicitPercent && declared === 'ratio';
  const unit = conflict ? 'unknown' : explicitPercent || declared === 'percent'
    ? 'percent' : declared === 'ratio' ? 'ratio' : 'unknown';
  const value = nonnegative(explicitPercent ? raw.trim().slice(0, -1) : raw);
  const valid = value != null && !conflict && (unit !== 'percent' || value <= 100) && (unit !== 'ratio' || value <= 1);
  return { value: valid ? value : null, unit: valid ? unit : 'unknown',
    percent: valid && unit !== 'unknown' ? (unit === 'ratio' ? value * 100 : value) : null,
    reason: conflict ? 'rate_unit_conflict' : !valid ? 'rate_unavailable' : unit === 'unknown' ? 'rate_unit_unverified' : null };
}
function buildBoostFunnel(values, { start = null, end = null, scope = 'date_range', sourceType, collectedAt = null } = {}) {
  const show_cnt = nonnegative(rawCell(values.show_cnt));
  const click_cnt = nonnegative(rawCell(values.click_cnt));
  const ctr = platformRate(values.ctr), cvr = platformRate(values.cvr);
  const missing_fields = Object.entries({ show_cnt, click_cnt, ctr: ctr.value, cvr: cvr.value })
    .filter(([, value]) => value == null).map(([key]) => key);
  return { window: { start, end, scope }, source_type: sourceType || 'unknown',
    collected_at: collectedAt, upstream_updated_at: null, freshness: 'unknown',
    show_cnt, click_cnt, ctr, cvr, missing_fields, joint_evidence_valid: false,
    reason: missing_fields.length ? 'funnel_fields_missing'
      : ctr.unit === 'unknown' || cvr.unit === 'unknown' ? 'rate_units_unverified'
      : 'upstream_timing_and_denominators_unverified' };
}
function boostListFunnel(stats, context = {}) {
  return buildBoostFunnel({ show_cnt: stats.showCntForRoi2Assist, click_cnt: stats.clickCntForRoi2Assist,
    ctr: stats.ctrForRoi2Assist, cvr: stats.convertRateForRoi2Assist },
  { start: context.start, end: context.end, scope: context.scope,
    sourceType: 'boost_list_stats', collectedAt: context.sourceAt });
}

module.exports = { platformRate, buildBoostFunnel, boostListFunnel };
