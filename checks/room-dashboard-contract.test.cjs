'use strict';
require('./setup-runtime.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
fs.writeFileSync(path.join(process.env.QC_RUNTIME_CONFIG_ROOT, 'config.json'), JSON.stringify({
  qianchuan_accounts: [{ id: 'room_contract_a', aavid: '12345' }, { id: 'room_contract_b', aavid: '67890' }],
}));
const { cleanLiveDashboard, buildLiveSummary } = require('../server-app/server/lib/mcpClean');
const { selectRoomPlan, readRoomDashboard } = require('../server-app/server/lib/liveRoomContext');
const tabs = require('../server-app/server/lib/qianchuanTabs');
const board = require('../server-app/server/lib/liveBoard');
const plans = require('../server-app/server/lib/chengfangLive');
const sourceAt = new Date().toISOString();
const start = '2026-09-28 10:00:00';
const raw = {
  account: 'room_contract_a', session_key: `room_contract_a|111|${start}`, dataValid: true,
  fetchedAt: sourceAt, server_time: sourceAt, component_times: { core: { source_at: sourceAt } },
  live: { isLive: true, rooms: [{ roomId: '111', startTime: start }] },
  live_metrics: { online: 0, watchUcount: 4423, gpm: 1098.58, watchToPayRate: 2.6, showToWatchRate: 22.99, orderCost: null },
  today: { cost: 10, netGmv: 50, netRoi: 5, orderCount: 2 },
  partial: true, missing_components: ['plan', 'boost', 'funnel'],
  boost_data_valid: false, boost_coverage: { complete: false, reason: 'primary_plan_ambiguous' },
};

test('摘要和详情保留前端核心经营指标、真实零值、单位和来源，不伪造完整漏斗', () => {
  const before = JSON.stringify(raw);
  const detail = cleanLiveDashboard(raw), summary = buildLiveSummary(raw);
  assert.deepEqual(detail.engagement, summary.engagement);
  assert.equal(summary.engagement.online, 0);
  assert.equal(summary.engagement.gpm, 1098.58);
  assert.equal(summary.engagement.watch_uv, 4423);
  assert.equal(summary.engagement.watch_to_pay_rate, 2.6);
  assert.equal(summary.engagement.show_to_watch_rate, 22.99);
  assert.equal(summary.engagement.units.watch_to_pay_rate, 'percent');
  assert.equal(summary.engagement.source_at, sourceAt);
  assert.equal(summary.engagement.net_order_cost, null);
  assert.deepEqual(summary.engagement.missing, ['net_order_cost']);
  assert.equal(summary.funnel.data_valid, false);
  assert.equal(summary.funnel.counts.product_clicks, null);
  assert.equal(JSON.stringify(raw), before);
  const empty = buildLiveSummary({ ...raw, live_metrics: {}, dataValid: false });
  assert.equal(empty.engagement.data_valid, false);
  assert.equal(empty.engagement.online, null);
});

test('详情与摘要均保留未取得追投的原因；经营指标变化进入快照身份', () => {
  for (const result of [cleanLiveDashboard(raw), buildLiveSummary(raw)]) {
    assert.equal(result.boost_data_valid, false);
    assert.deepEqual(result.boost_coverage, raw.boost_coverage);
    assert.deepEqual(result.missing_components, raw.missing_components);
  }
  const a = buildLiveSummary(raw), b = buildLiveSummary({ ...raw, live_metrics: { ...raw.live_metrics, online: 10 } });
  assert.notEqual(a.snapshot_id, b.snapshot_id);
  assert.deepEqual(require('../server-app/server/lib/watchContract').snapshotEvidence(a).engagement, a.engagement);
});

const planRows = [1, 2, 3].map(i => ({ id: `900${i}`, advId: '12345', marGoal: 2,
  name: `计划 ${i}`, ecpRoi2Goal: i + 3, budget: 100000000, adDeliveryName: '投放中' }));
const planResponse = { status_code: 0, fetched_at: sourceAt, data: { adInfos: planRows, adRoomInfoMap: {
  '9001': [{ id: '111', anchor: { id: 'anchor-111' } }],
  '9002': [{ id: '0', anchor: { id: 'anchor-222' } }],
  '9003': [{ id: '0', anchor: { id: 'anchor-333' } }],
} } };
test('平台房间或当前房间核验出的主播唯一匹配主计划；拒绝默认计划、其他房间和其他账户', () => {
  const identity = { advertiserId: '12345', roomId: '111', anchorId: 'anchor-111' };
  assert.equal(selectRoomPlan(planResponse, identity).ad.id, '9001');
  const second = selectRoomPlan(planResponse, { ...identity, roomId: '222', anchorId: 'anchor-222' });
  assert.equal(second.ad.id, '9002'); assert.equal(second.source, 'platform_anchor');
  assert.equal(selectRoomPlan(planResponse, { ...identity, advertiserId: '67890' }).ad, null);
  assert.equal(selectRoomPlan(planResponse, { ...identity, roomId: '999' }).ad, null);
  assert.equal(selectRoomPlan(planResponse, { ...identity, anchorId: 'wrong-anchor' }).ad, null);
  const duplicate = structuredClone(planResponse);
  duplicate.data.adRoomInfoMap['9002'] = [{ id: '111', anchor: { id: 'anchor-111' } }];
  assert.equal(selectRoomPlan(duplicate, identity).reason, 'primary_plan_ambiguous');
  assert.throws(() => selectRoomPlan({ ...planResponse, truncated: true }, identity), { code: 'room_plan_list_unavailable' });
});

let sessionStart = start, failList = false;
const boostCalls = [];
tabs.fetchLiveStatus = async () => ({ isLive: true, rooms: ['111', '222', '333'].map(roomId => ({ roomId, startTime: sessionStart })) });
plans.fetchLivePlanList = async () => planResponse;
board.fetchLiveCore = async (roomId, anchorId) => {
  assert.equal(anchorId, undefined);
  return { core_only: true, anchorId: `anchor-${roomId}`, metrics: { source_at: sourceAt, rows: [{ Metrics: {
    stat_cost_for_roi2: { Value: 10 }, total_order_settle_amount_realtime_for_roi2_1h: { Value: 50 },
    total_order_settle_count_realtime_for_roi2_1h: { Value: 2 }, total_prepay_and_pay_settle_realtime_roi2_1h: { Value: 5 },
  } }] } };
};
tabs.fetchBoostList = async (id, from, to, account, options) => {
  boostCalls.push({ id, from, to, account, options });
  if (failList) throw Object.assign(new Error('upstream_unavailable'), { code: 'upstream_unavailable' });
  return { status_code: 0, truncated: false, source_at: sourceAt, data: { adInfos: [{ id: `task-${id}`,
    name: `任务 ${id}`, adDeliveryName: '投放中', budget: 10000000, ecpRoi2Goal: 3 }], adStatsMap: {} } };
};
tabs.fetchBoostSummary = async () => ({ status_code: 0, data: { totalMetrics: { metrics: {
  statCostForRoi2Assist: { value: 10 }, totalPrepayAndPayOrderRoi2Assist: { value: 3 },
} } } });
test('三个房间并发获得各自主计划与追投，日累计不伪装本场，缺失指标不补零', async () => {
  const results = await Promise.all(['111', '222', '333'].map(room => readRoomDashboard('room_contract_a', room, { startTime: start })));
  results.forEach((result, i) => {
    assert.equal(result.plan.primary_ad_id, `900${i + 1}`);
    assert.equal(result.boost_tasks[0].primary_ad_id, `900${i + 1}`);
    assert.equal(result.plan_binding.room_id, `${i + 1}${i + 1}${i + 1}`);
    assert.equal(result.plan_binding.session_key, result.session_key);
    assert.equal(result.boost_data_valid, true);
    assert.equal(result.boost_coverage.list_complete, true);
    assert.equal(result.boost_window.scope, 'daily');
    assert.equal(result.boost_tasks[0].cost, null);
    assert.equal(result.boost_tasks[0].net_roi, null);
    assert.equal(result.boost_tasks[0].session_metrics.data_valid, false);
    assert.equal(result.plan.spent_pct, null);
    assert.equal(result.missing_components.includes('boost'), false);
  });
  assert.equal(boostCalls.length, 3);
  await readRoomDashboard('room_contract_a', '111', { startTime: start });
  assert.equal(boostCalls.length, 3, '同场短缓存复用');
  const other = await readRoomDashboard('room_contract_b', '111', { startTime: start });
  assert.equal(other.plan, null, '不能复用另一账户的主计划缓存');
  assert.equal(boostCalls.length, 3);
});
test('换场后不沿用旧追投；上游失败保留核心和已核验计划，并保留缺失原因', async () => {
  sessionStart = '2026-09-28 12:00:00'; failList = true;
  await assert.rejects(readRoomDashboard('room_contract_a', '111', { startTime: start }), { code: 'live_session_changed' });
  const next = await readRoomDashboard('room_contract_a', '111', { startTime: sessionStart });
  assert.ok(next.session_key.endsWith(sessionStart));
  assert.equal(next.today.cost, 10);
  assert.equal(next.plan.primary_ad_id, '9001');
  assert.equal(next.boost_data_valid, false);
  assert.equal(next.boost_coverage.reason, 'upstream_unavailable');
  assert.deepEqual(next.boost_tasks, []);
  assert.equal(boostCalls.length, 4);
});
