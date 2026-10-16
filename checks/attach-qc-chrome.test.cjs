'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { attachQianchuanChrome, getChromePageTarget, openQianchuanPageInProfile, diagnoseChromeAttachFailure } = require('../tools/attach-qc-chrome.playwright.cjs');

const directories = [];
function marker(content = '9222\n/devtools/browser/01234567-89ab-cdef-0123-456789abcdef\n') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-attach-test-'));
  directories.push(directory);
  const markerPath = path.join(directory, 'DevToolsActivePort');
  fs.writeFileSync(markerPath, content);
  return markerPath;
}
test.after(() => {
  for (const directory of directories) {
    // Only these test-created marker files/directories are removed, never a
    // browser profile or a recursively calculated directory tree.
    const markerPath = path.join(directory, 'DevToolsActivePort');
    if (fs.existsSync(markerPath)) fs.unlinkSync(markerPath);
    fs.rmdirSync(directory);
  }
});

function transport({ contexts = [{ name: 'existing-context' }], connectError, closeError } = {}) {
  const calls = { connect: [], close: 0, launch: 0, contextClose: 0 };
  const browser = {
    contexts: () => contexts,
    async close() { calls.close++; if (closeError) throw closeError; },
  };
  for (const context of contexts) context.close = async () => { calls.contextClose++; };
  const chromium = {
    async connectOverCDP(...args) { calls.connect.push(args); if (connectError) throw connectError; return browser; },
    async launch() { calls.launch++; assert.fail('must not launch Chrome'); },
    async launchPersistentContext() { calls.launch++; assert.fail('must not launch a profile'); },
  };
  return { calls, browser, chromium, contexts };
}

test('attaches directly to the marker WebSocket path without assigning an account context', async () => {
  const t = transport(), markerPath = marker();
  const original = fs.readFileSync(markerPath, 'utf8');
  const attached = await attachQianchuanChrome({ markerPath, expectedPort: 9222, timeoutMs: 4321, chromium: t.chromium });
  assert.deepEqual(t.calls.connect, [['ws://127.0.0.1:9222/devtools/browser/01234567-89ab-cdef-0123-456789abcdef', { timeout: 4321, noDefaults: true }]]);
  assert.equal(attached.browser, t.browser);
  assert.equal(attached.context, undefined);
  assert.equal(attached.contexts, undefined);
  assert.equal(attached.browser.contexts(), t.contexts);
  assert.ok(attached.limits.some(value => value.includes('browserContextId')));
  assert.equal(attached.attached.source, 'DevToolsActivePort');
  assert.equal(attached.attached.marker_path, markerPath);
  assert.equal(fs.readFileSync(markerPath, 'utf8'), original);
  const firstDetach = attached.detach();
  assert.equal(attached.detach(), firstDetach);
  await Promise.all([firstDetach, attached.detach()]);
  await attached.detach();
  assert.equal(t.calls.close, 1);
  assert.equal(t.calls.launch, 0);
  assert.equal(t.calls.contextClose, 0);
});

test('an actual marker may supply the official base path without a UUID', async () => {
  for (const browserPath of ['/devtools/browser', '/devtools/browser/']) {
    const t = transport();
    const attached = await attachQianchuanChrome({ markerPath: marker(`9222\r\n${browserPath}\r\n`), chromium: t.chromium });
    assert.equal(t.calls.connect[0][0], `ws://127.0.0.1:9222${browserPath}`);
    await attached.detach();
  }
});

test('several reported contexts still do not select or infer a login profile', async () => {
  const t = transport({ contexts: [{ name: 'one' }, { name: 'two' }] });
  const attached = await attachQianchuanChrome({ markerPath: marker(), chromium: t.chromium });
  assert.equal(attached.context, undefined);
  assert.equal(attached.browser.contexts().length, 2);
  assert.ok(attached.limits.some(value => value.includes('context.newPage()')));
  await attached.detach();
  assert.equal(t.calls.contextClose, 0);
});

test('a missing marker reports the prerequisite and makes no connection or launch', async () => {
  const t = transport(), markerPath = marker();
  fs.unlinkSync(markerPath);
  await assert.rejects(attachQianchuanChrome({ markerPath, chromium: t.chromium }), { code: 'chrome_marker_missing' });
  assert.equal(t.calls.connect.length, 0);
  assert.equal(t.calls.launch, 0);
});

