'use strict';

const { performance } = require('node:perf_hooks');
const { getChromePageTarget } = require('./attach-qc-chrome.playwright.cjs');
const { readQianchuanControlBatch } = require('./read-qc-control-batch.playwright.cjs');

function fail(code, message) {
  throw Object.assign(new Error(message), { code, advertising_writes: 0 });
}

function validateBindings(bindings) {
  if (!Array.isArray(bindings) || !bindings.length) fail('live_check_bindings_required', 'Existing, explicitly bound pages are required');
  const pages = new Set(), rooms = new Set(), scopes = new Set();
  return bindings.map(binding => {
    const room = binding?.room ?? binding?.label;
    if (!binding || typeof room !== 'string' || !room.trim() || room !== room.trim() ||
        (binding.room !== undefined && binding.label !== undefined && binding.room !== binding.label) ||
        !binding.page || ['url', 'context', 'reload', 'getByText'].some(name => typeof binding.page[name] !== 'function') ||
        typeof binding.browser_context_id !== 'string' || !binding.browser_context_id.trim() ||
        typeof binding.advertiser_id !== 'string' || !/^\d+$/.test(binding.advertiser_id) ||
        typeof binding.primary_ad_id !== 'string' || !/^\d+$/.test(binding.primary_ad_id) ||
        typeof binding.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(binding.date) ||
        !Number.isFinite(Date.parse(binding.date)) || new Date(binding.date).toISOString().slice(0, 10) !== binding.date ||
        typeof binding.pool !== 'string' || !binding.pool.trim()) {
      fail('live_check_binding_invalid', 'Explicit existing Page, room, CDP profile, advertiser, plan, valid date and pool are required');
    }
    const scope = JSON.stringify([binding.browser_context_id, binding.advertiser_id, binding.primary_ad_id, binding.date, binding.pool]);
    if (pages.has(binding.page) || rooms.has(room) || scopes.has(scope)) fail('live_check_binding_duplicate', 'Duplicate page, room or account/plan/date/pool binding');
    pages.add(binding.page); rooms.add(room); scopes.add(scope);
    return { page: binding.page, room, browser_context_id: binding.browser_context_id,
      advertiser_id: binding.advertiser_id, primary_ad_id: binding.primary_ad_id, date: binding.date, pool: binding.pool };
  });
}

function verifyUrl(value, binding) {
  let url;
  try { url = new URL(value); } catch { fail('identity_mismatch', 'The bound page has no valid URL'); }
  if (url.origin !== 'https://qianchuan.jinritemai.com' || url.username || url.password) fail('identity_mismatch', 'The bound page must use the Qianchuan HTTPS origin');
  const params = new URLSearchParams(url.search), hashQuery = url.hash.indexOf('?');
  if (hashQuery >= 0) for (const [key, val] of new URLSearchParams(url.hash.slice(hashQuery + 1))) params.append(key, val);
  for (const [names, expected] of [
    [['aavid', 'advertiser_id', 'advertiserId'], binding.advertiser_id],
    [['adId', 'primary_ad_id', 'primaryAdId'], binding.primary_ad_id],
  ]) {
    const values = names.flatMap(name => params.getAll(name));
    if (!values.length || values.some(value => value !== expected)) fail('identity_mismatch', 'The page URL differs from the explicit advertiser or primary plan');
  }
}

function verifyTarget(target, binding, expectedTargetId) {
  if (target?.browserContextId !== binding.browser_context_id) fail('chrome_profile_mismatch', 'The page is outside the explicitly bound Chrome profile');
  if (typeof target.targetId !== 'string' || !target.targetId) fail('chrome_target_missing', 'The bound page has no CDP target ID');
  if (expectedTargetId !== undefined && target.targetId !== expectedTargetId) fail('chrome_target_changed', 'The CDP target changed during refresh');
  verifyUrl(target.url, binding);
}

function errorDetails(error) {
  return { code: error?.code ?? null, name: error?.name ?? null, message: error?.message ?? String(error) };
}

/**
 * Repeated acceptance reads of existing pages. Refresh only; no browser startup,
 * attachment, page creation, filter changes, ad writes, files or automatic retry.
 * A failed refresh/read stops later rounds and preserves this round's successes.
 * Acceptance requires raw.complete for every room. Incomplete pools require an
 * explicit pagination check; this function does not change pages automatically.
 */
