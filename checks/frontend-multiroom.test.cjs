'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const publicRoot = path.resolve(__dirname, '../server-app/server/public/v4');
const sharedSource = fs.readFileSync(path.join(publicRoot, 'shared.js'), 'utf8').split('/* ===== 主题切换')[0];
const warroomSource = fs.readFileSync(path.join(publicRoot, 'pages/warroom.js'), 'utf8');
const startTime = '2026-09-28 10:00:00';
const rooms = [{ roomId: '111', startTime }, { roomId: '222', startTime }];
function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, String(value)) };
}
function loadShared(accounts = [{ id: 'a', break_even_roi: 3 }, { id: 'b', break_even_roi: 7 }]) {
  const context = { window: {}, document: { documentElement: { dataset: {} }, dispatchEvent() {} }, localStorage: storage(), sessionStorage: storage(),
    location: { search: '', origin: 'http://workbench.test' }, history: {}, CustomEvent: class {}, matchMedia: () => ({ matches: true }),
    URL, URLSearchParams, console, setTimeout, clearTimeout, AbortController,
    fetch: async () => ({ ok: true, json: async () => ({ ok: true, accounts }) }) };
  vm.runInNewContext(sharedSource, context);
  const V4 = context.window.V4;
  V4.setAccounts(accounts);
  return V4;
}
function extract(start, end, context) {
  const from = warroomSource.indexOf(start);
  assert.notEqual(from, -1);
  const to = warroomSource.indexOf(end, from);
  assert.notEqual(to, -1);
  return vm.runInNewContext('(' + warroomSource.slice(from, to).trim() + ')', context);
}

test('房间首次挂载尚无盘面数据时，覆盖提示可初始化并等待追投结果', () => {
  const nodes = new Map();
  const $ = id => { if (!nodes.has(id)) nodes.set(id, { style: {} }); return nodes.get(id); };
  const render = extract('function renderRoomCoverage(j)', 'function renderWatchList(j)', {
    roomScoped: true, $, V4: { emptyBox: text => text }, view: { querySelectorAll: () => [] },
  });
  assert.doesNotThrow(() => render());
  assert.match($('roomModulesStatus').textContent, /追投待核验/);
  render({ boost_data_valid: true });
  assert.match($('roomModulesStatus').textContent, /追投已接入/);
});

test('同户多房间必须选择，房间选择按账号隔离，换场不自动接管', () => {
  const V4 = loadShared();
  V4.updateRooms('a', rooms);
  assert.equal(V4.room('a'), null);
  V4.updateRooms('b', [rooms[0]]);
  assert.equal(V4.room('b').roomId, '111');
  assert.equal(V4.setRoom(V4.roomKey(rooms[1]), 'a'), true);
  const oldScope = V4.liveScopeKey();
  assert.equal(V4.breakEven(), null, '房间缺保本线时不得继承账户阈值');
  V4.setAcct('b');
  assert.notEqual(V4.liveScopeKey(), oldScope);
  V4.setAcct('a');
  assert.equal(V4.liveScopeKey(), oldScope);
  V4.updateRooms('a', [{ ...rooms[1], startTime: '2026-09-28 12:00:00' }]);
  assert.equal(V4.room(), null);
  V4.updateRooms('a', [{ ...rooms[1], startTime: '2026-09-28 12:00:00' }]);
  assert.equal(V4.room(), null, '重复刷新不得自动选新场');
});

test('核心失败仍可选择已探测的房间，状态未知不冒充下播清选择', () => {
  const V4 = loadShared();
  const detected = V4.roomsFromWatch({ isLive: true, room: null, available_rooms: [], detectedRoomId: '111', detectedRoomStartTime: startTime });
  V4.updateRooms('a', detected);
  assert.equal(V4.room().roomId, '111');
  assert.equal(V4.roomsFromWatch({ isLive: null, available_rooms: [] }), null);
  assert.equal(V4.room().roomId, '111');
  assert.equal(V4.roomsFromWatch({ isLive: false, status_stale: false, room: rooms[0] }).length, 0);
  assert.equal(V4.roomsFromWatch({ isLive: null, available_rooms: rooms }).length, 2);
});

