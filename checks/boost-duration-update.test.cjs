'use strict';
require('./setup-runtime.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const assert = require('node:assert/strict');

const accountId = 'duration_route_test';
const planId = '88';
const roomId = '222';
const startedAt = new Date(Date.now() - 600000).toISOString();
const configPath = path.join(process.env.QC_RUNTIME_CONFIG_ROOT, 'config.json');
function configure(allowedActions = ['update_duration', 'update_budget', 'update_roi', 'update_bid', 'update_audience']) {
  fs.writeFileSync(configPath, JSON.stringify({
    qianchuan_accounts: [{ id: accountId, aavid: '12345', cookieFile: 'unused.txt' }],
    agent_policy: { account_policies: { [accountId]: { boost_write_scope: {
      primary_ad_id: planId, room_id: roomId, session_started_at: startedAt, allowed_actions: allowedActions,
    } } } },
  }));
}
configure();
const tasks = new Map();
const writes = [];
let readbackBehavior = 'match';
function task(id, overrides = {}) {
  configure();
  writes.length = 0;
  readbackBehavior = 'match';
  const value = { id: String(id), createTime: Math.floor(Date.now() / 1000) - 30,
    status: 1, budget: 100 * 100000, ecpRoi2Goal: 10, smartBidType: 7,
    audience: { CityDivide: 0 }, duration_seconds: 21600,
    assistTaskInfoMap: { '2': { operation: { edit: { editable: true } } } }, ...overrides };
  tasks.set(String(id), value);
  return value;
}

const qianchuan = require('../server-app/server/lib/qianchuan');
const tabs = require('../server-app/server/lib/qianchuanTabs');
qianchuan.updateCampaignBudgetAndROI = async (...args) => {
  const [primary, targetId, budget, roiGoal, account, options] = args;
  assert.equal(primary, planId);
  assert.equal(account, accountId);
  assert.equal(budget, undefined);
  assert.equal(roiGoal, undefined);
  options.beforeWrite?.();
  writes.push(args);
  const current = tasks.get(String(targetId));
  if (readbackBehavior === 'match') current.duration_seconds = options.durationSeconds;
  if (readbackBehavior === 'unknown') delete current.duration_seconds;
  return { code: 0 };
};
tabs.fetchLiveStatus = async account => {
  assert.equal(account, accountId);
  return { isLive: true, rooms: [{ roomId, startTime: startedAt }] };
};
tabs.fetchBoostList = async (primary, _start, _end, account, options) => {
  assert.equal(primary, planId);
  assert.equal(account, accountId);
  assert.equal(options.includeAllStatus, true);
  return { code: 0, data: { adInfos: [...tasks.values()].map(value => structuredClone(value)) } };
};
const { handleCampaignBudget } = require('../server-app/server/routes/campaignOps');
const { runGuardedWrite } = require('../server-app/server/lib/onboardingGuard');
const opLog = require('../server-app/server/lib/operationLog');
const { getActionLimits } = require('../server-app/server/lib/actionLimits');

async function request(id, overrides = {}, guarded = true) {
  const body = { accountId, primaryAdId: planId, assistTaskId: String(id),
    durationSeconds: 25200, expectedDurationSeconds: 21600, source: 'agent', ...overrides };
  const req = new PassThrough();
  req.method = 'POST';
  req.url = '/api/campaign/budget';
  req.headers = { 'content-type': 'application/json' };
  req.socket = { remoteAddress: '127.0.0.1' };
  const res = { statusCode: 200, headersSent: false, body: '',
    writeHead(status) { this.statusCode = status; this.headersSent = true; },
    end(value = '') { this.body += value; } };
  req.end(JSON.stringify(body));
  const url = new URL(`http://localhost${req.url}`);
  if (guarded) await runGuardedWrite(req, res, url, handleCampaignBudget);
  else await handleCampaignBudget(req, res, url);
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

test('duration update uses observed prior value and persists an action-specific verified receipt', async () => {
  task('77');
  const result = await request('77');
  assert.equal(result.status, 200);
  assert.equal(result.body.effect_status, 'confirmed');
  assert.deepEqual(result.body.requested, { duration_seconds: 25200 });
  assert.equal(result.body.before.duration_seconds, 21600);
  assert.equal(result.body.actual.duration_seconds, 25200);
  assert.equal(result.body.readback.verified, true);
  assert.equal(result.body.readback.target_id, '77');
  assert.equal(writes.length, 1);
  assert.equal(writes[0][5].durationSeconds, 25200);
  assert.equal(writes[0][5].expectedDurationSeconds, 21600);
  const row = opLog.getById(result.body.operation_id);
  assert.equal(row.action, 'update_duration');
  assert.equal(row.account_id, accountId);
  assert.equal(String(row.target_id), '77');
  assert.deepEqual(row.params.receipt.requested, { duration_seconds: 25200 });
  assert.equal(row.params.receipt.effect_status, 'confirmed');
});

test('duration change rejects invalid units, missing prior value and mixed parameter updates before upstream writes', async () => {
  task('78');
  const invalid = [
    [{ durationSeconds: 0 }, 'invalid_duration'],
    [{ durationSeconds: 900 }, 'invalid_duration'],
    [{ durationSeconds: 2000 }, 'invalid_duration'],
    [{ durationSeconds: 88200 }, 'invalid_duration'],
    [{ durationSeconds: 1.5 }, 'invalid_duration'],
    [{ durationSeconds: '25200' }, 'invalid_duration'],
    [{ durationSeconds: Number.MAX_SAFE_INTEGER + 1 }, 'invalid_duration'],
    [{ expectedDurationSeconds: undefined }, 'invalid_duration'],
    [{ expectedDurationSeconds: -1 }, 'invalid_duration'],
    [{ durationSeconds: undefined }, 'invalid_expected_duration'],
    [{ assistTaskId: undefined }, 'invalid_duration'],
    ...[{ budget: 200 }, { roiGoal: 11 }, { bid: 20 }, { audienceTemplate: 'full_region' }]
      .map(fields => [fields, 'mixed_duration_update_not_supported']),
  ];
  for (const [fields, code] of invalid) {
    const result = await request('78', fields, false);
    assert.equal(result.status, 400, JSON.stringify(fields));
    assert.equal(result.body.code, code);
    assert.equal(result.body.advertising_writes, 0);
    assert.equal(result.body.effect_status, 'rejected');
  }
  assert.equal(writes.length, 0);
});

test('stale and unavailable prior durations reject with 409 and 423 and zero writes', async () => {
  task('79', { duration_seconds: 28800 });
  const conflict = await request('79');
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'duration_conflict');
  assert.equal(conflict.body.advertising_writes, 0);
  assert.equal(conflict.body.details.current_duration_seconds, 28800);
  assert.equal(writes.length, 0);

  task('80', { duration_seconds: undefined, Duration: 21600 });
  const unknown = await request('80');
  assert.equal(unknown.status, 423);
  assert.equal(unknown.body.code, 'duration_unavailable');
  assert.equal(unknown.body.advertising_writes, 0);
  assert.equal(writes.length, 0);
});

test('concurrent updates on the same task submit once and reject the stale second request', async () => {
  task('81');
  // Call the route directly so its target lock, not the outer plan-scope lock, is exercised.
  const results = await Promise.all([request('81', {}, false), request('81', {}, false)]);
  assert.equal(results.filter(result => result.body.effect_status === 'confirmed').length, 1);
  assert.equal(results.filter(result => result.body.code === 'duration_conflict').length, 1);
  assert.equal(writes.length, 1);
  assert.equal(tasks.get('81').duration_seconds, 25200);
});

test('accepted write with mismatching or missing duration readback remains unconfirmed', async () => {
  for (const [id, behavior] of [['82', 'mismatch'], ['83', 'unknown']]) {
    task(id);
    readbackBehavior = behavior;
    const result = await request(id);
    assert.equal(result.status, 200);
    assert.equal(result.body.upstream_accepted, true);
    assert.equal(result.body.effect_status, 'unconfirmed');
    assert.equal(result.body.readback.verified, false);
    assert.ok(result.body.readback.mismatches.includes('duration_seconds'));
    assert.equal(result.body.retry_write, false);
    assert.equal(writes.length, 1);
    assert.equal(opLog.getById(result.body.operation_id).params.receipt.effect_status, 'unconfirmed');
  }
});

test('scope lacking update_duration cannot borrow update_budget permission', async () => {
  task('84');
  configure(['update_budget']);
  const result = await request('84');
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'action_outside_authorization');
  assert.equal(result.body.advertising_writes, 0);
  assert.equal(writes.length, 0);
  configure();
});

test('three accepted duration changes consume the shared hourly parameter limit', async () => {
  task('85');
  for (let step = 0; step < 3; step++) {
    const result = await request('85', { durationSeconds: 25200 + step * 3600, expectedDurationSeconds: 21600 + step * 3600 });
    assert.equal(result.status, 200);
    assert.equal(result.body.effect_status, 'confirmed');
  }
  assert.equal(writes.length, 3);
  const logged = opLog.getRecentParameterUpdates(accountId, '85');
  assert.equal(logged.length, 3);
  assert.ok(logged.every(row => row.action === 'update_duration'));
  const limits = getActionLimits(accountId, '85');
  assert.equal(limits.update_duration.allowed, false);
  assert.equal(limits.update_duration.remaining, 0);
  assert.equal(limits.update_budget.remaining, 0);
  const fourth = await request('85', { durationSeconds: 36000, expectedDurationSeconds: 32400 });
  assert.equal(fourth.status, 429);
  assert.equal(fourth.body.code, 'parameter_rate_limit');
  assert.equal(writes.length, 3);
});
