'use strict';

// Exercise the real adapter/queue with an in-memory HTTPS boundary. Never load
// the customer's config, credentials or qianchuanTabs network implementation.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const boostDuration = require('../server-app/server/lib/boostDuration');

const filename = path.resolve(__dirname, '../server-app/server/lib/qianchuan.js');
const source = fs.readFileSync(filename, 'utf8');
const accountId = 'fixture-account';
const currentSeconds = 6 * 3600;
const requestedSeconds = currentSeconds + 1800;

function harness(options = {}) {
  const start = Math.floor(Date.now() / 1000) - 3600;
  const task = { id: '77', budget: 10_000_000, smartBidType: 7,
    startTime: start, endTime: start + currentSeconds, ...options.task };
  const state = { writes: [], listReads: [], materialReads: 0, events: [], task,
    response: options.response || { status_code: 0, data: { results: [{ status: 2 }] } } };
  const fakeHttps = {
    Agent: class {},
    request(request, onResponse) {
      const record = { method: request.method, path: request.path, body: null };
      state.writes.push(record);
      state.events.push('write');
      const req = new EventEmitter();
      req.setTimeout = () => req;
      req.write = value => { record.body = JSON.parse(value); return true; };
      req.destroy = () => req;
      req.end = () => queueMicrotask(() => {
        const res = new EventEmitter();
        res.statusCode = 200;
        res.setEncoding = () => {};
        onResponse(res);
        res.emit('data', JSON.stringify(state.response));
        res.emit('end');
      });
      return req;
    },
  };
  const tabs = {
    async fetchBoostList(...args) {
      state.events.push('read');
      state.listReads.push(args);
      return { status_code: options.listCode ?? 0,
        data: { adInfos: options.rows || [state.task] } };
    },
    async fetchBoostMaterialDetail() {
      state.materialReads++;
      return { data: { StatsData: { Rows: [{ Dimensions: { material_id: { Value: 'fixture-material' } } }] } } };
    },
  };
  const fixtureIdentity = id => { assert.equal(id, accountId); return '424242'; };
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, exports: module.exports,
    require(name) {
      if (name === 'https') return fakeHttps;
      if (name === './config') return { AAVID: '424242', GFVERSION: 'fixture', REQUEST_INTERVAL: 0 };
      if (name === './cookie') return {
        resolveAavid: fixtureIdentity,
        readQcCookie: id => { fixtureIdentity(id); return 'fixture-cookie-only'; },
        getCsrf: () => 'fixture-csrf-only',
      };
      if (name === './qianchuanTabs') return tabs;
      if (name === './boostDuration') return boostDuration;
      throw new Error('Unexpected dependency in isolated transport test: ' + name);
    },
    console: { log() {}, warn() {}, error() {} },
    process: { env: {} }, Date, Buffer, AbortController, structuredClone,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
  }, { filename });
  state.update = (budget, roiGoal, opts = {}, assistTaskId = '77') =>
    module.exports.updateCampaignBudgetAndROI('88', assistTaskId, budget, roiGoal, accountId, opts);
  state.duration = (opts = {}) => state.update(undefined, undefined, {
    durationSeconds: requestedSeconds, expectedDurationSeconds: currentSeconds, ...opts,
  });
  return state;
}

async function rejectWithoutWrite(state, operation, code) {
  await assert.rejects(operation, error => {
    assert.equal(error.code, code);
    assert.equal(error.advertising_writes, 0);
    assert.equal(error.skipOpLog, true);
    return true;
  });
  assert.equal(state.writes.length, 0);
  assert.equal(state.materialReads, 0);
}

test('budget-only edit uses the PMC partial endpoint and yuan-to-micro conversion without Mids', async () => {
  const state = harness();
  const result = await state.update(200, undefined, { expectedBudget: 100 });
  assert.equal(result.data.results[0].status, 2);
  assert.equal(result.confirmation_pending, undefined);
  assert.equal(state.writes.length, 1);
  assert.deepEqual(state.writes[0], {
    method: 'POST', path: '/ad/api/pmc/v1/batch_update_budget?aavid=424242',
    body: { ForceAsync: false, AdsData: [{ AdId: '77', AdBudget: 20_000_000 }] },
  });
  assert.equal(state.materialReads, 0);
  assert.equal(state.listReads.length, 1);
  assert.equal(state.listReads[0][0], '88');
  assert.equal(state.listReads[0][3], accountId);
  assert.equal(state.listReads[0][4].includeAllStatus, true);
});