test('账户发现的多房间在播状态和房间名称直接用于总览', () => {
  const V4 = loadShared();
  const view = V4.accountLiveView({ isLive: true, status_stale: false,
    available_rooms: rooms.map((room, i) => ({ ...room, roomName: '直播间' + (i + 1) })) });
  assert.equal(view.state, 'live');
  assert.equal(view.label, '2 个房间在播');
  const normalized = V4.normalizeRooms(rooms.map((room, i) => ({ ...room, roomName: '直播间' + (i + 1) })));
  assert.equal(normalized[0].title, '直播间1');
  assert.equal(normalized[1].title, '直播间2');
});

test('目标数字和口径一次保存，切换账号后回读仍绑定原房间', async () => {
  const V4 = loadShared();
  V4.updateRooms('a', rooms);
  V4.setRoom(V4.roomKey(rooms[0]));
  const scope = V4.liveScope(), calls = [];
  V4.apiPost = async (url, body, options) => {
    calls.push({ url, body, options });
    V4.setAcct('b');
  };
  V4.api = async (url, params) => {
    calls.push({ url, params });
    return { account_params: { target_roi: 4.2, target_roi_basis: 'payment' } };
  };
  const result = await V4.saveRoomTarget(scope, { target_roi: '4.2', target_roi_basis: 'payment' });
  assert.equal(result.target_roi, 4.2);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    { url: '/api/config', body: { account: 'a', room_id: '111', values: { target_roi: 4.2, target_roi_basis: 'payment' } }, options: { includeAccount: false } },
    { url: '/api/config', params: { account: 'a', room_id: '111' } },
  ]);
  await assert.rejects(V4.saveRoomTarget(scope, { target_roi: 2, target_roi_basis: 'unknown' }), /确认.*口径/);
  assert.equal(calls.length, 2, '无效目标不得发起保存');
});

test('目标回读不一致不报告保存成功', async () => {
  const V4 = loadShared();
  V4.apiPost = async () => ({ ok: true });
  V4.api = async () => ({ account_params: { target_roi: 3, target_roi_basis: 'payment' } });
  await assert.rejects(V4.saveRoomTarget({ account: 'a', room_id: '111', start_time: startTime },
    { target_roi: 4, target_roi_basis: 'payment' }), /回读不一致/);
});

test('作战室绑定完整场次请求，旧响应不能覆盖新房间或写入缓存', async () => {
  const scope = { account: 'a', room_id: '111', start_time: startTime };
  let resolve, current = true, rendered = 0;
  const CACHE = {}, calls = [];
  const context = { dashFlight: false, dashSeq: 0, targetRevision: 0, scope, scopeKey: 'a|111|10', acct0: 'a', CACHE,
    alive: () => current, S: {}, V4: { api: (url, params) => { calls.push({ url, params }); return new Promise(done => { resolve = done; }); }, cset() {} },
    applyDash: async () => { rendered++; }, currentRoomId: () => null };
  const refresh = extract('async function refreshDash()', '      /* ===== 追投占比', context);
  const pending = refresh();
  assert.equal(calls[0].params, scope);
  current = false;
  resolve({ account: 'a', live: { isLive: true, rooms: rooms.slice(0, 1) } });
  await pending;
  assert.equal(rendered, 0);
  assert.equal(Object.keys(CACHE).length, 0);
});

test('作战室拒绝其他房间的成功响应，不覆盖当前盘面', async () => {
  const scope = { account: 'a', room_id: '111', start_time: startTime };
  const CACHE = {}, status = {}, S = {};
  let rendered = 0;
  const refresh = extract('async function refreshDash()', '      /* ===== 追投占比', {
    dashFlight: false, dashSeq: 0, scope, scopeKey: 'a|111|10', acct0: 'a', CACHE, S, alive: () => true,
    targetParams: null, targetRevision: 0, renderTarget: () => assert.equal(S.coreReadFailed, true),
    $: () => status, V4: { api: async () => ({ account: 'a', live: { isLive: true, rooms: [rooms[1]] } }) },
    applyDash: async () => { rendered++; },
  });
  await refresh();
  assert.equal(rendered, 0);
  assert.equal(Object.keys(CACHE).length, 0);
  assert.equal(S.coreReadFailed, true);
  assert.match(status.textContent, /不一致/);
});

