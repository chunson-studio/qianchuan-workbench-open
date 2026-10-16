'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { startQianchuanNativeHost, isLoopbackAddress } = require('../tools/qc-native-session-host.cjs');
const { createQianchuanNativeClient } = require('../tools/qc-native-session-client.cjs');
const { createQianchuanNativeOperations } = require('../tools/qc-native-operations.cjs');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('extension adapter reuses host identity checks, per-profile queues and unknown-read semantics',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'qc-extension-host-')),runtimeFile=path.join(directory,'session.json');
  const gates=[deferred(),deferred()],entered=deferred();let active=0,max=0,calls=0;
  const bindings=[0,1].map(i=>({room:'扩展'+i,account_id:'account_'+i,advertiser_id:String(100+i),primary_ad_id:String(200+i),browser_context_id:'Profile '+i,target_id:String(300+i),page:{valid:true}}));
  const adapter={channel:'playwright-extension',accepts:p=>typeof p?.valid==='boolean',isClosed:()=>false,
    verify:async b=>{if(!b.page.valid)throw Object.assign(Error('private diagnosis'),{code:'extension_identity_changed'});}};
  const host=await startQianchuanNativeHost({browser:{isConnected:()=>true},bindings,pageAdapter:adapter,runtimeFile,operations:{read_control:{kind:'read',serialize:true,run:async({binding})=>{
    calls++;active++;max=Math.max(max,active);if(active===2)entered.resolve();await gates[Number(binding.room.slice(-1))].promise;active--;return {ok:true,advertising_writes:0};
  }}}});
  t.after(async()=>{gates.forEach(g=>g.resolve());await host.close();fs.unlinkSync(runtimeFile);fs.rmdirSync(directory);});
  const client=createQianchuanNativeClient({runtimeFile});
  const request=(i,id)=>({...Object.fromEntries(['room','account_id','advertiser_id','primary_ad_id'].map(k=>[k,bindings[i][k]])),operation:'read_control',request_id:id,input:{}});
  const a=client.call(request(0,'extension_read_a')),queued=client.call(request(0,'extension_read_b')),b=client.call(request(1,'extension_read_c'));
  await entered.promise;assert.equal(calls,2);assert.equal(max,2);
  gates.forEach(g=>g.resolve());assert.ok((await Promise.all([a,queued,b])).every(r=>r.ok));assert.equal(calls,3);
  assert.equal((await client.status()).channel,'playwright-extension');
  bindings[0].page.valid=false;
  const denied=await client.call(request(0,'extension_read_bad'));assert.equal(denied.ok,false);assert.equal(calls,3);assert.equal(denied.effect_status,'not_submitted');
});

async function fixture(t, operations, profiles = ['p-a', 'p-b']) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-native-host-'));
  const runtimeFile = path.join(directory, 'session.json');
  const bindings = profiles.map((profile, index) => {
    const advertiser_id = String(10001 + index), primary_ad_id = String(20001 + index);
    const page = { closed: false, target: { browserContextId: profile, targetId: 'target-' + index,
      url: `https://qianchuan.jinritemai.com/uni-prom/detail?aavid=${advertiser_id}&adId=${primary_ad_id}` },
      url() { return this.target.url; }, isClosed() { return this.closed; },
      context() { return { newCDPSession: async () => ({ send: async () => ({ targetInfo: { ...page.target } }), detach: async () => {} }) }; } };
    return { room: '房间' + index, account_id: 'account_' + index, advertiser_id, primary_ad_id,
      browser_context_id: profile, target_id: page.target.targetId, page };
  });
  const extraPages = [];
  const browser = { connected: true, closes: 0, isConnected() { return this.connected; }, contexts: () => [{ pages: () => [...bindings.map(binding => binding.page), ...extraPages] }],
    async close() { this.closes++; } };
  const host = await startQianchuanNativeHost({ browser, bindings, operations, runtimeFile });
  const client = createQianchuanNativeClient({ runtimeFile });
  t.after(async () => {
    await host.close();
    assert.equal(browser.closes, 0, 'The host must never close the caller browser');
    fs.unlinkSync(runtimeFile);
    fs.rmdirSync(directory);
  });
  const request = (index, operation, request_id, input = {}) => ({
    room: bindings[index].room, account_id: bindings[index].account_id,
    advertiser_id: bindings[index].advertiser_id, primary_ad_id: bindings[index].primary_ad_id,
    operation, request_id, input,
  });
  return { directory, runtimeFile, bindings, extraPages, browser, host, client, request };
}

