// Synthetic fixtures only. No real browser, service, account, Cookie or scheduler.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { exportQianchuanCredential, importExistingQianchuanCredential, runCredentialRefreshCli } from './codex-qc-credential-refresh.mjs';

const require = createRequire(import.meta.url);
const root = require('../checks/test-output.cjs').testOutputRoot();
const ADV = '6000003601';
const OTHER = '6000003602';
const ACCOUNT = 'synthetic-account';
const ORIGIN = 'https://qianchuan.jinritemai.com';
const BASE = 'http://127.0.0.1:18999';
const SECRET = 'SYNTHETIC_NOT_A_REAL_CREDENTIAL';
let fixtureNumber = 0;
let accidentalNetworkCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { accidentalNetworkCalls++; throw Error('real_network_forbidden'); };
after(() => { globalThis.fetch = originalFetch; assert.equal(accidentalNetworkCalls, 0); });

const cdpCookies = () => [
  { domain: '.jinritemai.com', name: 'synthetic_session', value: SECRET, path: '/', secure: true,
    httpOnly: true, session: true, expires: -1 },
  { domain: 'qianchuan.jinritemai.com', name: 'synthetic_persistent', value: 'fake', path: '/',
    secure: true, httpOnly: false, session: false, expires: 4102444800 },
];
const editorCookies = () => cdpCookies().map(({ expires, ...row }) => ({ ...row,
  hostOnly: !row.domain.startsWith('.'), ...(expires > 0 ? { expirationDate: expires } : {}) }));
async function fixture() {
  const directory = path.join(root, `credential-refresh-${++fixtureNumber}`);
  const private_root = path.join(directory, 'private-runtime');
  const importDir = path.join(private_root, 'credential-import');
  await fs.mkdir(importDir, { recursive: true });
  const cookie_file = path.join(importDir, 'input.json');
  await fs.writeFile(cookie_file, JSON.stringify(editorCookies()));
  return { directory, private_root, cookie_file, output_file: path.join(importDir, 'export.json'),
    receipt_file: path.join(importDir, 'receipt.json'), advertiser_id: ADV, account_id: ACCOUNT,
    base_url: BASE, export_authorized: true };
}
function fakeTab(overrides = {}) {
  const calls = [];
  const state = { url: `${ORIGIN}/home?aavid=${ADV}`, texts: [`Synthetic account\nID：${ADV}`],
    cookies: cdpCookies(), ...overrides };
  const cap = { async send(method, params) {
    calls.push({ action: 'send', method, params });
    if (state.sendError) throw Error(SECRET);
    state.afterSend?.(state);
    return { cookies: state.cookies };
  } };
  const tab = {
    async url() { calls.push({ action: 'url' }); return state.url; },
    playwright: { locator(selector) {
      calls.push({ action: 'header', selector });
      return { async evaluateAll(fn) {
        if (state.domError) throw Error(SECRET);
        return fn(state.texts.map(textContent => ({ textContent })));
      } };
    } },
    capabilities: { async get(name) {
      calls.push({ action: 'capability', name });
      if (state.capError) throw Error(SECRET);
      state.afterCapability?.(state);
      return cap;
    } },
  };
  return { tab, cap, calls, state };
}
function response(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}
function fakeHttp(overrides = {}) {
  const calls = [];
  const policy = { allowed_actions: ['existing_scope'], boost_write_scope: { marker: 'synthetic-scope' },
    mode: 'legacy-value', allow_write: false };
  const state = { policy, accounts: [{ id: ACCOUNT, aavid: ADV }],
    discovery: { ok: true, discovery_id: 'fixture-discovery', candidates: [
      { candidate_id: 'candidate-other', aavid: OTHER }, { candidate_id: 'candidate-exact', aavid: ADV } ] },
    selected: { ok: true, cookie_imported: true, updated: true, profile_created: false,
      mcp_reconnect_required: false, account: { id: ACCOUNT, aavid: ADV } },
    ...overrides };
  let registryRead = 0;
  const fetch_impl = async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ url, ...options, body });
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    assert.ok(options.signal instanceof AbortSignal);
    if (state.respond) {
      const custom = await state.respond({ url, options, body, calls, state });
      if (custom !== undefined) return custom;
    }
    if (url.endsWith('/api/accounts')) {
      assert.equal(options.method, 'GET');
      registryRead++;
      return response({ ok: true, accounts: state.registryAt?.(registryRead) ?? state.accounts });
    }
    assert.equal(url, new URL('/api/onboarding', url).href);
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.equal(options.headers['x-qc-onboarding'], '1');
    if (body.action === 'import') {
      assert.deepEqual(Object.keys(body).sort(), ['action', 'advertiser_id', 'cookie_json']);
      return response(state.discovery);
    }
    assert.equal(body.action, 'select', 'Only import/select are allowed');
    assert.deepEqual(Object.keys(body).sort(), ['account_id', 'action', 'candidate_id', 'discovery_id']);
    assert.equal(body.account_id, ACCOUNT, 'Cannot create a new account');
    return response(state.selected);
  };
  return { calls, state, fetch_impl };
}
async function assertReceipt(result, file) {
  const text = await fs.readFile(file, 'utf8');
  assert.ok(!text.includes(SECRET));
  assert.ok(!JSON.stringify(result).includes(SECRET));
  assert.deepEqual(JSON.parse(text), result);
}
const selectedCalls = http => http.calls.filter(call => call.body?.action === 'select');

