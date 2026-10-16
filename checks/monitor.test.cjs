'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { parseArgs, run } = require('../tools/monitor.cjs');
const NOW = Date.parse('2026-09-14T10:06:00Z');

function response(value, status = 200) { return { ok: status >= 200 && status < 300, status, json: async () => value }; }
function harness(sequence, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-monitor-'));
  const calls = [];
  const queue = [...sequence];
  const fetch = async url => {
    calls.push(url);
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return response(next.value, next.status);
  };
  const launcher = { verifyHealth: () => true };
  const connection = { baseUrl: 'http://127.0.0.1:19999', env: { QC_RUNTIME_DATA_ROOT: path.join(root, 'runtime') } };
  return { root, calls, fetch, launcher, connection, acquireLock: async () => ({ release: async () => {} }), ...options };
}

test('默认只执行一次，未开播时不请求大屏', async () => {
  const h = harness([
    { value: { ok: true } },
    { value: { ok: true, accounts: [{ id: '12345' }] } },
    { value: { ok: true, partial: false, errors: [], isLive: false } },
  ]);
  const out = await run({ ...h, cli: parseArgs(['--once', '--json']) });
  assert.equal(out.reports.length, 1);
  assert.equal(out.result.state, 'not_live');
  assert.equal(out.result.should_notify, false);
  assert.equal(out.result.changes[0].kind, 'baseline');
  assert.equal(h.calls.some(url => url.includes('live-dashboard')), false);
});

test('0 个或多个账户要求输入，不猜账户', async () => {
  for (const accounts of [[], [{ id: '1' }, { id: '2' }]]) {
    const h = harness([{ value: { ok: true } }, { value: { ok: true, accounts } }]);
    const out = await run({ ...h, cli: parseArgs(['--once']) });
    assert.equal(out.result.state, 'needs_input');
    assert.equal(out.result.account_id, null);
    assert.equal(out.exitCode, 1);
  }
});

test('dataValid=true 但大屏陈旧或缺来源时间仍保持无效，且不把缺失值补零', async () => {
  const h = harness([
    { value: { ok: true } },
    { value: { ok: true, accounts: [{ id: '12345' }] } },
    { value: { ok: true, partial: false, errors: [], isLive: true } },
    { value: { ok: true, dataValid: true, stale: true, partial: false, fetchedAt: '2026-09-14T10:05:30Z', today: { roi: null }, errors: [] } },
  ]);
  const out = await run({ ...h, now: NOW, cli: parseArgs(['--once']) });
  assert.equal(out.result.state, 'partial');
  assert.equal(out.result.data_valid, false);
  assert.equal(out.result.source_at, '2026-09-14T10:05:30Z');
  assert.equal(out.result.errors[0].code, 'dashboard_stale');
  const saved = JSON.parse(fs.readFileSync(path.join(h.root, 'runtime', 'monitor', '12345', 'latest.json'), 'utf8'));
  assert.equal(saved.snapshot.roi, null);
  assert.equal(saved.snapshot.cost, null);

  const missing = harness([
    { value: { ok: true } }, { value: { ok: true, accounts: [{ id: '12345' }] } },
    { value: { ok: true, partial: false, errors: [], isLive: true } },
    { value: { ok: true, dataValid: true, partial: false, errors: [], today: { cost: 10 } } },
  ]);
  const missingOut = await run({ ...missing, now: NOW, cli: parseArgs(['--once']) });
  assert.equal(missingOut.result.data_valid, false);
  assert.equal(missingOut.result.errors[0].code, 'source_time_missing');

  const future = harness([
    { value: { ok: true } }, { value: { ok: true, accounts: [{ id: '12345' }] } },
    { value: { ok: true, partial: false, errors: [], isLive: true } },
    { value: { ok: true, dataValid: true, partial: false, errors: [], fetchedAt: '2026-09-14T10:08:00Z', today: { cost: 10 } } },
  ]);
  const futureOut = await run({ ...future, now: NOW, cli: parseArgs(['--once']) });
  assert.equal(futureOut.result.errors[0].code, 'source_in_future');
});

test('跨轮只报告变化，首次基线和无变化不通知', async () => {
  const h = harness([
    { value: { ok: true } },
    { value: { ok: true, accounts: [{ id: '12345' }] } },
    { value: { ok: true, partial: false, errors: [], isLive: true } },
    { value: { ok: true, dataValid: true, partial: false, errors: [], fetchedAt: '2026-09-14T10:02:00Z', today: { cost: 10, roi: 2 }, live: { rooms: [{ roomId: 'r1' }] } } },
    { value: { ok: true, partial: false, errors: [], isLive: true } },
    { value: { ok: true, dataValid: true, partial: false, errors: [], fetchedAt: '2026-09-14T10:02:00Z', today: { cost: 10, roi: 2 }, live: { rooms: [{ roomId: 'r1' }] } } },
    { value: { ok: true, partial: false, errors: [], isLive: true } },
    { value: { ok: true, dataValid: true, partial: false, errors: [], fetchedAt: '2026-09-14T10:05:00Z', today: { cost: 20, roi: 1.8 }, live: { rooms: [{ roomId: 'r1' }] } } },
  ]);
  const out = await run({ ...h, now: NOW, cli: parseArgs(['--loop', '--interval-seconds', '60', '--max-rounds', '3']), sleep: async () => {} });
  assert.equal(out.reports[0].should_notify, false);
  assert.equal(out.reports[1].should_notify, false);
  assert.equal(out.reports[2].should_notify, true);
  assert.ok(out.reports[2].changes.some(change => change.field === 'cost' && change.to === 20));
});

