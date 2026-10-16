'use strict';

const ledger = require('./decisionLedger');
const { normalizeBrowserBoostCapture } = require('./browserBoostSnapshot');

const BROWSER_CAPTURE_STALE_AFTER_MS = 90_000;

function freshnessReadTime(value) {
  if (value == null) return new Date();
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw Object.assign(new Error('now必须是有效时间'), { code: 'invalid_timestamp', statusCode: 400 });
  }
  return date;
}

function getBrowserSnapshot(account, snapshotId, options = {}) {
  const snapshot = ledger.getSnapshot(account, snapshotId, options);
  if (!snapshot) return null;
  const now = freshnessReadTime(options.now);
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const captureEvidence = snapshot.components?.browser_capture;
  const capture = captureEvidence?.capture;
  const sourceAt = snapshot.meta?.source_at || captureEvidence?.captured_at || capture?.timing?.captured_at || null;
  const sourceMs = sourceAt == null ? NaN : Date.parse(sourceAt);
  const hasSourceTime = Number.isFinite(sourceMs);
  const ageMs = hasSourceTime ? Math.max(0, nowMs - sourceMs) : null;
  const clockSkewed = hasSourceTime && sourceMs - nowMs > BROWSER_CAPTURE_STALE_AFTER_MS;
  const stale = !hasSourceTime || ageMs > BROWSER_CAPTURE_STALE_AFTER_MS || clockSkewed;
  const dataValid = snapshot.meta?.data_valid === true;
  const partial = snapshot.meta?.partial === true;
  const freshness = stale ? 'stale' : (!dataValid ? 'unavailable' : (partial ? 'partial' : 'fresh'));
  const sourceAtBasis = captureEvidence?.provenance?.timestamp_basis
    || 'local browser capture time; observation time; platform generated time unknown';

  return {
    ...snapshot,
    meta: {
      ...snapshot.meta,
      generated_at: nowIso,
      freshness_checked_at: nowIso,
      age_ms: ageMs,
      freshness,
      stale,
      source_at_basis: sourceAtBasis,
    },
  };
}

function ingestBrowserSnapshot(capture, options = {}) {
  const summary = normalizeBrowserBoostCapture(capture, { now: options.now == null ? undefined : new Date(options.now) });
  const account = String(summary?.meta?.account_id || '');
  if (!account) throw Object.assign(new Error('浏览器快照缺少可信账号'), { code: 'invalid_browser_snapshot', statusCode: 400 });
  if (options.expectedAccount && account !== String(options.expectedAccount)) {
    throw Object.assign(new Error('capture可信账号与请求账号不一致'), { code: 'account_conflict', statusCode: 400 });
  }
  if (options.expectedAdvertiserId
    && String(summary.components?.browser_capture?.capture?.binding?.advertiser_id || '') !== String(options.expectedAdvertiserId)) {
    throw Object.assign(new Error('capture平台账户与本机注册账户不一致'), { code: 'advertiser_mismatch', statusCode: 400 });
  }
  const result = ledger.recordSnapshot(account, summary, {
    baseDir: options.baseDir,
    recordedAt: options.now == null ? undefined : new Date(options.now).toISOString(),
  });
  return {
    ok: true,
    snapshot_id: result.snapshot.snapshot_id,
    snapshot_persisted: true,
    duplicate: result.duplicate === true,
    summary: result.snapshot,
  };
}

module.exports = { ingestBrowserSnapshot, getBrowserSnapshot, BROWSER_CAPTURE_STALE_AFTER_MS };