function replacementPage(f, index = 0, changes = {}) {
  const binding = f.bindings[index];
  const page = { closed: false, target: { ...binding.page.target, targetId: 'replacement-' + index, ...changes },
    isClosed() { return this.closed; }, url() { return this.target.url; },
    context() { return { newCDPSession: async () => ({ send: async () => ({ targetInfo: { ...page.target } }), detach: async () => {} }) }; } };
  f.extraPages.push(page); return page;
}

test('closed page rebind preserves the browser connection, host identity and request receipts', async t => {
  let calls = 0;
  const f = await fixture(t, { echo: { kind: 'read', run: async ({ binding }) => { calls++; return { ok: true, target: binding.target_id }; } } });
  const original = await f.client.call(f.request(0, 'echo', 'old_page_read'));
  f.bindings[0].page.closed = true;
  assert.equal((await f.client.status()).binding_health[0].page_closed, true);
  const page = replacementPage(f);
  const request = { ...f.request(0, 'unused', 'rebind_closed_page'), target_id: page.target.targetId, observed_url: page.url() };
  const result = await f.client.rebindPage(request);
  assert.equal(result.ok, true); assert.equal(result.host_id, f.host.host_id);
  assert.equal(result.advertising_writes, 0); assert.equal(result.requests_replayed, 0);
  assert.equal((await f.client.status()).binding_health[0].page_closed, false);
  assert.equal(JSON.parse(fs.readFileSync(f.runtimeFile, 'utf8')).bindings[0].target_id, page.target.targetId);
  assert.deepEqual(await f.client.getRequest(f.request(0, 'echo', 'old_page_read')), original);
  assert.equal((await f.client.call(f.request(0, 'echo', 'new_page_read'))).result.target, page.target.targetId);
  assert.equal((await f.client.rebindPage(request)).already_bound, true); assert.equal(calls, 2);
  assert.equal(f.browser.closes, 0);
});

test('rebind rejects an open original, wrong profile, URL, target and disconnected browser', async t => {
  const f = await fixture(t, { echo: { kind: 'read', run: async () => ({ ok: true }) } });
  const page = replacementPage(f), request = { ...f.request(0, 'unused', 'rebind_wrong_page'), target_id: page.target.targetId, observed_url: page.url() };
  assert.equal((await f.client.rebindPage(request)).code, 'native_rebind_original_page_open');
  f.bindings[0].page.closed = true;
  page.target.browserContextId = 'other-profile';
  assert.equal((await f.client.rebindPage(request)).code, 'native_rebind_page_not_unique');
  page.target.browserContextId = f.bindings[0].browser_context_id;
  assert.equal((await f.client.rebindPage({ ...request, target_id: 'missing' })).code, 'native_rebind_page_not_unique');
  assert.equal((await f.client.rebindPage({ ...request, observed_url: page.url().replace('adId=20001', 'adId=99999') })).code, 'native_page_identity_mismatch');
  assert.equal((await f.client.rebindPage({ ...request, target_id: f.bindings[1].target_id })).code, 'native_binding_duplicate');
  f.browser.connected = false;
  assert.equal((await f.client.rebindPage(request)).code, 'native_browser_disconnected');
  assert.equal(JSON.parse(fs.readFileSync(f.runtimeFile, 'utf8')).bindings[0].target_id, f.bindings[0].target_id);
});