test('连续失败三次停止且轮次不重叠', async () => {
  let active = 0, maxActive = 0;
  let failureNumber = 0;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-monitor-fail-'));
  const fetch = async url => {
    active += 1; maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setImmediate(resolve));
    active -= 1;
    if (url.endsWith('/health/live')) return response({ ok: true });
    if (url.endsWith('/api/onboarding')) return response({ ok: true, accounts: [{ id: '12345' }] });
    failureNumber += 1;
    throw new Error(`upstream down at ${failureNumber}`);
  };
  const out = await run({
    root, fetch, launcher: { verifyHealth: () => true },
    connection: { baseUrl: 'http://127.0.0.1:19999', env: { QC_RUNTIME_DATA_ROOT: path.join(root, 'runtime') } },
    acquireLock: async () => ({ release: async () => {} }), sleep: async () => {},
    cli: parseArgs(['--loop', '--interval-seconds', '60', '--max-rounds', '9']),
  });
  assert.equal(out.reports.length, 3);
  assert.equal(out.exitCode, 1);
  assert.equal(maxActive, 1);
  assert.equal(out.reports[0].should_notify, true);
  assert.equal(out.reports[1].should_notify, false);
  assert.equal(out.reports[2].should_notify, true);
  assert.match(out.result.next_step, /连续失败 3 次/);
});

test('并发锁失败时不调用任何 HTTP', async () => {
  let fetched = false;
  const h = harness([], { fetch: async () => { fetched = true; } });
  const out = await run({ ...h, acquireLock: async () => { throw Object.assign(new Error('已有监控进程正在运行。'), { code: 'monitor_busy' }); }, cli: parseArgs(['--once']) });
  assert.equal(out.result.state, 'busy');
  assert.equal(out.exitCode, 1);
  assert.equal(fetched, false);
});

test('健康端口身份不属于本项目时停止，不能继续读账户', async () => {
  const h = harness([{ value: { ok: true, component: 'other_service' } }]);
  const out = await run({ ...h, launcher: { verifyHealth: () => false }, cli: parseArgs(['--once']) });
  assert.equal(out.result.state, 'unhealthy');
  assert.equal(out.exitCode, 1);
  assert.equal(h.calls.length, 1);
  assert.match(out.result.errors[0].message, /不是本项目/);
  assert.equal(out.result.should_notify, true);
  assert.equal(out.result.paused, true);
});

test('缺少配置统一返回 needs_setup，参数拒绝未知项、缺值和越界间隔', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-monitor-missing-'));
  const out = await run({ root, args: ['--once', '--json'] });
  assert.equal(out.result.state, 'needs_setup');
  assert.equal(out.result.errors[0].code, 'setup_required');
  assert.match(out.result.next_step, /tools\/setup\.cjs/);
  for (const args of [
    ['--unknown'], ['--account-id'], ['--loop', '--interval-seconds', '59'],
    ['--loop', '--interval-seconds', '86401'], ['--max-rounds'],
  ]) assert.throws(() => parseArgs(args));
});

test('外部定时每次新进程执行一轮时仍累计失败，第二次静默、第三次提示暂停', async () => {
  const sequence = [];
  for (let i = 0; i < 3; i++) sequence.push(
    { value: { ok: true } },
    { value: { ok: true, accounts: [{ id: '12345' }] } },
    { value: { ok: false, code: 'cookie_expired', error: '需要重新登录' }, status: 401 },
  );
  const h = harness(sequence);
  const results = [];
  for (let i = 0; i < 3; i++) results.push((await run({ ...h, cli: parseArgs(['--once', '--json']) })).result);
  assert.deepEqual(results.map(r => r.consecutive_failures), [1, 2, 3]);
  assert.deepEqual(results.map(r => r.should_notify), [true, false, true]);
  assert.equal(results[2].paused, true);
});

test('长循环只在内存保留最近 20 轮', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-monitor-bounded-'));
  let emitted = 0;
  const fetch = async url => {
    if (url.endsWith('/health/live')) return response({ ok: true });
    if (url.endsWith('/api/onboarding')) return response({ ok: true, accounts: [{ id: '12345' }] });
    return response({ ok: true, partial: false, errors: [], isLive: false });
  };
  const out = await run({
    root, fetch, launcher: { verifyHealth: () => true },
    connection: { baseUrl: 'http://127.0.0.1:19999', env: { QC_RUNTIME_DATA_ROOT: path.join(root, 'runtime') } },
    acquireLock: async () => ({ release: async () => {} }), sleep: async () => {}, onReport: () => { emitted += 1; },
    cli: parseArgs(['--loop', '--interval-seconds', '60', '--max-rounds', '25']),
  });
  assert.equal(emitted, 25, JSON.stringify(out.result));
  assert.equal(out.reports.length, 20);
  assert.equal(out.result.state, 'not_live');
});
