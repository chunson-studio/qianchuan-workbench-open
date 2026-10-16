'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getChromePageTarget } = require('./attach-qc-chrome.playwright.cjs');

const SCHEMA = 'qianchuan-native-session/v1';
const MAX_BODY = 256 * 1024;
const READ_RETENTION_MS = 120000;
const MAX_COMPLETED_READS = 64;
const MAX_FULL_WRITE_RESULTS = 32;
const FIELDS = ['room', 'account_id', 'advertiser_id', 'primary_ad_id'];
const idPattern = /^[A-Za-z0-9_-]{8,100}$/;
const fail = (code, message = code) => { throw Object.assign(new Error(message), { code }); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => plain(value) && Object.keys(value).every(key => keys.includes(key));
const canonical = value => JSON.stringify(value, function (key, item) {
  return plain(item) ? Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]])) : item;
});
const publicBinding = binding => Object.fromEntries([...FIELDS, 'browser_context_id', 'target_id'].map(key => [key, binding[key]]));

function isLoopbackAddress(address) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
}

function verifyUrl(value, binding) {
  let url;
  try { url = new URL(value); } catch { fail('native_page_identity_mismatch'); }
  if (url.origin !== 'https://qianchuan.jinritemai.com' || url.username || url.password) fail('native_page_identity_mismatch');
  const params = new URLSearchParams(url.search), hashQuery = url.hash.indexOf('?');
  if (hashQuery >= 0) for (const [key, val] of new URLSearchParams(url.hash.slice(hashQuery + 1))) params.append(key, val);
  for (const [names, expected] of [
    [['aavid', 'advertiser_id', 'advertiserId'], binding.advertiser_id],
    [['adId', 'primary_ad_id', 'primaryAdId'], binding.primary_ad_id],
  ]) {
    const values = names.flatMap(name => params.getAll(name));
    if (!values.length || values.some(value => value !== expected)) fail('native_page_identity_mismatch');
  }
}

function normalizeBindings(browser, bindings, pageAdapter) {
  if (!browser || typeof browser.isConnected !== 'function' || (!pageAdapter && typeof browser.contexts !== 'function') || !browser.isConnected()) fail('native_browser_required');
  if (!Array.isArray(bindings) || !bindings.length) fail('native_bindings_required');
  const pages = pageAdapter ? null : new Set(browser.contexts().flatMap(context => context.pages()));
  const rooms = new Set(), targets = new Set();
  return bindings.map(item => {
    if (!plain(item) || typeof item.room !== 'string' || !item.room.trim() || item.room !== item.room.trim() ||
        typeof item.account_id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(item.account_id) ||
        ['advertiser_id', 'primary_ad_id'].some(key => typeof item[key] !== 'string' || !/^\d+$/.test(item[key])) ||
        ['browser_context_id', 'target_id'].some(key => typeof item[key] !== 'string' || !item[key].trim()) ||
        (pageAdapter ? !pageAdapter.accepts(item.page) : !pages.has(item.page) || typeof item.page.url !== 'function' || typeof item.page.isClosed !== 'function' ||
        typeof item.page.context !== 'function')) fail('native_binding_invalid');
    if (rooms.has(item.room) || targets.has(item.target_id)) fail('native_binding_duplicate');
    rooms.add(item.room); targets.add(item.target_id);
    return Object.freeze({ ...publicBinding(item), page: item.page });
  });
}

async function verifyPage(browser, binding) {
  if (!browser.isConnected() || binding.page.isClosed()) fail('native_page_unavailable');
  verifyUrl(binding.page.url(), binding);
  const target = await getChromePageTarget(binding.page);
  if (target?.browserContextId !== binding.browser_context_id || target?.targetId !== binding.target_id) fail('native_page_identity_mismatch');
  verifyUrl(target.url, binding);
  verifyUrl(binding.page.url(), binding);
}

function checkRuntimeFile(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) fail('native_runtime_file_invalid');
  if (!fs.existsSync(file)) return;
  if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) fail('native_runtime_file_invalid');
  let prior;
  try { prior = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail('native_runtime_file_invalid'); }
  if (prior.schema !== SCHEMA || !Number.isSafeInteger(prior.pid)) fail('native_runtime_file_invalid');
  if (prior.status !== 'stopped') {
    try { process.kill(prior.pid, 0); } catch (error) { if (error.code === 'ESRCH') return; fail('native_host_already_registered'); }
    fail('native_host_already_registered');
  }
}