test('an observed unique URL discovers its actual target within the original profile without a new connection', async t => {
  const f = await fixture(t, { echo: { kind: 'read', run: async ({ binding }) => ({ target: binding.target_id }) } });
  f.bindings[0].page.closed = true; const page = replacementPage(f);
  replacementPage(f, 0, { targetId: 'same-url-other-profile', browserContextId: 'other-profile' });
  const request = { ...f.request(0, 'unused', 'observed_url_repair'), observed_url: page.url() };
  const result = await f.client.rebindPage(request);
  assert.equal(result.ok, true); assert.equal(result.binding.target_id, page.target.targetId);
  assert.equal(result.binding.browser_context_id, f.bindings[0].browser_context_id);
  assert.equal(f.browser.closes, 0);
  page.closed = true; replacementPage(f, 0, { targetId: 'duplicate-one' }); replacementPage(f, 0, { targetId: 'duplicate-two' });
  assert.equal((await f.client.rebindPage(request)).code, 'native_rebind_page_not_unique');
  assert.equal((await f.client.status()).bindings[0].target_id, page.target.targetId);
});

test('rebind waits for an in-flight write to finish and never replays its unknown result', async t => {
  const release = deferred(), started = deferred(); let calls = 0;
  const f = await fixture(t, { edit: { kind: 'write', run: async () => { calls++; started.resolve(); await release.promise; return { ok: true }; } } });
  const write = f.request(0, 'edit', 'unknown_before_rebind');
  const pending = f.client.call(write); await started.promise;
  f.bindings[0].page.closed = true; const page = replacementPage(f);
  const rebind = { ...f.request(0, 'unused', 'rebind_after_write'), target_id: page.target.targetId, observed_url: page.url() };
  assert.equal((await f.client.rebindPage(rebind)).code, 'native_rebind_busy');
  release.resolve(); const unknown = await pending;
  assert.equal(unknown.state, 'unknown');
  assert.equal((await f.client.rebindPage(rebind)).ok, true);
  assert.deepEqual(await f.client.call(write), unknown); assert.equal(calls, 1);
});

test('a disconnect during target validation cannot commit the replacement page', async t => {
  const f = await fixture(t, { echo: { kind: 'read', run: async () => ({ ok: true }) } });
  f.bindings[0].page.closed = true; const page = replacementPage(f); let probes = 0;
  page.context = () => ({ newCDPSession: async () => ({ send: async () => {
    if (++probes === 2) f.browser.connected = false;
    return { targetInfo: { ...page.target } };
  }, detach: async () => {} }) });
  const result = await f.client.rebindPage({ ...f.request(0, 'unused', 'disconnect_repair'), observed_url: page.url() });
  assert.equal(result.ok, false); assert.equal(result.code, 'native_page_unavailable');
  assert.equal(JSON.parse(fs.readFileSync(f.runtimeFile, 'utf8')).bindings[0].target_id, f.bindings[0].target_id);
});

test('a late page probe cannot change a binding after the recovery deadline', async t => {
  const f = await fixture(t, { echo: { kind: 'read', run: async () => ({ ok: true }) } });
  f.bindings[0].page.closed = true;
  const page = replacementPage(f), release = deferred(), started = deferred();
  page.context = () => ({ newCDPSession: async () => ({ send: async () => {
    started.resolve(); await release.promise; return { targetInfo: { ...page.target } };
  }, detach: async () => {} }) });
  const runtime = JSON.parse(fs.readFileSync(f.runtimeFile, 'utf8'));
  const pending = fetch(runtime.endpoint + '/rebind', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + runtime.token },
    body: JSON.stringify({ ...f.request(0, 'unused', 'bounded_rebind_request'), operation: undefined, input: undefined,
      host_id: runtime.host_id, target_id: page.target.targetId, observed_url: page.url(), deadline_at_ms: Date.now() + 100 }) });
  await started.promise;
  assert.equal((await (await pending).json()).code, 'native_rebind_timeout');
  release.resolve(); await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await f.client.status()).bindings[0].target_id, f.bindings[0].target_id);
});

test('each dispatch rechecks actual profile/target and URL before executing', async t => {
  let calls = 0;
  const f = await fixture(t, { inspect: { kind: 'read', run: async () => { calls++; return { count: 1 }; } } });
  const original = { ...f.bindings[0].page.target };
  for (const [field, value] of [['browserContextId', 'wrong-profile'], ['targetId', 'wrong-target'], ['url', original.url + '&advertiser_id=99999']]) {
    f.bindings[0].page.target = { ...original, [field]: value };
    const response = await f.client.call(f.request(0, 'inspect', 'wrong_' + field));
    assert.equal(response.ok, false);
    assert.equal(response.code, 'native_page_identity_mismatch');
    assert.equal(response.advertising_writes, 0);
  }
  assert.equal(calls, 0);
});

