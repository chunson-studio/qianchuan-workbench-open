'use strict';
const opLog = require('./operationLog');
const { safeActionLimits } = require('./actionLimits');
const { finiteNumber: n } = require('./dataContract');
const { readBoostDuration } = require('./boostDuration');

async function boundedRead(read, timeoutMs = 10000) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(read), new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('readback_timeout'), { code: 'readback_timeout' })), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

function normalizedTarget(raw, plan = false) {
  if (!raw) return null;
  return { status: plan ? n(raw.status) : boostStatus(raw, { requireManualPause: true }), budget: plan ? n(raw.budget) : n(raw.budget) == null ? null : n(raw.budget) / 100000,
    id: raw.id == null ? null : String(raw.id), smart_bid_type: n(raw.smartBidType),
    roi_goal: n(raw.roiGoal ?? raw.ecpRoi2Goal), bid: n(raw.bid) == null ? null : n(raw.bid) / 100000,
    audience: raw.audience || null,
    ...(!plan ? readBoostDuration(raw) : {}) };
}

function boostStatus(raw, { requireManualPause = false } = {}) {
  if (!raw) return null;
  const label = String(raw.adDeliveryName || '').trim();
  const status = n(raw.status);
  // Capacity guards use the coarse delivery state. Write receipts must also
  // prove the manual switch: the observed post-pause list says exactly 已暂停.
  if (status != null) return requireManualPause && status === 2 && label !== '已暂停' ? null : status;
  // list-required may omit status; generic pause labels are not manual-off proof.
  if (label === '投放中') return 1;
  if (label === '已暂停' || !requireManualPause && ['暂停中', '暂停投放'].includes(label)) return 2;
  if (['已终止', '已停止'].includes(label)) return 6;
  return null;
}

function compareReadback(actual, requested) {
  const matches = (observed, expected) => {
    if (observed == null) return false;
    if (typeof expected === 'number') return Number.isFinite(Number(observed)) && Math.abs(Number(observed) - expected) <= 0.00001;
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      return typeof observed === 'object' && Object.keys(expected).every(key => matches(observed[key], expected[key]));
    }
    return JSON.stringify(observed) === JSON.stringify(expected);
  };
  const mismatches = Object.keys(requested).filter(key => !matches(actual && actual[key], requested[key]));
  return { verified: Object.keys(requested).length > 0 && mismatches.length === 0, mismatches };
}