test('export checks header/URL, requests only the site, maps Cookie Editor fields, persists separate metadata', async () => {
  const f = await fixture(), browser = fakeTab();
  const result = await exportQianchuanCredential({ ...f, tab: browser.tab });
  assert.equal(result.ok, true);
  assert.equal(result.export.status, 'exported');
  assert.equal(result.export.cookie_count, 2);
  assert.deepEqual(JSON.parse(await fs.readFile(f.output_file, 'utf8')), editorCookies());
  assert.deepEqual(browser.calls.filter(c => c.action === 'send'), [
    { action: 'send', method: 'Network.getCookies', params: { urls: [ORIGIN + '/'] } },
  ]);
  const sendIndex = browser.calls.findIndex(c => c.action === 'send');
  assert.ok(browser.calls.slice(0, sendIndex).some(c => c.action === 'header'));
  assert.ok(browser.calls.slice(sendIndex + 1).some(c => c.action === 'header'));
  assert.equal(result.save.status, 'not_requested');
  assert.equal(Object.hasOwn(result, 'mcp_status'), false);
  await assertReceipt(result, f.receipt_file);
});

test('account-info exact advertiser label can verify the observed header selector', async () => {
  const f = await fixture(), b = fakeTab({ texts: [`当前可投商城的账户ID：${ADV}`] });
  const result = await exportQianchuanCredential({ ...f, tab: b.tab, header_selector: '.observed-account-id' });
  assert.equal(result.ok, true);
  assert.ok(b.calls.some(c => c.action === 'header' && c.selector === '.observed-account-id'));
  await assertReceipt(result, f.receipt_file);
});

test('account-info mismatched advertiser label refuses credential access', async () => {
  const f = await fixture(), b = fakeTab({ texts: [`当前可投商城的账户ID：${OTHER}`] });
  const result = await exportQianchuanCredential({ ...f, tab: b.tab });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'browser_header_advertiser_mismatch');
  assert.equal(b.calls.filter(c => c.action === 'send').length, 0);
});

test('caller supplied native CDP capability works without capability discovery', async () => {
  const f = await fixture(), b = fakeTab();
  delete b.tab.capabilities;
  assert.equal((await exportQianchuanCredential({ ...f, tab: b.tab, cdp_capability: b.cap })).ok, true);
  assert.equal(b.calls.filter(c => c.action === 'capability').length, 0);
});

