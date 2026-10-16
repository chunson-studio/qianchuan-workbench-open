/**
 * Explicitly authorized Codex CUA credential export, then existing-account refresh.
 * This is not a browser CLI. No browser launch, private CDP fields, profile editing,
 * ad actions, onboarding save/draft, account creation, or unrelated service assertions.
 *
 * exportQianchuanCredential({ tab, advertiser_id, output_file, private_root,
 *   export_authorized: true, cdp_capability?, receipt_file?, header_selector? })
 * The caller must have read the native capability documentation. Pass its `send`
 * capability bound to the same tab, or use tab.capabilities.get('cdp'). The default
 * .account-info-box is an already observed account-header selector. A different
 * header_selector must come from this page's observed DOM, never a guessed selector.
 *
 * importExistingQianchuanCredential({ base_url, account_id, advertiser_id,
 *   cookie_file, receipt_file, private_root, fetch_impl?, timeout_ms? })
 * All files must be new JSON files (input excepted) below the existing local
 * private-runtime/credential-import directory. Directories below private_root may
 * be created. Existing receipts/exports are never overwritten. Receipt checkpoints
 * contain metadata only; raw DOM, Cookie values and HTTP errors are never emitted.
 * The existing service owns atomic config/credential persistence and policy retention.
 * Do not rerun an unknown select: inspect the existing account in the local service and verify its identity.
 *
 * CLI (import only; absolute paths, no Cookie values on the command line):
 * node tools/codex-qc-credential-refresh.mjs import --base-url http://127.0.0.1:PORT
 *   --account-id ACCOUNT --advertiser-id ADVERTISER --private-root ABS/private-runtime
 *   --cookie-file ABS/private-runtime/credential-import/input.json
 *   --receipt-file ABS/private-runtime/credential-import/refresh-receipt.json
 */
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { Buffer } from 'node:buffer';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ORIGIN = 'https://qianchuan.jinritemai.com';
const HOST = 'qianchuan.jinritemai.com';
const COOKIE_LIMIT = 256 * 1024; // Matches the existing onboarding parser.
const RESPONSE_LIMIT = 2 * 1024 * 1024;
class RefreshError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new RefreshError(code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const stamp = () => new Date().toISOString();

function advertiser(value) {
  if (typeof value !== 'string' || !/^\d{5,30}$/.test(value)) fail('invalid_advertiser_id');
  return value;
}
function account(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,50}$/.test(value)) fail('invalid_account_id');
  return value;
}
function sizeLimit(value = COOKIE_LIMIT) {
  if (!Number.isInteger(value) || value < 1 || value > COOKIE_LIMIT) fail('invalid_size_limit');
  return value;
}
function localPath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f]/.test(value)
      || /^(?:\\\\|\/\/)/.test(value)) fail('invalid_local_path');
  const parts = value.slice(path.parse(value).root.length).split(/[\\/]/);
  if (parts.some(p => !p || p === '.' || p === '..' || /[<>:"|?*]|[. ]$/.test(p)
      || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(p))) fail('invalid_local_path');
  return path.resolve(value);
}
function below(root, file) {
  const relative = path.relative(root, file);
  return relative !== '' && !relative.startsWith('..' + path.sep)
    && relative !== '..' && !path.isAbsolute(relative);
}
async function statOrNull(file) {
  try { return await fs.lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function directoryChain(directory, createBelow) {
  const root = path.parse(directory).root;
  let cursor = root;
  for (const part of directory.slice(root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    let st = await statOrNull(cursor);
    if (!st && createBelow && below(createBelow, cursor)) {
      try { await fs.mkdir(cursor, { mode: 0o700 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      st = await fs.lstat(cursor);
    }
    if (!st || st.isSymbolicLink() || !st.isDirectory()) fail('unsafe_directory');
  }
}
async function guardedFile(privateRoot, file, mustExist = false) {
  const root = localPath(privateRoot);
  if (path.basename(root) !== 'private-runtime') fail('invalid_private_root');
  const target = localPath(file);
  if (!below(path.join(root, 'credential-import'), target)
      || path.extname(target).toLowerCase() !== '.json') fail('file_outside_credential_import');
  await directoryChain(root);
  await directoryChain(path.dirname(target), root);
  const st = await statOrNull(target);
  if (mustExist) {
    if (!st || !st.isFile() || st.isSymbolicLink() || st.nlink !== 1) fail('invalid_cookie_file');
  } else if (st) fail('output_already_exists');
  return target;
}
async function openNew(file) {
  return fs.open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY
    | (constants.O_NOFOLLOW || 0), 0o600);
}
async function writeHandle(handle, text) {
  const buffer = Buffer.from(text);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, offset);
    if (!bytesWritten) fail('file_write_failed');
    offset += bytesWritten;
  }
  await handle.truncate(buffer.length);
  await handle.sync();
}
async function readCookieFile(file, limit) {
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.nlink !== 1 || st.size < 1 || st.size > limit) fail('invalid_cookie_file_size');
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > limit) fail('invalid_cookie_file_size');
    let rows;
    try { rows = JSON.parse(buffer.subarray(0, length).toString('utf8')); }
    catch { fail('invalid_cookie_json'); }
    return validateCookies(rows, false);
  } finally { await handle.close(); }
}
function validateCookies(rows, fromCdp) {
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > 4096) fail('invalid_cookie_array');
  return rows.map(row => {
    if (!object(row) || typeof row.domain !== 'string'
        || ![HOST, '.' + HOST, '.jinritemai.com'].includes(row.domain)
        || row.path !== '/') fail('cookie_site_scope_mismatch');
    if (typeof row.name !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(row.name)
        || typeof row.value !== 'string' || /[\r\n;\x00-\x20\x7f]/.test(row.value)
        || typeof row.secure !== 'boolean' || typeof row.httpOnly !== 'boolean'
        || typeof row.session !== 'boolean') fail('invalid_cookie_fields');
    const hostOnly = !row.domain.startsWith('.');
    if (!fromCdp && row.hostOnly !== hostOnly) fail('invalid_cookie_fields');
    const expires = fromCdp ? row.expires : row.expirationDate;
    if (expires !== undefined && (!Number.isFinite(expires) || (!fromCdp && expires <= 0))) fail('invalid_cookie_expiry');
    if (!row.session && !(expires > 0)) fail('invalid_cookie_expiry');
    return { domain: row.domain, name: row.name, value: row.value, path: row.path,
      secure: row.secure, httpOnly: row.httpOnly, session: row.session, hostOnly,
      ...(expires > 0 ? { expirationDate: expires } : {}) };
  });
}

