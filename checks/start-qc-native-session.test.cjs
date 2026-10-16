'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { readQianchuanNativeConfig, bindQianchuanNativePages, inventoryQianchuanNativeSession, startQianchuanNativeSession, publicNativeSessionFailure } = require('../tools/start-qc-native-session.cjs');

function fixture() {
  const binding = { room: '测试房间', advertiser_id: '123', primary_ad_id: '456', browser_context_id: 'profile-one', target_id: 'target-one' };
  const url = 'https://qianchuan.jinritemai.com/main/ad/detail?aavid=123&adId=456';
  const page = { url: () => url, isClosed: () => false };
  const target = { targetId: binding.target_id, browserContextId: binding.browser_context_id, url };
  const browser = { isConnected: () => true, contexts: () => [{ pages: () => [page] }] };
  const config = { markerPath: path.resolve('private-runtime/DevToolsActivePort'), expectedPort: 9222,
    runtimeFile: path.resolve('private-runtime/test-native-session.json'), bindings: [binding] };
  const calls = [];
  const host = { host_id: 'test-host', close: async () => { calls.push('close'); return { ok: true }; } };
  const dependencies = {
    attachQianchuanChrome: async options => { calls.push(['attach', options]); return { browser, detach: async () => { calls.push('detach'); } }; },
    getChromePageTarget: async candidate => { assert.equal(candidate, page); return target; },
    startQianchuanNativeHost: async options => { calls.push(['host', options]); return host; },
    createQianchuanNativeOperations: () => ({ snapshot: { kind: 'read', run: async () => ({ ok: true }) } }),
    createQianchuanNativeAuxiliaryOperations: options => { calls.push(['auxiliary', options]); return { auxiliary_list: { kind: 'read', run: async () => ({ ok: true }) } }; },
    createQianchuanNativeParameterOperations: options => { calls.push(['parameters', options]); return {
      parameter_edit: { kind: 'write', run: async () => ({ ok: true }) },
      parameter_reconcile: { kind: 'write', run: async () => ({ ok: true }) },
    }; },
  };
  return { binding, page, target, browser, config, calls, host, dependencies };
}

test('explicit config supports BOM, defaults account to advertiser and caps connection wait', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-native-launch-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'config.json');
  fs.writeFileSync(configPath, '\uFEFF' + JSON.stringify(fixture().config));
  const config = readQianchuanNativeConfig(configPath);
  assert.equal(config.timeoutMs, 60000);
  assert.equal(config.bindings[0].account_id, '123');
  assert.deepEqual(config.observedUrls, []);
  assert.equal(config.parameterStateDirectory, path.join(path.dirname(config.runtimeFile), 'parameter-state'));
  assert.throws(() => readQianchuanNativeConfig('config.json'), { code: 'native_start_config_path_invalid' });
  fs.writeFileSync(configPath, JSON.stringify({ ...config, timeoutMs: 60001 }));
  assert.throws(() => readQianchuanNativeConfig(configPath), { code: 'native_start_config_invalid' });
});

test('exact targets and profiles work inside one aggregated Playwright context', async () => {
  const f = fixture();
  const second = { ...f.binding, room: '另一房间', target_id: 'target-two', browser_context_id: 'profile-two' };
  const otherPage = { ...f.page };
  f.browser.contexts = () => [{ pages: () => [otherPage, f.page] }];
  const bound = await bindQianchuanNativePages(f.browser, [f.binding, second], async page =>
    page === f.page ? f.target : { ...f.target, targetId: second.target_id, browserContextId: second.browser_context_id });
  assert.equal(bound[0].page, f.page);
  assert.equal(bound[1].page, otherPage);
});

test('freshly observed exact URL binds a unique actual target without using stale profile IDs',async()=>{
  const f=fixture();
  f.config.bindings=[{room:f.binding.room,advertiser_id:'123',primary_ad_id:'456',observed_url:f.page.url()}];
  await startQianchuanNativeSession(f.config,f.dependencies);
  const b=f.calls.find(v=>Array.isArray(v)&&v[0]==='host')[1].bindings[0];
  assert.equal(b.target_id,'target-one');assert.equal(b.browser_context_id,'profile-one');
});