for (const [name, change, code] of [
  ['wrong header ID', { texts: [`ID：${OTHER}`] }, 'browser_header_advertiser_mismatch'],
  ['prefix ID', { texts: [`ID：${ADV}9`] }, 'browser_header_advertiser_mismatch'],
  ['suffix letters', { texts: [`ID：${ADV}x`] }, 'browser_header_advertiser_mismatch'],
  ['duplicate identity labels', { texts: [`ID：${ADV}\nID：${OTHER}`] }, 'browser_header_advertiser_mismatch'],
  ['header missing', { texts: ['Loading'] }, 'browser_header_advertiser_mismatch'],
  ['multiple headers', { texts: [`ID：${ADV}`, `ID：${ADV}`] }, 'browser_header_ambiguous'],
  ['DOM unavailable', { domError: true }, 'browser_header_unavailable'],
  ['wrong URL ID', { url: `${ORIGIN}/home?aavid=${OTHER}` }, 'browser_advertiser_mismatch'],
  ['missing URL ID', { url: ORIGIN + '/home' }, 'browser_advertiser_mismatch'],
  ['duplicate URL ID', { url: `${ORIGIN}/?aavid=${ADV}&aavid=${ADV}` }, 'browser_advertiser_mismatch'],
  ['foreign origin', { url: `https://example.invalid/?aavid=${ADV}` }, 'qianchuan_origin_required'],
  ['sibling origin', { url: `https://compass.jinritemai.com/?aavid=${ADV}` }, 'qianchuan_origin_required'],
  ['HTTP origin', { url: `http://qianchuan.jinritemai.com/?aavid=${ADV}` }, 'qianchuan_origin_required'],
  ['nondefault port', { url: `${ORIGIN}:8443/?aavid=${ADV}` }, 'qianchuan_origin_required'],
  ['URL credentials', { url: `https://user:password@qianchuan.jinritemai.com/?aavid=${ADV}` }, 'qianchuan_origin_required'],
]) test(`export rejects ${name} before cookie access`, async () => {
  const f = await fixture(), b = fakeTab(change);
  const result = await exportQianchuanCredential({ ...f, tab: b.tab });
  assert.equal(result.ok, false); assert.equal(result.code, code);
  assert.equal(b.calls.filter(c => c.action === 'send').length, 0);
  await assert.rejects(fs.stat(f.output_file), { code: 'ENOENT' });
  await assertReceipt(result, f.receipt_file);
});

for (const kind of ['missing', 'get throws', 'send absent', 'send throws']) test(`export records unsupported capability gap: ${kind}`, async () => {
  const f = await fixture(), b = fakeTab();
  if (kind === 'missing') delete b.tab.capabilities;
  if (kind === 'get throws') b.state.capError = true;
  if (kind === 'send absent') delete b.cap.send;
  if (kind === 'send throws') b.state.sendError = true;
  const r = await exportQianchuanCredential({ ...f, tab: b.tab });
  assert.equal(r.ok, false);
  assert.equal(r.code, kind === 'send throws' ? 'cookie_export_unavailable' : 'cookie_export_capability_unavailable');
  assert.equal(r.verification.browser_identity, 'verified');
  assert.equal(r.export.status, 'not_started');
  await assertReceipt(r, f.receipt_file);
});

test('account switching during cookie request refuses to persist the export', async () => {
  const f = await fixture(), b = fakeTab({ afterSend: state => { state.texts = [`ID：${OTHER}`]; } });
  const r = await exportQianchuanCredential({ ...f, tab: b.tab });
  assert.equal(r.code, 'browser_header_advertiser_mismatch');
  await assert.rejects(fs.stat(f.output_file), { code: 'ENOENT' });
});