test('malformed markers and port mismatch reject before connecting', async () => {
  for (const content of ['0\n/devtools/browser/id', '65536\n/devtools/browser/id', 'abc\n/devtools/browser/id',
    '9222\nhttp://remote.invalid/devtools/browser/id', '9222\n/devtools/browser/../page/id',
    '9222\n/devtools/page/id', '9222\n/devtools/browser/id?secret=yes', '9222\n/devtools/browser/id\nextra', '9222']) {
    const t = transport();
    await assert.rejects(attachQianchuanChrome({ markerPath: marker(content), chromium: t.chromium }), { code: 'chrome_marker_invalid' });
    assert.equal(t.calls.connect.length, 0);
  }
  const t = transport();
  await assert.rejects(attachQianchuanChrome({ markerPath: marker(), expectedPort: 9223, chromium: t.chromium }), { code: 'chrome_port_mismatch' });
  assert.equal(t.calls.connect.length, 0);
});

test('configuration validates absolute marker path, file name and numeric options', async () => {
  const t = transport(), markerPath = marker();
  for (const input of [{ markerPath: 'DevToolsActivePort' }, { markerPath: path.join(path.dirname(markerPath), 'Cookies') }]) {
    await assert.rejects(attachQianchuanChrome({ ...input, chromium: t.chromium }), { code: 'chrome_marker_path_invalid' });
  }
  for (const input of [{ expectedPort: '9222' }, { expectedPort: 65536 }, { timeoutMs: 0 }, { timeoutMs: 0.5 }]) {
    await assert.rejects(attachQianchuanChrome({ markerPath, ...input, chromium: t.chromium }), { code: 'chrome_attach_options_invalid' });
  }
  assert.equal(t.calls.connect.length, 0);
});

test('connection and detach failures are returned without retries', async () => {
  const connectError = new Error('connection refused'), t = transport({ connectError });
  await assert.rejects(attachQianchuanChrome({ markerPath: marker(), chromium: t.chromium }), error => {
    assert.equal(error.code, 'chrome_attach_failed');
    assert.equal(error.cause, connectError);
    return true;
  });
  assert.equal(t.calls.connect.length, 1);
  assert.equal(t.calls.close, 0);
  const closeError = new Error('disconnect failed'), closing = transport({ closeError });
  const attached = await attachQianchuanChrome({ markerPath: marker(), chromium: closing.chromium });
  await assert.rejects(attached.detach(), error => error === closeError);
  await assert.rejects(attached.detach(), error => error === closeError);
  assert.equal(closing.calls.close, 1);
  assert.equal(closing.calls.contextClose, 0);
});