// Called inside the same target write lock. Acceptance is logged before readback, so a
// delayed read cannot let a concurrent request bypass cooldown or repeat an accepted write.
async function executeWithReceipt({ write, read, before, requested, logEntry, readTimeoutMs, preserveFields = [] }) {
  const began = Date.now();
  let result, thrown;
  try { result = await write(); } catch (error) { thrown = error; }
  const requestMs = Date.now() - began;
  const code = result && (result.status_code ?? result.code);
  const httpStatus = thrown?.statusCode || (/cookie_expired|cookie_not_found/.test(thrown?.message || '') ? 401 : 502);
  const accepted = !thrown && code === 0;
  const confirmationPending = accepted && result.confirmation_pending === true;
  const partialEffect = thrown?.partial_effect || thrown?.details?.partial_effect || null;
  const partialAccepted = !!thrown && thrown.partial === true && thrown.upstream_accepted === true
    && partialEffect && typeof partialEffect === 'object';
  // success remains the accepted-write signal used by cooldown queries. A mixed operation
  // may have accepted one field even though the requested operation as a whole failed.
  const upstreamAccepted = accepted || partialAccepted;
  // A synchronous guard may throw before any ad write and mark that explicitly.
  // Transport errors without this marker stay unknown because the upstream may have applied the write.
  const rejectedBeforeWrite = !!thrown && thrown.advertising_writes === 0;
  const rejectedByUpstream = thrown?.upstream_rejected === true || (!thrown && code != null && code !== 0);
  logEntry = typeof logEntry === 'function' ? logEntry(result) : logEntry;
  requested = typeof requested === 'function' ? requested(result) : requested;
  const initialStatus = accepted ? 'unconfirmed' : rejectedBeforeWrite || rejectedByUpstream ? 'rejected' : 'unconfirmed';
  const loggedParams = { ...logEntry.params, before, requested, upstream_accepted: upstreamAccepted,
    effect_status: initialStatus,
    ...(thrown?.advertising_writes !== undefined ? { advertising_writes: thrown.advertising_writes } : {}),
    ...(partialAccepted ? { partial: true, partial_effect: partialEffect,
      requested_action: logEntry.action } : {}) };
  const operationId = opLog.log({ ...logEntry, success: upstreamAccepted, result_code: code,
    result_msg: thrown ? thrown.message : accepted ? null : 'upstream_rejected_or_unknown',
    params: loggedParams });
  const readBegan = Date.now();
  let actual = null, reason = null;
  if (accepted) {
    try { actual = await boundedRead(() => read(result), typeof readTimeoutMs==='function'?readTimeoutMs():readTimeoutMs); }
    catch (error) { reason = error.code || error.message || 'readback_failed'; }
  }
  const comparison = compareReadback(actual, requested);
  const canonical = value => value && typeof value === 'object'
    ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  const preservation = preserveFields.filter(key => !Object.hasOwn(requested, key)).map(field => ({
    field, before: before?.[field] ?? null, actual: actual?.[field] ?? null,
    status: before?.[field] == null || actual?.[field] == null ? 'unknown'
      : JSON.stringify(canonical(before[field])) === JSON.stringify(canonical(actual[field])) ? 'unchanged' : 'changed',
  }));
  const preserved = preservation.every(item => item.status === 'unchanged');
  let verified = accepted && !confirmationPending && comparison.verified && preserved;
  const limits = safeActionLimits(logEntry.account_id, logEntry.target_id);
  const fields = { budget: 'update_budget', duration_seconds: 'update_duration', roi_goal: 'update_roi', bid: 'update_bid', audience: 'update_audience' };
  const acceptedFields = partialAccepted ? Object.entries(partialEffect)
    .filter(([, status]) => ['upstream_accepted', 'confirmed'].includes(status)).map(([key]) => key) : [];
  const limitFields = partialAccepted ? acceptedFields : Object.keys(requested);
  const unlocks = limitFields.map(key => limits[fields[key]]?.next_allowed_at).filter(Boolean).sort();
  const receipt = { operation_id: operationId, before: before || null, requested, actual,
    upstream_accepted: upstreamAccepted, effect_status: verified ? 'confirmed' : partialAccepted ? 'unconfirmed' : rejectedBeforeWrite || rejectedByUpstream ? 'rejected' : 'unconfirmed',
    ...(partialAccepted ? { partial: true, partial_effect: partialEffect, accepted_fields: acceptedFields } : {}),
    readback: { ...comparison, verified, preservation, target_id: String(logEntry.target_id),
      reason: verified ? null : confirmationPending ? result.confirmation_reason || 'upstream_batch_unconfirmed' : reason || (accepted && !preserved ? 'unchanged_fields_not_confirmed' : accepted ? 'requested_values_not_confirmed' : partialAccepted ? 'partial_write_unconfirmed' : rejectedBeforeWrite ? 'rejected_before_write' : rejectedByUpstream ? 'upstream_rejected' : 'upstream_rejected_or_unknown') },
    next_allowed_at: unlocks.at(-1) || limits[logEntry.action]?.next_allowed_at || null, action_limits: limits,
    retry_write: false, timings: { request_ms: requestMs, readback_ms: accepted ? Date.now() - readBegan : 0,
      total_ms: Date.now() - began, retry_ms: result?.request_timings?.retry_ms ?? null,
      retry_count: result?.request_timings?.retry_count ?? null,
      upstream_ms: result?.request_timings?.upstream_ms ?? null } };
  if (!operationId) receipt.audit_error = 'operation_log_persistence_failed';
  try {
    if (operationId) {
      opLog.attachReceipt(operationId, receipt);
      if (typeof opLog.getById === 'function' && !opLog.getById(operationId)?.params?.receipt) throw new Error('receipt_not_persisted');
    }
  } catch {
    receipt.audit_error = 'receipt_persistence_failed';
  }
  // A confirmed result must have a durable audit receipt. If audit persistence failed,
  // keep the accepted write in cooldown but expose its effect as unconfirmed.
  if (receipt.audit_error && receipt.effect_status === 'confirmed') {
    verified = false;
    receipt.effect_status = 'unconfirmed';
    receipt.readback.verified = false;
    receipt.readback.reason = receipt.audit_error;
  }
  return { ok: accepted, result, ...receipt,
    ...(thrown?.advertising_writes !== undefined ? { advertising_writes: thrown.advertising_writes } : rejectedBeforeWrite ? { advertising_writes: 0 } : {}),
    ...(thrown?.partial === true ? { partial: true } : {}),
    ...(thrown?.details !== undefined ? { details: thrown.details } : {}),
    ...(!accepted ? { http_status: httpStatus, code: thrown?.code || thrown?.message || code } : {}),
    message: verified ? '已回读确认生效' : partialAccepted ? 'ROI 已由上游接受；预算结果未确认，只读核验，不自动重发'
      : accepted ? '上游已接受，结果未确认；只读核验，禁止自动重发' : '上游拒绝或结果未知',
    ...(!accepted ? { error: thrown?.message || 'upstream_rejected_or_unknown' } : {}) };
}
module.exports = { executeWithReceipt, compareReadback, normalizedTarget, boundedRead, boostStatus };