test('observed URL must be exact, unique and cannot silently replace a fixed profile binding',async()=>{
  for(const kind of ['duplicate','changed','mixed']){
    const f=fixture();
    f.config.bindings=[{room:f.binding.room,advertiser_id:'123',primary_ad_id:'456',observed_url:f.page.url()}];
    if(kind==='duplicate')f.browser.contexts=()=>[{pages:()=>[f.page,{...f.page}]}];
    if(kind==='changed')f.config.bindings[0].observed_url+='&view=other';
    if(kind==='mixed')f.config.bindings[0].target_id='old-target';
    await assert.rejects(startQianchuanNativeSession(f.config,{...f.dependencies,getChromePageTarget:async()=>f.target}));
    assert.equal(f.calls.some(v=>Array.isArray(v)&&v[0]==='host'),false);
  }
});

test('missing target and wrong profile cannot reach host startup', async () => {
  for (const [change, code] of [[{ targetId: 'different' }, 'native_start_target_missing'], [{ browserContextId: 'different' }, 'native_start_profile_mismatch']]) {
    const f = fixture();
    Object.assign(f.target, change);
    await assert.rejects(startQianchuanNativeSession(f.config, f.dependencies), error => {
      assert.equal(error.code, code);
      assert.deepEqual(error.diagnostic, { stage: 'page_binding', failure_type: 'initialization_failed', transport_connected: true });
      return true;
    });
    assert.equal(f.calls.filter(item => item === 'detach').length, 1);
    assert.equal(f.calls.filter(item => Array.isArray(item) && item[0] === 'host').length, 0);
  }
});

test('URL account conflicts, plan conflicts and origin changes fail before host startup', async () => {
  for (const url of [
    'https://qianchuan.jinritemai.com/main?aavid=123&advertiser_id=999&adId=456',
    'https://qianchuan.jinritemai.com/main?aavid=123&adId=999',
    'https://other.example/main?aavid=123&adId=456',
  ]) {
    const f = fixture();
    f.target.url = url;
    await assert.rejects(startQianchuanNativeSession(f.config, f.dependencies), { code: 'native_start_page_identity_mismatch' });
    assert.equal(f.calls.filter(item => item === 'detach').length, 1);
  }
});

test('target URL and current page URL are independently checked', async () => {
  const f = fixture();
  f.page.url = () => 'https://qianchuan.jinritemai.com/main?aavid=123&adId=999';
  await assert.rejects(startQianchuanNativeSession(f.config, f.dependencies), { code: 'native_start_page_identity_mismatch' });
});

test('startup inventory has a bounded wait and detaches once on timeout', async () => {
  const f = fixture();
  f.config.timeoutMs = 5;
  f.dependencies.getChromePageTarget = () => new Promise(() => {});
  await assert.rejects(startQianchuanNativeSession(f.config, f.dependencies), { code: 'native_start_inventory_timeout' });
  assert.equal(f.calls.filter(item => item === 'detach').length, 1);
  assert.equal(f.calls.filter(item => Array.isArray(item) && item[0] === 'host').length, 0);
});

test('fixed operations and auxiliary registry receive only explicit bound configuration', async () => {
  const f = fixture();
  f.config.observedUrls = [{ browser_context_id: 'profile-one', url: 'https://qianchuan.jinritemai.com/observed' }];
  const owner = await startQianchuanNativeSession(f.config, f.dependencies);
  assert.equal(owner.browser, f.browser);
  const attachment = f.calls.find(item => Array.isArray(item) && item[0] === 'attach')[1];
  assert.equal(attachment.timeoutMs, 60000);
  assert.equal(attachment.expectedPort, 9222);
  const auxiliary = f.calls.find(item => Array.isArray(item) && item[0] === 'auxiliary')[1];
  assert.equal(auxiliary.browser, f.browser);
  assert.deepEqual(auxiliary.observedUrls, f.config.observedUrls);
  const args = f.calls.find(item => Array.isArray(item) && item[0] === 'host')[1];
  assert.deepEqual(Object.keys(args.operations), ['snapshot', 'auxiliary_list', 'parameter_edit', 'parameter_reconcile']);
  const parameters = f.calls.find(item => Array.isArray(item) && item[0] === 'parameters')[1];
  assert.deepEqual(parameters, { stateDirectory: path.join(path.dirname(f.config.runtimeFile), 'parameter-state'), runtimeRoot: undefined });
  assert.equal(args.bindings[0].page, f.page);
  assert.equal(args.bindings[0].account_id, f.binding.advertiser_id);
  assert.equal(args.port, 0);
  await owner.close();
});

