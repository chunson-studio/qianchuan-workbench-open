'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { runCreateRequest } = require('../server-app/server/lib/createRequest');
const payload = { primaryAdId: 'plan', budget: 100, liveFeed: true, duration: 18000 };
test('相同参数十次主动创建不被限制，同编号重试只回放原结果', async () => {
  const db = new DatabaseSync(':memory:');
  let calls = 0;
  const execute = async () => ({ status: 200, body: { ok: true, task_id: String(++calls) } });
  for (let i = 0; i < 10; i++) {
    const result = await runCreateRequest(db, 'a', `batch-task-${i}`, payload, execute);
    assert.equal(result.body.task_id, String(i + 1));
  }
  const replay = await runCreateRequest(db, 'a', 'batch-task-0', { duration: 18000, liveFeed: true, budget: 100, primaryAdId: 'plan' }, execute);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.task_id, '1');
  assert.equal(calls, 10);
  assert.equal((await runCreateRequest(db, 'a', 'batch-task-0', {...payload, budget: 200}, execute)).body.code, 'request_id_conflict');
  assert.equal(calls, 10);
  db.close();
});
test('并发重试和执行中断都不会再次调用上游；账户之间独立', async () => {
  const db = new DatabaseSync(':memory:');
  let release, calls = 0;
  const first = runCreateRequest(db, 'a', 'request-001', payload, async () => {
    calls++;
    await new Promise(resolve => { release = resolve; });
    throw new Error('connection_lost_after_submit');
  });
  assert.equal((await runCreateRequest(db, 'a', 'request-001', payload, () => { calls++; })).body.code, 'create_result_unconfirmed');
  release();
  await assert.rejects(first, /connection_lost/);
  assert.equal((await runCreateRequest(db, 'a', 'request-001', payload, () => { calls++; })).body.code, 'create_result_unconfirmed');
  assert.equal(calls, 1);
  assert.equal((await runCreateRequest(db, 'b', 'request-001', payload, async () => ({status:200,body:{ok:true}}))).body.ok, true);
  db.close();
});
test('错误请求编号在执行前拒绝，失败回执重试也不重复提交', async () => {
  const db = new DatabaseSync(':memory:');
  let calls = 0;
  const fail = async () => { calls++; return { status: 502, body: { ok: false, error: 'result_unknown' } }; };
  assert.equal((await runCreateRequest(db, 'a', '../bad', payload, fail)).status, 400);
  assert.equal(calls, 0);
  await runCreateRequest(db, 'a', 'request-failed', payload, fail);
  assert.equal((await runCreateRequest(db, 'a', 'request-failed', payload, fail)).status, 502);
  assert.equal(calls, 1);
  db.close();
});
