'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const chrome = require('../tools/attach-qc-chrome.playwright.cjs');
const control = require('../tools/read-qc-control-raw.playwright.cjs');
const { readQianchuanControlBatch } = require('../tools/read-qc-control-batch.playwright.cjs');

function binding(room, overrides = {}) {
  return { page: { context() {}, url() {} }, room, browser_context_id: 'profile-' + room,
    advertiser_id: '10001', primary_ad_id: '20001', date: '2026-10-15', pool: '调控中', ...overrides };
}

test('wrong CDP profile is rejected before any raw read', async t => {
  const item = binding('A');
  t.mock.method(chrome, 'getChromePageTarget', async () => ({ browserContextId: 'other-profile', targetId: 'target-a' }));
  const read = t.mock.method(control, 'readQianchuanControlRaw', async () => { throw new Error('must not read'); });
  const result = await readQianchuanControlBatch([item]);
  assert.equal(read.mock.callCount(), 0);
  assert.equal(result.ok, false);
  assert.equal(result.results[0].error.code, 'chrome_profile_mismatch');
  assert.equal(result.results[0].state, 'unknown');
  assert.equal(Object.hasOwn(result.results[0], 'raw'), false);
});

test('one room failure retains the concurrently completed healthy room and original error', async t => {
  const first = binding('A'), second = binding('B');
  const specByPage = new Map([[first.page, first], [second.page, second]]);
  let releaseFirst;
  const firstWait = new Promise(resolve => { releaseFirst = resolve; });
  const called = [];
  t.mock.method(chrome, 'getChromePageTarget', async page => {
    const spec = specByPage.get(page);
    return { browserContextId: spec.browser_context_id, targetId: 'target-' + spec.room };
  });
  t.mock.method(control, 'readQianchuanControlRaw', async (page, spec) => {
    called.push(page);
    assert.deepEqual(spec, { advertiser_id: '10001', primary_ad_id: '20001', date: '2026-10-15', pool: '调控中' });
    if (page === first.page) {
      await firstWait;
      throw Object.assign(new Error('The control table is still loading'), { code: 'data_unavailable' });
    }
    releaseFirst();
    return { ok: true, complete: false, total: 12, visible_rows: 1, tasks: [{ task_id: '30001' }] };
  });
  const result = await readQianchuanControlBatch([first, second]);
  assert.equal(result.ok, false);
  assert.deepEqual(called, [first.page, second.page]);
  assert.equal(result.results[0].error.code, 'data_unavailable');
  assert.equal(result.results[0].phase, 'raw_read');
  assert.equal(result.results[0].state, 'unknown');
  assert.equal(Object.hasOwn(result.results[0], 'raw'), false);
  assert.equal(result.results[1].ok, true);
  assert.equal(result.results[1].target_id, 'target-B');
  assert.equal(result.results[1].raw.complete, false);
  assert.equal(result.results[1].raw.tasks[0].task_id, '30001');
  for (const observation of [result, ...result.results]) {
    assert.ok(Number.isFinite(Date.parse(observation.started_at)));
    assert.ok(Number.isFinite(Date.parse(observation.completed_at)));
    assert.ok(observation.elapsed_ms >= 0);
    assert.equal(observation.advertising_writes, 0);
  }
});

test('duplicate page, room alias or scope is rejected before browser access', async t => {
  const inspect = t.mock.method(chrome, 'getChromePageTarget', async () => { throw new Error('must not inspect'); });
  const read = t.mock.method(control, 'readQianchuanControlRaw', async () => { throw new Error('must not read'); });
  const first = binding('A');
  const cases = [
    binding('B', { page: first.page }),
    binding(undefined, { label: 'A' }),
    binding('B', { browser_context_id: first.browser_context_id }),
  ];
  for (const duplicate of cases) {
    await assert.rejects(readQianchuanControlBatch([first, duplicate]), { code: 'batch_binding_duplicate' });
  }
  assert.equal(inspect.mock.callCount(), 0);
  assert.equal(read.mock.callCount(), 0);
});

test('a profile or target change after reading discards data and never retries', async t => {
  const first = binding('A'), second = binding('B');
  const counts = new Map(), items = new Map([[first.page, first], [second.page, second]]);
  t.mock.method(chrome, 'getChromePageTarget', async page => {
    const count = (counts.get(page) || 0) + 1;
    counts.set(page, count);
    const item = items.get(page);
    return { browserContextId: count === 2 && page === first.page ? 'changed-profile' : item.browser_context_id,
      targetId: count === 2 && page === second.page ? 'changed-target' : 'target-' + item.room };
  });
  const read = t.mock.method(control, 'readQianchuanControlRaw', async () => ({ ok: true, complete: true, tasks: [] }));
  const result = await readQianchuanControlBatch([first, second]);
  assert.equal(read.mock.callCount(), 2);
  assert.deepEqual(result.results.map(item => item.error.code), ['chrome_profile_mismatch', 'chrome_target_changed']);
  for (const item of result.results) {
    assert.equal(item.state, 'unknown');
    assert.equal(Object.hasOwn(item, 'raw'), false);
  }
});

