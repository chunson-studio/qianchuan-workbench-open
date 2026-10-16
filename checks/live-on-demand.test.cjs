'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// 隔离真实账户和凭据；唯一上游入口被替换为固定响应，测试不会发出网络请求。
const root = fs.mkdtempSync(path.join(require('./test-output.cjs').testOutputRoot(), 'live-read-test-'));
process.env.QC_RUNTIME_CONFIG_ROOT = root;
process.env.QC_RUNTIME_DATA_ROOT = root;
process.env.QC_DISABLE_BACKGROUND = '1';
const config = require('../server-app/server/lib/config');
const qc = require('../server-app/server/lib/qianchuan');
const TEST_DATE = new Date(Date.now()+8*3600000).toISOString().slice(0,10);
const calls = [];
const states = new Map();
const val = Value => ({ Value });
qc.statQuery = async (body, retries, account, options) => {
  calls.push({ body, account, options });
  const state = states.get(account);
  if (state.wait) await state.wait;
  if (body.reqFrom === 'topLivingCardRoi2') {
    if (body.Dimensions.includes('room_status') && state.ended) return { data: { StatsData: { Rows: [{ Dimensions: {
      room_id: val(state.room), room_start_time: val(state.start), room_end_time: val((TEST_DATE + ' 21:01:12')), room_status: val('4'),
    } }] } } };
    if (state.statusError) throw Object.assign(new Error('status failed'), { code: state.errorCode || 'upstream_timeout' });
    const rooms = state.rooms || [{ roomId: state.room, roomName: '测试直播', startTime: state.start }];
    return { data: { StatsData: { Rows: state.offline ? [] : rooms.map(room => ({ Dimensions: {
      room_status: val('2'), room_id: val(room.roomId), room_name: val(room.roomName), room_start_time: val(room.startTime),
    } })) } } };
  }
  if (body.reqFrom === 'init') {
    return { data: { StatsData: { Rows: [{ Dimensions: state.noAnchor ? {} : { room_with_anchor_id: val('anchor-' + account) } }] } } };
  }
  if (body.reqFrom === 'totalTrend') {
    if (state.trendError) throw Object.assign(new Error('trend failed'), { code: 'upstream_forbidden' });
    return { data: { StatsData: { Rows: ['18:05', '18:00'].map(time => ({
      Dimensions: { stat_time_5_minute: val(time) },
      Metrics: { stat_real_cost_for_roi2: val(20), total_order_settle_amount_realtime_for_roi2_1h: val(60) },
    })) } } };
  }
  if (body.reqFrom === 'materialVideo') {
    assert.deepEqual(body.Dimensions, []);
    assert.ok(!body.Filters.Conditions.some(c => ['roi2_material_type_v3', 'roi2_material_status'].includes(c.Field)));
    return { data: { StatsData: { Rows: [], Totals: state.assistMissing ? {} : { stat_cost_for_roi2_assist: val(state.assist ?? 300) } } } };
  }
  if (body.reqFrom === 'funnelModule') {
    return { data: { StatsData: { Rows: [{ Metrics: Object.fromEntries([
      'live_show_count_for_roi2', 'live_watch_count_for_roi2', 'live_product_click_count_for_roi2',
      'total_pay_order_count_for_roi2', 'total_show_to_watch_rate_for_roi2', 'total_watch_to_product_click_rate_for_roi2',
      'total_watch_to_pay_rate_realtime_for_roi2', 'total_product_click_to_pay_rate_realtime_for_roi2',
    ].map(key => [key, val(20)])) }] } } };
  }
  if (body.reqFrom === 'sourceChannel') {
    if (state.channelError) throw new Error('channel failed');
    return { data: { StatsData: { Rows: [{ Dimensions: { combined_first_compass_entrance_code: val('test_channel') },
      Metrics: { total_live_watch_cnt_for_roi2: val(50), total_live_pay_amt_for_roi2: val(100) } }] } } };
  }
  assert.equal(body.reqFrom, 'commonMetricCard');
  if (state.coreError) throw new Error('core failed');
  return { data: { StatsData: { Rows: [{ Metrics: {
    stat_cost_for_roi2: val(state.cost),
    total_order_settle_amount_realtime_for_roi2_1h: val(180),
    total_order_settle_count_realtime_for_roi2_1h: val(3),
    total_prepay_and_pay_settle_realtime_roi2_1h: val(3),
    room_pack_online_user_count: val(12),
  } }] } } };
};
const collector = require('../server-app/server/lib/liveCollector');
const dashboard = require('../server-app/server/routes/liveDashboard');
function account(id, extra = {}) {
  config.QIANCHUAN_ACCOUNTS.push({ id, name: id, aavid: '1234567890', cookieFile: 'unused.txt' });
  states.set(id, { room: 'room1', start: (TEST_DATE + ' 17:55:56'), cost: 60, ...extra });
  // 本测试只验证核心读取，不启动慢模块的自调用 HTTP。
  (global.__dashAsyncRefreshTs ||= {})[id] = Date.now() + 86400000;
  return id;
}
const watch = id => collector.getLatestWatch().find(a => a.accountId === id);
async function getDashboard(id, suffix = '') {
  let output;
  const res = { writeHead() {}, end(value) { output = JSON.parse(value); } };
  await dashboard({}, res, new URL('http://localhost/api/live-dashboard?account=' + id + suffix));
  return output;
}