test('budget adapter preserves optional expectedBudget compatibility and rejects malformed amounts', async () => {
  const compatible = harness();
  await compatible.update('200.01', undefined);
  assert.equal(compatible.writes[0].body.AdsData[0].AdBudget, 20_001_000);
  for (const budget of [0, -1, Infinity, NaN, true, '', '200bad', Number.MAX_SAFE_INTEGER]) {
    const state = harness();
    await rejectWithoutWrite(state, () => state.update(budget, undefined), 'invalid_budget');
  }
});

test('duration is the total since original start, with STARTEND=2 and no unrelated replacement fields', { timeout: 5000 }, async () => {
  const state = harness({ task: { deliverySeconds: 0 } });
  const result = await state.duration();
  assert.equal(result.data.results[0].status, 2);
  assert.deepEqual(state.writes, [{ method: 'POST',
    path: '/ad/api/pmc/v1/batch_update_schedule_type?aavid=424242',
    body: { ForceAsync: false, AdsData: [{ AdId: '77',
      Schedule: { ScheduleType: 2, EndTime: state.task.startTime + requestedSeconds } }] },
  }]);
  assert.equal(state.listReads.length, 1);
  assert.equal(state.materialReads, 0);
});

test('invalid duration ranges, steps, expected values, absent task and mixed edits cause zero writes', async () => {
  for (const durationSeconds of [0, 1799, 1801, 86401, Infinity, NaN, '23400', true]) {
    const state = harness();
    await rejectWithoutWrite(state, () => state.duration({ durationSeconds }), 'invalid_duration');
  }
  for (const expectedDurationSeconds of [undefined, null, 0, -1, 21600.5, '21600']) {
    const state = harness();
    await rejectWithoutWrite(state, () => state.duration({ expectedDurationSeconds }), 'invalid_duration');
  }
  const noTarget = harness();
  await rejectWithoutWrite(noTarget, () => noTarget.update(undefined, undefined, {
    durationSeconds: requestedSeconds, expectedDurationSeconds: currentSeconds,
  }, null), 'invalid_duration');
  const noRequested = harness();
  await rejectWithoutWrite(noRequested, () => noRequested.update(undefined, undefined, {
    expectedDurationSeconds: currentSeconds,
  }), 'invalid_duration');
  for (const extra of [{ budget: 200 }, { roi: 2 }, { bid: 5 },
    { audienceTemplate: 'fixture' }, { audience: {} }, { expectedBudget: 100 }]) {
    const state = harness();
    const { budget, roi, ...opts } = extra;
    await rejectWithoutWrite(state, () => state.update(budget, roi, {
      durationSeconds: requestedSeconds, expectedDurationSeconds: currentSeconds, ...opts,
    }), 'mixed_duration_update_not_supported');
  }
});

test('fresh budget/duration conflicts and unavailable budget evidence reject before transport', async () => {
  const budget = harness({ task: { budget: 30_000_000 } });
  await rejectWithoutWrite(budget, () => budget.update(200, undefined, { expectedBudget: 100 }), 'budget_conflict');
  assert.equal(budget.listReads.length, 1);
  const duration = harness();
  duration.task.endTime += 1800;
  await rejectWithoutWrite(duration, () => duration.duration(), 'duration_conflict');
  for (const value of [undefined, null, 0, 'unknown']) {
    const state = harness({ task: { budget: value } });
    await rejectWithoutWrite(state, () => state.update(200, undefined, { expectedBudget: 100 }), 'target_parameter_unavailable');
  }
});

test('duration requires finite NO_BID schedule and rejects ambiguous or contradictory readback', async () => {
  for (const smartBidType of [undefined, null, 0, 106, 'unknown']) {
    const state = harness({ task: { smartBidType } });
    await rejectWithoutWrite(state, () => state.duration(), 'duration_mode_not_supported');
  }
  for (const task of [{ startTime: undefined }, { endTime: undefined },
    { startTime: 'bad' }, { startTime: true }, { endTime: 0 },
    { duration_seconds: currentSeconds + 1800 }]) {
    const state = harness({ task });
    await rejectWithoutWrite(state, () => state.duration(), 'duration_unavailable');
  }
  const ended = harness({ task: { startTime: Math.floor(Date.now() / 1000) - 10 * 3600 } });
  ended.task.endTime = ended.task.startTime + currentSeconds;
  await rejectWithoutWrite(ended, () => ended.duration(), 'duration_end_in_past');
});

test('duration accepts the verified 0.5h and 24h boundaries', async () => {
  for (const durationSeconds of [1800, 86400]) {
    const state = harness();
    state.task.startTime = Math.floor(Date.now() / 1000) - 60;
    state.task.endTime = state.task.startTime + currentSeconds;
    await state.duration({ durationSeconds });
    assert.equal(state.writes[0].body.AdsData[0].Schedule.EndTime, state.task.startTime + durationSeconds);
  }
});

