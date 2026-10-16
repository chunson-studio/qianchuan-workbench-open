'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkQianchuanApiParallel } = require('../tools/check-qc-api-parallel.cjs');
const bindings = ['1', '2'].map(n => ({ room: n, account_id: 'fixture_' + n, advertiser_id: n, primary_ad_id: '9' + n }));
const response = b => ({ status_code: 0, truncated: false,
  data: { adInfos: [{ id: b.primary_ad_id + '1', advId: b.advertiser_id }], pagination: { totalNum: '1' } } });
test('parallel benchmark preserves every account and nonempty result across three rounds', async () => {
  let inFlight = 0, peak = 0;
  const result = await checkQianchuanApiParallel({ bindings, date: '2026-10-15' }, { read: async b => {
    inFlight++; peak = Math.max(peak, inFlight); await new Promise(r => setTimeout(r, 1)); inFlight--; return response(b);
  } });
  assert.equal(result.ok, true); assert.equal(result.rounds.length, 3); assert.equal(peak, 2);
  assert.ok(result.rounds.every(r => r.rooms.every(x => x.task_count === 1 && x.platform_updated_at === null)));
});
test('one expired account is cancelled, stays unknown, preserves healthy account and prevents another round', async () => {
  let aborted = false;
  const result = await checkQianchuanApiParallel({ bindings, date: '2026-10-15', timeout_ms: 10 }, { read: async (b, signal) => {
    if (b.room === '1') return response(b);
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }));
  } });
  assert.equal(result.ok, false); assert.equal(result.rounds.length, 1); assert.equal(aborted, true);
  assert.equal(result.rounds[0].rooms[0].task_count, 1); assert.equal(result.rounds[0].rooms[1].task_count, null);
});
test('cross-account, partial and inconsistent-page results never become complete or empty', async () => {
  for (const kind of ['account', 'partial', 'pagination']) {
    const result = await checkQianchuanApiParallel({ bindings, date: '2026-10-15' }, { read: async b => {
      const r = response(b); if (kind === 'account') r.data.adInfos[0].advId = '999';
      if (kind === 'partial') r.truncated = true;
      if (kind === 'pagination') r.data.pagination.totalNum = '2'; return r;
    } });
    assert.equal(result.ok, false); assert.ok(result.rounds[0].rooms.every(r => r.task_count === null));
  }
});
test('real task-list implementation passes caller cancellation through its queue to HTTP', async () => {
  const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
  const filename = path.resolve(__dirname, '../server-app/server/lib/qianchuanTabs.js');
  const module = { exports: {} }, controller = new AbortController(), observed = [];
  const qc = {
    enqueue: async (fn, account, options) => { observed.push(options.signal); return fn(options.signal); },
    requestAPI: async (_method, _url, _body, _account, signal) => { observed.push(signal); return {
      status_code: 0, data: { adInfos: [], adStatsMap: {} } }; },
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, Date, URLSearchParams,
    console: { log() {}, warn() {}, error() {} },
    require(name) {
      if (name === 'fs') return { existsSync: () => true, promises: {} };
      if (name === 'path') return path;
      if (name === './utils') return {};
      if (name === './config') return { CACHE_DIR: 'fixture-cache' };
      if (name === './qianchuan') return qc;
      if (name === './cookie') return { resolveAavid: () => '1' };
      if (name === './db' || name === './creativeVideoLibrary') return {};
      throw Error('unexpected_dependency_' + name);
    },
  }, { filename });
  await module.exports.fetchBoostList('91', '2026-10-15', '2026-10-15', 'fixture', { signal: controller.signal });
  assert.deepEqual(observed, [controller.signal, controller.signal]);
});
