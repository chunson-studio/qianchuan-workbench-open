'use strict';
require('./setup-runtime.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
fs.writeFileSync(path.join(process.env.QC_RUNTIME_CONFIG_ROOT, 'config.json'), JSON.stringify({
  qianchuan_accounts: [{ id: 'advertiser_a', aavid: '12345', anchorId: 'wrong-account-anchor' }, { id: 'advertiser_b', aavid: '67890' }],
  manual_config: { break_even_roi: 99, avg_order_price: 999 },
  account_config: { advertiser_a: { break_even_roi: 88 } },
}));
const tabs = require('../server-app/server/lib/qianchuanTabs');
const board = require('../server-app/server/lib/liveBoard');
const start = '2026-09-27 10:00:00';
let rooms = [{ roomId: '111', startTime: start }, { roomId: '222', startTime: start }];
tabs.fetchLiveStatus = async () => ({ isLive: rooms.length > 0, rooms });
const coreCalls = [];
board.fetchLiveCore = async (roomId, anchorId, startTime, accountId) => {
  assert.equal(anchorId, undefined); // 不得借用账户上另一直播间的主播 ID。
  coreCalls.push({ roomId, startTime, accountId });
  const cost = (accountId === 'advertiser_a' ? 100 : 1000) + Number(roomId);
  return { core_only: true, anchorId: `anchor-${roomId}`, metrics: { source_at: new Date().toISOString(), rows: [{ Metrics: {
    stat_cost_for_roi2: { Value: cost }, total_order_settle_amount_realtime_for_roi2_1h: { Value: cost * 3 },
    total_order_settle_count_realtime_for_roi2_1h: { Value: 3 }, total_prepay_and_pay_settle_realtime_roi2_1h: { Value: 3 },
  } }] } };
};
const dashboard = require('../server-app/server/routes/liveDashboard');
const configRoute = require('../server-app/server/routes/config');
const { getAccountParams } = require('../server-app/server/lib/api-helpers');
const { readRoomDashboard } = require('../server-app/server/lib/liveRoomContext');
async function request(route, url, data) {
  let payload, status;
  const req = { method: data ? 'POST' : 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' }, _qcJsonBodyPromise: Promise.resolve({ data }) };
  await route(req, { writeHead(code) { status = code; }, end(text) { payload = JSON.parse(text); } }, new URL('http://local' + url));
  return { status, payload };
}

test('同广告账户两个直播间并发读取、切回和另一账户同房间 ID 都独立', async () => {
  const [a, b, other] = await Promise.all([
    readRoomDashboard('advertiser_a', '111'), readRoomDashboard('advertiser_a', '222'), readRoomDashboard('advertiser_b', '111'),
  ]);
  assert.equal(a.today.cost, 211);
  assert.equal(b.today.cost, 322);
  assert.equal(other.today.cost, 1111);
  assert.notEqual(a.session_key, b.session_key);
  assert.notEqual(a.session_key, other.session_key);
  assert.equal((await readRoomDashboard('advertiser_a', '111')).today.cost, 211);
  assert.equal(coreCalls.length, 3);
});

test('房间 ROI 参数独立保存并回读，缺失值不继承账号或全局阈值', async () => {
  for (const [room_id, value] of [['111', 2], ['222', 5]]) {
    const result = await request(configRoute, '/api/config', { account: 'advertiser_a', room_id, key: 'target_roi', value });
    assert.equal(result.status, 200);
  }
  const first = await request(dashboard, '/api/live-dashboard?account=advertiser_a&room_id=111');
  const second = await request(dashboard, '/api/live-dashboard?account=advertiser_a&room_id=222');
  assert.equal(first.payload.target_roi, 2);
  assert.equal(second.payload.target_roi, 5);
  assert.equal(first.payload.break_even_roi, null);
  assert.equal(getAccountParams('advertiser_b').break_even_roi, null);
  assert.equal(getAccountParams('advertiser_a', { roomId: '333' }).target_roi, null);
  const saved = JSON.parse(fs.readFileSync(path.join(process.env.QC_RUNTIME_CONFIG_ROOT, 'config.json'), 'utf8'));
  assert.equal(saved.account_config.advertiser_a.rooms['111'].target_roi, 2);
  assert.equal(saved.account_config.advertiser_a.rooms['222'].target_roi, 5);
});

test('多房间未指定目标时返回明确选择要求，不采集第一间；错房间或旧场次拒绝', async () => {
  const before = coreCalls.length;
  const result = await request(dashboard, '/api/live-dashboard?account=advertiser_a');
  assert.equal(result.status, 409);
  assert.equal(result.payload.code, 'live_room_required');
  assert.equal(result.payload.rooms.length, 2);
  assert.equal(coreCalls.length, before);
  await assert.rejects(readRoomDashboard('advertiser_a', '999'), { code: 'live_room_not_found' });
  await assert.rejects(readRoomDashboard('advertiser_a', '111', { startTime: '2026-09-26 10:00:00' }), { code: 'live_session_changed' });
  rooms = [{ roomId: '111', startTime: '2026-09-27 12:00:00' }, rooms[1]];
  const changed = await readRoomDashboard('advertiser_a', '111');
  assert.ok(changed.session_key.endsWith('2026-09-27 12:00:00'));
  assert.equal(coreCalls.length, before + 1);
});

test('同广告户多个房间按主计划选择独立动作与 ROI 淘汰规则', async () => {
  const { checkHttpWritePolicy, checkBoostElimination } = require('../server-app/server/lib/onboardingGuard');
  const { describeExecutionPolicy } = require('../server-app/server/lib/agentPolicy');
  const scopes = [
    { primary_ad_id: '11', room_id: '111', session_started_at: start, allowed_actions: ['update_roi'], elimination: { order_roi_below: 2 } },
    { primary_ad_id: '22', room_id: '222', session_started_at: start, allowed_actions: ['update_budget'], elimination: { order_roi_below: 5 } },
  ];
  const config = { qianchuan_accounts: [{ id: 'advertiser_a' }], agent_policy: { account_policies: { advertiser_a: { boost_write_scopes: scopes } } } };
  const data = { accountId: 'advertiser_a', primaryAdId: '11', assistTaskId: '99', roiGoal: 2 };
  const a = checkHttpWritePolicy(config, '/api/campaign/budget', data);
  assert.equal(a.allowed, true);
  assert.equal(a.binding.room_id, '111');
  assert.equal(checkHttpWritePolicy(config, '/api/campaign/budget', { ...data, primaryAdId: '22' }).code, 'action_outside_authorization');
  const b = checkHttpWritePolicy(config, '/api/campaign/budget', { ...data, primaryAdId: '22', roiGoal: undefined, budget: 130 });
  assert.equal(b.binding.room_id, '222');
  const metrics = { statCostForRoi2Assist: 50, totalPayOrderCountForRoi2Assist: 1, totalPrepayAndPayOrderRoi2Assist: 3 };
  assert.equal(checkBoostElimination(metrics, a.binding.elimination).allowed, false);
  assert.equal(checkBoostElimination(metrics, b.binding.elimination).allowed, true);
  assert.equal(describeExecutionPolicy(config.agent_policy, 'advertiser_a').boost_write_scopes.length, 2);
  scopes.push({ ...scopes[0] });
  assert.equal(checkHttpWritePolicy(config, '/api/campaign/budget', data).code, 'write_scope_ambiguous');
});

test('真实路由白名单、状态投影与摘要转发保留房间及场次绑定', async () => {
  const { EventEmitter } = require('node:events');
  const route = require('../server-app/server/routes');
  const routeRequest = url => new Promise(resolve => {
    const req = Object.assign(new EventEmitter(), { method: 'GET', url, headers: {}, socket: { remoteAddress: '127.0.0.1' } });
    const res = Object.assign(new EventEmitter(), {
      writeHead(status) { this.status = status; this.headersSent = true; }, setHeader() {},
      end(text) { this.writableEnded = true; this.emit('finish'); resolve({ status: this.status, payload: JSON.parse(text) }); },
    });
    route(req, res);
  });
  const selected = await routeRequest('/api/live-dashboard?account=advertiser_a&room_id=222&start_time=' + encodeURIComponent(start));
  assert.equal(selected.status, 200);
  assert.equal(selected.payload.today.cost, 322);
  const status = await routeRequest('/api/live-watch?account=advertiser_a&room_id=222&start_time=' + encodeURIComponent(start));
  assert.equal(status.status, 200);
  assert.equal(status.payload.accounts[0].room.room_id, '222');
  assert.equal(status.payload.accounts[0].dataValid, true);
  const { fetchDashboard } = require('../server-app/server/routes/liveSummary')._test;
  const data = await fetchDashboard('advertiser_a', { roomId: '222', startTime: start,
    fetchImpl: async url => {
      assert.equal(new URL(url).searchParams.get('room_id'), '222');
      assert.equal(new URL(url).searchParams.get('start_time'), start);
      return { ok: true, json: async () => selected.payload };
    } });
  const summary = require('../server-app/server/lib/mcpClean').buildLiveSummary(data);
  assert.equal(summary.live.room_id, '222');
  assert.equal(summary.threshold.target_roi, 5);
});
