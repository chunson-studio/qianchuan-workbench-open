'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

class QianchuanChromeAttachError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'QianchuanChromeAttachError';
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new QianchuanChromeAttachError(code, message, cause ? { cause } : undefined);
}

/** Classify only evidence present in the connector error. Never return its
 * message, endpoint, headers or cause; a generic timeout has an unknown phase. */
function diagnoseChromeAttachFailure(error, { timeoutMs, elapsedMs } = {}) {
  const messages = [], codes = [];
  let current = error;
  for (let index = 0; current && index < 4; index++, current = current.cause) {
    messages.push(String(current.message ?? '').slice(0, 32000));
    codes.push(String(current.code ?? ''));
  }
  const text = messages.join('\n');
  const connected = /<ws connected>/.test(text) || /Protocol error \((?:Browser|Target)\./.test(text);
  const connecting = /<ws connecting>/.test(text);
  const timeout = /timeout|timed out|ETIMEDOUT/i.test(text) || error?.name === 'TimeoutError' || codes.includes('ETIMEDOUT');
  const networkCode = ['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET']
    .find(code => codes.includes(code) || new RegExp('\\b' + code + '\\b').test(text));
  const statusMatch = text.match(/(?:Unexpected server response|WebSocket (?:error|handshake)[^\n]{0,60}?response)[^\d\n]{0,20}(\d{3})/i);
  const status = statusMatch ? Number(statusMatch[1]) : undefined;
  const unreachable = ['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL', 'ENOTFOUND'].includes(networkCode) || /connection refused/i.test(text);
  const rejected = status !== undefined && status !== 101 || /(?:websocket|handshake).{0,80}(?:rejected|denied)|(?:access|permission) denied/i.test(text);
  let stage = 'attachment', failureType = 'connection_failed';
  if (connected) { stage = 'cdp_initialization'; failureType = timeout ? 'initialization_timeout' : 'initialization_failed'; }
  else if (unreachable) { stage = 'transport_connect'; failureType = 'endpoint_unreachable'; }
  else if (rejected) { stage = 'websocket_handshake'; failureType = 'handshake_rejected'; }
  else if (connecting) { stage = 'websocket_handshake'; failureType = timeout ? 'handshake_timeout' : 'handshake_failed'; }
  else if (timeout) failureType = 'timeout_phase_unknown';
  return Object.freeze({ stage, failure_type: failureType, transport_connected: connected ? true : connecting || unreachable || rejected ? false : null,
    ...(networkCode ? { transport_code: networkCode } : {}), ...(status ? { http_status: status } : {}),
    ...(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? { timeout_ms: timeoutMs } : {}),
    ...(Number.isSafeInteger(elapsedMs) && elapsedMs >= 0 ? { elapsed_ms: elapsedMs } : {}) });
}

/** Read an existing page's target metadata; do not discover or create pages. */
async function getChromePageTarget(page) {
  const session = await page.context().newCDPSession(page);
  let readFailed = false;
  try {
    return (await session.send('Target.getTargetInfo')).targetInfo;
  } catch (error) {
    readFailed = true;
    throw error;
  } finally {
    try { await session.detach(); }
    catch (error) {
      // A disconnect during cleanup must not replace the original read error.
      if (!readFailed) throw error;
    }
  }
}

function checkQianchuanUrl(value, advertiserId, primaryAdId) {
  let parsed;
  try { if (typeof value !== 'string') throw new Error('not a string'); parsed = new URL(value); }
  catch { fail('chrome_page_binding_invalid', 'An explicit Qianchuan HTTPS URL is required'); }
  if (parsed.origin !== 'https://qianchuan.jinritemai.com' || parsed.username || parsed.password) {
    fail('chrome_page_binding_invalid', 'The page must use the Qianchuan HTTPS origin');
  }
  const params = new URLSearchParams(parsed.search), hashQuery = parsed.hash.indexOf('?');
  if (hashQuery >= 0) for (const [key, val] of new URLSearchParams(parsed.hash.slice(hashQuery + 1))) params.append(key, val);
  for (const [names, expected] of [
    [['aavid', 'advertiser_id', 'advertiserId'], advertiserId],
    [['adId', 'primary_ad_id', 'primaryAdId'], primaryAdId],
  ]) {
    if (expected === undefined) continue;
    const values = names.flatMap(name => params.getAll(name));
    if (!values.length || values.some(value => value !== expected)) {
      fail('chrome_page_binding_invalid', 'The URL does not match the explicit advertiser or primary plan');
    }
  }
  return parsed.href;
}

/**
 * Open an observed Qianchuan URL through an existing page in the same ordinary
 * Chrome profile. Verify the popup's CDP profile; the caller then verifies its
 * real login, displayed plan, date and business state. Never retry window.open.
 */
async function openQianchuanPageInProfile(opener, { url, browserContextId, advertiser_id, primary_ad_id, timeoutMs = 15000 } = {}) {
  if (typeof browserContextId !== 'string' || !browserContextId.trim() ||
      typeof advertiser_id !== 'string' || !/^\d+$/.test(advertiser_id) ||
      typeof primary_ad_id !== 'string' || !/^\d+$/.test(primary_ad_id) ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    fail('chrome_page_open_options_invalid', 'Explicit profile, advertiser, primary plan and a positive timeout are required');
  }
  const targetUrl = checkQianchuanUrl(url, advertiser_id, primary_ad_id);
  checkQianchuanUrl(opener.url(), advertiser_id);
  const openerTarget = await getChromePageTarget(opener);
  checkQianchuanUrl(openerTarget.url, advertiser_id);
  if (openerTarget.browserContextId !== browserContextId) fail('chrome_profile_mismatch', 'The opener is not in the explicitly requested Chrome profile');
  checkQianchuanUrl(opener.url(), advertiser_id);
  // Attach a rejection handler before evaluating, including when a blocked
  // popup causes this function to fail before the popup timeout is reached.
  const pendingPopup = opener.waitForEvent('popup', { timeout: timeoutMs }).then(page => ({ page }), error => ({ error }));
  let opened;
  try { opened = await opener.evaluate(targetUrl => !!window.open(targetUrl, '_blank'), targetUrl); }
  catch (error) { fail('chrome_popup_failed', 'The popup operation failed; its result is unconfirmed and it was not retried', error); }
  if (!opened) fail('chrome_popup_blocked', 'window.open returned no window; no retry was made');
  const observed = await pendingPopup;
  if (observed.error) fail('chrome_popup_failed', 'No popup was observed within the requested wait; no retry was made', observed.error);
  const target = await getChromePageTarget(observed.page);
  if (target.browserContextId !== browserContextId || target.browserContextId !== openerTarget.browserContextId) {
    fail('chrome_profile_mismatch', 'The popup belongs to a different Chrome profile; it was not closed or retried');
  }
  return { page: observed.page, target };
}

/**
 * Attach to Chrome whose remote-debugging access the user has already enabled.
 * Read only the explicitly supplied DevToolsActivePort marker. Do not launch
 * Chrome, change settings, import cookies, navigate, or close tabs/contexts.
 * The caller must verify account, plan and live-scene identity before use.
 * Chrome may expose multiple login profiles through one aggregated Playwright
 * context. Do not use browser.contexts() as proof of login-profile isolation.
 */
async function attachQianchuanChrome({ markerPath, expectedPort, timeoutMs = 15000, chromium } = {}) {
  if (typeof markerPath !== 'string' || !path.isAbsolute(markerPath) || path.basename(markerPath) !== 'DevToolsActivePort') {
    fail('chrome_marker_path_invalid', 'markerPath must be an explicit absolute path to DevToolsActivePort');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 ||
      (expectedPort !== undefined && (!Number.isInteger(expectedPort) || expectedPort < 1 || expectedPort > 65535))) {
    fail('chrome_attach_options_invalid', 'timeoutMs and expectedPort must be valid positive integers');
  }
  let marker;
  try {
    const stat = fs.statSync(markerPath);
    if (!stat.isFile() || stat.size > 4096) fail('chrome_marker_invalid', 'The Chrome marker must be a small regular file');
    marker = fs.readFileSync(markerPath, 'utf8');
  } catch (error) {
    if (error instanceof QianchuanChromeAttachError) throw error;
    if (error?.code === 'ENOENT') {
      fail('chrome_marker_missing', 'DevToolsActivePort is missing; attach requires remote-debugging access already enabled by the user');
    }
    fail('chrome_marker_unreadable', 'Could not read the explicitly supplied Chrome marker', error);
  }
  const lines = marker.replace(/^\uFEFF/, '').trimEnd().split(/\r?\n/).map(line => line.trim());
  if (lines.length !== 2 || !/^\d{1,5}$/.test(lines[0]) ||
      !/^\/devtools\/browser(?:\/[A-Za-z0-9_-]+|\/)?$/.test(lines[1])) {
    fail('chrome_marker_invalid', 'DevToolsActivePort must contain a port and its actual /devtools/browser WebSocket path');
  }
  const port = Number(lines[0]);
  if (port < 1 || port > 65535) fail('chrome_marker_invalid', 'The Chrome marker port must be between 1 and 65535');
  if (expectedPort !== undefined && port !== expectedPort) fail('chrome_port_mismatch', 'The Chrome marker port differs from expectedPort');
  const endpoint = `ws://127.0.0.1:${port}${lines[1]}`;
  if (!chromium) {
    try { chromium = createRequire(path.resolve(__dirname, '../server-app/package.json'))('playwright-core').chromium; }
    catch (error) { fail('playwright_unavailable', 'The project Playwright dependency is unavailable', error); }
  }
  if (typeof chromium?.connectOverCDP !== 'function') fail('playwright_unavailable', 'chromium.connectOverCDP is unavailable');
  let browser;
  const startedAt = Date.now();
  try { browser = await chromium.connectOverCDP(endpoint, { timeout: timeoutMs, noDefaults: true }); }
  catch (error) {
    const failure = new QianchuanChromeAttachError('chrome_attach_failed', 'Chrome attachment failed; inspect the redacted diagnostic; no retry was made', { cause: error });
    failure.diagnostic = diagnoseChromeAttachFailure(error, { timeoutMs, elapsedMs: Date.now() - startedAt });
    throw failure;
  }
  let detachPromise;
  const detach = () => {
    // Closing this attached Browser handle releases its connection. Never close
    // contexts or pages separately, and never retry a failed detach implicitly.
    detachPromise ||= Promise.resolve().then(() => browser.close());
    return detachPromise;
  };
  return {
    browser,
    attached: Object.freeze({ source: 'DevToolsActivePort', marker_path: path.resolve(markerPath), endpoint }),
    limits: Object.freeze([
      'Playwright browser.contexts() may aggregate several Chrome login profiles; context count does not establish account isolation.',
      'Use getChromePageTarget(page) to read its CDP Target.getTargetInfo targetId, browserContextId and URL, then verify its real logged-in account and plan.',
      'Do not use an aggregated context.newPage() to create a page for another account. openQianchuanPageInProfile uses an explicitly verified existing opener and verifies the popup profile.',
      'Target.getBrowserContexts may omit ordinary Chrome profiles. A browserContextId observed in TargetInfo does not establish that Target.createTarget can open a page in that profile.',
    ]),
    detach,
  };
}

module.exports = { attachQianchuanChrome, diagnoseChromeAttachFailure, getChromePageTarget, openQianchuanPageInProfile, QianchuanChromeAttachError };
