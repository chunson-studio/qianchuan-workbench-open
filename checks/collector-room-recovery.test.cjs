'use strict';
require('./setup-runtime.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');
const account = 'recovery_room_test';
const start = '2026-09-30 09:30:00';
fs.writeFileSync(path.join(process.env.QC_RUNTIME_CONFIG_ROOT, 'config.json'), JSON.stringify({
  qianchuan_accounts: [{ id: account, aavid: '12345', cookieFile: 'unused.txt' }],
}));
const tabs = require('../server-app/server/lib/qianchuanTabs');
const board = require('../server-app/server/lib/liveBoard');
let rooms = [{ roomId: '111', startTime: start }, { roomId: '222', startTime: start }];
let statusReads = 0;
const coreReads = [];
tabs.fetchLiveStatus = async id => {
  assert.equal(id, account); statusReads++;
  return { isLive: rooms.length > 0, rooms: structuredClone(rooms) };
};
board.fetchLiveCore = async (roomId, anchorId, startTime, id) => {
  assert.equal(id, account); assert.equal(anchorId, undefined);
  coreReads.push({ roomId, startTime });
  return { core_only: true, anchorId: `anchor-${roomId}`, metrics: { source_at: new Date().toISOString(), rows: [{ Metrics: {
    stat_cost_for_roi2: { Value: 20 }, total_order_settle_amount_realtime_for_roi2_1h: { Value: 60 },
    total_order_settle_count_realtime_for_roi2_1h: { Value: 3 }, total_prepay_and_pay_settle_realtime_roi2_1h: { Value: 3 },
  } }] } };
};
const collector = require('../server-app/server/lib/liveCollector');
const route = require('../server-app/server/routes/collectorRecovery');
const httpBase = 'http://local';
const query = (room = '222', sessionStart = start) =>
  new URLSearchParams({ account, room_id: room, start_time: sessionStart }).toString();
async function routeRequest(apiPath, suffix = query(), method = 'GET') {
  let payload, status;
  const req = { method, headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  await route(req, { writeHead(value) { status = value; }, end(value) { payload = JSON.parse(value); } },
    new URL(`${httpBase}${apiPath}?${suffix}`));
  return { status, payload };
}
test('unselected multi-room health requires selection and never reads the first room', async () => {
  await collector.ensureLiveWatch(account);
  const result = await routeRequest('/health/data', `account=${account}`);
  assert.equal(result.payload.code, 'live_room_required');
  assert.equal(result.payload.restart_recommended, false);
  assert.equal(coreReads.length, 0);
});

test('selected health and recovery use the requested room without starting account-wide background work', async () => {
  const before = collector.getCollectorStatus().started_at;
  const health = await routeRequest('/health/data');
  assert.equal(health.status, 200);
  assert.equal(health.payload.ready, true);
  assert.equal(health.payload.room_id, '222');
  assert.equal(health.payload.start_time, start);
  assert.equal(health.payload.watch.room_id, '222');
  assert.equal(coreReads.at(-1).roomId, '222');
  const recovery = await routeRequest('/api/collector/recover', query('111'), 'POST');
  assert.equal(recovery.status, 200);
  assert.equal(recovery.payload.action, 'room_recollect');
  assert.equal(recovery.payload.watch.room_id, '111');
  assert.equal(coreReads.at(-1).roomId, '111');
  assert.equal(collector.getCollectorStatus().started_at, before);
});

test('missing pairs and invalid dates fail without choosing another room', async () => {
  const before = statusReads;
  for (const suffix of [`account=${account}&room_id=222`, `account=${account}&start_time=${encodeURIComponent(start)}`]) {
    const result = await routeRequest('/api/collector/recover', suffix, 'POST');
    assert.equal(result.status, 400);
    assert.equal(result.payload.code, 'session_binding_required');
    assert.equal(result.payload.restart_recommended, false);
  }
  const invalid = await routeRequest('/health/data', query('222', 'bad-date'));
  assert.equal(invalid.status, 400);
  assert.equal(invalid.payload.code, 'live_session_invalid');
  assert.equal(statusReads, before);
});

test('changed session is rejected and an ended target is never replaced by the remaining live room', async () => {
  const before = coreReads.length;
  rooms = [{ roomId: '111', startTime: start }, { roomId: '222', startTime: '2026-09-30 11:00:00' }];
  const changed = await routeRequest('/api/collector/recover', query(), 'POST');
  assert.equal(changed.status, 409);
  assert.equal(changed.payload.code, 'live_session_changed');
  assert.equal(changed.payload.ready, false);
  assert.equal(changed.payload.restart_recommended, false);
  assert.equal(coreReads.length, before);
  rooms = [rooms[0]];
  const ended = await routeRequest('/health/data');
  assert.equal(ended.status, 200);
  assert.equal(ended.payload.state, 'offline');
  assert.equal(ended.payload.watch.room_id, '222');
  assert.equal(ended.payload.watch.is_live, false);
  assert.equal(coreReads.length, before);
  rooms.push({ roomId: '222', startTime: start });
});

test('actual route query whitelist accepts recovery room and session fields', async () => {
  const router = require('../server-app/server/routes');
  const result = await new Promise(resolve => {
    const req = Object.assign(new EventEmitter(), { method: 'GET', url: `/health/data?${query()}`,
      headers: {}, socket: { remoteAddress: '127.0.0.1' } });
    const res = Object.assign(new EventEmitter(), { writeHead(code) { this.status = code; this.headersSent = true; },
      setHeader() {}, end(text) { this.writableEnded = true; this.emit('finish'); resolve({ status: this.status, payload: JSON.parse(text) }); } });
    router(req, res);
  });
  assert.equal(result.status, 200);
  assert.equal(result.payload.room_id, '222');
  assert.equal(result.payload.start_time, start);
});
