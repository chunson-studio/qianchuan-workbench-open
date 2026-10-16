'use strict';
require('./setup-runtime.cjs');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
fs.writeFileSync(path.join(process.env.QC_RUNTIME_CONFIG_ROOT, 'config.json'), JSON.stringify({
  qianchuan_accounts: [{ id: 'compass_test_a', aavid: '123456' }, { id: 'compass_test_b', aavid: '234567' }],
}));
const screen = require('../server-app/server/lib/compassScreen');
const { normVal, parseFive, parseDistribution, parseFlow, fiveWindow, resultFromRaw } = screen._test;
const { cleanCompassScreen } = require('../server-app/server/lib/mcpClean');
const ts = 1790587980;

test('罗盘价格、百分比、不可用值和真实零按单位归一，趋势与卡片使用同一金额单位', () => {
  assert.equal(normVal({ unit: 'priceV2', value: 10700 }), 107);
  assert.equal(normVal({ unit: 'price', value: 187.5 }), 1.875);
  assert.equal(normVal({ unit: 'ratio', value: 0.335 }), 33.5);
  assert.equal(normVal({ unit: 'nan', value: 0 }), null);
  assert.equal(normVal({ unit: 'number', value: 0 }), 0);
  assert.equal(normVal({ unit: 'price', value: '' }), null);
  const raw = { card: [
    { index_display: '用户支付金额', value: { unit: 'priceV2', value: 10700 }, change_value: { unit: 'ratio', value: .335 },
      trends: [{ date_time: ts, horizontal: '09/28 17:33', vertical: 10700 }] },
    { index_display: '在线人数', index_tip: '近5分钟在线人数平均值', value: { unit: 'number', value: 50 } },
  ] };
  const five = parseFive(raw);
  assert.equal(five[0].trend[0].v, 107);
  assert.equal(five[0].change_pct, 33.5);
  assert.equal(five[1].aggregation, 'five_minute_average');
  assert.equal(fiveWindow(raw).end, new Date((ts + 60) * 1000).toISOString());
  assert.equal(fiveWindow({}).start, null);
  const result = resultFromRaw({ five: { ...raw, update_time: '2026/09/28 17:38更新' } }, 'direct');
  assert.equal(result.five_updated_at, '2026-09-28T09:38:00.000Z');
  assert.ok(Math.abs(Date.now() - Date.parse(result.fetched_at)) < 1000);
});

test('全域接口的 natural_data 不被误标自然流量，渠道未知成交保持空值', () => {
  const dist = parseDistribution({ ad_roi_info: { version: 2, start_time: ts }, natural_data: [
    { channel_name: '直播推荐', watch_ratio: { unit: 'ratio', value: .2247 },
      pay_ratio: { unit: 'ratio', value: .2972 }, gpm: { unit: 'price', value: 145418 },
      sub_flow: [{ channel_name: '同城', gpm: { unit: 'nan', value: 0 } }] },
  ], pay_data: [] });
  assert.equal(dist.separation_mode, 'unified');
  assert.equal(dist.rows[0].group, 'all');
  assert.equal(dist.rows[0].gpm, 1454.18);
  assert.equal(dist.rows[0].children[0].gpm, null);
  assert.match(dist.notice, /不区分自然\/付费/);
  const separate = parseDistribution({ ad_roi_info: { version: 0 }, natural_data: [{ channel_name: '推荐' }], pay_data: [{ channel_name: '广告' }] });
  assert.deepEqual(separate.rows.map(c => c.group), ['natural', 'paid']);
  assert.equal(parseDistribution({}).separation_mode, 'unknown');
});

test('MCP 摘要保留来源、窗口和最新分钟值，详情保留完整序列且不改原数据', () => {
  const traffic = parseFlow({ index_selected: ['直播推荐'], channel_list: [], trends: [
    { date_time: ts, display_name: '直播推荐', vertical: 6 },
    { date_time: ts + 60, display_name: '直播推荐', vertical: 0 },
  ] });
  const data = { account_id: 'compass_test_a', room_id: '11111', component_times: { flow: { source_at: 'now' } }, traffic_trend: traffic };
  const before = JSON.stringify(data), summary = cleanCompassScreen(data), detail = cleanCompassScreen(data, 'detail');
  assert.equal(summary.traffic_trend.points, undefined);
  assert.equal(summary.traffic_trend.points_omitted, true);
  assert.equal(summary.traffic_trend.point_count, 2);
  assert.equal(summary.traffic_trend.latest_by_channel[0].value, 0);
  assert.equal(summary.traffic_trend.interval_seconds, 60);
  assert.equal(detail.traffic_trend.points.length, 2);
  assert.equal(JSON.stringify(data), before);
});

