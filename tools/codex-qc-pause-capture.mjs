/**
 * Codex CUA REPL module, not a browser/HTTP CLI. Observe an ALREADY bound tab.
 * Read its native CDP documentation first: only readEvents and send are used.
 * No navigation, selectors, ad submission, HTTP replay or credential export.
 *
 * const capture = await beginPauseCapture({ tab, tab_id, advertiser_id,
 *   expected_account_url, request_path, expected_ids, binding_verified: true,
 *   private_root: ABS_PRIVATE_RUNTIME, output_dir: ABS_NEW_PAUSE_CAPTURE_DIR });
 * // The authorized operator performs the original action separately.
 * try { const receipt = await collectPauseCapture(capture); }
 * finally { await stopPauseCapture(capture); }
 *
 * output_dir must be a NEW direct child of private_root/pause-captures.
 * The caller confirms the tab/URL/account/IDs binding; URL is checked again.
 * Do not use alongside another Network observer on the same tab: disable stops
 * this tab's Network domain. Raw *.raw.json files are local secret-bearing data.
 * Return values/errors never include raw events, URL queries, headers or bodies.
 * Only whitelisted observed request/response business fields enter the receipt. HTTP receipt
 * is observation, not proof of manual pause, live readback or API replay.
 * A pending response can be collected again; loss/limits/ambiguity require a new
 * capture. New filenames are exclusive; no output or receipt is overwritten.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { Buffer } from 'node:buffer';

const ORIGIN = 'https://qianchuan.jinritemai.com';
const PAUSE_PATH = '/ad/api/pmc/v1/batch_update_operation';
const sessions = new WeakMap();
class CaptureError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new CaptureError(code); };
const obj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const integer = x => Number.isSafeInteger(x) && x >= 0;
const stamp = () => new Date().toISOString();
async function safeCall(fn, code) {
  try { return await fn(); } catch { fail(code); }
}
function localPath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f]/.test(value)
      || /^(?:\\\\|\/\/)/.test(value)) fail('invalid_local_path');
  const parts = value.slice(path.parse(value).root.length).split(/[\\/]/);
  if (parts.some(p => !p || p === '.' || p === '..' || /[<>:"|?*]|[. ]$/.test(p)
      || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(p))) fail('invalid_local_path');
  return path.resolve(value);
}
async function directoryChain(directory) {
  let cursor = path.parse(directory).root;
  for (const part of directory.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    const st = await safeCall(() => fs.lstat(cursor), 'unsafe_directory');
    if (!st.isDirectory() || st.isSymbolicLink()) fail('unsafe_directory');
  }
}
async function newOutput(privateRoot, outputDir) {
  const root = localPath(privateRoot), out = localPath(outputDir);
  if (path.basename(root) !== 'private-runtime') fail('invalid_private_root');
  const parent = path.join(root, 'pause-captures');
  if (path.dirname(out) !== parent) fail('output_outside_capture_root');
  await directoryChain(root);
  try { await fs.mkdir(parent, { mode: 0o700 }); }
  catch (e) { if (e.code !== 'EEXIST') fail('output_create_failed'); }
  await directoryChain(parent);
  try { await fs.mkdir(out, { mode: 0o700 }); }
  catch (e) { fail(e.code === 'EEXIST' ? 'output_already_exists' : 'output_create_failed'); }
  await directoryChain(out);
  return out;
}
async function writeNew(s, name, value) {
  await directoryChain(s.out);
  // Names are internal constants/counters, never supplied by events or callers.
  await safeCall(() => fs.writeFile(path.join(s.out, name), JSON.stringify(value, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 }), 'output_write_failed');
}
function scopedUrl(value, advertiser, pathname) {
  let u;
  try { u = new URL(value); } catch { fail('account_url_mismatch'); }
  const ids = u.searchParams.getAll('aavid');
  if (u.origin !== ORIGIN || u.username || u.password || u.hash
      || (pathname && u.pathname !== pathname) || ids.length !== 1 || ids[0] !== advertiser)
    fail('account_url_mismatch');
  return u;
}
async function verifyTab(s) {
  const url = await safeCall(() => s.tab.url(), 'tab_url_unavailable');
  if (scopedUrl(url, s.advertiser).href !== s.expectedUrl) fail('account_url_mismatch');
}
function limit(value, fallback, ceiling) {
  value ??= fallback;
  if (!Number.isInteger(value) || value < 1 || value > ceiling) fail('invalid_capture_limit');
  return value;
}
function validatePage(page, after, s) {
  if (!obj(page) || !Array.isArray(page.events) || !integer(page.cursor)
      || typeof page.hasMore !== 'boolean' || typeof page.truncated !== 'boolean'
      || page.events.length > s.pageSize || page.cursor < after) fail('invalid_event_page');
  if (page.truncated) fail('events_truncated');
  let last = after;
  for (const event of page.events) {
    if (!obj(event) || !integer(event.sequence) || event.sequence <= last
        || event.sequence > page.cursor || event.source?.tabId !== s.tabId
        || typeof event.method !== 'string' || !obj(event.params)) fail('invalid_event_sequence_or_tab');
    last = event.sequence;
  }
  if (page.hasMore && (page.cursor <= after || !page.events.length)) fail('event_cursor_stalled');
}
async function drain(s, baseline = false) {
  let after = s.cursor;
  for (let i = 1; i <= s.maxPages; i++) {
    const page = await safeCall(() => s.cdp.readEvents({ ...(after === undefined ? {} : { afterSequence: after }),
      limit: s.pageSize }), 'events_read_failed');
    let bytes;
    try { bytes = Buffer.byteLength(JSON.stringify(page)); } catch { fail('invalid_event_page'); }
    s.bytes += bytes;
    if (s.bytes > s.maxBytes) fail('capture_byte_limit');
    if (!baseline) await writeNew(s, `events-${s.attempt}-${i}.raw.json`, page);
    validatePage(page, after ?? -1, s);
    s.count += page.events.length;
    if (s.count > s.maxEvents) fail('capture_event_limit');
    if (!baseline) s.events.push(...page.events);
    after = s.cursor = page.cursor;
    if (!page.hasMore) return;
  }
  fail('capture_page_limit');
}
function requestBusiness(event, s) {
  try {
    const p = event.params, r = p.request;
    if (event.method !== 'Network.requestWillBeSent' || r?.method !== 'POST') return null;
    scopedUrl(r.url, s.advertiser, s.requestPath);
    if (scopedUrl(p.documentURL, s.advertiser).href !== s.expectedUrl) return null;
    if (typeof p.requestId !== 'string' || !p.requestId || typeof r.postData !== 'string') return null;
    const b = JSON.parse(r.postData);
    if (b.OptType !== 2 || !Array.isArray(b.Objects) || b.Objects.length !== s.ids.length) return null;
    const ids = b.Objects.map(o => o?.objectID);
    if (new Set(ids).size !== s.ids.length || !ids.every(id => s.ids.includes(id))
        || !b.Objects.every(o => obj(o) && o.type === 1)) return null;
    return { OptType: b.OptType, Objects: b.Objects.map(o => ({ type: o.type, objectID: o.objectID })) };
  } catch { return null; }
}
function responseBusiness(parsed, s) {
  const response = {};
  if (obj(parsed) && Number.isSafeInteger(parsed.status_code)) response.status_code = parsed.status_code;
  const rows = parsed?.data?.results;
  const valid = Array.isArray(rows) && rows.length === s.ids.length
    && rows.every(r => obj(r) && typeof r.flag === 'boolean' && obj(r.object)
      && r.object.type === 1 && s.ids.includes(r.object.objectId))
    && new Set(rows.map(r => r.object.objectId)).size === s.ids.length;
  if (valid) response.data = { results: rows.map(r => ({ flag: r.flag,
    object: { objectId: r.object.objectId, type: r.object.type } })) };
  return { response, response_observation: valid && Object.hasOwn(response, 'status_code')
    ? 'business_fields_observed' : 'unconfirmed' };
}
function state(capture) {
  const s = sessions.get(capture);
  if (!s) fail('invalid_capture_handle');
  return s;
}
export async function beginPauseCapture(options = {}) {
  const { tab, tab_id, advertiser_id, expected_account_url, request_path, expected_ids } = options;
  if (options.binding_verified !== true || !tab || typeof tab.url !== 'function'
      || typeof tab.capabilities?.get !== 'function') fail('verified_tab_required');
  if (typeof tab_id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(tab_id)) fail('invalid_tab_id');
  if (typeof advertiser_id !== 'string' || !/^\d{5,30}$/.test(advertiser_id)) fail('invalid_advertiser_id');
  if (request_path !== PAUSE_PATH) fail('unsupported_pause_path');
  if (!Array.isArray(expected_ids) || !expected_ids.length || expected_ids.length > 1000
      || !expected_ids.every(id => typeof id === 'string' && /^\d{5,30}$/.test(id))
      || new Set(expected_ids).size !== expected_ids.length) fail('invalid_expected_ids');
  const s = { tab, tabId: tab_id, advertiser: advertiser_id, requestPath: request_path,
    expectedUrl: scopedUrl(expected_account_url, advertiser_id).href, ids: [...expected_ids],
    maxPages: limit(options.max_pages, 10, 100), pageSize: limit(options.page_size, 1000, 1000),
    maxEvents: limit(options.max_events, 10000, 100000), maxBytes: limit(options.max_bytes, 8 * 1024 * 1024, 64 * 1024 * 1024),
    bodyLimit: limit(options.max_response_bytes, 1024 * 1024, 8 * 1024 * 1024),
    events: [], count: 0, bytes: 0, attempt: 0, enabled: false, busy: false, terminal: false, stopped: false };
  await verifyTab(s);
  s.out = await newOutput(options.private_root, options.output_dir);
  try {
    s.cdp = await safeCall(() => tab.capabilities.get('cdp'), 'cdp_capability_unavailable');
    if (typeof s.cdp?.send !== 'function' || typeof s.cdp?.readEvents !== 'function') fail('cdp_capability_unavailable');
    await verifyTab(s);
    // Mark before send: an error may arrive after the domain was enabled.
    s.enabled = true;
    await safeCall(() => s.cdp.send('Network.enable'), 'network_enable_failed');
    await drain(s, true);
    await verifyTab(s);
    // Pre-existing traffic is discarded only after its cursor is fully drained.
    s.count = 0; s.bytes = 0;
    await writeNew(s, 'capture-ready.json', { at: stamp(), tab_id, advertiser_id,
      cursor: s.cursor, observation_only: true });
    const handle = Object.freeze({ output_dir: s.out, observation_only: true });
    sessions.set(handle, s);
    return handle;
  } catch (e) {
    let disabled = !s.enabled;
    if (s.enabled) { try { await s.cdp.send('Network.disable'); disabled = true; } catch {} }
    const code = e instanceof CaptureError ? e.code : 'capture_initialization_failed';
    try { await writeNew(s, 'capture-failed.json', { at: stamp(), code, network_disabled: disabled }); } catch {}
    fail(code);
  }
}
export async function collectPauseCapture(capture) {
  const s = state(capture);
  if (s.stopped || s.terminal) fail('capture_closed');
  if (s.busy) fail('capture_busy');
  s.busy = true; s.attempt++;
  try {
    await verifyTab(s);
    await drain(s);
    await verifyTab(s);
    const matching = s.events.map(event => ({ event, business: requestBusiness(event, s) })).filter(x => x.business);
    if (matching.length === 0) fail('pause_request_not_observed');
    if (matching.length !== 1) fail('exact_pause_request_not_unique');
    const { event: request, business } = matching[0], requestId = request.params.requestId;
    const responses = s.events.filter(e => e.method === 'Network.responseReceived' && e.params.requestId === requestId);
    if (!responses.length) fail('pause_response_pending');
    if (responses.length !== 1) fail('pause_response_ambiguous');
    const response = responses[0], r = response.params.response;
    if (!obj(r) || !Number.isInteger(r.status) || r.status < 100 || r.status > 599
        || response.sequence <= request.sequence) fail('invalid_pause_response');
    scopedUrl(r.url, s.advertiser, s.requestPath);
    if (!s.events.some(e => e.method === 'Network.loadingFinished' && e.params.requestId === requestId
        && e.sequence > response.sequence)) fail('pause_response_pending');
    const body = await safeCall(() => s.cdp.send('Network.getResponseBody', { requestId }), 'response_body_unavailable');
    if (!obj(body) || typeof body.body !== 'string' || typeof body.base64Encoded !== 'boolean'
        || Buffer.byteLength(body.body) > s.bodyLimit * 2) fail('invalid_response_body');
    await writeNew(s, `response-${s.attempt}.raw.json`, { response, body });
    if (body.base64Encoded && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.body))
      fail('invalid_response_body');
    const decoded = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
    if (Buffer.byteLength(decoded) > s.bodyLimit) fail('response_body_limit');
    let parsed;
    try { parsed = JSON.parse(decoded); } catch { parsed = null; }
    await verifyTab(s);
    const receipt = { path: s.requestPath, method: 'POST', request: business,
      http_status: r.status, response_body_observed: true, ...responseBusiness(parsed, s), manual_readback_required: true,
      api_replay_verified: false, observation_only: true };
    await writeNew(s, 'pause-interface.json', receipt);
    s.terminal = true;
    return receipt;
  } catch (e) {
    const code = e instanceof CaptureError ? e.code : 'capture_collect_failed';
    // Only a complete snapshot lacking a request/body can be extended later.
    s.terminal = !['pause_request_not_observed', 'pause_response_pending', 'response_body_unavailable'].includes(code);
    try { await writeNew(s, `failure-${s.attempt}.json`, { at: stamp(), code, terminal: s.terminal }); } catch {}
    fail(code);
  } finally { s.busy = false; }
}
export async function stopPauseCapture(capture) {
  const s = state(capture);
  if (s.busy) fail('capture_busy');
  if (s.stopped) return { stopped: true, observation_only: true };
  s.busy = true;
  try {
    await safeCall(() => s.cdp.send('Network.disable'), 'network_disable_failed');
    s.stopped = true; s.events.length = 0;
    await writeNew(s, 'capture-stopped.json', { at: stamp(), network_disabled: true });
    return { stopped: true, observation_only: true };
  } finally { s.busy = false; }
}
