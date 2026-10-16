'use strict';

// All config, credentials, readers and handlers are fixtures. The real guard
// and standard error formatter run without importing the customer's runtime.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const guardPath = path.resolve(__dirname, '../server-app/server/lib/onboardingGuard.js');
const errorPath = path.resolve(__dirname, '../server-app/server/lib/handleApiError.js');
const guardSource = fs.readFileSync(guardPath, 'utf8');
const errorSource = fs.readFileSync(errorPath, 'utf8');
const secret = 'fixture-sensitive-value';

function harness(options = {}) {
  const start = new Date(Date.now() - 600000).toISOString();
  const binding = { primary_ad_id: '111', room_id: '222', session_started_at: start,
    allowed_actions: ['pause'] };
  const config = { qianchuan_accounts: [{ id: 'fixture' }], agent_policy: {
    account_policies: { fixture: { boost_write_scope: binding } },
  } };
  const state = { liveReads: 0, listReads: 0, handlerWrites: 0,
    live: { isLive: true, rooms: [{ roomId: '222', startTime: start }], error: null },
    body: { accountId: 'fixture', primaryAdId: '111', assistTaskId: '333', status: 2 },
    rows: [{ id: '333', status: 1, createTime: Math.floor(Date.now() / 1000) - 60 }], binding };
  if (Object.hasOwn(options, 'live')) state.live = options.live;
  const readers = {
    async fetchLiveStatus(account) {
      assert.equal(account, 'fixture');
      state.liveReads++;
      if (Object.hasOwn(options, 'throws')) throw options.throws;
      return state.live;
    },
    async fetchBoostList(plan, _from, _to, account) {
      assert.equal(account, 'fixture');
      assert.equal(plan, '111');
      state.listReads++;
      return { status_code: 0, data: { adInfos: state.rows } };
    },
  };
  const utils = {
    requireWriteAuth: () => true,
    readJsonBody: async () => ({ data: state.body }),
    sendJSON(res, body, status = 200) { res.status = status; res.body = JSON.parse(JSON.stringify(body)); },
    getLocalDateStr: (date = new Date()) => date.toISOString().slice(0, 10),
  };
  function load(source, filename) {
    const module = { exports: {} };
    vm.runInNewContext(source, {
      module, exports: module.exports, Date,
      console: { error() {}, warn() {} },
      require(name) {
        if (name === './browserBoostRequests') return {assertNoUnknownBrowserRequest(){},assertBrowserRequestIdUnused(){}};
        if (name === './accountRegistry') return { readConfig: () => config };
        if (name === './config') return { CONFIG_PATH: 'fixture-only' };
        if (name === './utils') return utils;
        if (name === './agentPolicy') return {
          checkAgentWritePolicy: () => ({ allowed: true }),
          resolveBoostWriteScope: policy => ({ binding: policy.boost_write_scope }),
        };
        if (name === './dataContract') return { finiteNumber: value => typeof value === 'number' && Number.isFinite(value) ? value : null };
        if (name === './writeReceipt') return { boostStatus: task => task.status };
        if (name === './qianchuanTabs') return readers;
        if (name === './targetWriteLock') return { withTargetWriteLock: (_account, _key, run) => run() };
        if (name === './boostExecutionOwner') return { assertBoostExecutionOwner: (_req, account, plan) => {
          assert.equal(account, 'fixture'); assert.equal(plan, '111');
        } };
        throw new Error('Unexpected dependency in isolated guard test: ' + name);
      },
    }, { filename });
    return module.exports;
  }
  state.guard = load(guardSource, guardPath);
  state.handleApiError = load(errorSource, errorPath).handleApiError;
  state.check = () => state.guard.checkHttpWritePolicy(config, '/api/campaign/status', state.body);
  state.readers = readers;
  state.run = async () => {
    const req = { method: 'POST', headers: {} };
    const res = {};
    await state.guard.runGuardedWrite(req, res, new URL('http://fixture/api/campaign/status'), () => {
      state.handlerWrites++;
      res.body = { ok: true };
      res.status = 200;
    });
    return res;
  };
  return state;
}

function assertZeroWrite(state, res, code, status) {
  assert.equal(res.status, status);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, code);
  assert.equal(res.body.effect_status, 'rejected');
  assert.equal(res.body.advertising_writes, 0);
  assert.equal(res.body.retry_write, false);
  assert.equal(state.handlerWrites, 0);
  assert.equal(state.listReads, 0);
  assert.equal(state.liveReads, 1);
  assert.equal(JSON.stringify(res.body).includes(secret), false);
}

test('returned credential failures remain cookie_expired/401 with zero writes', async () => {
  for (const live of [
    { error: secret, code: 'cookie_expired', statusCode: 401, retryable: false },
    { error: 'cookie_expired' }, { error: 'cookie_not_found' },
    { error: secret, code: 'cookie_not_found' },
  ]) {
    const state = harness({ live });
    const res = await state.run();
    assertZeroWrite(state, res, 'cookie_expired', 401);
    assert.equal(res.body.error, 'cookie_expired');
    assert.equal(res.body.retryable, false);
    assert.equal(res.body.component, 'live_status');
  }
});

