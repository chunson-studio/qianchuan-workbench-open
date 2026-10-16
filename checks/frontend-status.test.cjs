'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../server-app/server/public/v4/shared.js'), 'utf8');
const shared = source.split('/* ===== 主题切换')[0];
const room = { roomId: '111', startTime: '2026-09-28 10:00:00' };

function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, String(value)) };
}
function loadShared() {
  const context = { window: {}, document: { documentElement: { dataset: {} }, dispatchEvent() {} }, localStorage: storage(), sessionStorage: storage(),
    location: { search: '', origin: 'http://workbench.test' }, history: {}, CustomEvent: class {}, matchMedia: () => ({ matches: true }),
    URL, URLSearchParams, console, setTimeout, clearTimeout, AbortController,
    fetch: async () => ({ ok: true, json: async () => ({ ok: true, accounts: [{ id: 'a' }] }) }) };
  vm.runInNewContext(shared, context);
  context.window.V4.setAccounts([{ id: 'a' }]);
  return context.window.V4;
}

test('明确登录失效才引导更新凭据，HTTP 403 引导核对账户并保持未知', () => {
  const V4 = loadShared();
  const denied = V4.accountLiveView({ isLive: null, status_stale: true, cookieExpired: false,
    errors: [{ component: 'on_demand_core', code: 'upstream_forbidden', error: 'HTTP 403' }] });
  assert.equal(denied.state, 'unknown');
  assert.equal(denied.label, '访问被拒绝');
  assert.equal(denied.reason, 'upstream_forbidden');
  assert.equal(denied.action, 'account');
  assert.equal(denied.rooms, null);
  assert.match(denied.detail, /尚不能确定是否过期/);
  for (const state of [{ cookieExpired: true }, { errors: [{ code: 'cookie_expired' }] }]) {
    const expired = V4.accountLiveView(state);
    assert.equal(expired.state, 'credential');
    assert.equal(expired.label, '登录已失效');
    assert.equal(expired.action, 'credential');
    assert.equal(expired.rooms, null);
  }
  const missing = V4.accountLiveView({ code: 'cookie_not_found' });
  assert.equal(missing.label, '登录资料未配置');
  assert.equal(missing.action, 'credential');
});

test('直播状态过时与从未取得状态分别说明，不把旧房间判为当前在播或下播', () => {
  const V4 = loadShared();
  for (const isLive of [true, false]) {
    const delayed = V4.accountLiveView({ isLive, status_stale: true, available_rooms: [room] });
    assert.equal(delayed.state, 'unknown');
    assert.equal(delayed.reason, 'status_stale');
    assert.equal(delayed.label, '直播状态更新延迟');
    assert.equal(delayed.action, 'refresh');
    assert.equal(delayed.rooms, null);
  }
  const unknown = V4.accountLiveView(null);
  assert.equal(unknown.state, 'unknown');
  assert.equal(unknown.reason, 'status_unknown');
  assert.equal(unknown.label, '直播状态待核验');
});

test('请求超时和限频提供重试入口，不要求更新凭据或输出原始错误信息', () => {
  const V4 = loadShared();
  for (const code of ['upstream_timeout', 'queue_timeout', 'rate_limited']) {
    const result = V4.accountLiveView({ isLive: null, errors: [{ code, error: 'private upstream detail' }] });
    assert.equal(result.state, 'unknown');
    assert.equal(result.action, 'refresh');
    assert.doesNotMatch(result.detail, /private upstream detail/);
  }
});

test('指标延迟或组件被拒绝不推翻独立在播证据，房间选择继续按账号场次保留', () => {
  const V4 = loadShared();
  const live = { accountId: 'a', isLive: true, status_stale: false, available_rooms: [room] };
  V4.updateLiveWatch([live], true);
  for (const extra of [{ data_stale: true }, { errors: [{ code: 'upstream_forbidden' }] }]) {
    const state = { ...live, ...extra };
    const result = V4.accountLiveView(state);
    assert.equal(result.state, 'live');
    assert.equal(result.rooms[0].roomId, room.roomId);
    assert.equal(result.rooms[0].startTime, room.startTime);
    assert.equal(result.action, extra.data_stale ? 'refresh' : 'account');
    V4.updateLiveWatch([state], true);
    assert.equal(V4.room('a').roomId, room.roomId);
  }
  V4.updateLiveWatch([{ accountId: 'a', isLive: null, errors: [{ code: 'upstream_forbidden' }] }], true);
  assert.equal(V4.room('a').roomId, room.roomId, '拒绝访问仍保留上次选定的身份');
  assert.equal(V4.accountLiveView(V4.watchState('a')).rooms, null, '保留选择不代表已确认在播');
});

test('多房间待选择不误报指标延迟，明确未开播才清空原场次', () => {
  const V4 = loadShared();
  const live = { accountId: 'a', isLive: true, available_rooms: [room], data_stale: true, requires_room_selection: true };
  const result = V4.accountLiveView(live);
  assert.equal(result.reason, 'live');
  assert.equal(result.label, '1 个房间在播');
  V4.updateLiveWatch([live], true);
  const offline = { accountId: 'a', isLive: false, status_stale: false, available_rooms: [room] };
  V4.updateLiveWatch([offline], true);
  assert.equal(V4.room('a'), null);
  assert.equal(V4.accountLiveView(offline).rooms.length, 0);
  assert.equal(V4.accountLiveView(offline).action, null);
  const missing = V4.accountLiveView({ isLive: true, available_rooms: [{ roomId: room.roomId }] });
  assert.equal(missing.state, 'live');
  assert.equal(missing.reason, 'room_unverified');
  assert.equal(missing.rooms, null);
});

test('新用户默认浅色主题，已有深色偏好和切换持久化保留', () => {
  const from = source.indexOf('(function (V4)', source.indexOf('/* ===== 主题切换'));
  const to = source.indexOf('/* ===== 部署检测', from);
  const localStorage = storage();
  const applied = new Map();
  const context = { window: { V4: { preferences: { get: key => localStorage.getItem(key), set: (key, value) => localStorage.setItem(key, value) } } }, localStorage, document: { readyState: 'loading', addEventListener() {},
    getElementById: () => null, documentElement: { setAttribute: (k, v) => applied.set(k, v), removeAttribute: k => applied.delete(k) } } };
  vm.runInNewContext(source.slice(from, to), context);
  const V4 = context.window.V4;
  assert.equal(V4.theme(), 'paper');
  localStorage.setItem('v4-theme', 'dark');
  assert.equal(V4.theme(), 'dark');
  V4.toggleTheme();
  assert.equal(V4.theme(), 'paper');
  assert.equal(applied.get('data-theme'), 'paper');
  V4.toggleTheme();
  assert.equal(V4.theme(), 'dark');
  assert.equal(applied.has('data-theme'), false);
});
