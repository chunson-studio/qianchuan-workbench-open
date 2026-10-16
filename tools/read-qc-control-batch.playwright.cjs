'use strict';

const { performance } = require('node:perf_hooks');
const chrome = require('./attach-qc-chrome.playwright.cjs');
const control = require('./read-qc-control-raw.playwright.cjs');

function fail(code, message) {
  throw Object.assign(new Error(message), { code, advertising_writes: 0 });
}

function validateBindings(bindings) {
  if (!Array.isArray(bindings) || !bindings.length) fail('batch_bindings_required', 'A nonempty bindings array is required');
  const pages = new Set(), rooms = new Set(), scopes = new Set();
  return bindings.map(binding => {
    if (!binding || typeof binding !== 'object') fail('batch_binding_invalid', 'Each binding must be an object');
    const room = binding.room ?? binding.label;
    if (typeof room !== 'string' || !room.trim() || room !== room.trim() ||
        (binding.room !== undefined && binding.label !== undefined && binding.room !== binding.label) ||
        !binding.page || typeof binding.page.context !== 'function' || typeof binding.page.url !== 'function' ||
        typeof binding.browser_context_id !== 'string' || !binding.browser_context_id.trim() ||
        typeof binding.advertiser_id !== 'string' || !/^\d+$/.test(binding.advertiser_id) ||
        typeof binding.primary_ad_id !== 'string' || !/^\d+$/.test(binding.primary_ad_id) ||
        typeof binding.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(binding.date) ||
        typeof binding.pool !== 'string' || !binding.pool.trim()) {
      fail('batch_binding_invalid', 'Explicit page, room/label, CDP profile, advertiser, plan, date and pool are required');
    }
    const scope = JSON.stringify([binding.browser_context_id, binding.advertiser_id, binding.primary_ad_id, binding.date, binding.pool]);
    if (pages.has(binding.page) || rooms.has(room) || scopes.has(scope)) {
      fail('batch_binding_duplicate', 'A page, room or account/plan/date/pool binding occurs more than once');
    }
    pages.add(binding.page); rooms.add(room); scopes.add(scope);
    return { page: binding.page, room, browser_context_id: binding.browser_context_id,
      advertiser_id: binding.advertiser_id, primary_ad_id: binding.primary_ad_id, date: binding.date, pool: binding.pool };
  });
}

function verifyTarget(target, binding, expectedTargetId) {
  if (target?.browserContextId !== binding.browser_context_id) {
    fail('chrome_profile_mismatch', 'The page is outside the explicitly bound CDP profile');
  }
  if (typeof target.targetId !== 'string' || !target.targetId) fail('chrome_target_missing', 'The page has no CDP target ID');
  if (expectedTargetId !== undefined && target.targetId !== expectedTargetId) {
    fail('chrome_target_changed', 'The page CDP target changed during the read');
  }
}

function roomTimeout(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    fail('batch_timeout_invalid', 'Options must be an object');
  }
  const value = options.perRoomTimeoutMs === undefined ? 8000 : options.perRoomTimeoutMs;
  if (!Number.isSafeInteger(value) || value <= 0) fail('batch_timeout_invalid', 'perRoomTimeoutMs must be a positive integer');
  return value;
}

/**
 * Read existing, explicitly bound pages in parallel. No refresh, navigation,
 * filtering, advertising writes, retries or persistent output. Each successful
 * raw result retains its own coverage fields; batch ok does not assert coverage.
 * A room has one deadline across its three stages (default 8000 ms). Timeout
 * ends the wait, discards late results and prevents further batch stages. It
 * does not cancel an already dispatched CDP/raw read or its internal operations.
 */
async function readQianchuanControlBatch(bindings, options = {}) {
  const selected = validateBindings(bindings);
  const perRoomTimeoutMs = roomTimeout(options);
  const started_at = new Date().toISOString(), start = performance.now();
  const timings = selected.map(() => ({}));
  const settled = await Promise.allSettled(selected.map(async (binding, index) => {
    const timing = timings[index], itemStart = performance.now();
    const deadline = itemStart + perRoomTimeoutMs;
    const timeoutError = Object.assign(new Error('Room read deadline exceeded; an already dispatched read may still be pending'),
      { name: 'TimeoutError', code: 'batch_room_timeout', pending_read: true, advertising_writes: 0 });
    let expired = false, timer;
    const checkDeadline = () => {
      if (expired || performance.now() >= deadline) {
        expired = true;
        throw timeoutError;
      }
    };
    timing.started_at = new Date().toISOString();
    const timeout = new Promise((resolve, reject) => {
      const arm = () => {
        const remaining = deadline - performance.now();
        if (remaining <= 0) { expired = true; reject(timeoutError); }
        else timer = setTimeout(arm, Math.min(Math.ceil(remaining), 2147483647));
      };
      arm();
    });
    try {
      return await Promise.race([timeout, (async () => {
        checkDeadline();
        timing.phase = 'profile_before';
        const before = await chrome.getChromePageTarget(binding.page);
        checkDeadline();
        verifyTarget(before, binding);
        timing.phase = 'raw_read';
        const raw = await control.readQianchuanControlRaw(binding.page, {
          advertiser_id: binding.advertiser_id, primary_ad_id: binding.primary_ad_id,
          date: binding.date, pool: binding.pool,
        });
        checkDeadline();
        timing.phase = 'profile_after';
        const after = await chrome.getChromePageTarget(binding.page);
        checkDeadline();
        verifyTarget(after, binding, before.targetId);
        return { target_id: before.targetId, raw };
      })()]);
    } finally {
      clearTimeout(timer);
      timing.completed_at = new Date().toISOString();
      timing.elapsed_ms = performance.now() - itemStart;
    }
  }));
  const results = settled.map((outcome, index) => {
    const { page, ...binding } = selected[index];
    const result = { ...binding, ...timings[index], advertising_writes: 0 };
    if (outcome.status === 'fulfilled') return { ...result, ok: true, state: 'observed', ...outcome.value };
    const error = outcome.reason;
    return { ...result, ok: false, state: 'unknown', ...(error?.pending_read === true ? { pending_read: true } : {}), error: {
      code: error?.code ?? null, name: error?.name ?? null, message: error?.message ?? String(error),
    } };
  });
  return { ok: results.every(result => result.ok), channel: 'playwright-native', advertising_writes: 0,
    started_at, completed_at: new Date().toISOString(), elapsed_ms: performance.now() - start, results };
}

module.exports = { readQianchuanControlBatch };