test('invalid per-room timeouts are rejected before browser access', async t => {
  const inspect = t.mock.method(chrome, 'getChromePageTarget', async () => { throw new Error('must not inspect'); });
  const read = t.mock.method(control, 'readQianchuanControlRaw', async () => { throw new Error('must not read'); });
  for (const perRoomTimeoutMs of [0, -1, 1.5, NaN, Infinity, '20', null]) {
    await assert.rejects(readQianchuanControlBatch([binding('A')], { perRoomTimeoutMs }), { code: 'batch_timeout_invalid' });
  }
  assert.equal(inspect.mock.callCount(), 0);
  assert.equal(read.mock.callCount(), 0);
});

test('a never-resolving room is bounded and retains the healthy room', { timeout: 2000 }, async t => {
  const first = binding('A'), second = binding('B');
  const items = new Map([[first.page, first], [second.page, second]]);
  t.mock.method(chrome, 'getChromePageTarget', async page => {
    const item = items.get(page);
    return { browserContextId: item.browser_context_id, targetId: 'target-' + item.room };
  });
  const healthy = { ok: true, complete: false, total: 12, visible_rows: 1, tasks: [{ task_id: '30001' }] };
  const read = t.mock.method(control, 'readQianchuanControlRaw', page =>
    page === first.page ? new Promise(() => {}) : Promise.resolve(healthy));
  const result = await readQianchuanControlBatch([first, second], { perRoomTimeoutMs: 30 });
  assert.ok(result.elapsed_ms < 1000, 'A stuck room must not hold the batch indefinitely');
  assert.equal(read.mock.callCount(), 2);
  assert.equal(result.ok, false);
  assert.equal(result.results[0].error.code, 'batch_room_timeout');
  assert.equal(result.results[0].error.name, 'TimeoutError');
  assert.equal(result.results[0].state, 'unknown');
  assert.equal(result.results[0].pending_read, true);
  assert.equal(result.results[0].phase, 'raw_read');
  assert.equal(Object.hasOwn(result.results[0], 'raw'), false);
  assert.equal(result.results[1].ok, true);
  assert.deepEqual(result.results[1].raw, healthy);
});

test('late initial profile metadata does not dispatch a raw read', { timeout: 2000 }, async t => {
  const item = binding('A');
  let release;
  const inspect = t.mock.method(chrome, 'getChromePageTarget', () => new Promise(resolve => { release = resolve; }));
  const read = t.mock.method(control, 'readQianchuanControlRaw', async () => { throw new Error('must not read'); });
  const result = await readQianchuanControlBatch([item], { perRoomTimeoutMs: 30 });
  const returned = JSON.stringify(result);
  assert.equal(result.results[0].phase, 'profile_before');
  assert.equal(result.results[0].error.code, 'batch_room_timeout');
  release({ browserContextId: item.browser_context_id, targetId: 'target-A' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(inspect.mock.callCount(), 1);
  assert.equal(read.mock.callCount(), 0);
  assert.equal(JSON.stringify(result), returned);
});

test('late raw success stays unknown and does not dispatch a final profile read', { timeout: 2000 }, async t => {
  const item = binding('A');
  let release;
  const inspect = t.mock.method(chrome, 'getChromePageTarget', async () =>
    ({ browserContextId: item.browser_context_id, targetId: 'target-A' }));
  const read = t.mock.method(control, 'readQianchuanControlRaw', () => new Promise(resolve => { release = resolve; }));
  const result = await readQianchuanControlBatch([item], { perRoomTimeoutMs: 30 });
  const returned = JSON.stringify(result);
  release({ ok: true, complete: true, tasks: [] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(inspect.mock.callCount(), 1);
  assert.equal(read.mock.callCount(), 1);
  assert.equal(result.results[0].ok, false);
  assert.equal(result.results[0].state, 'unknown');
  assert.equal(result.results[0].pending_read, true);
  assert.equal(result.results[0].error.code, 'batch_room_timeout');
  assert.equal(Object.hasOwn(result.results[0], 'raw'), false);
  assert.equal(JSON.stringify(result), returned);
});
