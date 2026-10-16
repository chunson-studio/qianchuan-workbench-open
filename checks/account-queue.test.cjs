'use strict';
require('./setup-runtime.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { enqueue } = require('../server-app/server/lib/qianchuan');
const { REQUEST_INTERVAL } = require('../server-app/server/lib/config');

test('冷却等待计入排队超时，过期任务绝不执行；其他账号独立推进', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  await enqueue(async () => 'seed', 'queue_expiry');
  let expiredCalls = 0;
  const expired = assert.rejects(enqueue(async () => { expiredCalls++; }, 'queue_expiry', { waitTimeoutMs: 100 }),
    error => ['queue_timeout', 'queue_wait_timeout'].includes(error.code) && error.timeoutMs === 100);
  assert.equal(await enqueue(async () => 'other-room', 'queue_independent'), 'other-room');
  t.mock.timers.tick(100);
  await expired;
  assert.equal(expiredCalls, 0);

  // 超时任务未发送，下一项仍遵守上一次真实请求留下的间隔。
  let nextCalls = 0;
  const next = enqueue(async () => { nextCalls++; return 'done'; }, 'queue_expiry');
  t.mock.timers.tick(REQUEST_INTERVAL - 101);
  await Promise.resolve();
  assert.equal(nextCalls, 0);
  t.mock.timers.tick(1);
  assert.equal(await next, 'done');
  assert.equal(expiredCalls, 0);
});

test('冷却后的执行拥有独立超时，不再受排队计时器影响', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  await enqueue(async () => 'seed', 'queue_execution');
  let finish;
  const started = new Promise(resolve => { finish = resolve; });
  const result = enqueue(async () => {
    finish();
    await new Promise(resolve => setTimeout(resolve, 300));
    return 'completed';
  }, 'queue_execution', { waitTimeoutMs: REQUEST_INTERVAL + 100, timeoutMs: 1000 });
  t.mock.timers.tick(REQUEST_INTERVAL);
  await started;
  t.mock.timers.tick(300);
  assert.equal(await result, 'completed');
});