test('冷启动并发页面与状态读取只请求一轮，缺少主播配置时自动核验，缓存复用', async () => {
  let release;
  const id = account('cold', { wait: new Promise(resolve => { release = resolve; }) });
  const reads = [getDashboard(id), collector.ensureLiveWatch(id), collector.ensureLiveWatch(id)];
  release();
  const [page] = await Promise.all(reads);
  assert.equal(page.live.isLive, true);
  assert.equal(page.dataValid, true);
  assert.equal(page.today.cost, 60);
  assert.equal(page.live_metrics.online, 12);
  assert.equal(page.live_metrics.basicCost, null);
  assert.equal(watch(id).room.anchor_id, 'anchor-cold');
  assert.deepEqual(calls.filter(c => c.account === id).map(c => c.body.reqFrom), ['topLivingCardRoi2', 'init', 'commonMetricCard']);
  assert.ok(calls.filter(c => c.account === id).every(c => c.options.priority === 1));
  const core = calls.find(c => c.account === id && c.body.reqFrom === 'commonMetricCard').body;
  assert.deepEqual(core.Filters.Conditions.find(c => c.Field === 'anchor_id').Values, ['anchor-cold']);
  await getDashboard(id);
  assert.equal(calls.filter(c => c.account === id).length, 3);
});

test('状态失败返回未知；核心失败仍显示已核验在播，缺失数据保持 null', async () => {
  const id = account('status-error', { statusError: true });
  await Promise.all([collector.ensureLiveWatch(id), collector.ensureLiveWatch(id)]);
  const page = await getDashboard(id);
  assert.equal(page.live.isLive, null);
  assert.equal(page.stale, true);
  assert.equal(page.partial, true);
  assert.equal(page.today, null);
  assert.equal(calls.filter(c => c.account === id).length, 1);
  const coreId = account('core-error', { coreError: true });
  const corePage = await getDashboard(coreId);
  assert.equal(corePage.live.isLive, true);
  assert.equal(corePage.dataValid, false);
  assert.equal(corePage.today, null);
  assert.equal(corePage.live_metrics.cost, null);
  assert.equal(corePage.partial, true);
});

test('账户发现多个在播房间仍是已核验在播，不默认采第一间', async () => {
  const rooms = [
    { roomId: '111', roomName: '房间甲', startTime: '2026-09-28 10:00:00' },
    { roomId: '222', roomName: '房间乙', startTime: '2026-09-28 10:30:00' },
  ];
  const id = account('multi-cold', { rooms });
  await collector.ensureLiveWatch(id);
  const live = watch(id);
  assert.equal(live.isLive, true);
  assert.equal(live.status_stale, false);
  assert.ok(live.liveCheckedAt);
  assert.equal(live.requires_room_selection, true);
  assert.deepEqual(live.available_rooms.map(r => r.roomId), ['111', '222']);
  assert.equal(live.room, null);
  assert.equal(live.live_metrics.cost, null);
  assert.deepEqual(live.errors, []);
  assert.deepEqual(calls.filter(c => c.account === id).map(c => c.body.reqFrom), ['topLivingCardRoi2']);
  assert.equal(collector.assessCollectorWatch(live).restart_recommended, false);
});

