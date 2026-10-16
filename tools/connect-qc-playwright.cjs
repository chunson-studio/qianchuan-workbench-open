'use strict';

// Native Playwright sessions. Callers verify the logged-in account, live room,
// current objects and each write result; URL binding alone does not prove them.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { performance } = require('node:perf_hooks');

class QianchuanPlaywrightError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'QianchuanPlaywrightError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new QianchuanPlaywrightError(code, message, details);
}

function canonicalProfile(value) {
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value)) {
    fail('profile_invalid', 'profile_dir must be an explicit absolute directory');
  }
  let candidate = path.resolve(value);
  const missing = [];
  while (!fs.existsSync(candidate)) {
    const parent = path.dirname(candidate);
    if (parent === candidate) break;
    missing.unshift(path.basename(candidate));
    candidate = parent;
  }
  if (fs.existsSync(candidate)) {
    if (!fs.statSync(candidate).isDirectory()) fail('profile_invalid', 'profile_dir must be a directory');
    candidate = fs.realpathSync.native(candidate);
  }
  const directory = path.join(candidate, ...missing);
  const key = process.platform === 'win32' ? directory.toLowerCase() : directory;
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    for (const product of ['Google/Chrome', 'Google/Chrome Beta', 'Google/Chrome Dev', 'Google/Chrome SxS', 'Microsoft/Edge', 'Microsoft/Edge Beta', 'Microsoft/Edge Dev', 'Microsoft/Edge SxS']) {
      const knownRoot = path.resolve(process.env.LOCALAPPDATA, product, 'User Data');
      const root = (fs.existsSync(knownRoot) ? fs.realpathSync.native(knownRoot) : knownRoot).toLowerCase();
      if (key === root || key.startsWith(root + path.sep)) {
        fail('default_profile_forbidden', 'Use a dedicated profile_dir, not the default Chrome or Edge user-data directory');
      }
    }
  }
  return { directory, key };
}

function identity(value, field) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    fail('binding_invalid', `${field} must be a nonempty identifier without precision loss`);
  }
  return value;
}

function validateUrl(value, binding) {
  if (typeof value !== 'string' || !value) fail('browser_identity_unavailable', 'A Qianchuan HTTPS URL string is required');
  let parsed;
  try { parsed = new URL(value); } catch { fail('browser_identity_unavailable', 'A valid Qianchuan HTTPS URL is required'); }
  if (parsed.origin !== 'https://qianchuan.jinritemai.com' || parsed.username || parsed.password) {
    fail('browser_identity_unavailable', 'The page is outside the Qianchuan HTTPS origin');
  }
  const params = new URLSearchParams(parsed.search);
  const hashQuery = parsed.hash.indexOf('?');
  if (hashQuery !== -1) {
    for (const [key, val] of new URLSearchParams(parsed.hash.slice(hashQuery + 1))) params.append(key, val);
  }
  for (const [field, aliases] of [
    ['advertiser_id', ['aavid', 'advertiser_id', 'advertiserId']],
    ['primary_ad_id', ['adId', 'primary_ad_id', 'primaryAdId']],
  ]) {
    const values = aliases.flatMap(name => params.getAll(name));
    if (!values.length || values.some(item => !item)) fail('browser_identity_unavailable', `The URL has no complete ${field} binding`);
    if (values.some(item => item !== binding[field])) fail('browser_identity_mismatch', `The URL does not match ${field}`);
  }
  return parsed.href;
}

function normalizeSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) fail('binding_invalid', 'A session specification is required');
  const profile = canonicalProfile(spec.profile_dir);
  const binding = Object.freeze({
    account_id: identity(spec.account_id, 'account_id'),
    advertiser_id: identity(spec.advertiser_id, 'advertiser_id'),
    primary_ad_id: identity(spec.primary_ad_id, 'primary_ad_id'),
    profile_dir: profile.directory,
  });
  const url = spec.url === undefined ? undefined : validateUrl(spec.url, binding);
  return { ...binding, binding, key: profile.key, url };
}

function defaultChromium() {
  return createRequire(path.resolve(__dirname, '../server-app/package.json'))('playwright-core').chromium;
}