test('account switching during capability acquisition prevents cookie access', async () => {
  const f = await fixture(), b = fakeTab({ afterCapability: state => { state.url = `${ORIGIN}/?aavid=${OTHER}`; } });
  const r = await exportQianchuanCredential({ ...f, tab: b.tab });
  assert.equal(r.code, 'browser_advertiser_mismatch');
  assert.equal(b.calls.filter(c => c.action === 'send').length, 0);
  await assert.rejects(fs.stat(f.output_file), { code: 'ENOENT' });
});

test('export byte limit is checked before any Cookie file is written', async () => {
  const f = await fixture(), b = fakeTab();
  const r = await exportQianchuanCredential({ ...f, tab: b.tab, max_cookie_bytes: 10 });
  assert.equal(r.code, 'invalid_cookie_file_size');
  await assert.rejects(fs.stat(f.output_file), { code: 'ENOENT' });
  await assertReceipt(r, f.receipt_file);
});

for (const [name, patch] of [
  ['foreign cookie', { domain: '.example.invalid' }], ['parent suffix spoof', { domain: '.com' }],
  ['host-only parent', { domain: 'jinritemai.com' }], ['sibling cookie', { domain: 'compass.jinritemai.com' }],
  ['non-root cookie', { path: '/home' }], ['invalid value', { value: 'bad;value' }],
  ['invalid secure type', { secure: 'true' }], ['invalid expiration', { expires: 'later' }],
]) test(`export rejects ${name} without writing cookie file`, async () => {
  const f = await fixture(), rows = cdpCookies(); Object.assign(rows[0], patch);
  const r = await exportQianchuanCredential({ ...f, tab: fakeTab({ cookies: rows }).tab });
  assert.equal(r.ok, false);
  await assert.rejects(fs.stat(f.output_file), { code: 'ENOENT' });
  await assertReceipt(r, f.receipt_file);
});

test('export requires explicit authorization and a string advertiser ID', async () => {
  for (const patch of [{ export_authorized: false }, { advertiser_id: Number(ADV) }, { max_cookie_bytes: 999999 }]) {
    const f = await fixture(), b = fakeTab();
    assert.equal((await exportQianchuanCredential({ ...f, ...patch, tab: b.tab })).ok, false);
    assert.equal(b.calls.length, 0);
  }
});

test('export does not overwrite an existing local file', async () => {
  const f = await fixture(), b = fakeTab();
  await fs.writeFile(f.output_file, 'KEEP_SYNTHETIC');
  const r = await exportQianchuanCredential({ ...f, tab: b.tab });
  assert.equal(r.code, 'output_already_exists');
  assert.equal(await fs.readFile(f.output_file, 'utf8'), 'KEEP_SYNTHETIC');
  assert.equal(b.calls.length, 0);
});

test('import succeeds for exact second candidate, retains policy, and does not request a retired MCP check', async () => {
  const f = await fixture(), h = fakeHttp(), policy = structuredClone(h.state.policy);
  const r = await importExistingQianchuanCredential({ ...f, fetch_impl: h.fetch_impl, allowed_actions: [] });
  assert.equal(r.ok, true); assert.equal(r.code, 'credential_updated');
  assert.equal(r.export.status, 'not_observed');
  assert.equal(r.verification.discovered_identity, 'verified');
  assert.equal(r.verification.existing_account_after_select, 'verified');
  assert.equal(r.save.status, 'confirmed');
  assert.equal(r.save.updated, true); assert.equal(r.save.profile_created, false);
  assert.equal(Object.hasOwn(r, 'mcp_status'), false);
  assert.deepEqual(h.state.policy, policy);
  assert.equal(selectedCalls(h).length, 1);
  assert.equal(selectedCalls(h)[0].body.candidate_id, 'candidate-exact');
  assert.deepEqual(h.calls.map(c => c.body?.action ?? 'accounts'), ['accounts', 'import', 'accounts', 'select', 'accounts']);
  assert.deepEqual(JSON.parse(h.calls[1].body.cookie_json), editorCookies());
  await assertReceipt(r, f.receipt_file);
});