test('binding changes during an operation discard its result and never claim a verified write', async t => {
  const f = await fixture(t, { drift: { kind: 'write', run: async ({ page }) => {
    page.target.targetId = 'different-target'; return { ok: true, write_verified: true };
  } } });
  const result = await f.client.call(f.request(0, 'drift', 'postcheck_drift'));
  assert.equal(result.ok, false);
  assert.equal(result.state, 'unknown');
  assert.equal(result.effect_status, 'unconfirmed');
  assert.equal(result.result, undefined);
  assert.equal(result.retry_write, false);
});

test('completed reads are bounded without retaining their full results forever', async t => {
  let calls = 0;
  const f = await fixture(t, { inspect: { kind: 'read', run: async () => ({ value: ++calls, snapshot: 'visible data' }) } });
  const count = f.host.retention.completed_reads + 1;
  for (let index = 0; index < count; index++) await f.client.call(f.request(0, 'inspect', 'bounded_read_' + index));
  const expired = await f.client.getRequest(f.request(0, 'inspect', 'bounded_read_0'));
  assert.equal(expired.code, 'native_request_not_found');
  const newest = await f.client.getRequest(f.request(0, 'inspect', 'bounded_read_' + (count - 1)));
  assert.equal(newest.result.value, count);
  assert.equal(f.host.retention.completed_read_ms, 120000);
  assert.equal(calls, count);
});

test('old completed write payloads compact while their receipts and unknown writes prevent replay', async t => {
  let calls = 0;
  const f = await fixture(t, { edit: { kind: 'write', run: async ({ input }) => {
    calls++; if (input.fail) throw Error('unknown submit');
    return { snapshot: 'large return value', value: input.value };
  } } });
  const unknown = f.request(0, 'edit', 'retained_unknown', { fail: true });
  await f.client.call(unknown);
  const count = f.host.retention.full_write_results + 1;
  for (let index = 0; index < count; index++) await f.client.call(f.request(0, 'edit', 'bounded_write_' + index, { value: index }));
  const first = f.request(0, 'edit', 'bounded_write_0', { value: 0 });
  const compact = await f.client.getRequest(first);
  assert.equal(compact.result_expired, true);
  assert.equal(compact.result, undefined);
  assert.equal(compact.requires_readback, true);
  assert.deepEqual(await f.client.call(first), compact);
  assert.equal((await f.client.call(unknown)).state, 'unknown');
  assert.equal(calls, count + 1);
  assert.equal((await f.client.call({ ...first, input: { value: 999 } })).code, 'native_request_conflict');
});

test('different profiles execute concurrently and writes in one profile remain serial', async t => {
  const first = deferred(), started = deferred(), calls = [];
  const f = await fixture(t, { edit: { kind: 'write', run: async ({ binding, input }) => {
    calls.push(input.id);
    if (input.id === 'first') { started.resolve(); await first.promise; }
    return { room: binding.room, id: input.id };
  } } }, ['same-profile', 'same-profile', 'other-profile']);
  const one = f.client.call(f.request(0, 'edit', 'serial_first', { id: 'first' }));
  await started.promise;
  const two = f.client.call(f.request(1, 'edit', 'serial_second', { id: 'second' }));
  const three = await f.client.call(f.request(2, 'edit', 'parallel_third', { id: 'third' }));
  assert.equal(three.ok, true);
  assert.deepEqual(calls, ['first', 'third']);
  first.resolve();
  const returned = await Promise.all([one, two]);
  assert.ok(returned.every(value => value.ok));
  assert.deepEqual(calls, ['first', 'third', 'second']);
});