function receipt(kind) {
  return { schema_version: 1, operation: kind, channel: kind === 'export' ? 'codex-cua' : 'local-http',
    started_at: stamp(), ok: false, code: 'in_progress', retry_write: false,
    export: { status: kind === 'export' ? 'not_started' : 'not_observed' },
    verification: {}, save: { status: kind === 'export' ? 'not_requested' : 'not_started' } };
}
async function workflow(kind, work) {
  const result = receipt(kind);
  let handle;
  const checkpoint = async () => {
    if (handle) await writeHandle(handle, JSON.stringify(result, null, 2) + '\n');
  };
  try {
    await work(result, checkpoint, async file => { handle = await openNew(file); });
    result.ok = true;
    result.code = kind === 'export' ? 'credential_exported' : 'credential_updated';
  } catch (error) {
    result.ok = false;
    result.code = error instanceof RefreshError ? error.code : 'credential_refresh_failed';
    if (result.save.status === 'submitted') result.save.status = 'unknown';
  }
  result.finished_at = stamp();
  try { await checkpoint(); }
  catch {
    result.ok = false;
    result.code = 'receipt_write_failed';
    // A sync failure can occur after bytes were written. Best effort replaces any
    // complete success JSON with the failed receipt; never retry a service write.
    try { await checkpoint(); } catch { /* Return metadata, never a raw FS error. */ }
  }
  try { await handle?.close(); }
  catch { result.ok = false; result.code = 'receipt_close_failed'; }
  return result;
}

async function verifyTab(tab, id, selector) {
  if (typeof tab?.url !== 'function' || typeof tab?.playwright?.locator !== 'function') fail('browser_identity_api_unavailable');
  const checkUrl = async () => {
    let url;
    try { url = new URL(await tab.url()); } catch { fail('browser_url_unavailable'); }
    if (url.origin !== ORIGIN || url.username || url.password) fail('qianchuan_origin_required');
    const ids = url.searchParams.getAll('aavid');
    if (ids.length !== 1 || ids[0] !== id) fail('browser_advertiser_mismatch');
  };
  await checkUrl();
  let texts;
  try { texts = await tab.playwright.locator(selector).evaluateAll(es => es.map(e => e.textContent)); }
  catch { fail('browser_header_unavailable'); }
  if (!Array.isArray(texts) || texts.length !== 1 || typeof texts[0] !== 'string') fail('browser_header_ambiguous');
  const ids = [...texts[0].matchAll(/(?:^|\s)(?:广告账户ID|账户ID|广告户ID|当前可投商城的账户ID|ID)\s*[:：]\s*(\d+)(?=\s|$)/gi)].map(m => m[1]);
  if (ids.length !== 1 || ids[0] !== id) fail('browser_header_advertiser_mismatch');
  await checkUrl();
}