for (const [name, accounts] of [
  ['missing existing account', []],
  ['different advertiser', [{ id: ACCOUNT, aavid: OTHER }]],
  ['different account id', [{ id: 'another-account', aavid: ADV }]],
  ['duplicate advertiser', [{ id: ACCOUNT, aavid: ADV }, { id: 'another', aavid: ADV }]],
  ['duplicate account id', [{ id: ACCOUNT, aavid: ADV }, { id: ACCOUNT, aavid: OTHER }]],
  ['numeric advertiser', [{ id: ACCOUNT, aavid: Number(ADV) }]],
]) test(`import rejects ${name} before discovery`, async () => {
  const f = await fixture(), h = fakeHttp({ accounts });
  const r = await importExistingQianchuanCredential({ ...f, fetch_impl: h.fetch_impl });
  assert.equal(r.code, 'existing_account_binding_mismatch');
  assert.equal(h.calls.length, 1); assert.equal(r.save.status, 'not_started');
  await assertReceipt(r, f.receipt_file);
});

for (const [name, candidates] of [
  ['wrong candidate', [{ candidate_id: 'wrong', aavid: OTHER }]],
  ['empty candidates', []],
  ['numeric candidate identity', [{ candidate_id: 'numeric', aavid: Number(ADV) }]],
  ['duplicate identity', [{ candidate_id: 'a', aavid: ADV }, { candidate_id: 'b', aavid: ADV }]],
  ['duplicate candidate token', [{ candidate_id: 'a', aavid: OTHER }, { candidate_id: 'a', aavid: ADV }]],
  ['conflicting identity alias', [{ candidate_id: 'a', aavid: ADV, advertiser_id: OTHER }]],
]) test(`import never selects ${name}`, async () => {
  const f = await fixture(), h = fakeHttp(); h.state.discovery.candidates = candidates;
  const r = await importExistingQianchuanCredential({ ...f, fetch_impl: h.fetch_impl });
  assert.equal(r.ok, false); assert.equal(selectedCalls(h).length, 0);
  assert.equal(r.save.status, 'not_started');
  await assertReceipt(r, f.receipt_file);
});

test('account registry changed during discovery prevents select', async () => {
  const f = await fixture(), h = fakeHttp({ registryAt: n => n === 1 ? [{ id: ACCOUNT, aavid: ADV }] : [] });
  const r = await importExistingQianchuanCredential({ ...f, fetch_impl: h.fetch_impl });
  assert.equal(r.code, 'existing_account_binding_mismatch');
  assert.equal(r.verification.discovered_identity, 'verified');
  assert.equal(selectedCalls(h).length, 0);
});

for (const patch of [
  { cookie_imported: undefined }, { updated: false }, { profile_created: true },
  { mcp_reconnect_required: undefined }, { status: 'unknown' }, { ok: false },
  { account: { id: ACCOUNT, aavid: OTHER } }, { account_id: 'wrong' },
]) test(`select response is unconfirmed for ${JSON.stringify(patch)}`, async () => {
  const f = await fixture(), h = fakeHttp(); Object.assign(h.state.selected, patch);
  const r = await importExistingQianchuanCredential({ ...f, fetch_impl: h.fetch_impl });
  assert.equal(r.ok, false); assert.equal(r.save.status, 'unknown');
  assert.equal(r.retry_write, false); assert.equal(selectedCalls(h).length, 1);
  assert.equal(h.calls.length, 4);
  await assertReceipt(r, f.receipt_file);
});

test('minimal documented select success flags are accepted and independently registry-read', async () => {
  const f = await fixture(), h = fakeHttp(); delete h.state.selected.account;
  assert.equal((await importExistingQianchuanCredential({ ...f, fetch_impl: h.fetch_impl })).ok, true);
  assert.equal(h.calls.length, 5);
});