test('切换房间卸载会停止轮询，不再访问已移除的趋势监听', () => {
  let stopped = 0, removed = 0;
  const context = { dead: false, stoppers: [() => stopped++, () => stopped++], onResize: () => {},
    removeEventListener: (event, listener) => { assert.equal(event, 'resize'); assert.equal(listener, context.onResize); removed++; } };
  const from = warroomSource.indexOf('function unmount()');
  const to = warroomSource.indexOf('      };', from);
  const unmount = vm.runInNewContext('(' + warroomSource.slice(from, to) + '})', context);
  assert.doesNotThrow(unmount);
  assert.equal(context.dead, true);
  assert.equal(stopped, 2);
  assert.equal(removed, 0);
});

test('目标保存完成后，保存前发出的盘面请求不能把目标显示改回旧值', async () => {
  const scope = { account: 'a', room_id: '111', start_time: startTime };
  let release, shown;
  const context = { dashFlight: false, dashSeq: 0, targetRevision: 0, targetParams: null, scope, scopeKey: 'a|111|10', acct0: 'a', CACHE: {}, S: {}, alive: () => true,
    V4: { api: () => new Promise(resolve => { release = resolve; }), cset() {} },
    currentRoomId: () => null, applyDash: async data => { shown = data.thresholds; } };
  const refresh = extract('async function refreshDash()', '      /* ===== 追投占比', context);
  const pending = refresh();
  context.targetRevision = 1; context.targetParams = { target_roi: 4.2, target_roi_basis: 'platform_net_1h' };
  release({ account: 'a', live: { isLive: true, rooms: [rooms[0]] }, thresholds: { target_roi: 2, target_roi_basis: 'payment' } });
  await pending;
  assert.equal(shown.target_roi, 4.2); assert.equal(shown.target_roi_basis, 'platform_net_1h');
});



test('没有房间保本线时不以零或账户目标判断健康', () => {
  const compute = extract('function computeLiveState(j)', '      /* ===== 第二行', { V4: { breakEven: () => null, fmtMoney: value => String(value) } });
  assert.equal(compute({ live: { isLive: true }, dataValid: true, today: { cost: 100, netRoi: 5 }, thresholds: { break_even_roi: null } }).word, '直播中');
});