async function checkQianchuanLiveParallel(bindings, {
  rounds = 3, refreshTimeoutMs = 20000, readyTimeoutMs = 12000, perRoomTimeoutMs = 8000,
} = {}) {
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 20 ||
      [refreshTimeoutMs, readyTimeoutMs, perRoomTimeoutMs].some(value => !Number.isSafeInteger(value) || value <= 0)) {
    fail('live_check_options_invalid', 'rounds must be 1..20 and timeout values must be positive integers');
  }
  const selected = validateBindings(bindings), started_at = new Date().toISOString(), start = performance.now();
  const results = [];
  for (let round = 1; round <= rounds; round++) {
    const roundStart = performance.now(), roundStartedAt = new Date().toISOString();
    const refresh = await Promise.all(selected.map(async binding => {
      const itemStart = performance.now(), { page, ...identity } = binding;
      const deadline = itemStart + refreshTimeoutMs + readyTimeoutMs;
      let phase = 'profile_before', target_id, expired = false, pending = false, timer;
      const timeoutError = () => Object.assign(new Error('The complete refresh/readiness deadline expired; an in-flight operation was not cancelled'), { code: 'refresh_deadline_exceeded' });
      const checkDeadline = () => {
        if (expired || performance.now() >= deadline) { expired = true; throw timeoutError(); }
      };
      const step = async (nextPhase, call) => {
        checkDeadline();
        phase = nextPhase;
        pending = true;
        try {
          const result = await call();
          checkDeadline();
          return result;
        } finally { pending = false; }
      };
      const failure = error => ({ ...identity, ok: false, state: 'unknown', phase, target_id: target_id ?? null,
        elapsed_ms: performance.now() - itemStart, pending_refresh: pending, operation_cancelled: false,
        advertising_writes: 0, error: errorDetails(error) });
      const deadlineResult = new Promise(resolve => {
        const wait = () => {
          const remaining = deadline - performance.now();
          if (remaining > 0) { timer = setTimeout(wait, Math.min(remaining, 2147483647)); return; }
          expired = true;
          resolve(failure(timeoutError()));
        };
        wait();
      });
      const work = (async () => { try {
        const before = await step('profile_before', () => getChromePageTarget(page));
        verifyTarget(before, binding);
        target_id = before.targetId;
        verifyUrl(page.url(), binding);
        await step('refresh', () => page.reload({ waitUntil: 'domcontentloaded', timeout: refreshTimeoutMs }));
        await step('plan_ready', () => page.getByText('计划ID：' + binding.primary_ad_id, { exact: true }).filter({ visible: true }).waitFor({ state: 'visible', timeout: readyTimeoutMs }));
        await step('total_ready', () => page.getByText(/^共\s*\d+\s*条任务$/, { exact: true }).filter({ visible: true }).waitFor({ state: 'visible', timeout: readyTimeoutMs }));
        await step('loading_ready', () => page.getByText('加载中...', { exact: true }).waitFor({ state: 'hidden', timeout: readyTimeoutMs }));
        // The table may arrive before the account header. Wait once, then prove
        // uniqueness; an immediate count of zero is not an identity conflict.
        const account = page.getByText('ID：' + binding.advertiser_id, { exact: true }).filter({ visible: true });
        await step('account_ready', () => account.waitFor({ state: 'visible', timeout: readyTimeoutMs }));
        if (await step('account_ready', () => account.count()) !== 1) fail('account_identity_ambiguous', 'The visible advertiser header is not unique');
        verifyTarget(await step('profile_after', () => getChromePageTarget(page)), binding, target_id);
        verifyUrl(page.url(), binding);
        checkDeadline();
        return { ...identity, ok: true, phase: 'ready', target_id, elapsed_ms: performance.now() - itemStart, advertising_writes: 0 };
      } catch (error) { return failure(error); } })();
      // This deadline only bounds reporting. The late worker stays observed and
      // must pass step()'s deadline check before dispatching any further action.
      try { return await Promise.race([work, deadlineResult]); }
      finally { clearTimeout(timer); }
    }));
    const ready = selected.filter((_, index) => refresh[index].ok);
    let batch = null;
    if (ready.length) {
      try { batch = await readQianchuanControlBatch(ready, { perRoomTimeoutMs }); }
      catch (error) { batch = { ok: false, advertising_writes: 0, error: errorDetails(error), results: [] }; }
    }
    const coverage_complete = batch?.ok === true && Array.isArray(batch.results) && batch.results.length === ready.length &&
      batch.results.every(item => item.ok === true && item.raw?.complete === true);
    const ok = refresh.every(item => item.ok) && coverage_complete;
    results.push({ round, ok, started_at: roundStartedAt, completed_at: new Date().toISOString(),
      elapsed_ms: performance.now() - roundStart, coverage_complete, refresh, batch, advertising_writes: 0 });
    if (!ok) break;
  }
  return { ok: results.length === rounds && results.every(result => result.ok), channel: 'playwright-native',
    advertising_writes: 0, requested_rounds: rounds, completed_rounds: results.length,
    stopped_early: results.length < rounds, started_at, completed_at: new Date().toISOString(),
    elapsed_ms: performance.now() - start, rounds: results,
    limits: ['Refresh and raw-read acceptance only; no advertising operation was executed.',
      'Acceptance requires raw.complete=true for every room. Incomplete pools require an explicit pagination check; this function does not change pages automatically.',
      'A timed-out refresh or batch read may still be pending; this function stops subsequent rounds rather than claiming the browser operation was cancelled.'] };
}

module.exports = { checkQianchuanLiveParallel };
