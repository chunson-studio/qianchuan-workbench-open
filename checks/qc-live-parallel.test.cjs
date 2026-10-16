'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const chrome = require('../tools/attach-qc-chrome.playwright.cjs');
const batch = require('../tools/read-qc-control-batch.playwright.cjs');
const modulePath = require.resolve('../tools/check-qc-live-parallel.cjs');

function loadChecker(getTarget, readBatch) {
  const originalTarget = chrome.getChromePageTarget, originalBatch = batch.readQianchuanControlBatch;
  const cached = require.cache[modulePath];
  try {
    chrome.getChromePageTarget = getTarget;
    batch.readQianchuanControlBatch = readBatch;
    delete require.cache[modulePath];
    return require(modulePath).checkQianchuanLiveParallel;
  } finally {
    chrome.getChromePageTarget = originalTarget;
    batch.readQianchuanControlBatch = originalBatch;
    if (cached) require.cache[modulePath] = cached;
    else delete require.cache[modulePath];
  }
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function binding(index, { reload } = {}) {
  const calls = { reload: 0, waits: 0, target: 0 };
  const advertiser_id = String(10000 + index), primary_ad_id = String(20000 + index);
  const url = `https://qianchuan.jinritemai.com/uni-prom/detail?aavid=${advertiser_id}&adId=${primary_ad_id}`;
  const page = {
    url: () => url,
    context: () => ({}),
    async reload() { calls.reload++; if (reload) await reload(); },
    getByText() { return {
      filter() { return this; },
      async waitFor() { calls.waits++; },
      async count() { return 1; },
    }; },
  };
  const value = { page, room: 'room-' + index, browser_context_id: 'profile-' + index,
    advertiser_id, primary_ad_id, date: '2026-10-15', pool: '调控中' };
  const target = { targetId: 'target-' + index, browserContextId: value.browser_context_id, url };
  return { value, page, calls, target };
}

function batchRecorder() {
  const calls = [];
  return { calls, async read(bindings, options) {
    calls.push({ rooms: bindings.map(item => item.room), options });
    return { ok: true, results: bindings.map(item => ({ room: item.room, ok: true, raw: { complete: true } })) };
  } };
}

const limits = { rounds: 3, refreshTimeoutMs: 35, readyTimeoutMs: 35, perRoomTimeoutMs: 10 };

test('a permanently hung pre-refresh target check reaches its deadline while preserving healthy rooms', { timeout: 2000 }, async () => {
  const stuck = binding(1), healthy = binding(2), recorder = batchRecorder();
  const check = loadChecker(async page => {
    if (page === stuck.page) return new Promise(() => {});
    return healthy.target;
  }, recorder.read);
  const result = await check([stuck.value, healthy.value], limits);
  assert.equal(result.ok, false);
  assert.equal(result.completed_rounds, 1);
  assert.equal(result.stopped_early, true);
  const [failed, ready] = result.rounds[0].refresh;
  assert.equal(failed.phase, 'profile_before');
  assert.equal(failed.state, 'unknown');
  assert.equal(failed.pending_refresh, true);
  assert.equal(failed.operation_cancelled, false);
  assert.equal(failed.error.code, 'refresh_deadline_exceeded');
  assert.equal(ready.ok, true);
  assert.equal(stuck.calls.reload, 0);
  assert.equal(healthy.calls.reload, 1);
  assert.deepEqual(recorder.calls.map(item => item.rooms), [['room-2']]);
  assert.equal(result.rounds[0].batch.results[0].raw.complete, true);
});

test('a target check that resolves after the reported deadline cannot dispatch a late reload', { timeout: 2000 }, async () => {
  const late = deferred(), room = binding(1), recorder = batchRecorder();
  const check = loadChecker(() => late.promise, recorder.read);
  const result = await check([room.value], limits);
  assert.equal(result.rounds[0].refresh[0].error.code, 'refresh_deadline_exceeded');
  late.resolve(room.target);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(room.calls.reload, 0);
  assert.equal(room.calls.waits, 0);
  assert.equal(recorder.calls.length, 0);
});

test('a late reload completion cannot begin readiness waits or claim the in-flight reload was cancelled', { timeout: 2000 }, async () => {
  const late = deferred(), room = binding(1, { reload: () => late.promise }), recorder = batchRecorder();
  const check = loadChecker(async () => room.target, recorder.read);
  const result = await check([room.value], limits);
  const failed = result.rounds[0].refresh[0];
  assert.equal(failed.phase, 'refresh');
  assert.equal(failed.pending_refresh, true);
  assert.equal(failed.operation_cancelled, false);
  assert.equal(room.calls.reload, 1);
  late.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(room.calls.reload, 1);
  assert.equal(room.calls.waits, 0);
  assert.equal(recorder.calls.length, 0);
});

test('the post-refresh target check shares the same bounded deadline and cannot stall the whole round', { timeout: 2000 }, async () => {
  const room = binding(1), recorder = batchRecorder();
  let checks = 0;
  const check = loadChecker(async () => ++checks === 1 ? room.target : new Promise(() => {}), recorder.read);
  const result = await check([room.value], limits);
  const failed = result.rounds[0].refresh[0];
  assert.equal(failed.phase, 'profile_after');
  assert.equal(failed.state, 'unknown');
  assert.equal(failed.pending_refresh, true);
  assert.equal(room.calls.reload, 1);
  assert.equal(room.calls.waits, 4);
  assert.equal(recorder.calls.length, 0);
  assert.equal(result.completed_rounds, 1);
});