test('duplicates share one pending write and completed receipt, conflicts never dispatch', async t => {
  const release = deferred(), started = deferred(); let calls = 0;
  const f = await fixture(t, { edit: { kind: 'write', run: async ({ input }) => { calls++; started.resolve(); await release.promise; return { value: input.value }; } } });
  const request = f.request(0, 'edit', 'same_write_001', { value: 7, nested: { a: 1, b: 2 } });
  const first = f.client.call(request);
  await started.promise;
  const second = f.client.call({ ...request, input: { nested: { b: 2, a: 1 }, value: 7 } });
  const state = await f.client.getRequest(request);
  assert.equal(state.state, 'running');
  const conflict = await f.client.call({ ...request, input: { value: 8 } });
  assert.equal(conflict.code, 'native_request_conflict');
  release.resolve();
  const results = await Promise.all([first, second]);
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(await f.client.call(request), results[0]);
  assert.equal(calls, 1);
});

test('unknown write is retained and never replayed after an operation failure', async t => {
  let calls = 0;
  const f = await fixture(t, { edit: { kind: 'write', run: async () => { calls++; throw Error('platform disconnected'); } } });
  const request = f.request(0, 'edit', 'unknown_write_1');
  const result = await f.client.call(request);
  assert.equal(result.state, 'unknown');
  assert.equal(result.effect_status, 'unconfirmed');
  assert.equal(result.retry_write, false);
  assert.deepEqual(await f.client.call(request), result);
  assert.deepEqual(await f.client.getRequest(request), result);
  assert.equal(calls, 1);
});

test('real prepare-batch failure is unknown in the outer receipt, retains step progress and never replays', async t => {
  const batch = createQianchuanNativeOperations().ui_prepare_batch;
  const f = await fixture(t, { ui_prepare_batch: batch });
  let fills = 0;
  const element = { tagName: 'INPUT', innerText: '', isConnected: true, getAttribute: () => null };
  const rootNode = { tagName: 'DIV', innerText: '编辑素材追投', isConnected: true, contains: value => value === element };
  const handle = { evaluate: async (fn, arg) => fn(element, arg?.node || arg), dispose: async () => {}, fill: async () => {
    fills++; if (fills === 2) throw Error('form action result unknown');
  } };
  const target = { filter() { return this; }, count: async () => 1, elementHandle: async () => handle };
  const root = { filter() { return this; }, count: async () => 1, evaluate: async fn => fn(rootNode),
    elementHandle: async () => ({ node: rootNode, dispose: async () => {} }), getByText: () => target, getByRole: () => target };
  f.bindings[0].page.getByRole = () => root;
  const steps = ['100', '2.45', 'third'].map(value => ({ scope: { type: 'boost_form', title: '编辑素材追投' },
    target: [{ by: 'role', value: 'textbox' }], action: 'fill', value }));
  const request = f.request(0, 'ui_prepare_batch', 'prepare_unknown_1', { steps });
  const result = await f.client.call(request);
  assert.equal(result.ok, false); assert.equal(result.state, 'unknown');
  assert.equal(result.effect_status, 'unconfirmed'); assert.equal(result.advertising_writes, 0);
  assert.equal(result.code, 'native_operation_failed');
  assert.equal(result.operation_code, 'native_prepare_batch_step_failed');
  assert.equal(result.requires_readback, true);
  assert.equal(result.result.executed_steps, 1); assert.equal(result.result.attempted_steps, 2);
  assert.equal(result.result.failed_step, 2); assert.equal(result.result.retry_batch, false);
  assert.deepEqual(await f.client.getRequest(request), result);
  assert.deepEqual(await f.client.call(request), result);
  assert.equal(fills, 2);
});

test('real prepare-batch preflight rejection is rejected/not-submitted at both layers', async t => {
  const f = await fixture(t, { ui_prepare_batch: createQianchuanNativeOperations().ui_prepare_batch });
  const request = f.request(0, 'ui_prepare_batch', 'prepare_rejected_1', { steps: [{
    scope: { type: 'task_confirmation', task_ids: ['12345'], task_action: 'delete' },
    target: [{ by: 'role', value: 'button', name: '确定' }], action: 'click',
  }] });
  const result = await f.client.call(request);
  assert.equal(result.ok, false); assert.equal(result.state, 'rejected');
  assert.equal(result.effect_status, 'not_submitted'); assert.equal(result.advertising_writes, 0);
  assert.equal(result.operation_code, 'native_prepare_batch_step_forbidden');
  assert.equal(result.result.executed_steps, 0); assert.equal(result.result.attempted_steps, 0);
  assert.deepEqual(await f.client.call(request), result);
});