test('同广告账户的两房间分别绑定罗盘身份，缓存不跨户/跨场，权限失败不回落', async () => {
  const tabs = require('../server-app/server/lib/qianchuanTabs');
  const direct = require('../server-app/server/lib/compassDirect');
  const { readRoomScreen } = require('../server-app/server/lib/compassRoom');
  const original = { status: tabs.fetchLiveStatus, direct: direct.fetchCompassDirect, screen: screen.fetchScreenLive };
  let start = '2026-09-28 13:18:06', deny = false, wrongSession = false, failFlow = false, calls = [];
  tabs.fetchLiveStatus = async () => ({ isLive: true, rooms: ['11111', '22222'].map(roomId => ({ roomId, startTime: start })) });
  direct.fetchCompassDirect = async (account, url, opts) => {
    calls.push({ account, url, room: opts.roomId });
    return deny ? { st: 10119 } : { st: 0, data: { is_self: true, live_start_ts: Date.parse((wrongSession ? '2026-09-27 13:18:06' : start).replace(' ', 'T') + '+08:00') / 1000, live_status: 2, nickname: opts.roomId } };
  };
  screen.fetchScreenLive = async (account, room) => ({ five: [{ name: room, value: 0 }], fetched_at: '2026-09-28T09:00:00.000Z',
    component_times: Object.fromEntries(['five', 'portrait', 'flow', 'distribution'].map(k => [k, { data_valid: !(failFlow && k === 'flow'), source_at: '2026-09-28T09:00:00.000Z' }])),
    errors: failFlow ? { flow: 'timeout' } : undefined });
  try {
    await assert.rejects(readRoomScreen('compass_test_a', null, { startTime: start }), e => e.code === 'live_room_required');
    await assert.rejects(readRoomScreen('compass_test_a', '11111'), e => e.code === 'live_session_required');
    const [a, b, c] = await Promise.all([
      readRoomScreen('compass_test_a', '11111', { startTime: start }),
      readRoomScreen('compass_test_a', '22222', { startTime: start }),
      readRoomScreen('compass_test_b', '11111', { startTime: start }),
    ]);
    assert.equal(calls.length, 3); assert.notEqual(a.session_key, b.session_key); assert.notEqual(a.session_key, c.session_key);
    assert.equal(b.five[0].name, '22222'); assert.equal(a.binding.verified, true);
    const cached = await readRoomScreen('compass_test_a', '11111', { startTime: start });
    assert.equal(cached.cached, true); assert.equal(cached.fetched_at, a.fetched_at); assert.equal(calls.length, 3);
    deny = true;
    await assert.rejects(readRoomScreen('compass_test_a', '11111', { startTime: start, fresh: true }), e => e.code === 'compass_room_forbidden');
    await assert.rejects(readRoomScreen('compass_test_a', '11111', { startTime: start }), e => e.code === 'compass_room_forbidden');
    deny = false; wrongSession = true;
    await assert.rejects(readRoomScreen('compass_test_a', '11111', { startTime: start, fresh: true }), e => e.code === 'compass_session_mismatch');
    wrongSession = false; start = '2026-09-28 14:00:00';
    await assert.rejects(readRoomScreen('compass_test_a', '11111', { startTime: '2026-09-28 13:18:06' }), e => e.code === 'live_session_changed');
    failFlow = true;
    const partial = await readRoomScreen('compass_test_a', '11111', { startTime: start });
    assert.equal(partial.partial, true); assert.equal(partial.data_valid, false); assert.deepEqual(partial.missing_components, ['flow']);
  } finally { tabs.fetchLiveStatus = original.status; direct.fetchCompassDirect = original.direct; screen.fetchScreenLive = original.screen; }
});

test('前端罗盘请求必须带场次，读取失败清空旧模块，在线均值有明确标签', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../server-app/server/public/v4/pages/warroom.js'), 'utf8');
  assert.match(source, /V4\.api\('\/api\/compass\/screen', scope/);
  assert.match(source, /j\.room_id !== scope\.room_id/);
  assert.match(source, /在线人数（5分钟均值）/);
  assert.match(source, /for \(const id of \['compassPortrait', 'compassFive', 'compassChannels'\]\) \$\(id\)\.innerHTML = ''/);
});