for (const stage of ['accounts', 'import', 'select', 'readback']) test(`HTTP failure at ${stage} is sanitized, recorded, and not retried`, async () => {
  const f = await fixture(), h = fakeHttp({ respond: ({ body, calls }) => {
    const current = body?.action ?? (calls.length > 4 ? 'readback' : 'accounts');
    if (current === stage) return response({ ok: false, error: SECRET }, 503);
  } });
  const r = await importExistingQianchuanCredential({ ...f, fetch_impl: h.fetch_impl });
  assert.equal(r.ok, false); assert.equal(r.code, 'local_http_failed');
  assert.equal(r.save.status, stage === 'select' ? 'unknown' : stage === 'readback' ? 'confirmed' : 'not_started');
  assert.equal(selectedCalls(h).length, ['select', 'readback'].includes(stage) ? 1 : 0);
  await assertReceipt(r, f.receipt_file);
});

test('thrown fetch errors containing Cookie data are never propagated', async () => {
  const f = await fixture(), h = fakeHttp({ respond: ({ body }) => { if (body?.action === 'select') throw Error(SECRET); } });
  const r = await importExistingQianchuanCredential({ ...f, fetch_impl: h.fetch_impl });
  assert.equal(r.code, 'local_http_request_failed'); assert.equal(r.save.status, 'unknown');
  await assertReceipt(r, f.receipt_file);
});

for (const [name, respond] of [
  ['redirect', () => new Response(null, { status: 302, headers: { Location: 'https://example.invalid' } })],
  ['non JSON', () => new Response(SECRET, { headers: { 'Content-Type': 'text/html' } })],
  ['malformed JSON', () => new Response(SECRET, { headers: { 'Content-Type': 'application/json' } })],
  ['oversize response', () => response({ ok: false, error: SECRET.repeat(70000) })],
  ['declared oversize response', () => response({}, 200, { 'Content-Length': '99999999' })],
  ['unknown response', () => response({ status: 'unknown' })],
]) test(`local HTTP refuses ${name}`, async () => {
  const f = await fixture(), h = fakeHttp({ respond });
  const r = await importExistingQianchuanCredential({ ...f, fetch_impl: h.fetch_impl });
  assert.equal(r.ok, false); assert.equal(h.calls.length, 1);
  await assertReceipt(r, f.receipt_file);
});

for (const base_url of ['https://example.invalid', 'http://127.0.0.1.example.invalid', 'http://192.168.1.2',
  'file:///tmp/a', 'http://user:password@127.0.0.1:18999', 'http://@127.0.0.1:18999', 'http://127.0.0.1:18999/api',
  'http://127.0.0.1:18999/?token=secret', 'http://127.0.0.1:18999/#secret', 'http://[::ffff:192.168.1.1]']) {
  test(`import refuses nonlocal/credential-bearing base: ${base_url}`, async () => {
    const f = await fixture(), h = fakeHttp();
    const r = await importExistingQianchuanCredential({ ...f, base_url, fetch_impl: h.fetch_impl });
    assert.equal(r.ok, false); assert.equal(h.calls.length, 0);
  });
}
for (const base_url of ['http://localhost:18999', 'http://[::1]:18999', 'https://127.0.0.1:18999']) {
  test(`supported loopback URL: ${base_url}`, async () => {
    const f = await fixture(), h = fakeHttp();
    const r = await importExistingQianchuanCredential({ ...f, base_url, fetch_impl: h.fetch_impl });
    assert.equal(r.ok, true);
    assert.ok(h.calls.every(c => new URL(c.url).origin === base_url));
  });
}