test('explicit returned unknown never becomes success and does not invent an advertising submission', async t => {
  const f = await fixture(t, { prepare: { kind: 'write', run: async ({ input }) => ({
    ok: input.ok, status: 'unknown', effect_status: 'unconfirmed', advertising_writes: 0, code: input.code,
  }) } });
  for (const [index, input] of [{ ok: true, code: 'native_prepare_failed' }, { ok: false, code: 'private-token=secret' }].entries()) {
    const result = await f.client.call(f.request(0, 'prepare', 'returned_unknown_' + index, input));
    assert.equal(result.ok, false); assert.equal(result.state, 'unknown');
    assert.equal(result.effect_status, 'unconfirmed'); assert.equal(result.advertising_writes, 0);
    assert.equal(result.operation_code, index === 0 ? 'native_prepare_failed' : undefined);
    assert.equal(result.retry_write, false);
  }
});

test('operation failures expose bounded safe codes without messages, causes or arbitrary details', async t => {
  const f = await fixture(t, { edit: { kind: 'write', run: async ({ input }) => {
    throw Object.assign(new Error('access_token=private-message ws://private-endpoint', { cause: new Error('private-cause') }), {
      code: input.code, details: { endpoint: 'ws://private-details', token: 'private-token' },
    });
  } } });
  const codes = ['native_parameter_target_missing', 'a'.repeat(80), 'a'.repeat(81), 'TOKEN_SECRET', 'code-with-hyphen', 'code=private-token', 123];
  for (const [index, code] of codes.entries()) {
    const result = await f.client.call(f.request(0, 'edit', 'safe_failure_' + index, { code }));
    assert.equal(result.code, 'native_operation_failed');
    assert.equal(result.operation_code, index < 2 ? code : undefined);
    assert.equal(result.effect_status, 'unconfirmed');
    assert.equal(result.advertising_writes, undefined);
    assert.equal(result.retry_write, false);
    assert.doesNotMatch(JSON.stringify(result), /private-|access_token|TOKEN_SECRET|details|message|cause|ws:\/\//);
  }
});

test('explicit not-submitted failures retain their receipt and never authorize automatic retry', async t => {
  let calls = 0;
  const f = await fixture(t, { edit: { kind: 'write', run: async ({ input }) => {
    calls++;
    throw Object.assign(new Error('validation failed'), { code: 'native_parameter_invalid', ...input });
  } } });
  const declarations = [
    { effect_status: 'not_submitted' },
    { details: { effect_status: 'not_submitted' } },
    { effect_status: 'not_submitted', details: { effect_status: 'not_submitted' } },
  ];
  for (const [index, input] of declarations.entries()) {
    const request = f.request(0, 'edit', 'not_submitted_' + index, input);
    const result = await f.client.call(request);
    assert.equal(result.code, 'native_operation_failed');
    assert.equal(result.operation_code, 'native_parameter_invalid');
    assert.equal(result.effect_status, 'not_submitted');
    assert.equal(result.advertising_writes, 0);
    assert.equal(result.retry_write, false);
    assert.deepEqual(await f.client.getRequest(request), result);
    assert.deepEqual(await f.client.call(request), result);
  }
  assert.equal(calls, declarations.length);
});

test('missing, conflicting or textual no-submit claims leave dispatched writes unconfirmed', async t => {
  const f = await fixture(t, { edit: { kind: 'write', run: async ({ input }) => {
    throw Object.assign(new Error('not_submitted safe to retry'), { code: 'native_not_submitted', ...input });
  } } });
  const declarations = [
    {}, { effect_status: 'unconfirmed' }, { effect_status: 'confirmed' },
    { details: { effect_status: 'not submitted' } },
    { effect_status: 'unconfirmed', details: { effect_status: 'not_submitted' } },
    { effect_status: 'not_submitted', details: { effect_status: 'confirmed' } },
  ];
  for (const [index, input] of declarations.entries()) {
    const result = await f.client.call(f.request(0, 'edit', 'unknown_effect_' + index, input));
    assert.equal(result.state, 'unknown');
    assert.equal(result.code, 'native_operation_failed');
    assert.equal(result.effect_status, 'unconfirmed');
    assert.equal(result.advertising_writes, undefined);
    assert.equal(result.retry_write, false);
  }
});

test('queued timeout prevents a late write after its client stops waiting', async t => {
  const release = deferred(), started = deferred(), calls = [];
  const f = await fixture(t, { edit: { kind: 'write', run: async ({ input }) => {
    calls.push(input.id);
    if (input.id === 'first') { started.resolve(); await release.promise; }
    return { ok: true };
  } } }, ['shared', 'shared']);
  const first = f.client.call(f.request(0, 'edit', 'long_first_1', { id: 'first' }));
  await started.promise;
  const request = f.request(1, 'edit', 'expires_second', { id: 'second' });
  try { await f.client.call(request, { timeoutMs: 30 }); } catch (error) { assert.equal(error.code, 'native_result_unknown'); }
  await new Promise(resolve => setTimeout(resolve, 15));
  release.resolve(); await first;
  const result = await f.client.getRequest(request);
  assert.equal(result.code, 'native_queue_timeout');
  assert.equal(result.effect_status, 'not_submitted');
  assert.deepEqual(calls, ['first']);
});

test('loopback binding, Origin and Host rejection, authorization and token redaction', async t => {
  const f = await fixture(t, { echo: { kind: 'read', run: async ({ input }) => input } });
  for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.equal(isLoopbackAddress(address), true);
  for (const address of ['192.168.1.20', '8.8.8.8', '127.0.0.2', undefined, 'localhost']) assert.equal(isLoopbackAddress(address), false);
  const privateValue = JSON.parse(fs.readFileSync(f.runtimeFile, 'utf8'));
  assert.equal(new URL(f.host.endpoint).hostname, '127.0.0.1');
  assert.equal(JSON.stringify(f.host).includes(privateValue.token), false);
  assert.equal(JSON.stringify(f.client).includes(privateValue.token), false);
  const headers = { Authorization: 'Bearer ' + privateValue.token };
  for (const extra of [{ Origin: 'https://evil.example' }, { Origin: f.host.endpoint }]) {
    const response = await fetch(f.host.endpoint + '/status', { headers: { ...headers, ...extra } });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, 'native_origin_rejected');
  }
  const wrongHost = await new Promise((resolve, reject) => {
    http.get(f.host.endpoint + '/status', { headers: { ...headers, Host: 'evil.example' } }, response => {
      response.resume(); response.once('end', () => resolve(response.statusCode));
    }).once('error', reject);
  });
  assert.equal(wrongHost, 403);
  assert.equal((await fetch(f.host.endpoint + '/status')).status, 401);
  const status = await (await fetch(f.host.endpoint + '/status', { headers })).text();
  assert.equal(status.includes(privateValue.token), false);
  const echo = await f.client.call(f.request(0, 'echo', 'redact_token_1', { nested: privateValue.token }));
  assert.equal(JSON.stringify(echo).includes(privateValue.token), false);
  assert.equal(echo.result.nested, '[redacted]');
});

test('only registered names run and a replacement host cannot receive an old client request', async t => {
  let calls = 0;
  const f = await fixture(t, { inspect: { kind: 'read', run: async () => { calls++; return { ok: true }; } } });
  const request = f.request(0, 'inspect', 'host_bound_req');
  const unregistered = await f.client.call({ ...request, operation: '../arbitrary-script.cjs' });
  assert.equal(unregistered.code, 'native_operation_invalid');
  const changed = { ...JSON.parse(fs.readFileSync(f.runtimeFile, 'utf8')), host_id: '00000000-0000-0000-0000-000000000000' };
  fs.writeFileSync(f.runtimeFile, JSON.stringify(changed));
  await assert.rejects(f.client.call(request), { code: 'native_host_changed' });
  assert.throws(() => createQianchuanNativeClient({ runtimeFile: f.runtimeFile, expectedHostId: f.host.host_id }), { code: 'native_host_changed' });
  assert.equal(calls, 0);
});
