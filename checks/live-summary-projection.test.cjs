'use strict';
require('./setup-runtime.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
fs.writeFileSync(path.join(process.env.QC_RUNTIME_CONFIG_ROOT, 'config.json'), JSON.stringify({
  qianchuan_accounts: [{ id: 'summary_fixture', aavid: '12345', cookieFile: 'unused.txt' }], accounts: [],
}));
const route = require('../server-app/server/routes');
const { buildAndPersist, projectSummary } = require('../server-app/server/routes/liveSummary')._test;
const ledger = require('../server-app/server/lib/decisionLedger');
const at = new Date().toISOString();
const dashboard = { account: 'summary_fixture', session_key: 'summary_fixture|room-1|2026-09-30 10:00:00',
  fetchedAt: at, server_time: at, liveCheckedAt: at, dataValid: true,
  live: { isLive: true, roomId: 'room-1', startTime: '2026-09-30 10:00:00' },
  today: { cost: 100, gmv: 1100, roi: 11, netGmv: 900, netRoi: 9, orderCount: 10 },
  boost_data_valid: true, boost_truncated: false, boost_source_at: at, boost_window: 'daily',
  boost_tasks: Array.from({ length: 15 }, (_, i) => ({ id: 'task-' + i, name: '椿-虚构追投-' + i,
    primary_ad_id: 'plan-1', status: i < 3 ? '投放中' : '已暂停', status_code: i < 3 ? 1 : 2,
    budget: 100, duration_seconds: 21600, duration_unit: 'seconds', duration_source: 'upstream.endTime-startTime',
    source_at: at, cost: 10, gmv: 90, net_roi: 9, order_count: 1,
    metric_roi_basis: { net_roi: 'platform_net_1h' },
    action_limits: { used: 0, remaining: 3 }, available_actions: { pause: { allowed: null, reason: 'write_preflight_required' } } })),
};
function request(url) {
  return new Promise(resolve => {
    const req = Object.assign(new EventEmitter(), { method: 'GET', url, headers: {}, socket: { remoteAddress: '127.0.0.1' } });
    const res = Object.assign(new EventEmitter(), { setHeader() {},
      writeHead(status) { this.status = status; this.headersSent = true; },
      end(text) { this.writableEnded = true; this.emit('finish'); resolve({ status: this.status, data: JSON.parse(text) }); } });
    route(req, res);
  });
}
test('摘要裁剪只影响出口，可信账本保留完整任务、质量和原快照身份', t => {
  const full = buildAndPersist('summary_fixture', dashboard, { getMaterialChanges: () => ({ top: [], exceptions: [] }) });
  assert.equal(full.snapshot_persisted, true);
  const before = JSON.stringify(full), small = projectSummary(full, false);
  assert.equal(JSON.stringify(full), before);
  assert.strictEqual(projectSummary(full), full);
  assert.equal(small.boosts_omitted, true); assert.equal(Object.hasOwn(small, 'boosts'), false);
  assert.equal(small.snapshot_id, full.snapshot_id);
  assert.deepEqual(small.boost_coverage, full.boost_coverage);
  assert.deepEqual(small.components, full.components);
  assert.deepEqual(small.meta, full.meta);
  assert.deepEqual(small.financial_checks, full.financial_checks);
  const stored = ledger.getSnapshot('summary_fixture', small.snapshot_id);
  assert.deepEqual(stored.boosts, full.boosts);
  assert.equal(stored.boosts.length, 15);
  const fullBytes = Buffer.byteLength(JSON.stringify(full)), smallBytes = Buffer.byteLength(JSON.stringify(small));
  assert.ok(smallBytes < fullBytes);
  t.diagnostic(JSON.stringify({ sample: '15 synthetic boost tasks', full_bytes: fullBytes, projected_bytes: smallBytes,
    reduction_percent: +(100 * (1 - smallBytes / fullBytes)).toFixed(2), measure: 'UTF-8 bytes, not tokens or cost', real_network_requests: 0 }));
});
test('真实路由接受0/1、默认完整；非法投影参数在取数前拒绝', async () => {
  const calls = [];
  global.fetch = async url => {
    const target = new URL(url); calls.push(target);
    assert.equal(target.searchParams.get('account'), 'summary_fixture');
    assert.equal(target.searchParams.get('room_id'), 'room-1');
    assert.equal(target.searchParams.get('start_time'), '2026-09-30 10:00:00');
    return { ok: true, json: async () => dashboard };
  };
  const scope = '/api/live-summary?account=summary_fixture&room_id=room-1&start_time=2026-09-30%2010%3A00%3A00';
  for (const suffix of ['', '&include_boosts=1']) {
    const full = await request(scope + suffix);
    assert.equal(full.status, 200); assert.equal(full.data.boosts.length, 15);
  }
  const small = await request(scope + '&include_boosts=0');
  assert.equal(small.status, 200); assert.equal(small.data.boosts_omitted, true);
  assert.equal(Object.hasOwn(small.data, 'boosts'), false);
  const before = calls.length;
  for (const value of ['false', '2', '']) {
    const bad = await request(scope + '&include_boosts=' + value);
    assert.equal(bad.status, 400); assert.equal(bad.data.code, 'invalid_include_boosts');
  }
  assert.equal(calls.length, before);
});