test('explicit parameter state directory reaches fixed factory and relative directory is rejected', async () => {
  const f = fixture();
  f.config.parameterStateDirectory = path.resolve('private-runtime/other-parameter-state');
  f.config.runtimeRoot = path.resolve('private-runtime/shared-control');
  const owner = await startQianchuanNativeSession(f.config, f.dependencies);
  assert.deepEqual(f.calls.find(item => Array.isArray(item) && item[0] === 'parameters')[1],
    { stateDirectory: f.config.parameterStateDirectory, runtimeRoot: f.config.runtimeRoot });
  await owner.close();
  const invalid = fixture();
  invalid.config.parameterStateDirectory = 'relative-state';
  await assert.rejects(startQianchuanNativeSession(invalid.config, invalid.dependencies), { code: 'native_start_config_invalid' });
  assert.deepEqual(invalid.calls, []);
  const invalidRoot=fixture();invalidRoot.config.runtimeRoot='relative-runtime';
  await assert.rejects(startQianchuanNativeSession(invalidRoot.config,invalidRoot.dependencies),{code:'native_start_config_invalid'});
  assert.deepEqual(invalidRoot.calls,[]);
});

test('duplicate operation names fail without silently replacing an operation', async () => {
  const f = fixture();
  f.dependencies.createQianchuanNativeAuxiliaryOperations = () => ({ snapshot: { kind: 'write', run() {} } });
  await assert.rejects(startQianchuanNativeSession(f.config, f.dependencies), error => {
    assert.equal(error.code, 'native_start_operation_duplicate');
    assert.equal(error.diagnostic.stage, 'operation_registration');
    assert.equal(error.diagnostic.transport_connected, true);
    return true;
  });
  assert.equal(f.calls.filter(item => item === 'detach').length, 1);
});

test('close is idempotent and closes host before detaching, without closing pages or contexts', async () => {
  const f = fixture();
  f.browser.close = () => assert.fail('launcher must use attachment.detach');
  const owner = await startQianchuanNativeSession(f.config, f.dependencies);
  await Promise.all([owner.close(), owner.close()]);
  assert.deepEqual(f.calls.filter(item => typeof item === 'string'), ['close', 'detach']);
});

test('startup preserves original error if connection detach also fails', async () => {
  const f = fixture();
  f.dependencies.startQianchuanNativeHost = async () => { throw Object.assign(new Error('host failure'), { code: 'host_failed' }); };
  f.dependencies.attachQianchuanChrome = async () => ({ browser: f.browser, detach: async () => { throw new Error('detach failure'); } });
  await assert.rejects(startQianchuanNativeSession(f.config, f.dependencies), error => {
    assert.equal(error.code, 'host_failed');
    assert.equal(error.diagnostic.stage, 'host_initialization');
    assert.equal(error.diagnostic.transport_connected, true);
    return true;
  });
});

test('invalid or duplicate bindings fail before any browser connection', async () => {
  for (const mutate of [config => { config.timeoutMs = 60001; }, config => { config.bindings.push({ ...config.bindings[0] }); },
    config => { config.bindings[0].advertiser_id = 'not-a-number'; }, config => { config.cookies = 'never-read'; }]) {
    const f = fixture();
    mutate(f.config);
    await assert.rejects(startQianchuanNativeSession(f.config, f.dependencies));
    assert.deepEqual(f.calls, []);
  }
});

test('missing auxiliary factory is fatal before browser attachment', async () => {
  const f = fixture();
  f.dependencies.createQianchuanNativeAuxiliaryOperations = {};
  await assert.rejects(startQianchuanNativeSession(f.config, f.dependencies), { code: 'native_start_auxiliary_unavailable' });
  assert.deepEqual(f.calls, []);
});

test('missing parameter factory is fatal before browser attachment', async () => {
  const f = fixture();
  f.dependencies.createQianchuanNativeParameterOperations = {};
  await assert.rejects(startQianchuanNativeSession(f.config, f.dependencies), { code: 'native_start_parameters_unavailable' });
  assert.deepEqual(f.calls, []);
});

test('CLI rejects missing explicit config with a sanitized error and no browser access', () => {
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../tools/start-qc-native-session.cjs')], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  const error = JSON.parse(result.stderr);
  assert.deepEqual(Object.keys(error), ['status', 'code', 'diagnostic', 'pid']);
  assert.equal(error.code, 'native_start_usage_config_required');
  assert.deepEqual(error.diagnostic, { stage: 'configuration', failure_type: 'startup_failed', transport_connected: null });
});