test('failed list, duplicate identity and platform edit block reject both partial operations', async () => {
  for (const kind of ['budget', 'duration']) {
    const states = [
      [harness({ listCode: 40002 }), 'target_verification_failed'],
      [harness({ rows: [{ id: '77' }, { id: '77' }] }), 'target_verification_failed'],
      [harness({ task: { assistTaskInfoMap: { '2': { operation: { edit: { editable: false } } } } } }), 'upstream_action_blocked'],
    ];
    for (const [state, code] of states) {
      await rejectWithoutWrite(state, () => kind === 'budget'
        ? state.update(200, undefined, { expectedBudget: 100 }) : state.duration(), code);
    }
  }
});

test('owner is checked after the fresh list and immediately before the only write', async () => {
  for (const kind of ['budget', 'duration']) {
    const state = harness();
    const ownerError = Object.assign(new Error('fixture owner stopped'), {
      code: 'execution_owner_stopped', skipOpLog: true, advertising_writes: 0,
    });
    const beforeWrite = () => { state.events.push('owner'); throw ownerError; };
    await rejectWithoutWrite(state, () => kind === 'budget'
      ? state.update(200, undefined, { expectedBudget: 100, beforeWrite })
      : state.duration({ beforeWrite }), 'execution_owner_stopped');
    assert.deepEqual(state.events, ['read', 'owner']);
    state.events.length = 0;
    const acceptOwner = () => { state.events.push('owner'); };
    if (kind === 'budget') await state.update(200, undefined, { expectedBudget: 100, beforeWrite: acceptOwner });
    else await state.duration({ beforeWrite: acceptOwner });
    assert.deepEqual(state.events, ['read', 'owner', 'write']);
  }
});

test('batch per-item failure is rejected, while running/missing/unknown states stay unconfirmed', async () => {
  for (const kind of ['budget', 'duration']) {
    const perform = state => kind === 'budget' ? state.update(200, undefined, { expectedBudget: 100 }) : state.duration();
    const failed = harness({ response: { status_code: 0,
      data: { results: [{ status: 3, error: { errorMessage: 'fixture platform refusal' } }] } } });
    await assert.rejects(() => perform(failed), error => {
      assert.equal(error.code, 'batch_update_rejected');
      assert.equal(error.statusCode, 409);
      assert.equal(error.upstream_rejected, true);
      assert.equal(error.message, 'fixture platform refusal');
      return true;
    });
    assert.equal(failed.writes.length, 1);
    for (const data of [undefined, {}, { results: [] }, { results: [{ status: 1 }] },
      { results: [{ status: 0 }] }, { results: [{ status: '2' }] },
      { results: [{ status: 2 }, { status: 2 }] }]) {
      const state = harness({ response: { status_code: 0, data } });
      const result = await perform(state);
      assert.equal(result.status_code, 0);
      assert.equal(result.confirmation_pending, true);
      assert.ok(result.confirmation_reason);
      assert.equal(state.writes.length, 1);
    }
    const topFailure = harness({ response: { status_code: 40002, message: 'fixture top-level refusal' } });
    const result = await perform(topFailure);
    assert.equal(result.status_code, 40002);
    assert.equal(result.message, 'fixture top-level refusal');
    assert.equal(result.confirmation_pending, undefined);
    assert.equal(topFailure.writes.length, 1);
  }
});

test('mixed budget/ROI edits retain the existing full-update endpoint and preserved settings', async () => {
  const state = harness({ task: { smartBidType: 0, ecpRoi2Goal: 2, deepExternalAction: 576,
    audience: { CityDivide: 0 }, name: 'fixture full update', externalAction: 169 } });
  await state.update(200, 2.1, { expectedBudget: 100 });
  assert.equal(state.writes.length, 1);
  assert.match(state.writes[0].path, /^\/ad\/api\/pmc\/v1\/uni-promotion\/ad\/update-uni-prom-assist-task\?/);
  assert.equal(state.materialReads, 1);
  const body = state.writes[0].body;
  assert.equal(body.Budget, 20_000_000);
  assert.equal(body.EcpRoi2Goal, 2.1);
  assert.equal(body.SmartBidType, 0);
  assert.equal(body.DeepExternalAction, 576);
  assert.deepEqual(body.Audience, { CityDivide: 0 });
  assert.deepEqual(body.Mids, ['fixture-material']);
});
