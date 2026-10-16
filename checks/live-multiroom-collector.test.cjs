'use strict';
require('./setup-runtime.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../server-app/server/lib/config');
const tabs = require('../server-app/server/lib/qianchuanTabs');
const board = require('../server-app/server/lib/liveBoard');
config.QIANCHUAN_ACCOUNTS.push({ id: 'background_multi', name: '测试多直播间' });
const rooms = [
  { roomId: '111', startTime: '2026-09-28 10:00:00' },
  { roomId: '222', startTime: '2026-09-28 10:30:00' },
];
let status = { isLive: true, rooms }, coreCalls = 0;
tabs.fetchLiveStatus = async () => status;
board.fetchLiveCore = async () => { coreCalls++; throw new Error('不得默认采集某一间'); };
const collector = require('../server-app/server/lib/liveCollector');

test('后台账户探测保留多个在播房间，异常不冒充下播或触发单间采集', async t => {
  const running = collector.startLiveCollector();
  t.after(() => running.stop());
  await new Promise(resolve => setImmediate(resolve));
  const current = () => collector.getLatestWatch().find(a => a.accountId === 'background_multi');
  assert.equal(current().isLive, true);
  assert.equal(current().status_stale, false);
  assert.equal(current().available_rooms.length, 2);
  assert.equal(current().room, null);
  assert.equal(collector.assessCollectorWatch(current()).restart_recommended, false);
  status = { isLive: true, rooms: [{ roomId: '111', startTime: 'invalid' }] };
  await running.recoverAccount('background_multi', { force: true });
  assert.equal(current().isLive, null);
  assert.equal(current().status_stale, true);
  status = { isLive: true, rooms };
  await running.recoverAccount('background_multi', { force: true });
  assert.equal(current().isLive, true);
  assert.equal(current().status_stale, false);
  assert.deepEqual(current().errors, []);
  assert.equal(coreCalls, 0);
});