export async function exportQianchuanCredential(options = {}) {
  return workflow('export', async (result, checkpoint, startReceipt) => {
    const { tab, advertiser_id, private_root, output_file, cdp_capability,
      export_authorized, header_selector = '.account-info-box' } = options;
    result.advertiser_id = advertiser(advertiser_id);
    if (export_authorized !== true) fail('explicit_export_authorization_required');
    if (typeof header_selector !== 'string' || !header_selector.trim() || header_selector.length > 512) fail('invalid_header_selector');
    const limit = sizeLimit(options.max_cookie_bytes);
    const output = await guardedFile(private_root, output_file);
    const receiptFile = await guardedFile(private_root, options.receipt_file ?? output + '.receipt.json');
    if (output === receiptFile) fail('receipt_cookie_path_collision');
    await startReceipt(receiptFile);
    result.receipt_file = receiptFile;
    await checkpoint();
    await verifyTab(tab, advertiser_id, header_selector);
    result.verification.browser_identity = 'verified';
    await checkpoint();
    let cap = cdp_capability;
    if (!cap) {
      if (typeof tab.capabilities?.get !== 'function') fail('cookie_export_capability_unavailable');
      try { cap = await tab.capabilities.get('cdp'); }
      catch { fail('cookie_export_capability_unavailable'); }
    }
    if (typeof cap?.send !== 'function') fail('cookie_export_capability_unavailable');
    await verifyTab(tab, advertiser_id, header_selector);
    let payload;
    try { payload = await cap.send('Network.getCookies', { urls: [ORIGIN + '/'] }); }
    catch { fail('cookie_export_unavailable'); }
    const rows = validateCookies(payload?.cookies, true);
    const text = JSON.stringify(rows, null, 2) + '\n';
    if (Buffer.byteLength(text) > limit) fail('invalid_cookie_file_size');
    // The tab may have switched account while the native capability was awaited.
    await verifyTab(tab, advertiser_id, header_selector);
    result.verification.browser_identity_after_export = 'verified';
    await checkpoint();
    await guardedFile(private_root, output);
    const handle = await openNew(output);
    try { await writeHandle(handle, text); }
    finally { await handle.close(); }
    result.export = { status: 'exported', cookie_count: rows.length, bytes: Buffer.byteLength(text),
      output_file: output, site_origin: ORIGIN, exported_at: stamp() };
    await checkpoint();
  });
}

function localBase(value) {
  if (typeof value !== 'string' || /\s|\\|@/.test(value)) fail('invalid_base_url');
  let url;
  try { url = new URL(value); } catch { fail('invalid_base_url'); }
  // Match the service's localAccess allowlist; redirects are separately prohibited.
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.pathname !== '/' || url.search || url.hash) fail('loopback_base_url_required');
  return url.origin;
}
async function jsonRequest(fetchImpl, base, route, body, timeout) {
  let response;
  try {
    response = await fetchImpl(base + route, { method: body ? 'POST' : 'GET',
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json', 'x-qc-onboarding': '1' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error',
      signal: AbortSignal.timeout(timeout), cache: 'no-store', credentials: 'omit' });
  } catch { fail('local_http_request_failed'); }
  if (!response || !response.ok || response.redirected || (response.url && response.url !== base + route)) fail('local_http_failed');
  if (!/^application\/json(?:;|$)/i.test(response.headers?.get('content-type') || '')) fail('local_http_invalid_content_type');
  const length = response.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > RESPONSE_LIMIT)) fail('local_http_response_too_large');
  const reader = response.body?.getReader?.();
  if (!reader) fail('local_http_invalid_response');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > RESPONSE_LIMIT) fail('local_http_response_too_large');
      chunks.push(Buffer.from(next.value));
    }
  } finally { try { await reader.cancel(); } catch { /* Never expose transport errors. */ } }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail('local_http_invalid_json'); }
  if (!object(data) || data.ok !== true) fail('local_http_rejected');
  return data;
}
function verifyRegistry(data, id, adv) {
  if (!Array.isArray(data.accounts) || !data.accounts.every(object)) fail('invalid_account_registry');
  const byId = data.accounts.filter(row => row.id === id);
  const byAdv = data.accounts.filter(row => row.aavid === adv);
  if (byId.length !== 1 || byAdv.length !== 1 || byId[0] !== byAdv[0]) fail('existing_account_binding_mismatch');
}
function exactCandidate(data, adv) {
  if (typeof data.discovery_id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(data.discovery_id)
      || !Array.isArray(data.candidates) || !data.candidates.every(object)) fail('invalid_discovery');
  const matches = data.candidates.filter(row => row.aavid === adv);
  if (matches.length !== 1) fail('discovery_advertiser_mismatch');
  const match = matches[0];
  if (typeof match.candidate_id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(match.candidate_id)
      || data.candidates.filter(row => row.candidate_id === match.candidate_id).length !== 1
      || (Object.hasOwn(match, 'advertiser_id') && match.advertiser_id !== adv)) fail('invalid_discovery_candidate');
  return match.candidate_id;
}
function verifySaved(data, id, adv) {
  if (data.cookie_imported !== true || data.updated !== true || data.profile_created !== false
      || data.mcp_reconnect_required !== false
      || (Object.hasOwn(data, 'status') && !['ok', 'success', 'saved', 'updated'].includes(data.status))
      || (Object.hasOwn(data, 'account') && (!object(data.account) || data.account.id !== id || data.account.aavid !== adv))
      || (Object.hasOwn(data, 'account_id') && data.account_id !== id)) fail('credential_save_unconfirmed');
}