test('单间转多间清除单间金额；状态失败不伪装下播，恢复单间不串金额', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const id = account('multi-transition');
  await collector.ensureLiveWatch(id);
  assert.equal(watch(id).live_metrics.cost, 60);
  t.mock.timers.tick(11000);
  states.get(id).rooms = [
    { roomId: 'room1', startTime: (TEST_DATE + ' 17:55:56') },
    { roomId: 'room2', startTime: (TEST_DATE + ' 18:00:00') },
  ];
  await collector.ensureLiveWatch(id);
  const multiple = watch(id);
  assert.equal(multiple.isLive, true);
  assert.equal(multiple.room, null);
  assert.equal(multiple.session_key, null);
  assert.equal(multiple.live_metrics.cost, null);
  assert.equal(multiple.fetchedAt, null);
  t.mock.timers.tick(11000);
  states.get(id).statusError = true;
  await collector.ensureLiveWatch(id);
  assert.equal(watch(id).isLive, null);
  assert.equal(watch(id).status_stale, true);
  assert.equal(watch(id).liveCheckedAt, multiple.liveCheckedAt);
  t.mock.timers.tick(6000);
  Object.assign(states.get(id), { rooms: undefined, room: 'room2', cost: 7, statusError: false });
  await collector.ensureLiveWatch(id);
  assert.equal(watch(id).isLive, true);
  assert.equal(watch(id).requires_room_selection, false);
  assert.equal(watch(id).live_metrics.cost, 7);
  assert.equal(watch(id).available_rooms.length, 1);
  t.mock.timers.tick(11000);
  states.get(id).offline = true;
  await collector.ensureLiveWatch(id);
  assert.equal(watch(id).isLive, false);
  assert.deepEqual(watch(id).available_rooms, []);
});

test('主播核验缺失时不发出无效核心请求；确认下播时不请求大屏', async () => {
  const id = account('no-anchor', { noAnchor: true });
  const page = await getDashboard(id);
  assert.equal(page.live.isLive, true);
  assert.equal(page.dataValid, false);
  assert.ok(page.errors.some(e => e.code === 'core_anchor_missing'));
  assert.equal(calls.filter(c => c.account === id).length, 2);
  const offId = account('offline', { offline: true });
  const off = await getDashboard(offId);
  assert.equal(off.live.isLive, false);
  assert.equal(off.status_stale, false);
  assert.equal(calls.filter(c => c.account === offId && c.body.reqFrom !== 'topLivingCardRoi2').length, 0);
});

test('换场后核心失败不会继承上一场的消耗和时间；恢复后错误清除', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const id = account('session');
  await collector.ensureLiveWatch(id);
  const before = watch(id);
  t.mock.timers.tick(11000);
  Object.assign(states.get(id), { room: 'room2', start: (TEST_DATE + ' 20:00:00'), coreError: true });
  await collector.ensureLiveWatch(id); // 新场次已完成状态核验，再断言场次隔离。
  const failed = await getDashboard(id);
  assert.notEqual(failed.session_key, before.session_key);
  assert.equal(failed.live.rooms[0].roomId, 'room2');
  assert.equal(failed.today, null);
  assert.equal(failed.fetchedAt, null);
  t.mock.timers.tick(6000);
  Object.assign(states.get(id), { coreError: false, cost: 5 });
  await collector.ensureLiveWatch(id);
  const recovered = await getDashboard(id);
  assert.equal(recovered.today.cost, 5);
  assert.equal(recovered.partial, false);
  assert.deepEqual(recovered.errors, []);
});

test('同场读取失败保留原读数与时间，状态失败不伪装下播', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const id = account('preserve');
  await collector.ensureLiveWatch(id);
  const before = watch(id);
  t.mock.timers.tick(11000);
  states.get(id).coreError = true;
  await collector.ensureLiveWatch(id);
  assert.equal(watch(id).fetchedAt, before.fetchedAt);
  assert.equal(watch(id).live_metrics.cost, 60);
  assert.equal(watch(id).isLive, true);
  t.mock.timers.tick(6000);
  states.get(id).statusError = true;
  await collector.ensureLiveWatch(id);
  assert.equal(watch(id).isLive, null);
  assert.equal(watch(id).status_stale, true);
});

test('拒绝访问后退避一分钟，多个页面轮询不持续冲击上游', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const id = account('forbidden', { statusError: true, errorCode: 'upstream_forbidden' });
  await collector.ensureLiveWatch(id);
  t.mock.timers.tick(11000);
  await Promise.all([getDashboard(id), collector.ensureLiveWatch(id)]);
  assert.equal(calls.filter(c => c.account === id).length, 1);
  assert.equal(watch(id).session_key, null);
  assert.equal(watch(id).cookieExpired, false);
  t.mock.timers.tick(50000);
  states.get(id).statusError = false;
  await collector.ensureLiveWatch(id);
  assert.equal(watch(id).isLive, true);
  assert.equal(watch(id).dataValid, true);
});