/**
 * Hold an already authorized Browser in this process. No browser attachment,
 * launch, credentials, arbitrary code/path dispatch, business decisions or
 * per-operation files. Registered reads must be read-only; registered writes
 * serialize within the actual CDP profile. Different profiles are independent.
 * Writes retain minimal deduplication receipts for this host's lifetime; read
 * results retain at most 64 completed reads and expire after two minutes when
 * the cache is next accessed. Only the latest
 * 32 completed write payloads remain in memory; older write receipts still
 * prevent replay. Callers retain host_id with unresolved requests and must not
 * replay them against a replacement host. A queue serializes one operation,
 * not a multi-step form: callers must keep one active round per room/main plan.
 */
async function startQianchuanNativeHost({ browser, bindings, operations, runtimeFile, port = 0, pageAdapter } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail('native_port_invalid');
  checkRuntimeFile(runtimeFile);
  if (pageAdapter && (!plain(pageAdapter) || pageAdapter.channel !== 'playwright-extension' ||
      ['accepts','verify','isClosed'].some(key => typeof pageAdapter[key] !== 'function') ||
      pageAdapter.onInitialFailure !== undefined && typeof pageAdapter.onInitialFailure !== 'function')) fail('native_page_adapter_invalid');
  let selected = normalizeBindings(browser, bindings, pageAdapter);
  const verifyBoundPage = binding => pageAdapter ? pageAdapter.verify(binding) : verifyPage(browser, binding);
  const pageClosed = binding => pageAdapter ? pageAdapter.isClosed(binding) : binding.page.isClosed();
  if (!plain(operations) || !Object.keys(operations).length) fail('native_operations_required');
  const registered = new Map();
  for (const [name, operation] of Object.entries(operations)) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(name) || ['constructor', 'prototype'].includes(name) ||
        !plain(operation) || !['read', 'write'].includes(operation.kind) || typeof operation.run !== 'function' ||
        (operation.serialize !== undefined && typeof operation.serialize !== 'boolean')) fail('native_operation_invalid');
    registered.set(name, Object.freeze({ kind: operation.kind, run: operation.run, serialize: operation.serialize === true }));
  }
  if (pageAdapter?.onInitialFailure) {
    const checks = await Promise.allSettled(selected.map(verifyBoundPage));
    for (let index = 0; index < checks.length; index++) {
      if (checks[index].status === 'rejected') await pageAdapter.onInitialFailure(selected[index], checks[index].reason);
    }
    selected = selected.filter((_binding, index) => checks[index].status === 'fulfilled');
    if (!selected.length) fail('native_no_healthy_bindings');
  } else await Promise.all(selected.map(verifyBoundPage));
  const byRoom = new Map(selected.map(binding => [binding.room, binding]));
  const hostId = crypto.randomUUID(), token = crypto.randomBytes(32).toString('hex');
  const requests = new Map(), writes = new Map();
  let endpoint, closing = false, closePromise;
  const metadata = () => ({ schema: SCHEMA, host_id: hostId, endpoint, pid: process.pid,
    ...(pageAdapter ? { channel: pageAdapter.channel } : {}),
    status: closing ? 'stopped' : 'running', created_at: createdAt, bindings: selected.map(publicBinding),
    operations: [...registered].map(([name, operation]) => ({ name, kind: operation.kind })),
    retention: { completed_read_ms: READ_RETENTION_MS, completed_reads: MAX_COMPLETED_READS,
      full_write_results: MAX_FULL_WRITE_RESULTS, write_receipts: 'host_lifetime' } });
  const createdAt = new Date().toISOString();
  const writeRuntime = () => fs.writeFileSync(runtimeFile, JSON.stringify({ ...metadata(), token }, null, 2) + '\n', { mode: 0o600 });
  const send = (response, status, body) => {
    if (response.destroyed || response.writableEnded) return;
    let serialized;
    try { serialized = JSON.stringify(body).replaceAll(token, '[redacted]'); }
    catch { serialized = JSON.stringify({ ok: false, code: 'native_result_not_serializable', retry_write: false }); status = 500; }
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(serialized);
  };
  const authenticate = request => {
    if (!isLoopbackAddress(request.socket.remoteAddress) || request.headers.origin !== undefined ||
        request.headers.host !== new URL(endpoint).host) fail('native_origin_rejected');
    const provided = request.headers.authorization;
    if (typeof provided !== 'string' || !provided.startsWith('Bearer ')) fail('native_auth_failed');
    const value = Buffer.from(provided.slice(7)), expected = Buffer.from(token);
    if (value.length !== expected.length || !crypto.timingSafeEqual(value, expected)) fail('native_auth_failed');
  };
  const bodyOf = async request => {
    if (!(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) fail('native_content_type_invalid');
    let size = 0; const chunks = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > MAX_BODY) fail('native_request_too_large');
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('native_request_invalid'); }
  };
  const requestBinding = body => {
    if (body.host_id !== hostId) fail('native_host_changed');
    if (!idPattern.test(body.request_id || '')) fail('native_request_id_invalid');
    const binding = byRoom.get(body.room);
    if (!binding || FIELDS.some(key => body[key] !== binding[key])) fail('native_binding_mismatch');
    return binding;
  };
  // Repair an explicitly observed replacement page using the current browser
  // connection. This never attaches to Chrome or replays business requests.
  const rebindPage = async (body, binding) => {
    if (pageAdapter) fail('native_rebind_unsupported_for_channel');
    if (!browser.isConnected()) fail('native_browser_disconnected');
    if ((body.target_id !== undefined && (typeof body.target_id !== 'string' || !body.target_id.trim())) ||
        typeof body.observed_url !== 'string' || !body.observed_url) fail('native_rebind_invalid');
    if (!Number.isSafeInteger(body.deadline_at_ms) || body.deadline_at_ms > Date.now() + 300000) fail('native_deadline_invalid');
    const deadline = Math.min(body.deadline_at_ms, Date.now() + 8000);
    let expired = false, timer;
    const checkDeadline = () => { if (expired || Date.now() >= deadline) fail('native_rebind_timeout'); };
    checkDeadline();
    verifyUrl(body.observed_url, binding);
    if (selected.some(item => item.room !== binding.room && item.target_id === body.target_id)) fail('native_binding_duplicate');
    const busy = () => [...requests.values()].some(record => !record.result &&
      record.binding.browser_context_id === binding.browser_context_id);
    if (writes.has(binding.browser_context_id) || busy()) fail('native_rebind_busy');
    const repair = async () => {
      if ((body.target_id === undefined || binding.target_id === body.target_id) && !binding.page.isClosed()) {
        if (binding.page.url() !== body.observed_url) fail('native_page_identity_mismatch');
        await verifyBoundPage(binding);
        return { ok: true, host_id: hostId, binding: publicBinding(binding), already_bound: true,
          advertising_writes: 0, requests_replayed: 0 };
      }
      if (!binding.page.isClosed()) fail('native_rebind_original_page_open');
      const candidates = browser.contexts().flatMap(context => context.pages())
        .filter(page => !page.isClosed() && page.url() === body.observed_url);
      const matches = [];
      for (const page of candidates) {
        const target = await getChromePageTarget(page);
        if (typeof target.targetId === 'string' && !!target.targetId.trim() &&
            (body.target_id === undefined || target.targetId === body.target_id) && target.browserContextId === binding.browser_context_id &&
            target.url === body.observed_url) matches.push({ page, target });
      }
      if (matches.length !== 1) fail('native_rebind_page_not_unique');
      const match = matches[0];
      if (selected.some(item => item.room !== binding.room && item.target_id === match.target.targetId)) fail('native_binding_duplicate');
      const replacement = Object.freeze({ ...binding, target_id: match.target.targetId, page: match.page });
      await verifyPage(browser, replacement);
      checkDeadline();
      if (!browser.isConnected() || replacement.page.isClosed()) fail('native_page_unavailable');
      if (replacement.page.url() !== body.observed_url || busy()) fail('native_rebind_changed');
      const index = selected.indexOf(binding);
      if (index < 0 || byRoom.get(binding.room) !== binding) fail('native_rebind_changed');
      selected[index] = replacement; byRoom.set(binding.room, replacement);
      try { writeRuntime(); }
      catch (error) { selected[index] = binding; byRoom.set(binding.room, binding); throw error; }
      return { ok: true, host_id: hostId, binding: publicBinding(replacement), already_bound: false,
        advertising_writes: 0, requests_replayed: 0 };
    };
    const pending = Promise.resolve().then(repair);
    writes.set(binding.browser_context_id, pending);
    try { return await Promise.race([pending, new Promise((_resolve, reject) => {
      timer = setTimeout(() => { expired = true; reject(Object.assign(new Error('native_rebind_timeout'), { code: 'native_rebind_timeout' })); },
        Math.max(1, deadline - Date.now()));
    })]); }
    finally { clearTimeout(timer); if (writes.get(binding.browser_context_id) === pending) writes.delete(binding.browser_context_id); }
  };
  const snapshot = record => record.result || { ok: true, host_id: hostId, request_id: record.request_id,
    state: record.phase, operation: record.operation, binding: publicBinding(record.binding),
    effect_status: record.phase === 'running' && record.kind === 'write' ? 'unconfirmed' : 'not_submitted', retry_write: false };
  const pruneRequests = () => {
    const completedReads = [], fullWrites = [];
    const now = Date.now();
    for (const [id, record] of requests) {
      if (!record.result) continue;
      if (record.kind === 'read') {
        if (now - record.completed_at >= READ_RETENTION_MS) requests.delete(id);
        else completedReads.push(record);
      } else if (Object.hasOwn(record.result, 'result')) fullWrites.push(record);
    }
    completedReads.sort((a, b) => a.completed_at - b.completed_at);
    for (const record of completedReads.slice(0, Math.max(0, completedReads.length - MAX_COMPLETED_READS))) requests.delete(record.request_id);
    fullWrites.sort((a, b) => a.completed_at - b.completed_at);
    for (const record of fullWrites.slice(0, Math.max(0, fullWrites.length - MAX_FULL_WRITE_RESULTS))) {
      const { result, ...receipt } = record.result;
      record.result = { ...receipt, result_expired: true, requires_readback: true, effect_status: 'unconfirmed' };
    }
  };
  function schedule(body, binding, operation) {
    pruneRequests();
    const fingerprint = crypto.createHash('sha256').update(canonical({ operation: body.operation, input: body.input,
      ...Object.fromEntries(FIELDS.map(key => [key, body[key]])) })).digest('hex');
    const existing = requests.get(body.request_id);
    if (existing) {
      if (existing.fingerprint !== fingerprint) fail('native_request_conflict');
      return existing;
    }
    const record = { request_id: body.request_id, fingerprint, operation: body.operation, kind: operation.kind,
      binding, phase: 'queued', deadline: body.deadline_at_ms, result: null };
    requests.set(body.request_id, record);
    let resolveResult;
    record.promise = new Promise(resolve => { resolveResult = resolve; });
    const finish = result => {
      if (record.result) return;
      clearTimeout(record.timer);
      record.result = { host_id: hostId, request_id: record.request_id, operation: record.operation,
        binding: publicBinding(binding), retry_write: false, ...result };
      record.phase = record.result.state;
      record.completed_at = Date.now();
      resolveResult(record.result);
      // Do not retain a settled Promise, which would pin an evicted payload.
      record.promise = null;
      pruneRequests();
    };
    const expired = () => {
      if (record.result) return true;
      if (Date.now() >= record.deadline) {
        finish({ ok: false, state: 'rejected', code: 'native_queue_timeout', effect_status: 'not_submitted', advertising_writes: 0 });
        return true;
      }
      return false;
    };
    record.timer = setTimeout(() => { if (record.phase !== 'running') expired(); }, Math.max(1, record.deadline - Date.now()));
    const execute = async () => {
      if (expired()) return;
      record.phase = 'checking';
      try {
        await verifyBoundPage(binding);
        if (expired() || closing) {
          if (!record.result) finish({ ok: false, state: 'rejected', code: 'native_host_stopped', effect_status: 'not_submitted', advertising_writes: 0 });
          return;
        }
        record.phase = 'running';
        clearTimeout(record.timer);
        const result = await operation.run({ page: binding.page, binding: publicBinding(binding), input: body.input });
        await verifyBoundPage(binding);
        // An operation can report a failed/unknown outcome without throwing
        // (for example, a partially completed form-preparation batch).
        if (result?.ok === false || result?.status === 'unknown' || result?.state === 'unknown') {
          const operationCode = typeof result?.code === 'string' && /^[a-z0-9_]{1,80}$/.test(result.code) ? result.code : undefined;
          const effect = operation.kind === 'read' || result?.effect_status === 'not_submitted' ? 'not_submitted' : 'unconfirmed';
          const rejected = (result?.status === 'rejected' || result?.state === 'rejected') && effect === 'not_submitted';
          finish({ ok: false, state: rejected ? 'rejected' : 'unknown', code: 'native_operation_failed',
            ...(operationCode ? { operation_code: operationCode } : {}), effect_status: effect,
            requires_readback: !rejected || result?.requires_readback === true,
            ...(effect === 'not_submitted' || result?.advertising_writes === 0 ? { advertising_writes: 0 } : {}), result });
        } else {
          // Completed dispatch alone is not a claim of advertising success.
          finish({ ok: true, state: 'completed', result });
        }
      } catch (error) {
        const dispatched = record.phase === 'running';
        const operationCode = typeof error?.code === 'string' && /^[a-z0-9_]{1,80}$/.test(error.code) ? error.code : undefined;
        const effects = [error?.effect_status, error?.details?.effect_status].filter(value => value !== undefined);
        const explicitlyNotSubmitted = effects.length > 0 && effects.every(value => value === 'not_submitted');
        const notSubmitted = !dispatched || operation.kind === 'read' || explicitlyNotSubmitted;
        finish({ ok: false, state: dispatched ? 'unknown' : 'rejected',
          code: dispatched ? 'native_operation_failed' : (/^[A-Za-z0-9_]+$/.test(error?.code || '') ? error.code : 'native_identity_check_failed'),
          ...(dispatched && operationCode ? { operation_code: operationCode } : {}),
          effect_status: notSubmitted ? 'not_submitted' : 'unconfirmed',
          ...(notSubmitted ? { advertising_writes: 0 } : {}) });
      }
    };
    if (operation.kind === 'write' || operation.serialize) {
      const prior = writes.get(binding.browser_context_id) || Promise.resolve();
      const next = prior.then(execute, execute);
      writes.set(binding.browser_context_id, next);
      next.finally(() => { if (writes.get(binding.browser_context_id) === next) writes.delete(binding.browser_context_id); }).catch(() => {});
    } else execute().catch(() => {});
    return record;
  }
  const server = http.createServer(async (request, response) => {
    try {
      authenticate(request);
      if (closing) fail('native_host_stopped');
      if (request.method === 'GET' && request.url === '/status') return send(response, 200, { ok: true, ...metadata(), connected: browser.isConnected(),
        binding_health: selected.map(binding => ({ ...publicBinding(binding), page_closed: pageClosed(binding) })) });
      if (request.method !== 'POST' || !['/call', '/request', '/rebind'].includes(request.url)) fail('native_route_invalid');
      const body = await bodyOf(request);
      if (!exactKeys(body, [...FIELDS, 'host_id', 'request_id', ...(request.url === '/call' ? ['operation', 'input', 'deadline_at_ms'] :
        request.url === '/rebind' ? ['target_id', 'observed_url', 'deadline_at_ms'] : [])])) fail('native_request_invalid');
      const binding = requestBinding(body);
      if (request.url === '/rebind') return send(response, 200, await rebindPage(body, binding));
      if (request.url === '/request') {
        pruneRequests();
        const record = requests.get(body.request_id);
        if (!record) return send(response, 404, { ok: false, code: 'native_request_not_found', host_id: hostId, retry_write: false });
        if (FIELDS.some(key => record.binding[key] !== body[key])) fail('native_binding_mismatch');
        return send(response, 200, snapshot(record));
      }
      if (typeof body.operation !== 'string' || !registered.has(body.operation) || !plain(body.input)) fail('native_operation_invalid');
      if (!Number.isSafeInteger(body.deadline_at_ms) || body.deadline_at_ms > Date.now() + 300000) fail('native_deadline_invalid');
      const record = schedule(body, binding, registered.get(body.operation));
      return send(response, 200, record.promise ? await record.promise : snapshot(record));
    } catch (error) {
      const code = /^[A-Za-z0-9_]+$/.test(error?.code || '') ? error.code : 'native_request_failed';
      send(response, code === 'native_auth_failed' ? 401 : code === 'native_origin_rejected' ? 403 : code === 'native_request_conflict' ? 409 : 400,
        { ok: false, code, host_id: hostId, advertising_writes: 0, retry_write: false });
    }
  });
  server.requestTimeout = 300000;
  server.headersTimeout = 15000;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    endpoint = 'http://127.0.0.1:' + server.address().port;
    fs.mkdirSync(path.dirname(runtimeFile), { recursive: true });
    checkRuntimeFile(runtimeFile);
    writeRuntime();
  } catch (error) {
    server.close();
    throw error;
  }
  const close = () => {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = new Promise((resolve, reject) => server.close(error => {
      try {
        const current = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
        if (current.host_id === hostId) writeRuntime();
      } catch { /* Closing the HTTP owner never closes the external browser. */ }
      if (error) reject(error); else resolve({ ok: true, host_id: hostId, status: 'stopped' });
    }));
    return closePromise;
  };
  return Object.freeze({ ...metadata(), runtime_file: runtimeFile, close });
}

module.exports = { startQianchuanNativeHost, isLoopbackAddress };