test('thrown structured read failures preserve safe metadata and match handleApiError semantics', async () => {
  const error = Object.assign(new Error(secret), {
    code: 'upstream_timeout', statusCode: 504, retryable: true, component: 'qianchuan_upstream', timeoutMs: 20000,
    errors: [secret], details: { cookie: secret }, cause: secret,
  });
  const state = harness({ throws: error });
  let safeError;
  await assert.rejects(state.guard.verifyBoostScope(state.check(), state.body, state.readers), caught => {
    safeError = caught;
    assert.equal(caught.message.includes(secret), false);
    assert.equal(caught.details, undefined);
    assert.equal(caught.errors, undefined);
    assert.equal(caught.cause, undefined);
    return true;
  });
  const standard = {};
  state.handleApiError(standard, safeError);
  state.liveReads = 0;
  const res = await state.run();
  assertZeroWrite(state, res, 'upstream_timeout', 504);
  for (const key of ['ok', 'error', 'code', 'component', 'retryable', 'timeout_ms', 'partial', 'errors', 'advertising_writes', 'effect_status'])
    assert.deepEqual(res.body[key], standard.body[key], key);
  assert.equal(res.status, standard.status);
  assert.equal(res.body.timeout_ms, 20000);
  assert.equal(res.body.component, 'qianchuan_upstream');
  assert.equal(res.body.retryable, true);
});

test('timeout and availability codes are not collapsed into authorization or ended-session failures', async () => {
  const cases = [
    ['upstream_timeout', 504, true], ['queue_timeout', 504, true],
    ['queue_wait_timeout', 504, true], ['exec_timeout', 504, true],
    ['request_timeout', 504, true], ['request_cancelled', 504, true],
    ['upstream_unavailable', 502, true], ['upstream_bad_response', 502, false],
    ['upstream_parse_error', 502, false], ['rate_limited', 429, true],
    ['upstream_forbidden', 403, false], ['upstream_locked', 423, true],
  ];
  for (const [code, status, retryable] of cases) {
    const state = harness({ live: { error: secret, code, component: 'qianchuan_queue' } });
    const res = await state.run();
    assertZeroWrite(state, res, code, status);
    assert.equal(res.body.retryable, retryable);
    assert.equal(res.body.component, 'qianchuan_queue');
  }
  const state = harness({ live: { error: '', code: 'upstream_timeout', retryable: false, timeout_ms: 15000 } });
  const res = await state.run();
  assertZeroWrite(state, res, 'upstream_timeout', 504);
  assert.equal(res.body.retryable, false);
  assert.equal(res.body.timeout_ms, 15000);
});

test('unknown/free-form errors, fields and malformed metadata cannot leak or become a retrying write', async () => {
  for (const live of [
    { error: secret, code: secret, component: secret, timeoutMs: secret, details: { cookie: secret } },
    { error: secret, code: '__proto__', statusCode: '__proto__', component: secret },
    { error: secret, code: 'constructor', statusCode: 700, timeoutMs: -1 },
    null, [], false,
  ]) {
    const state = harness({ live });
    const res = await state.run();
    assertZeroWrite(state, res, 'live_verification_failed', 403);
    assert.equal(res.body.component, 'live_status');
    assert.equal(res.body.timeout_ms, null);
    assert.equal(res.body.retryable, false);
    assert.equal(res.body.details, undefined);
    assert.deepEqual(res.body.errors, []);
  }
  const state = harness({ live: { error: secret, code: secret, statusCode: 504, retryable: true, component: secret } });
  const res = await state.run();
  assertZeroWrite(state, res, 'upstream_timeout', 504);
  assert.equal(res.body.component, 'live_status');
  assert.equal(res.body.retryable, true);
});

test('healthy exact-session reads still pass, and ended/wrong sessions still reject', async () => {
  const healthy = harness();
  assert.equal((await healthy.run()).status, 200);
  assert.equal(healthy.handlerWrites, 1);
  assert.equal(healthy.listReads, 1);
  for (const kind of ['ended', 'wrong-room', 'wrong-start']) {
    const state = harness();
    if (kind === 'ended') state.live = { isLive: false, rooms: [], error: null };
    if (kind === 'wrong-room') state.live.rooms[0].roomId = 'other-room';
    if (kind === 'wrong-start') state.live.rooms[0].startTime = new Date(Date.now()).toISOString();
    assertZeroWrite(state, await state.run(), 'session_outside_authorization', 403);
  }
});

test('account, plan and action authorization still reject before any reader or handler', async () => {
  for (const [change, code] of [
    [{ accountId: 'unconfigured' }, 'account_required'],
    [{ primaryAdId: 'other-plan' }, 'plan_outside_authorization'],
    [{ status: 1 }, 'action_outside_authorization'],
  ]) {
    const state = harness();
    Object.assign(state.body, change);
    const res = await state.run();
    assert.equal(res.status, 403);
    assert.equal(res.body.code, code);
    assert.equal(res.body.advertising_writes, 0);
    assert.equal(state.handlerWrites, 0);
    assert.equal(state.liveReads, 0);
    assert.equal(state.listReads, 0);
  }
});