test('前端将未知、真实下播、在播缺数据分开，不把空值判为亏损', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../server-app/server/public/v4/pages/warroom.js'), 'utf8');
  const start = source.indexOf('function computeLiveState(j)');
  const end = source.indexOf('/* ===== 第二行', start);
  const compute = require('node:vm').runInNewContext('(' + source.slice(start, end).trim() + ')', {
    V4: { breakEven: () => 3, fmtMoney: n => n.toFixed(2) },
  });
  assert.equal(compute({live:{isLive:null}}).word, '状态待确认');
  assert.equal(compute({live:{isLive:false},status_stale:true}).word, '状态待确认');
  assert.equal(compute({live:{isLive:false}}).word, '未在播');
  assert.equal(compute({live:{isLive:true},today:null}).word, '直播中');
  assert.equal(compute({live:{isLive:true},today:{cost:60,netRoi:4},dataValid:true}).word, '直播中');
});

test('关闭后台仍可按需读取趋势，并发合并、排序、核心刷新后保留趋势及其时间', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const id = account('trend-cache');
  await Promise.all([collector.ensureLiveTrend(id), collector.ensureLiveTrend(id)]);
  const before = collector.getLatestTrend(id);
  assert.deepEqual(before.trend.map(p => p.time), ['18:00', '18:05']);
  assert.equal(before.trend[0].roi, 3);
  assert.equal(calls.filter(c => c.account === id && c.body.reqFrom === 'totalTrend').length, 1);
  t.mock.timers.tick(11000);
  await collector.ensureLiveWatch(id);
  assert.deepEqual(collector.getLatestTrend(id).trend, before.trend);
  assert.equal(collector.getLatestTrend(id).fetchedAt, before.fetchedAt);
  await collector.ensureLiveTrend(id);
  assert.equal(calls.filter(c => c.account === id && c.body.reqFrom === 'totalTrend').length, 1);
  t.mock.timers.tick(60000);
  states.get(id).trendError = true;
  await collector.ensureLiveTrend(id);
  const failed = collector.getLatestTrend(id);
  assert.equal(failed.fetchedAt, before.fetchedAt);
  assert.deepEqual(failed.trend, before.trend);
  assert.equal(failed.errors[0].code, 'upstream_forbidden');
  t.mock.timers.tick(11000);
  states.get(id).room = 'room2';
  await collector.ensureLiveTrend(id);
  assert.deepEqual(collector.getLatestTrend(id).trend, []);
  assert.equal(collector.getLatestTrend(id).fetchedAt, null);
});

test('按需流速采样覆盖所有状态，复用一分钟，同场累计差分且缺失不补零', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const id = account('flow-read');
  await Promise.all([collector.ensureLiveFlow(id), collector.ensureLiveFlow(id)]);
  assert.equal(collector.getLatestTrend(id).flowSamples.length, 1);
  assert.equal(collector.getLatestTrend(id).flowSamples[0].assistCost, 300);
  await collector.ensureLiveFlow(id);
  assert.equal(calls.filter(c => c.account === id && c.body.reqFrom === 'materialVideo').length, 1);
  t.mock.timers.tick(61000);
  states.get(id).cost = 80;
  states.get(id).assist = 305;
  await collector.ensureLiveFlow(id);
  const samples = collector.getLatestTrend(id).flowSamples;
  assert.equal(samples.length, 2);
  assert.equal(samples[1].totalCost - samples[0].totalCost, 20);
  assert.equal(samples[1].assistCost - samples[0].assistCost, 5);
  t.mock.timers.tick(61000);
  states.get(id).assistMissing = true;
  await collector.ensureLiveFlow(id);
  assert.equal(collector.getLatestTrend(id).flowSamples.length, 2);
  t.mock.timers.tick(61000);
  Object.assign(states.get(id), { room: 'room-new', assistMissing: false });
  await collector.ensureLiveFlow(id);
  assert.equal(collector.getLatestTrend(id).flowSamples.length, 1);
});