test('path and input protections stop before any HTTP request', async () => {
  const cases = [
    f => ({ cookie_file: 'relative.json' }),
    f => ({ cookie_file: path.join(f.private_root, 'outside.json') }),
    f => ({ cookie_file: path.join(f.private_root, 'credential-import-evil', 'file.json') }),
    f => ({ cookie_file: path.dirname(f.cookie_file) + '/nested/../input.json' }),
    f => ({ cookie_file: '\\\\server\\share\\input.json' }),
    f => ({ cookie_file: f.cookie_file + ':stream.json' }),
    f => ({ cookie_file: path.join(path.dirname(f.cookie_file), 'CON.json') }),
    f => ({ cookie_file: path.join(path.dirname(f.cookie_file), 'missing.json') }),
    f => ({ receipt_file: f.cookie_file }),
    f => ({ receipt_file: path.join(f.directory, 'outside-receipt.json') }),
    f => ({ private_root: f.directory }),
    f => ({ account_id: '../account' }),
    f => ({ advertiser_id: Number(ADV) }),
    f => ({ timeout_ms: 0 }),
    f => ({ max_cookie_bytes: 999999 }),
  ];
  for (const change of cases) {
    const f = await fixture(), h = fakeHttp();
    const r = await importExistingQianchuanCredential({ ...f, ...change(f), fetch_impl: h.fetch_impl });
    assert.equal(r.ok, false); assert.equal(h.calls.length, 0);
  }
});

test('output path collision and existing receipt stop before browser/network access', async () => {
  const f = await fixture(), b = fakeTab(), h = fakeHttp();
  const collision = await exportQianchuanCredential({ ...f, tab: b.tab, receipt_file: f.output_file });
  assert.equal(collision.code, 'receipt_cookie_path_collision');
  await fs.writeFile(f.receipt_file, 'KEEP_RECEIPT');
  const r = await importExistingQianchuanCredential({ ...f, fetch_impl: h.fetch_impl });
  assert.equal(r.code, 'output_already_exists');
  assert.equal(await fs.readFile(f.receipt_file, 'utf8'), 'KEEP_RECEIPT');
  assert.equal(b.calls.length + h.calls.length, 0);
});

test('symlink/junction directory cannot redirect private output', async () => {
  const f = await fixture(), outside = path.join(f.directory, 'outside');
  await fs.mkdir(outside);
  const junction = path.join(path.dirname(f.cookie_file), 'linked');
  await fs.symlink(outside, junction, process.platform === 'win32' ? 'junction' : 'dir');
  const b = fakeTab();
  const r = await exportQianchuanCredential({ ...f, tab: b.tab, output_file: path.join(junction, 'export.json') });
  assert.equal(r.code, 'unsafe_directory'); assert.equal(b.calls.length, 0);
  assert.deepEqual(await fs.readdir(outside), []);
});

test('hard-linked cookie file is refused', async () => {
  const f = await fixture(), h = fakeHttp();
  await fs.link(f.cookie_file, path.join(path.dirname(f.cookie_file), 'second-link.json'));
  const r = await importExistingQianchuanCredential({ ...f, fetch_impl: h.fetch_impl });
  assert.equal(r.code, 'invalid_cookie_file'); assert.equal(h.calls.length, 0);
});

for (const [name, contents] of [
  ['empty', ''], ['invalid JSON', SECRET], ['object instead of array', '{}'], ['empty array', '[]'],
  ['oversized', 'x'.repeat(256 * 1024 + 1)],
  ['hostOnly mismatch', JSON.stringify([{ ...editorCookies()[0], hostOnly: true }])],
  ['foreign cookie file', JSON.stringify([{ ...editorCookies()[0], domain: '.example.invalid' }])],
]) test(`invalid Cookie Editor input: ${name}`, async () => {
  const f = await fixture(), h = fakeHttp();
  await fs.writeFile(f.cookie_file, contents);
  const r = await importExistingQianchuanCredential({ ...f, fetch_impl: h.fetch_impl });
  assert.equal(r.ok, false); assert.equal(h.calls.length, 0);
  await assertReceipt(r, f.receipt_file);
});