test('房间盘面不调用账户级趋势、罗盘、汇总和决策接口', async () => {
  assert.doesNotMatch(warroomSource, /V4\.api\('\/api\/live-trend'/);
  const stops = [
    ['async function refreshChengfangLive()', '      function renderPlan('],
    ['async function refreshRounds()', '      /* ===== 老板评审'],
    ['async function refreshBoss()', '      /* ===== 店铺成交'],
    ['async function refreshSplit(which)', '      // 仅后台读取'],
    ['async function refreshScreen()', '      /* ===== 轮询'],
  ];
  let roomScreenReads = 0, roomRoundReads = 0;
  for (const [start, end] of stops) await extract(start, end, { roomScoped: true,
    refreshRoomScreen: async () => { roomScreenReads++; }, refreshRoomRounds: async () => { roomRoundReads++; } })();
  assert.equal(roomScreenReads, 1);
  assert.equal(roomRoundReads, 1);
});

test('房间目标比较只使用相同口径，实际为零仍是有效数值', () => {
  const V4 = loadShared(), now = Date.parse('2026-09-28T05:00:00Z');
  const data = { dataValid: true, live: { isLive: true }, component_times: { core: { source_at: new Date(now).toISOString() } }, today: { roi: 4, netRoi: 2.5 } };
  const payment = V4.roomTargetView(data, { target_roi: 3, target_roi_basis: 'payment' }, now);
  const net = V4.roomTargetView(data, { target_roi: 3, target_roi_basis: 'platform_net_1h' }, now);
  assert.equal(payment.state, 'met'); assert.equal(payment.delta, 1);
  assert.equal(net.state, 'below'); assert.equal(net.delta, -.5);
  const zero = V4.roomTargetView({ ...data, today: { roi: 0 } }, { target_roi: 3, target_roi_basis: 'payment' }, now);
  assert.equal(zero.actual, 0); assert.equal(zero.state, 'below');
  for (const basis of ['final_settlement', 'chengfang_comprehensive']) {
    const missing = V4.roomTargetView(data, { target_roi: 3, target_roi_basis: basis }, now);
    assert.equal(missing.actual, null); assert.equal(missing.delta, null); assert.equal(missing.state, 'unknown');
  }
});

test('未知目标、未知实际和陈旧来源不得被显示为已达标', () => {
  const V4 = loadShared(), now = Date.parse('2026-09-28T05:00:00Z');
  const params = { target_roi: 3, target_roi_basis: 'payment' };
  const data = { dataValid: true, live: { isLive: true }, fetchedAt: new Date(now).toISOString(), today: { roi: 5 } };
  for (const target of [null, undefined, '']) assert.equal(V4.roomTargetView(data, { ...params, target_roi: target }, now).state, 'unconfigured');
  assert.equal(V4.roomTargetView(data, { ...params, target_roi_basis: 'unknown' }, now).delta, null);
  for (const change of [{ dataValid: false }, { stale: true }, { live: { isLive: false } }, { today: { roi: null } },
    { component_times: { core: { source_at: new Date(now - 31000).toISOString() } } },
    { component_times: { core: { source_at: new Date(now + 10000).toISOString() } } }]) {
    const projected = V4.roomTargetView({ ...data, ...change }, params, now);
    assert.equal(projected.state, 'unknown'); assert.equal(projected.delta, null);
  }
});

test('总览房间响应必须匹配账户、房间和开播时间三个维度', () => {
  const V4 = loadShared(), scope = { account: 'a', room_id: '111', start_time: startTime };
  const data = { account: 'a', live: { rooms: [rooms[0]] } };
  assert.equal(V4.roomDashboardMatches(scope, data), true);
  assert.equal(V4.roomDashboardMatches({ ...scope, account: 'b' }, data), false);
  assert.equal(V4.roomDashboardMatches({ ...scope, room_id: '222' }, data), false);
  assert.equal(V4.roomDashboardMatches({ ...scope, start_time: '2026-09-28 13:00:00' }, data), false);
  assert.equal(V4.roomDashboardMatches(scope, { ...data, live: { rooms } }), false);
});

test('房间追投区区分未取得和真实空列表，未知净值不回落支付金额或零', () => {
  const elements = Object.fromEntries(['boosts', 'boostSum', 'boostFoot'].map(id => [id, { innerHTML: '', textContent: '' }]));
  const context = { boostFunnelMarkup: () => '', roomScoped: true, S: { be: null }, $: id => elements[id],
    V4: { emptyBox: text => text, stateClass: () => { throw Error('未知保本线不得着色'); } },
    fmtMoney: n => Number(n).toFixed(2), fmtM: n => String(n), esc: value => String(value) };
  const render = extract('function renderBoosts(j)', '      /* ===== 主计划', context);
  render({ boost_tasks: [], boost_data_valid: false, boost_coverage: { reason: 'primary_plan_ambiguous' } });
  assert.match(elements.boosts.innerHTML, /多个主计划/);
  assert.equal(elements.boostFoot.textContent, '任务数量未知');
  render({ boost_tasks: [], boost_data_valid: true, boost_coverage: {complete:true}, plan: { primary_ad_id: '9001' } });
  assert.match(elements.boosts.innerHTML, /当前已读列表中没有在投追投任务/);
  render({ boost_data_valid: true, plan: { primary_ad_id: '9001' }, boost_window: { start: '2026-09-28' },
    boost_tasks: [{ id: '1', name: '核验任务', status: '投放中', cost: 0, gmv: 999, net_gmv: null, net_roi: null, order_count: null }] });
  assert.match(elements.boosts.innerHTML, /消耗 <b>0.00/);
  assert.match(elements.boosts.innerHTML, /净成交 <b>--/);
  assert.doesNotMatch(elements.boosts.innerHTML, /999/);
  assert.match(elements.boosts.innerHTML, /净ROI <b class="">--/);
  assert.match(elements.boostFoot.innerHTML, /日累计，非本场归因/);
});

function fleetHarness(api, options = {}) {
  const V4 = loadShared(options.accounts || [{ id: 'a', name: '账户 A' }, { id: 'b', name: '账户 B' }]), nodes = new Map(), timers = [];
  if (options.filters) V4.fleetViewState = options.filters;
  V4.api = api;
  V4.poll = fn => { const timer = { fn, stopped: false }; timers.push(timer); return () => { timer.stopped = true; }; };
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { textContent: '', innerHTML: '', querySelectorAll: selector => options.selectorResults?.[id]?.[selector] || [], contains: () => false, setAttribute() {} });
    return nodes.get(id);
  };
  const view = { querySelector: node, querySelectorAll: () => [] };
  const source = fs.readFileSync(path.join(publicRoot, 'pages/overview.js'), 'utf8');
  const fn = source.slice(source.indexOf('function mountRoomFleet('), source.indexOf('  const HTML ='));
  let active = true;
  const mount = vm.runInNewContext('(' + fn.trim() + ')', { V4, document: { activeElement: null }, esc: V4.esc, fmtMoney: V4.fmtMoney, location: {} });
  const stop = mount(view, () => active);
  return { V4, node, timers, stop: () => { active = false; stop(); } };
}
const flushFleet = () => new Promise(resolve => setImmediate(resolve));
const watchFleet = () => ({ accounts: [
  { accountId: 'a', isLive: true, available_rooms: rooms },
  { accountId: 'b', isLive: true, available_rooms: rooms.slice(0, 1) },
] });
const fleetDash = scope => ({ account: scope.account, live: { isLive: true, rooms: [{ roomId: scope.room_id, startTime: scope.start_time }] },
  fetchedAt: new Date().toISOString(), dataValid: true, today: { roi: 4, cost: 123.45 }, thresholds: { target_roi: 3, target_roi_basis: 'payment' } });