function findExecutable(chromium) {
  const candidates = [];
  if (typeof chromium.executablePath === 'function') candidates.push(chromium.executablePath());
  if (process.platform === 'win32') {
    for (const base of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean)) {
      candidates.push(path.join(base, 'Google/Chrome/Application/chrome.exe'), path.join(base, 'Microsoft/Edge/Application/msedge.exe'));
    }
  }
  return candidates.find(value => value && fs.existsSync(value));
}

/**
 * One manager per caller process. Different profiles run independently; run()
 * serializes work only within one profile. open() serializes setup only: callers
 * needing operation ownership must keep all work inside run(). No disk locks,
 * cookie import/export, retries, scheduler or advertising decisions are added.
 *
 * onContextCreated(context, spec) runs before page navigation (e.g. test routes).
 * chromium is an optional dependency injection seam for tests.
 * run(spec, callback, { queueTimeoutMs, signal }) cancels queued work before it
 * can submit. queueTimeoutMs covers queue wait only. AbortSignal also applies
 * during prepare; neither mechanism interrupts a callback that has started.
 */
function createQianchuanPlaywrightSessions(options = {}) {
  const { headless = false, timeoutMs = 15000, onContextCreated } = options;
  if (typeof headless !== 'boolean' || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 ||
      (onContextCreated !== undefined && typeof onContextCreated !== 'function')) {
    fail('session_options_invalid', 'headless, timeoutMs or onContextCreated is invalid');
  }
  if (options.executablePath !== undefined && (typeof options.executablePath !== 'string' ||
      !path.isAbsolute(options.executablePath) || !fs.existsSync(options.executablePath) || !fs.statSync(options.executablePath).isFile())) {
    fail('session_options_invalid', 'executablePath must name an existing absolute executable path');
  }
  const entries = new Map();
  let chromium;

  function entryFor(spec) {
    let entry = entries.get(spec.key);
    if (entry && entry.account_id !== spec.account_id) fail('profile_account_conflict', 'This profile is already bound to another account');
    if (entry?.closing) fail('session_closing', 'The profile is closing; wait for close() to finish');
    if (!entry) {
      entry = { account_id: spec.account_id, directory: spec.profile_dir, context: null, ready: false, pages: new Map(), tail: Promise.resolve(), closing: false };
      entries.set(spec.key, entry);
    }
    return entry;
  }

  function enqueue(entry, work) {
    const current = entry.tail.then(work);
    entry.tail = current.catch(() => {});
    return current;
  }

  async function contextFor(entry, spec) {
    if (!entry.context) {
      try {
        chromium ||= options.chromium || defaultChromium();
        if (typeof chromium?.launchPersistentContext !== 'function') fail('playwright_unavailable', 'chromium.launchPersistentContext is unavailable');
        const executablePath = options.executablePath || findExecutable(chromium);
        const context = await chromium.launchPersistentContext(entry.directory, { headless, timeout: timeoutMs, ...(executablePath ? { executablePath } : {}) });
        entry.context = context;
        entry.ready = false;
        context.setDefaultTimeout(timeoutMs);
        context.setDefaultNavigationTimeout(timeoutMs);
        context.on('close', () => {
          if (entry.context === context) { entry.context = null; entry.ready = false; entry.pages.clear(); }
        });
      } catch (error) {
        if (error instanceof QianchuanPlaywrightError) throw error;
        fail('browser_launch_failed', 'Could not launch the dedicated Playwright profile', { cause: String(error?.message || error), retry_write: false });
      }
    }
    if (!entry.ready) {
      if (onContextCreated) await onContextCreated(entry.context, { ...spec.binding, ...(spec.url ? { url: spec.url } : {}) });
      entry.ready = true;
    }
    return entry.context;
  }

  async function prepare(entry, spec) {
    const context = await contextFor(entry, spec);
    const pageKey = JSON.stringify([spec.advertiser_id, spec.primary_ad_id]);
    const matches = context.pages().filter(page => {
      if (page.isClosed()) return false;
      try { validateUrl(page.url(), spec.binding); return true; } catch { return false; }
    });
    if (matches.length > 1) fail('browser_page_ambiguous', 'More than one page matches the advertiser and primary plan');
    let page = matches[0];
    const previous = entry.pages.get(pageKey);
    if (!page && previous && !previous.isClosed()) validateUrl(previous.url(), spec.binding);
    if (!page) {
      if (!spec.url) fail('page_unavailable', 'No matching page exists; supply an observed, explicitly bound URL');
      page = await context.newPage();
      entry.pages.set(pageKey, page);
      await page.goto(spec.url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    }
    validateUrl(page.url(), spec.binding);
    entry.pages.set(pageKey, page);
    return { page, context, binding: spec.binding };
  }

  async function open(input) {
    const spec = normalizeSpec(input);
    const entry = entryFor(spec);
    return enqueue(entry, () => prepare(entry, spec));
  }

  async function run(input, callback, runOptions = {}) {
    const spec = normalizeSpec(input);
    if (typeof callback !== 'function') fail('session_callback_invalid', 'run requires a callback');
    if (!runOptions || typeof runOptions !== 'object' || Array.isArray(runOptions)) {
      fail('session_run_options_invalid', 'run options must be an object');
    }
    const { queueTimeoutMs = timeoutMs, signal } = runOptions;
    if (!Number.isSafeInteger(queueTimeoutMs) || queueTimeoutMs <= 0 || queueTimeoutMs > 2147483647 ||
        (signal !== undefined && (!signal || typeof signal.aborted !== 'boolean' ||
          typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function'))) {
      fail('session_run_options_invalid', 'queueTimeoutMs or signal is invalid');
    }
    const cancellation = code => new QianchuanPlaywrightError(code,
      code === 'session_queue_timeout' ? 'The profile queue wait expired before the callback started' : 'The session run was cancelled before the callback started',
      { effect_status: 'not_submitted', retry_write: false });
    if (signal?.aborted) throw cancellation('session_cancelled');
    const entry = entryFor(spec);
    const queueDeadline = performance.now() + queueTimeoutMs;
    let phase = 'queued', cancelled = null, timer;
    let resolveOutcome, rejectOutcome;
    const outcome = new Promise((resolve, reject) => { resolveOutcome = resolve; rejectOutcome = reject; });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
    const cancel = code => {
      if (phase === 'running' || phase === 'finished' || cancelled) return;
      cancelled = cancellation(code);
      cleanup();
      rejectOutcome(cancelled);
    };
    const onAbort = () => cancel('session_cancelled');
    signal?.addEventListener('abort', onAbort, { once: true });
    // An AbortSignal can change between the initial check and listener setup.
    if (signal?.aborted) onAbort();
    if (!cancelled) timer = setTimeout(() => cancel('session_queue_timeout'), queueTimeoutMs);
    const queued = enqueue(entry, async () => {
      try {
        // Timers may be delayed by event-loop load; never trust only the timer.
        if (performance.now() >= queueDeadline) cancel('session_queue_timeout');
        if (cancelled) throw cancelled;
        phase = 'preparing';
        clearTimeout(timer);
        const session = await prepare(entry, spec);
        if (signal?.aborted) onAbort();
        if (cancelled) throw cancelled;
        phase = 'running';
        cleanup();
        // Never replay or abandon a started callback. A failure after a write
        // requires original-ID readback, even when later queued work can run.
        try {
          const result = await callback(session);
          if (session.page.isClosed()) fail('browser_identity_unavailable', 'The bound page closed before run completed');
          validateUrl(session.page.url(), spec.binding);
          return result;
        } catch (error) {
          error.details = { ...error.details, effect_status: 'unconfirmed', retry_write: false };
          throw error;
        }
      } finally {
        phase = 'finished';
        cleanup();
      }
    });
    queued.then(resolveOutcome, rejectOutcome);
    return outcome;
  }

  async function close(profileDir) {
    const selected = profileDir === undefined ? [...entries.values()] : [entries.get(canonicalProfile(profileDir).key)].filter(Boolean);
    return Promise.all(selected.map(entry => {
      if (entry.closing) return entry.tail;
      entry.closing = true;
      return enqueue(entry, async () => {
        try {
          if (entry.context) await entry.context.close();
          entry.context = null;
          entry.ready = false;
          entry.pages.clear();
        } finally { entry.closing = false; }
      });
    }));
  }

  return Object.freeze({ open, run, close });
}

module.exports = { createQianchuanPlaywrightSessions, QianchuanPlaywrightError };
