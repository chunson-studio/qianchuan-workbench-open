'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(require('./test-output.cjs').testOutputRoot(), 'home-split-test-'));
process.env.QC_RUNTIME_CONFIG_ROOT = root;
process.env.QC_RUNTIME_DATA_ROOT = root;
const config = require('../server-app/server/lib/config');
config.QIANCHUAN_ACCOUNTS.push({ id: 'cache_test', aavid: '12345' }, { id: 'another', aavid: '67890' });
const qc = require('../server-app/server/lib/qianchuan');
let gate, calls = 0, fail = false, cost = 10;
qc.statQuery = async (body, retries, account, opts) => {
  calls++;
  assert.ok(opts.signal);
  if (gate) await gate;
  if (fail) throw new Error('test unavailable');
  return { data: { StatsData: { Totals: { stat_cost_for_roi2: { ValueStr: String(cost) } }, Rows: [] } } };
};
const handle = require('../server-app/server/routes/homeSplit');
const date = require('../server-app/server/lib/utils').getLocalDateStr();
async function read(quick = true, account = 'cache_test', day = date) {
  let status, data;
  await handle({ method: 'GET' }, { writeHead(code) { status = code; }, end(text) { data = JSON.parse(text); } },
    new URL(`http://localhost/api/home-split?account=${account}&date=${day}${quick ? '&quick=1' : ''}`));
  return { status, data };
}
test('冷读者立即得到采集中，20 个读者只拉一轮，普通读者等待同一结果', async () => {
  let release;
  gate = new Promise(resolve => { release = resolve; });
  const pending = await Promise.all(Array.from({ length: 20 }, () => read()));
  assert.ok(pending.every(item => item.status === 202 && item.data.all === null && item.data.fetched_at === null));
  assert.equal(calls, 4);
  const waiting = read(false);
  release(); gate = null;
  const result = await waiting;
  assert.equal(result.status, 200);
  assert.equal(result.data.all.cost, 20);
  const cached = await read();
  assert.equal(cached.data.cached, true);
  assert.equal(cached.data.finalized, false);
  assert.equal(cached.data.fetched_at, result.data.fetched_at);
  assert.equal(calls, 4);
  assert.equal(fs.existsSync(path.join(config.CACHE_DIR, 'home-split', `cache_test_${date}.json`)), true);
});
test('陈旧快照立即可读，更新失败保留读数与来源时间，并退避重试', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const previous = (await read()).data;
  t.mock.timers.tick(61000);
  let release;
  gate = new Promise(resolve => { release = resolve; });
  fail = true;
  const stale = await read();
  assert.equal(stale.data.all.cost, previous.all.cost);
  assert.equal(stale.data.stale, true);
  assert.equal(stale.data.refreshing, true);
  assert.equal(stale.data.fetched_at, previous.fetched_at);
  release(); gate = null;
  await new Promise(resolve => setImmediate(resolve));
  const failed = await read();
  assert.equal(failed.data.all.cost, previous.all.cost);
  assert.equal(failed.data.refreshing, false);
  assert.ok(failed.data.refresh_error);
  const count = calls;
  await read();
  assert.equal(calls, count);
  fail = false;
});
test('账户和日期隔离，真零可以缓存，不继承其他账户的成交', async () => {
  cost = 0;
  const other = await read(false, 'another');
  assert.equal(other.data.all.cost, 0);
  assert.equal(other.data.account, 'another');
  const before = calls;
  const again = await read(true, 'another');
  assert.equal(again.data.all.cost, 0);
  assert.equal(calls, before);
  const historical = await read(false, 'another', '2026-09-01');
  assert.equal(historical.data.date, '2026-09-01');
  assert.equal(historical.data.finalized, true);
  assert.equal(calls, before + 4);
});


test('private baseline neither guesses values nor reads or writes runtime',t=>{
 const inspected=[];t.mock.method(fs,'readdirSync',p=>{inspected.push(p);throw Error('unexpected_io');});
 const out=require('../server-app/server/lib/flowBaseline').getFlowBaseline('synthetic');
 assert.equal(out.strategy_status,'not_included');assert.equal(out.sessions_used,null);assert.deepEqual(inspected,[]);
});