test('账户状态区分未开播、登录失效和未知，不把旧房间数冒充在播', () => {
  const V4 = loadShared();
  const live = { accountId: 'a', isLive: true, available_rooms: [rooms[0], rooms[0], rooms[1], {roomId:'missing-start'}] };
  assert.equal(V4.accountLiveView(live).label, '2 个房间在播');
  V4.updateLiveWatch([live], true);
  V4.setRoom(V4.roomKey(rooms[0]), 'a');
  for (const state of [null, {isLive:null}, {isLive:false,status_stale:true}, {...live,status_stale:true}]) {
    assert.equal(V4.accountLiveView(state).state, 'unknown');
    assert.equal(V4.accountLiveView(state).rooms, null);
  }
  assert.equal(V4.accountLiveView({...live,cookieExpired:true}).state, 'credential');
  V4.updateLiveWatch([], true);
  assert.equal(V4.watchState('a'), null);
  assert.equal(V4.room('a').roomId, '111', '未知保留场次身份');
  V4.updateLiveWatch([{accountId:'a',isLive:false,status_stale:false}], true);
  assert.equal(V4.room('a'), null, '明确下播才清空选择');
  assert.equal(V4.accountLiveView(V4.watchState('a')).state, 'offline');
});

test('单账户读取失败将状态改为未知，保留身份且不影响其他账户状态', async () => {
  const V4=loadShared();
  V4.updateLiveWatch([{accountId:'a',isLive:true,available_rooms:rooms.slice(0,1)},{accountId:'b',isLive:false}],true);
  V4.api=async()=>{throw new Error('network unavailable');};
  await assert.rejects(V4.loadRooms('a'),/network unavailable/);
  assert.equal(V4.accountLiveView(V4.watchState('a')).state,'unknown');
  assert.equal(V4.accountLiveView(V4.watchState('b')).state,'offline');
  assert.equal(V4.room('a').roomId,'111');
});



test('账户入口随核验结果更新，离开页面解除监听且不处理迟到读取', async () => {
  const V4 = loadShared(), nodes=new Map();
  const node=id=>{if(!nodes.has(id)) nodes.set(id,{innerHTML:'',textContent:'',querySelectorAll:()=>[]});return nodes.get(id);};
  const view={querySelector:node};
  let release, active=true;
  V4.api=()=>new Promise(resolve=>{release=resolve;});
  const mount=extract('function mountRoomChooser(', '  V4.pages.warroom =', {V4,esc:V4.esc});
  const stop=mount(view,'a',()=>active);
  V4.updateLiveWatch([{accountId:'a',isLive:false}],true);
  assert.equal(node('#roomChoiceTitle').textContent,'当前账户未开播');
  V4.updateLiveWatch([{accountId:'a',isLive:true,available_rooms:rooms}],true);
  assert.equal((node('#roomChoices').innerHTML.match(/data-room-choice=/g)||[]).length,2);
  V4.updateLiveWatch([{accountId:'a',isLive:null,cookieExpired:true}],true);
  assert.equal(node('#roomCredentialLink').hidden,false);
  assert.equal(node('#roomChoices').hidden,true);
  active=false;stop();
  V4.updateLiveWatch([{accountId:'a',isLive:false}],true);
  release({accounts:[{accountId:'a',isLive:false}]});await flushFleet();
  assert.equal(node('#roomChoiceTitle').textContent,'登录已失效');
});