export async function importExistingQianchuanCredential(options = {}) {
  return workflow('import_existing', async (result, checkpoint, startReceipt) => {
    const { advertiser_id, account_id, private_root, fetch_impl = globalThis.fetch } = options;
    result.account_id = account(account_id);
    result.advertiser_id = advertiser(advertiser_id);
    const base = localBase(options.base_url);
    const limit = sizeLimit(options.max_cookie_bytes);
    const timeout = options.timeout_ms ?? 30000;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 60000 || typeof fetch_impl !== 'function') fail('invalid_http_options');
    const input = await guardedFile(private_root, options.cookie_file, true);
    const receiptFile = await guardedFile(private_root, options.receipt_file);
    if (input === receiptFile) fail('receipt_cookie_path_collision');
    await startReceipt(receiptFile);
    result.receipt_file = receiptFile;
    await checkpoint();
    const rows = await readCookieFile(input, limit);
    const cookieJson = JSON.stringify(rows);
    if (Buffer.byteLength(cookieJson) > limit) fail('invalid_cookie_file_size');
    result.input = { format: 'cookie_editor_json', cookie_count: rows.length, cookie_file: input };
    await checkpoint();
    const request = (route, body) => jsonRequest(fetch_impl, base, route, body, timeout);
    verifyRegistry(await request('/api/accounts'), account_id, advertiser_id);
    result.verification.existing_account = 'verified';
    await checkpoint();
    const discovered = await request('/api/onboarding', { action: 'import', cookie_json: cookieJson, advertiser_id });
    const candidate = exactCandidate(discovered, advertiser_id);
    result.verification.discovered_identity = 'verified';
    await checkpoint();
    // Recheck after discovery; the service also enforces targetAccountId atomically.
    verifyRegistry(await request('/api/accounts'), account_id, advertiser_id);
    result.verification.existing_account_before_select = 'verified';
    result.save = { status: 'submitted', submitted_at: stamp() };
    await checkpoint();
    const selected = await request('/api/onboarding', { action: 'select', discovery_id: discovered.discovery_id,
      candidate_id: candidate, account_id });
    verifySaved(selected, account_id, advertiser_id);
    result.save = { status: 'confirmed', cookie_imported: true, updated: true, profile_created: false,
      mcp_reconnect_required: false, confirmed_at: stamp() };
    await checkpoint();
    verifyRegistry(await request('/api/accounts'), account_id, advertiser_id);
    result.verification.existing_account_after_select = 'verified';
    await checkpoint();
  });
}

const HELP = 'Import only: import --base-url URL --account-id ID --advertiser-id ID --private-root ABS/private-runtime --cookie-file ABS.json --receipt-file ABS.json [--timeout-ms N]';
export async function runCredentialRefreshCli(argv, dependencies = {}) {
  if (!Array.isArray(argv) || !argv.every(value => typeof value === 'string')) return { ok: false, code: 'invalid_cli_arguments', usage: HELP };
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { ok: true, usage: HELP };
  const fields = { '--base-url': 'base_url', '--account-id': 'account_id', '--advertiser-id': 'advertiser_id',
    '--private-root': 'private_root', '--cookie-file': 'cookie_file', '--receipt-file': 'receipt_file', '--timeout-ms': 'timeout_ms' };
  if (argv[0] !== 'import' || argv.length % 2 !== 1) return { ok: false, code: 'invalid_cli_arguments', usage: HELP };
  const options = {};
  for (let index = 1; index < argv.length; index += 2) {
    const key = Object.hasOwn(fields, argv[index]) ? fields[argv[index]] : null, value = argv[index + 1];
    if (!key || Object.hasOwn(options, key) || !value || value.startsWith('--')) return { ok: false, code: 'invalid_cli_arguments', usage: HELP };
    options[key] = key === 'timeout_ms' ? Number(value) : value;
  }
  return importExistingQianchuanCredential({ ...options, fetch_impl: dependencies.fetch_impl ?? globalThis.fetch });
}
if (typeof process === 'object' && process !== null && Array.isArray(process.argv)
    && process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await runCredentialRefreshCli(process.argv.slice(2));
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (!result.ok) process.exitCode = 1;
}