test('connection diagnostic distinguishes transport, handshake and initialized-transport failures', () => {
  const cases = [
    ['Timeout 60000ms exceeded\n<ws connecting> ws://127.0.0.1:9222/devtools/browser/private-id', 'websocket_handshake', 'handshake_timeout', false],
    ['<ws connecting> ws://private\nUnexpected server response: 403', 'websocket_handshake', 'handshake_rejected', false, undefined, 403],
    ['connect ECONNREFUSED 127.0.0.1:9222', 'transport_connect', 'endpoint_unreachable', false, 'ECONNREFUSED'],
    ['<ws connecting> ws://private\n<ws connected> ws://private\nProtocol error (Target.setAutoAttach): failed', 'cdp_initialization', 'initialization_failed', true],
    ['<ws connected> ws://private\nTimeout 60000ms exceeded', 'cdp_initialization', 'initialization_timeout', true],
    ['Timeout 60000ms exceeded', 'attachment', 'timeout_phase_unknown', null],
    ['unclassified failure', 'attachment', 'connection_failed', null],
  ];
  for (const [message, stage, type, connected, transportCode, httpStatus] of cases) {
    const result = diagnoseChromeAttachFailure(new Error(message), { timeoutMs: 60000, elapsedMs: 60123 });
    assert.equal(result.stage, stage);
    assert.equal(result.failure_type, type);
    assert.equal(result.transport_connected, connected);
    assert.equal(result.transport_code, transportCode);
    assert.equal(result.http_status, httpStatus);
    assert.equal(result.timeout_ms, 60000);
    assert.equal(result.elapsed_ms, 60123);
    assert.equal(Object.isFrozen(result), true);
    assert.doesNotMatch(JSON.stringify(result), /private|127\.0\.0\.1|devtools|ws:\/\//);
  }
});

test('connection diagnostic reads nested network evidence without exposing causes or endpoints', async () => {
  const secret = 'never-output-access-token';
  const cause = Object.assign(new Error('ws://127.0.0.1:9222/' + secret), { code: 'EHOSTUNREACH' });
  const connectError = new Error('request failed token=' + secret, { cause });
  const t = transport({ connectError });
  await assert.rejects(attachQianchuanChrome({ markerPath: marker(), timeoutMs: 4321, chromium: t.chromium }), error => {
    assert.equal(error.cause, connectError);
    assert.equal(error.diagnostic.stage, 'transport_connect');
    assert.equal(error.diagnostic.failure_type, 'endpoint_unreachable');
    assert.equal(error.diagnostic.transport_code, 'EHOSTUNREACH');
    assert.equal(error.diagnostic.timeout_ms, 4321);
    assert.doesNotMatch(error.message + JSON.stringify(error), new RegExp(secret + '|127\\.0\\.0\\.1'));
    return true;
  });
  assert.equal(t.calls.connect.length, 1);
  assert.equal(t.calls.launch, 0);
});

test('page target getter returns exact CDP metadata and detaches its temporary session', async () => {
  const targetInfo = { targetId: 'target-one', browserContextId: 'actual-profile-one', url: 'https://qianchuan.jinritemai.com/', type: 'page' };
  const calls = [], session = {
    async send(method) { calls.push(method); return { targetInfo }; },
    async detach() { calls.push('detach'); },
  };
  const context = { async newCDPSession(targetPage) { assert.equal(targetPage, page); calls.push('attach'); return session; } };
  const page = { context: () => context };
  assert.equal(await getChromePageTarget(page), targetInfo);
  assert.deepEqual(calls, ['attach', 'Target.getTargetInfo', 'detach']);
});

test('page target getter detaches after metadata failure without retrying or opening a page', async () => {
  const failure = new Error('target closed'), calls = [];
  const page = { context: () => ({ async newCDPSession() { return {
    async send(method) { calls.push(method); throw failure; },
    async detach() { calls.push('detach'); },
  }; } }) };
  await assert.rejects(getChromePageTarget(page), error => error === failure);
  assert.deepEqual(calls, ['Target.getTargetInfo', 'detach']);
});

test('page target getter preserves the original read error when detach also fails', async () => {
  const readError = Object.assign(new Error('target read disconnected'), { code: 'original_read_error' });
  const detachError = new Error('cleanup disconnected'), calls = [];
  const page = { context: () => ({ async newCDPSession() { return {
    async send(method) { calls.push(method); throw readError; },
    async detach() { calls.push('detach'); throw detachError; },
  }; } }) };
  await assert.rejects(getChromePageTarget(page), error => error === readError && error.code === 'original_read_error');
  assert.deepEqual(calls, ['Target.getTargetInfo', 'detach']);
});

test('page target getter reports detach failure after a successful read', async () => {
  const detachError = new Error('cleanup disconnected'), calls = [];
  const page = { context: () => ({ async newCDPSession() { return {
    async send(method) { calls.push(method); return { targetInfo: { targetId: 'read-succeeded' } }; },
    async detach() { calls.push('detach'); throw detachError; },
  }; } }) };
  await assert.rejects(getChromePageTarget(page), error => error === detachError);
  assert.deepEqual(calls, ['Target.getTargetInfo', 'detach']);
});

function popupFixture({ openerProfile = 'profile-one', popupProfile = 'profile-one', opened = true, popupError, evaluateError } = {}) {
  const calls = [], options = {
    url: 'https://qianchuan.jinritemai.com/uni-prom/detail?aavid=10001&adId=20002',
    browserContextId: 'profile-one', advertiser_id: '10001', primary_ad_id: '20002', timeoutMs: 1234,
  };
  const openerInfo = { targetId: 'opener', browserContextId: openerProfile, url: options.url.replace('20002', '20001') };
  const popupInfo = { targetId: 'popup', browserContextId: popupProfile, url: options.url };
  const contextFor = targetInfo => ({ async newCDPSession() { return {
    async send(method) { calls.push(targetInfo.targetId + ':' + method); return { targetInfo }; },
    async detach() { calls.push(targetInfo.targetId + ':detach'); },
  }; } });
  const popup = { context: () => contextFor(popupInfo) };
  const opener = {
    url: () => openerInfo.url,
    context: () => contextFor(openerInfo),
    waitForEvent(event, config) {
      calls.push('listen');
      assert.equal(event, 'popup');
      assert.deepEqual(config, { timeout: 1234 });
      return popupError ? Promise.reject(popupError) : Promise.resolve(popup);
    },
    async evaluate(fn, targetUrl) {
      calls.push('window.open');
      assert.ok(calls.indexOf('listen') < calls.indexOf('window.open'));
      assert.equal(targetUrl, options.url);
      assert.match(String(fn), /window\.open/);
      if (evaluateError) throw evaluateError;
      return opened;
    },
  };
  return { opener, popup, openerInfo, popupInfo, options, calls };
}

test('ordinary-profile popup uses its verified opener for the same advertiser and a different plan', async () => {
  const f = popupFixture();
  const result = await openQianchuanPageInProfile(f.opener, f.options);
  assert.equal(result.page, f.popup);
  assert.equal(result.target, f.popupInfo);
  assert.deepEqual(f.calls, ['opener:Target.getTargetInfo', 'opener:detach', 'listen', 'window.open', 'popup:Target.getTargetInfo', 'popup:detach']);
});

test('opener profile or advertiser mismatch blocks window.open', async () => {
  const wrongProfile = popupFixture({ openerProfile: 'other-profile' });
  await assert.rejects(openQianchuanPageInProfile(wrongProfile.opener, wrongProfile.options), { code: 'chrome_profile_mismatch' });
  assert.equal(wrongProfile.calls.includes('window.open'), false);
  const wrongAccount = popupFixture();
  wrongAccount.openerInfo.url = wrongAccount.openerInfo.url.replace('10001', '10002');
  await assert.rejects(openQianchuanPageInProfile(wrongAccount.opener, wrongAccount.options), { code: 'chrome_page_binding_invalid' });
  assert.deepEqual(wrongAccount.calls, []);
});

test('target URL must bind the same advertiser and specified plan without conflicting aliases', async () => {
  for (const suffix of ['?aavid=10002&adId=20002', '?aavid=10001&adId=20001', '?aavid=10001&adId=20002&advertiser_id=10002', '?aavid=10001&adId=20002#/detail?primary_ad_id=20003']) {
    const f = popupFixture();
    await assert.rejects(openQianchuanPageInProfile(f.opener, { ...f.options, url: 'https://qianchuan.jinritemai.com/uni-prom/detail' + suffix }), { code: 'chrome_page_binding_invalid' });
    assert.deepEqual(f.calls, []);
  }
  const f = popupFixture();
  await assert.rejects(openQianchuanPageInProfile(f.opener, { ...f.options, url: f.options.url.replace('https:', 'http:') }), { code: 'chrome_page_binding_invalid' });
  assert.deepEqual(f.calls, []);
});

test('a popup in another profile is rejected after one opening attempt', async () => {
  const f = popupFixture({ popupProfile: 'other-profile' });
  await assert.rejects(openQianchuanPageInProfile(f.opener, f.options), { code: 'chrome_profile_mismatch' });
  assert.equal(f.calls.filter(value => value === 'window.open').length, 1);
  assert.equal(f.calls.at(-1), 'popup:detach');
});

test('blocked, timed-out or failed popup operations never replay window.open', async () => {
  for (const [config, code] of [
    [{ opened: false, popupError: new Error('late popup timeout') }, 'chrome_popup_blocked'],
    [{ popupError: Object.assign(new Error('popup timeout'), { name: 'TimeoutError' }) }, 'chrome_popup_failed'],
    [{ evaluateError: new Error('opener disconnected'), popupError: new Error('late popup timeout') }, 'chrome_popup_failed'],
  ]) {
    const f = popupFixture(config);
    await assert.rejects(openQianchuanPageInProfile(f.opener, f.options), { code });
    assert.equal(f.calls.filter(value => value === 'window.open').length, 1);
    assert.equal(f.calls.includes('popup:Target.getTargetInfo'), false);
  }
});
