'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../server-app/server/public/v4/pages/warroom.js'), 'utf8');
function section(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from > 0 && to > from); return source.slice(from, to);
}
function harness(roomScoped = true) {
  const nodes = new Map(), $ = id => { if (!nodes.has(id)) nodes.set(id, { innerHTML: '', textContent: '' }); return nodes.get(id); };
  const buttons = ['active', 'paused', 'all'].map(value => ({ dataset: { boostFilter: value }, style: {}, attrs: {},
    setAttribute(key, data) { this.attrs[key] = data; } }));
  const S = { boostFilter: 'active', be: null };
  const context = vm.createContext({ S, roomScoped, $, alive: () => true,
    view: { querySelectorAll: () => buttons }, V4: { emptyBox: text => text, stateClass: () => '' },
    esc: value => String(value ?? '').replace(/</g, '&lt;'), fmtM: value => `¥${value}`, fmtMoney: value => `¥${value}` });
  vm.runInContext(section('function boostFunnelMarkup(', '/* ===== 主计划'), context);
  vm.runInContext(section("view.querySelectorAll('[data-boost-filter]').forEach(button => {", '      renderRoomCoverage();'), context);
  return { S, $, buttons, render: vm.runInContext('renderBoosts', context) };
}
const frame = { boost_data_valid: true, boost_truncated: false, boost_window: { start: '2020-01-02' },
  plan: { primary_ad_id: 'fixture-plan' }, boost_tasks: [
    { id: 'active', name: 'Running', status: '投放中', budget: 100, cost: 2, order_count: 1,
      duration_seconds: 21600, duration_unit: 'seconds' },
    { id: 'paused', name: 'PauseLate', status: '已暂停', board_group: 'manual_paused', budget: 200, cost: 4,
      order_count: 3, net_roi: 12, duration_seconds: null, duration_unit: 'unknown' },
    { id: 'wait', name: 'Waiting', status: '关联直播间未开播', board_group: 'offline_wait',
      duration_seconds: 1234, duration_unit: 'unknown' },
  ] };

test('read-only filter exposes paused late orders and real total duration without treating the subset as all history', () => {
  const h = harness(); h.render(frame);
  assert.match(h.$('boosts').innerHTML, /Running/); assert.doesNotMatch(h.$('boosts').innerHTML, /PauseLate/);
  assert.match(h.$('boosts').innerHTML, /总时长 <b>6 小时/);
  h.buttons[1].onclick();
  assert.match(h.$('boosts').innerHTML, /PauseLate/); assert.match(h.$('boosts').innerHTML, /支付 <b>3<\/b>/);
  assert.doesNotMatch(h.$('boosts').innerHTML, /Running|opacity:\.55/);
  assert.match(h.$('boosts').innerHTML, /总时长 <b>--/); assert.equal(h.buttons[1].attrs['aria-pressed'], 'true');
  assert.match(h.$('boostFoot').innerHTML, /非全部历史暂停任务/);
  h.buttons[2].onclick(); assert.match(h.$('boosts').innerHTML, /Running/); assert.match(h.$('boosts').innerHTML, /Waiting/);
  assert.match(h.$('boostSum').textContent, /已读全部 3/);
});

test('empty selected group does not mean an empty task list; unknown room coverage clears prior rows', () => {
  const h = harness(); h.render({ ...frame, boost_tasks: [frame.boost_tasks[0]] }); h.buttons[1].onclick();
  assert.match(h.$('boosts').innerHTML, /已读列表中没有暂停/);
  h.render({ boost_data_valid: false, boost_tasks: [], boost_coverage: { reason: 'room_plan_loading' } });
  h.buttons[2].onclick();
  assert.equal(h.S.boostFrame, null); assert.equal(h.$('boostFoot').textContent, '任务数量未知');
  assert.doesNotMatch(h.$('boosts').innerHTML, /Running|PauseLate/);
});

test('switching filters during a fast read keeps the old-frame label and its original date', () => {
  const h = harness(false); h.render(frame);
  h.render({ boost_tasks: [], from_fast_path: true, boost_data_valid: false });
  assert.match(h.$('boostSum').textContent, /显示上次读取/);
  h.buttons[1].onclick();
  assert.match(h.$('boosts').innerHTML, /PauseLate/); assert.match(h.$('boostSum').textContent, /显示上次读取/);
  assert.equal(h.S.boostFrame, frame);
});