test('漏斗渠道按需采集更新已缓存盘面，核心刷新保留独立时间，切场隔离', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const id = account('insights-read');
  await getDashboard(id);
  await Promise.all([collector.ensureLiveInsights(id), collector.ensureLiveInsights(id)]);
  const page = await getDashboard(id);
  assert.equal(page.funnel.counts.shows, 20);
  assert.equal(page.funnel.data_valid, true);
  assert.equal(page.source[0].pay, 100);
  assert.equal(calls.filter(c => c.account === id && c.body.reqFrom === 'sourceChannel').length, 1);
  const sourceAt = page.component_times.channels.source_at;
  t.mock.timers.tick(11000);
  await collector.ensureLiveWatch(id);
  const refreshed = await getDashboard(id);
  assert.equal(refreshed.source[0].pay, 100);
  assert.equal(refreshed.component_times.channels.source_at, sourceAt);
  states.get(id).room = 'new-insights-room';
  t.mock.timers.tick(11000);
  await collector.ensureLiveWatch(id);
  const changed = await getDashboard(id);
  assert.equal(changed.source.length, 0);
  states.get(id).channelError = true;
  await collector.ensureLiveInsights(id);
  const partial = await getDashboard(id);
  assert.equal(partial.funnel.counts.shows, 20);
  assert.equal(partial.source.length, 0);
});

test('已结束场次可回补核心、趋势、漏斗和渠道，刷新复用并持久保存', async t => {
  // 固定“当天”与样本场次一致，跨午夜运行不会把本场样本当成历史数据。
  t.mock.timers.enable({ apis: ['Date'], now: new Date((TEST_DATE + 'T22:00:00+08:00')).getTime() });
  const id = account('ended-display', { offline: true, ended: true });
  const page = await getDashboard(id);
  assert.equal(page.live.isLive, false);
  assert.equal(page.live.rooms[0].endTime, (TEST_DATE + ' 21:01:12'));
  assert.equal(page.today.cost, 60);
  assert.equal(page.funnel.counts.shows, 20);
  assert.equal(page.source[0].pay, 100);
  assert.equal(collector.getLatestTrend(id).trend.length, 2);
  const before = calls.filter(c => c.account === id).length;
  const again = await getDashboard(id);
  assert.equal(again.funnel.data_valid, true);
  assert.equal(calls.filter(c => c.account === id).length, before);
  const cacheFile = path.join(config.CACHE_DIR, 'ended-board', id + '.json');
  assert.equal(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).record.room.status, '已结束');
  for (const call of calls.filter(c => c.account === id && !['topLivingCardRoi2', 'init'].includes(c.body.reqFrom))) {
    assert.deepEqual(call.body.Filters.Conditions.find(c => c.Field === 'room_id').Values, ['room1']);
    if (call.body.reqFrom === 'totalTrend') assert.equal(call.body.EndTime, (TEST_DATE + ' 21:01:12'));
  }
});


test('缓存到期且上游阻塞时，多读者立即拿同一旧快照；完成后再看到新值', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const id = account('swr-blocked');
  const first = await getDashboard(id);
  t.mock.timers.tick(35000);
  let release;
  const state = states.get(id);
  state.wait = new Promise(resolve => { release = resolve; });
  state.cost = 77;
  const before = calls.filter(c => c.account === id).length;
  let timeout;
  try {
    const pages = await Promise.race([
      Promise.all(Array.from({ length: 12 }, (_, index) => getDashboard(id, index % 2 ? '&full=1' : ''))),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('读取被上游阻塞')), 1000); }),
    ]);
    for (const page of pages) {
      assert.equal(page.today.cost, 60);
      assert.equal(page.fetchedAt, first.fetchedAt);
      assert.equal(page.data_stale, true);
      assert.equal(page.status_stale, true);
    }
    assert.equal(calls.filter(c => c.account === id).length, before + 1);
  } finally { clearTimeout(timeout); release(); }
  await collector.ensureLiveWatch(id);
  const current = await getDashboard(id);
  assert.equal(current.today.cost, 77);
  assert.notEqual(current.fetchedAt, first.fetchedAt);
  assert.equal(current.data_stale, false);
});

test('共享读取保温在无人读取后停止，移出账户不会重新启动定时器', async () => {
  const { createReader } = require('../server-app/server/lib/liveReadService');
  let refreshed = 0, warmed = 0;
  const reader = createReader({ peek: () => ({liveCheckedAt: 'known'}), refresh: async () => { refreshed++; },
    warm: async () => { warmed++; }, intervalMs: 10, leaseMs: 35 });
  await reader.read('lease');
  await new Promise(resolve => setTimeout(resolve, 80));
  const count = refreshed;
  assert.ok(warmed > 0);
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(refreshed, count);
  await reader.read('stop'); reader.stop('stop');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(refreshed, count + 1);
});