test('JSON extension alone cannot make a directory a cookie file', async () => {
  const f = await fixture(), h = fakeHttp();
  const directory = path.join(path.dirname(f.cookie_file), 'directory.json');
  await fs.mkdir(directory);
  const r = await importExistingQianchuanCredential({ ...f, cookie_file: directory, fetch_impl: h.fetch_impl });
  assert.equal(r.code, 'invalid_cookie_file'); assert.equal(h.calls.length, 0);
});

test('CLI import can use injected fetch and exposes metadata only', async () => {
  const f = await fixture(), h = fakeHttp();
  const r = await runCredentialRefreshCli(['import', '--base-url', BASE, '--account-id', ACCOUNT,
    '--advertiser-id', ADV, '--private-root', f.private_root, '--cookie-file', f.cookie_file,
    '--receipt-file', f.receipt_file, '--timeout-ms', '25000'], { fetch_impl: h.fetch_impl });
  assert.equal(r.ok, true); await assertReceipt(r, f.receipt_file);
});

test('CUA-like module import and synthetic export work without global process or Buffer', async () => {
  const f = await fixture();
  const source = new URL('./codex-qc-credential-refresh.mjs', import.meta.url).href;
  // An isolated child avoids changing globals used by the test runner. Only
  // synthetic TMP files and the fake tab/CDP are used, with network disabled.
  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs/promises';
    import hostProcess from 'node:process';
    const source = hostProcess.argv[1];
    const options = JSON.parse(hostProcess.argv[2]);
    const ADV = ${JSON.stringify(ADV)}, ORIGIN = ${JSON.stringify(ORIGIN)}, SECRET = ${JSON.stringify(SECRET)};
    const cdpCookies = ${cdpCookies.toString()};
    const fakeTab = ${fakeTab.toString()};
    delete globalThis.process;
    delete globalThis.Buffer;
    globalThis.fetch = async () => { throw Error('real_network_forbidden'); };
    assert.equal(typeof process, 'undefined');
    assert.equal(typeof Buffer, 'undefined');
    const module = await import(source);
    assert.equal(typeof module.importExistingQianchuanCredential, 'function');
    const result = await module.exportQianchuanCredential({ ...options, tab: fakeTab().tab });
    assert.equal(result.ok, true, result.code);
    assert.equal(result.export.status, 'exported');
    const rows = JSON.parse(await fs.readFile(options.output_file, 'utf8'));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].value, SECRET);
    assert.deepEqual(JSON.parse(await fs.readFile(options.receipt_file, 'utf8')), result);
    assert.equal((await module.runCredentialRefreshCli(['--help'])).ok, true);
    for (const [label, value] of [['null', null], ['no-argv', {}], ['nonarray-argv', { argv: { 1: source } }]]) {
      globalThis.process = value;
      assert.equal(typeof (await import(source + '?sandbox=' + label)).exportQianchuanCredential, 'function');
    }
    assert.equal(typeof Buffer, 'undefined');
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script, source, JSON.stringify(f)],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, '');
});

test('CLI never exports browsers or accepts inline Cookie values/unknown or duplicate arguments', async () => {
  for (const args of [['export'], ['import', '--cookie-json', SECRET], ['import', '--base-url', BASE, '--base-url', BASE],
    ['import', '--cookie-file'], ['import', '--cookie-file', '--receipt-file'], ['import', '__proto__', 'value']]) {
    const r = await runCredentialRefreshCli(args);
    assert.equal(r.ok, false); assert.ok(!JSON.stringify(r).includes(SECRET));
  }
  const source = fileURLToPath(new URL('./codex-qc-credential-refresh.mjs', import.meta.url));
  const help = spawnSync(process.execPath, [source, '--help'], { encoding: 'utf8', windowsHide: true });
  assert.equal(help.status, 0); assert.match(JSON.parse(help.stdout).usage, /Import only/);
  const invalid = spawnSync(process.execPath, [source, 'export', '--cookie', SECRET], { encoding: 'utf8', windowsHide: true });
  assert.equal(invalid.status, 1); assert.ok(!(invalid.stdout + invalid.stderr).includes(SECRET));
});
