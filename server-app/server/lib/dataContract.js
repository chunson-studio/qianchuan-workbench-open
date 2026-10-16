'use strict';

const crypto = require('crypto');

const DATA_SCHEMA_VERSION = '2.0';
const FRESHNESS = Object.freeze({
  FRESH: 'fresh',
  PARTIAL: 'partial',
  STALE: 'stale',
  UNAVAILABLE: 'unavailable',
});

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function timestamp(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function normalizeErrors(errors) {
  const source = Array.isArray(errors) ? errors : (errors ? [errors] : []);
  return source.map((item) => {
    if (typeof item === 'string') {
      return { code: 'unknown_error', component: 'unknown', retryable: false, message: item };
    }
    const error = item && typeof item === 'object' ? item : {};
    return {
      code: String(error.code || 'unknown_error'),
      component: String(error.component || 'unknown'),
      retryable: error.retryable === true,
      ...(error.timeout_ms != null || error.timeoutMs != null
        ? { timeout_ms: finiteNumber(error.timeout_ms != null ? error.timeout_ms : error.timeoutMs) }
        : {}),
      ...(error.message || error.error ? { message: String(error.message || error.error) } : {}),
    };
  });
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .filter(value => value !== null && value !== undefined && value !== '')
    .map(String))];
}

function buildDataMeta(input = {}) {
  const now = timestamp(input.generatedAt) || new Date().toISOString();
  const sourceAt = timestamp(input.sourceAt);
  const generatedMs = Date.parse(now);
  const sourceMs = sourceAt ? Date.parse(sourceAt) : null;
  const ageMs = sourceMs == null ? null : Math.max(0, generatedMs - sourceMs);
  const staleAfterMs = finiteNumber(input.staleAfterMs);
  const dataValid = input.dataValid === true;
  const partial = input.partial === true;
  const stale = input.stale === true || (ageMs != null && staleAfterMs != null && ageMs > staleAfterMs);

  const missing = uniqueStrings(input.missing);
  if (!sourceAt && !missing.includes('source_at')) missing.push('source_at');

  let freshness = FRESHNESS.FRESH;
  if (!dataValid) freshness = FRESHNESS.UNAVAILABLE;
  else if (stale) freshness = FRESHNESS.STALE;
  else if (partial || !sourceAt) freshness = FRESHNESS.PARTIAL;

  return {
    schema_version: DATA_SCHEMA_VERSION,
    account_id: input.accountId == null ? null : String(input.accountId),
    session_key: input.sessionKey == null || input.sessionKey === '' ? null : String(input.sessionKey),
    generated_at: now,
    source_at: sourceAt,
    age_ms: ageMs,
    freshness,
    data_valid: dataValid,
    stale,
    partial,
    missing,
    errors: normalizeErrors(input.errors),
    source_type: input.sourceType == null || input.sourceType === '' ? null : String(input.sourceType),
  };
}

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((out, key) => {
    out[key] = stableObject(value[key]);
    return out;
  }, {});
}

function buildSnapshotId(meta, metrics, evidence) {
  const stable = JSON.stringify(stableObject({
    account_id: meta && meta.account_id,
    session_key: meta && meta.session_key,
    source_at: meta && meta.source_at,
    metrics: metrics || {},
    ...(evidence ? { evidence } : {}),
  }));
  return crypto.createHash('sha256').update(stable).digest('hex').slice(0, 20);
}

function diffMetrics(previous, current, fields) {
  const before = previous && typeof previous === 'object' ? previous : {};
  const after = current && typeof current === 'object' ? current : {};
  const keys = Array.isArray(fields) && fields.length
    ? fields
    : [...new Set([...Object.keys(before), ...Object.keys(after)])];
  const changes = [];
  for (const key of keys) {
    const from = before[key] === undefined ? null : before[key];
    const to = after[key] === undefined ? null : after[key];
    if (Object.is(from, to)) continue;
    const fromNumber = finiteNumber(from);
    const toNumber = finiteNumber(to);
    const change = { field: key, from, to };
    if (fromNumber != null && toNumber != null) {
      change.delta = +(toNumber - fromNumber).toFixed(4);
      change.delta_pct = fromNumber === 0 ? null : +((toNumber - fromNumber) / Math.abs(fromNumber) * 100).toFixed(2);
    }
    changes.push(change);
  }
  return changes;
}

module.exports = {
  DATA_SCHEMA_VERSION,
  FRESHNESS,
  finiteNumber,
  timestamp,
  normalizeErrors,
  buildDataMeta,
  buildSnapshotId,
  diffMetrics,
};