function inventoryFixture(extraTargets = []) {
  const f = fixture();
  const targets = [{ ...f.target, type: 'page', title: '测试计划' }, ...extraTargets];
  const pages = targets.map(target => ({ url: () => target.url, isClosed: () => false, title: async () => target.title }));
  f.browser.contexts = () => [{ pages: () => pages }];
  f.dependencies.getChromePageTarget = async page => targets[pages.indexOf(page)];
  f.browser.newBrowserCDPSession = async () => ({
    send: async method => { assert.equal(method, 'Target.getTargets'); f.calls.push('cdp-read'); return { targetInfos: targets }; },
    detach: async () => { f.calls.push('cdp-detach'); },
  });
  return { ...f, targets, pages };
}

test('read-only inventory returns exact current candidates for stale bindings without selecting or changing them', async () => {
  const f = inventoryFixture();
  f.binding.target_id = 'stale-target';
  f.binding.browser_context_id = 'stale-profile';
  f.targets.push({ ...f.targets[0], targetId: 'another-current-target', browserContextId: 'another-current-profile' });
  f.pages.push({ url: () => f.targets[1].url, isClosed: () => false, title: async () => f.targets[1].title });
  const configBefore = JSON.stringify(f.config);
  const result = await inventoryQianchuanNativeSession(f.config, f.dependencies);
  assert.deepEqual(result.configured_candidates, [{ room: '测试房间', targets: [
    { target_id: 'target-one', browser_context_id: 'profile-one' },
    { target_id: 'another-current-target', browser_context_id: 'another-current-profile' },
  ] }]);
  assert.equal(JSON.stringify(f.config), configBefore);
  assert.equal(result.configuration_changed, false);
  assert.equal(result.advertising_writes, 0);
  assert.deepEqual(result.target_comparison, { available: true, cdp_only_target_ids: [], mapped_only_target_ids: [] });
  assert.deepEqual(f.calls.map(item => Array.isArray(item) ? item[0] : item), ['attach', 'cdp-read', 'cdp-detach', 'detach']);
});

test('inventory redacts query strings and title credentials and never reads titles of personal pages', async () => {
  const f = inventoryFixture([
    { targetId: 'private', browserContextId: 'profile-private', type: 'page', url: 'https://personal.example/private-path?password=private-secret', title: 'private-secret' },
    { targetId: 'login', browserContextId: 'profile-login', type: 'page', url: 'https://sso.oceanengine.com/login?token=login-secret' },
    { targetId: 'newtab', browserContextId: 'profile-new', type: 'page', url: 'chrome://newtab/?token=newtab-secret' },
    { targetId: 'version', browserContextId: 'profile-version', type: 'page', url: 'chrome://version/' },
    { targetId: 'blank', browserContextId: 'profile-blank', type: 'page', url: 'about:blank' },
  ]);
  f.targets[0].url += '&access_token=query-secret';
  f.targets[0].title = '计划 token=title-secret https://example.test/url-secret';
  for (const page of f.pages.slice(1)) page.title = async () => assert.fail('non-task page titles must not be read');
  const result = await inventoryQianchuanNativeSession(f.config, f.dependencies);
  assert.equal(result.pages.length, 1);
  assert.deepEqual(result.pages[0].advertiser_ids, ['123']);
  assert.deepEqual(result.pages[0].primary_ad_ids, ['456']);
  assert.equal(result.non_qianchuan_pages.length, 5);
  assert.deepEqual(result.non_qianchuan_pages[0], { ok: true, target_id: 'private', browser_context_id: 'profile-private', surface: 'other_page' });
  assert.equal(result.non_qianchuan_pages[1].surface, 'task_login_page');
  assert.equal(result.non_qianchuan_pages[2].origin, 'chrome://newtab');
  assert.equal(result.non_qianchuan_pages[3].origin, 'chrome://version');
  assert.equal(result.non_qianchuan_pages[4].surface, 'blank_page');
  assert.doesNotMatch(JSON.stringify(result), /query-secret|title-secret|url-secret|private-secret|login-secret|newtab-secret|personal\.example|private-path/);
});

test('CDP target inventory reports differences from mapped pages without attaching or navigating them', async () => {
  const f = inventoryFixture();
  const onlyCdp = { ...f.targets[0], targetId: 'cdp-only', browserContextId: 'profile-cdp', title: '另一计划' };
  const privateTarget = { type: 'page', targetId: 'private-cdp', browserContextId: 'private-profile', url: 'https://private.example/secret', title: 'private-title' };
  const cdpTargets = [onlyCdp, privateTarget, { type: 'service_worker', targetId: 'worker', url: 'https://private.example/worker' }];
  f.browser.newBrowserCDPSession = async () => ({
    send: async method => { assert.equal(method, 'Target.getTargets'); return { targetInfos: cdpTargets }; },
    detach: async () => { f.calls.push('cdp-detach'); },
  });
  const result = await inventoryQianchuanNativeSession(f.config, f.dependencies);
  assert.deepEqual(result.target_comparison, { available: true, cdp_only_target_ids: ['cdp-only', 'private-cdp'], mapped_only_target_ids: ['target-one'] });
  assert.equal(result.cdp_target_inventory.targets.length, 2);
  assert.deepEqual(result.cdp_target_inventory.targets[1], { target_id: 'private-cdp', browser_context_id: 'private-profile', surface: 'other_page' });
  assert.doesNotMatch(JSON.stringify(result), /private\.example|private-title|worker/);
  assert.equal(f.calls.filter(item => item === 'cdp-detach').length, 1);
  assert.equal(f.calls.filter(item => item === 'detach').length, 1);
});

test('failed CDP inventory stays unknown and does not pretend there are no unmapped targets', async () => {
  const f = inventoryFixture();
  f.browser.newBrowserCDPSession = async () => ({ send: async () => { throw new Error('ws://secret-endpoint token=secret'); }, detach: async () => { f.calls.push('cdp-detach'); } });
  const result = await inventoryQianchuanNativeSession(f.config, f.dependencies);
  assert.deepEqual(result.cdp_target_inventory, { ok: false, code: 'native_inventory_cdp_targets_unavailable', targets: [] });
  assert.equal(result.target_comparison.available, false);
  assert.equal(result.pages.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /secret/);
  assert.equal(f.calls.filter(item => item === 'cdp-detach').length, 1);
});

test('inventory timeout detaches once and preserves its phase even if cleanup also fails', async () => {
  const f = inventoryFixture();
  f.config.timeoutMs = 5;
  f.dependencies.getChromePageTarget = () => new Promise(() => {});
  f.dependencies.attachQianchuanChrome = async () => ({ browser: f.browser, detach: async () => { f.calls.push('detach'); throw new Error('cleanup failure'); } });
  await assert.rejects(inventoryQianchuanNativeSession(f.config, f.dependencies), error => {
    assert.equal(error.code, 'native_start_inventory_timeout');
    assert.deepEqual(error.diagnostic, { stage: 'page_inventory', failure_type: 'initialization_failed', transport_connected: true });
    return true;
  });
  assert.equal(f.calls.filter(item => item === 'detach').length, 1);
});

test('inventory cannot propose a candidate after discarding an invalid identity alias', async () => {
  const f = inventoryFixture();
  f.targets[0].url += '&advertiser_id=invalid-private-value';
  const result = await inventoryQianchuanNativeSession(f.config, f.dependencies);
  assert.equal(result.pages[0].invalid_identity_parameters, true);
  assert.deepEqual(result.configured_candidates[0].targets, []);
  assert.doesNotMatch(JSON.stringify(result), /invalid-private-value/);
});

test('public startup failures expose only allowlisted numeric or enumerated diagnostics', () => {
  const failure = publicNativeSessionFailure(Object.assign(new Error('token=secret ws://secret'), {
    code: 'bad secret', diagnostic: { stage: 'ws://secret', failure_type: 'secret', transport_connected: 'secret',
      endpoint: 'ws://secret', headers: { token: 'secret' }, elapsed_ms: 100, timeout_ms: 60000, http_status: 403, transport_code: 'ECONNREFUSED' },
  }));
  assert.deepEqual(failure, { code: 'native_start_failed', diagnostic: { stage: 'startup', failure_type: 'startup_failed',
    transport_connected: null, timeout_ms: 60000, elapsed_ms: 100, http_status: 403, transport_code: 'ECONNREFUSED' } });
  assert.doesNotMatch(JSON.stringify(failure), /secret|endpoint|headers/);
});
