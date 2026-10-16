'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createQianchuanNativeAuxiliaryOperations } = require('../tools/qc-native-auxiliary.cjs');

const screen = 'https://compass.jinritemai.com/screen/live/shop?live_room_id=123&live_app_id=1128#data';
const overview = 'https://compass.jinritemai.com/shop/live-overview';
const binding = { room: 'test-room', advertiser_id: '456', primary_ad_id: '789', browser_context_id: 'profile-a', target_id: 'plan-a' };
function page({ url = screen, profile = 'profile-a', id = 'screen-a', text = '测试直播间 开播时间 2026/10/14 19:03', warnings = [], links = [], mutateAfterRead } = {}) {
  const item = { currentUrl: url, profile, id, reads: 0, opens: 0, popup: null,
    url() { return this.currentUrl; }, isClosed() { return false; }, async title() { return '直播大屏'; },
    context() { return { newCDPSession: async () => ({ send: async () => ({ targetInfo: { browserContextId: item.profile, targetId: item.id, url: item.currentUrl } }), detach: async () => {} }) }; },
    async evaluate(fn, input) {
      if (fn.name === 'readVisibleAuxiliaryDom') { this.reads++; mutateAfterRead?.(this); return { title: '直播大屏', text, warnings, links, headings: [], raw_cards: [], text_truncated: false, comments_excluded: false }; }
      this.opens++; this.openedUrl = input; return !!this.popup;
    },
    async waitForEvent() { if (!this.popup) throw new Error('timeout'); return this.popup; },
    async waitForURL(expected) { if (typeof expected === 'function') { if (!expected(new URL(this.currentUrl))) throw new Error('timeout'); } else assert.equal(this.currentUrl, expected); },
  };
  return item;
}
function setup(list, opts = {}) {
  const browser = { isConnected: () => true, contexts: () => [{ pages: () => list }] };
  return createQianchuanNativeAuxiliaryOperations({ browser, ...opts });
}
const spec = () => ({ target_id: 'screen-a', expected_url: screen, room_id: '123', expected_name: '测试直播间', expected_start_time: '2026/10/14 19:03' });

test('discovery returns only allowed existing pages in the explicit actual profile', async () => {
  const operations = setup([page(), page({ profile: 'profile-b', id: 'other' }), page({ url: 'https://example.com/private', id: 'outside' }),
    page({ url: 'https://qianchuan.jinritemai.com/board-next?aavid=456&live_room_id=123', id: 'native' })]);
  const result = await operations.auxiliary_list.run({ binding, input: {} });
  assert.deepEqual(result.pages.map(item => item.target_id), ['screen-a', 'native']);
  assert.equal(result.discovery_complete, true);
  assert.ok(result.pages.every(item => item.shop_identity_verified === false && item.scene_verified === false));
});

test('snapshot binds exact target URL room visible name and start; retains shop warning without claiming shop identity', async () => {
  const p = page({ warnings: ['你访问的不是当前登录店铺官方账号开播的直播间', '无法进入复盘模式'], links: [{ text: '详情', href: 'https://compass.jinritemai.com/shop/live-detail?live_room_id=123' }, { text: '其他', href: 'https://example.com' }] });
  const result = await setup([p]).auxiliary_snapshot.run({ binding, input: spec() });
  assert.equal(result.room_url_verified, true);
  assert.equal(result.start_time_text_verified, true);
  assert.equal(result.identity_warning, true);
  assert.equal(result.shop_identity_verified, false);
  assert.equal(result.links.length, 1);
  assert.equal(result.advertising_writes, 0);
});

test('wrong profile rejects before DOM read', async () => {
  const p = page({ profile: 'profile-b' });
  await assert.rejects(setup([p]).auxiliary_snapshot.run({ binding, input: spec() }), { code: 'auxiliary_profile_mismatch' });
  assert.equal(p.reads, 0);
});

test('wrong room and duplicated URL room IDs reject', async () => {
  const p = page();
  await assert.rejects(setup([p]).auxiliary_snapshot.run({ binding, input: { ...spec(), room_id: '124' } }), { code: 'auxiliary_room_mismatch' });
  const duplicate = screen.replace('live_app_id=1128', 'live_room_id=123');
  await assert.rejects(setup([page({ url: duplicate })]).auxiliary_snapshot.run({ binding, input: { ...spec(), expected_url: duplicate } }), { code: 'auxiliary_room_mismatch' });
});

test('profile or URL changed during snapshot rejects all returned data', async () => {
  for (const mutation of [item => { item.profile = 'profile-b'; }, item => { item.currentUrl = overview; }]) {
    const p = page({ mutateAfterRead: mutation });
    await assert.rejects(setup([p]).auxiliary_snapshot.run({ binding, input: spec() }), error => ['auxiliary_profile_mismatch', 'auxiliary_url_mismatch'].includes(error.code));
  }
});

test('wrong visible name or start fails; login warnings are explicit', async () => {
  const operations = setup([page({ warnings: ['登录已过期'] })]);
  await assert.rejects(operations.auxiliary_snapshot.run({ binding, input: { ...spec(), expected_name: '另一直播间' } }), { code: 'auxiliary_visible_name_mismatch' });
  await assert.rejects(operations.auxiliary_snapshot.run({ binding, input: { ...spec(), expected_start_time: '2026/10/15 19:03' } }), { code: 'auxiliary_start_time_mismatch' });
  assert.equal((await operations.auxiliary_snapshot.run({ binding, input: spec() })).login_warning, true);
});

test('unknown input fields cannot provide code or hidden navigation', async () => {
  const p = page(), operations = setup([p]);
  await assert.rejects(operations.auxiliary_snapshot.run({ binding, input: { ...spec(), evaluate: 'secret' } }), { code: 'auxiliary_snapshot_options_invalid' });
  await assert.rejects(operations.auxiliary_list.run({ binding, input: { url: screen } }), { code: 'auxiliary_list_options_invalid' });
  assert.equal(p.reads, 0);
});

test('open accepts same-profile observed URL only and never arbitrary external URLs', async () => {
  const plan = page({ id: 'plan-a', url: 'https://qianchuan.jinritemai.com/uni-prom/detail?aavid=456&adId=789' });
  const operations = setup([plan]);
  await assert.rejects(operations.auxiliary_open.run({ page: plan, binding, input: { url: screen } }), { code: 'auxiliary_url_not_observed' });
  await assert.rejects(operations.auxiliary_open.run({ page: plan, binding, input: { url: 'https://example.com' } }), { code: 'auxiliary_url_not_allowed' });
  assert.equal(plan.opens, 0);
});

test('open reuses a visible same-profile observed href, opens once, requires scene snapshot', async () => {
  const detail = 'https://compass.jinritemai.com/shop/live-detail?live_room_id=123';
  const plan = page({ id: 'plan-a', url: 'https://qianchuan.jinritemai.com/uni-prom/detail?aavid=456&adId=789' });
  const source = page({ links: [{ text: '详情', href: detail }] });
  plan.popup = page({ id: 'new-detail', url: detail });
  const operations = setup([plan, source]);
  await operations.auxiliary_snapshot.run({ binding, input: spec() });
  const result = await operations.auxiliary_open.run({ page: plan, binding, input: { url: detail } });
  assert.equal(plan.opens, 1);
  assert.equal(result.requires_snapshot, true);
  assert.equal(result.scene_verified, false);
  assert.equal(result.target_id, 'new-detail');
});

test('observations do not transfer across profiles and wrong popup profile rejects without retry', async () => {
  const plan = page({ id: 'plan-a' });
  const wrongRegistry = setup([plan], { observedUrls: [{ browser_context_id: 'profile-b', url: screen }] });
  await assert.rejects(wrongRegistry.auxiliary_open.run({ page: plan, binding, input: { url: screen } }), { code: 'auxiliary_url_not_observed' });
  plan.popup = page({ profile: 'profile-b', id: 'wrong-popup' });
  const operations = setup([plan], { observedUrls: [{ browser_context_id: 'profile-a', url: screen }] });
  await assert.rejects(operations.auxiliary_open.run({ page: plan, binding, input: { url: screen } }), { code: 'auxiliary_profile_mismatch' });
  assert.equal(plan.opens, 1);
});

test('Qianchuan screen rejects advertiser mismatch instead of borrowing another account', async () => {
  const url = 'https://qianchuan.jinritemai.com/board-next?aavid=999&live_room_id=123';
  const result = await setup([page({ url })]).auxiliary_list.run({ binding, input: {} });
  assert.equal(result.pages.length, 0);
  assert.equal(result.discovery_complete, false);
  assert.equal(result.unreadable_candidates, 1);
});

test('duplicate target IDs cannot select a random tab', async () => {
  await assert.rejects(setup([page(), page()]).auxiliary_snapshot.run({ binding, input: spec() }), { code: 'auxiliary_target_not_unique' });
});

test('a discovered unknown shop route cannot become a settings/account navigation', async () => {
  const url = 'https://compass.jinritemai.com/shop/account-settings';
  const plan = page({ id: 'plan-a' });
  const operations = setup([page({ url, id: 'settings' }), plan]);
  await operations.auxiliary_list.run({ binding, input: {} });
  await assert.rejects(operations.auxiliary_open.run({ page: plan, binding, input: { url } }), { code: 'auxiliary_navigation_route_unverified' });
  assert.equal(plan.opens, 0);
});

test('real DOM collector returns bounded financial digits and near-five region without products/comments', async () => {
  const original = global.document;
  const p = page();
  const raw = '导航\n直播大屏\n专业版\n测试直播间\n开播时间 2026/10/14 19:03\n直播间成交金额\n¥\n1\n2\n3\n综合趋势\n商品列表\n不应返回的商品\n近5分钟数据\n09:01更新\n进入人数\n12\n实时评论\n不应返回的评论\n你访问的不是当前登录店铺官方账号开播的直播间';
  global.document = { title: '直播大屏', body: { innerText: raw }, querySelectorAll: () => [] };
  p.evaluate = async (fn, args) => fn(args);
  try {
    const result = await setup([p]).auxiliary_snapshot.run({ binding, input: spec() });
    assert.equal(result.text_scope, 'necessary_regions_only');
    assert.ok(result.regions.financial.raw.includes('¥\n1\n2\n3'));
    assert.equal(result.regions.financial.complete, true);
    assert.equal(result.regions.five_minutes.complete, true);
    assert.ok(result.regions.five_minutes.raw.includes('进入人数\n12'));
    assert.equal(result.text.includes('不应返回'), false);
    assert.equal(result.identity_warning, true);
  } finally { global.document = original; }
});

test('missing boundaries report missing region and never return the entire body as a fallback', async () => {
  const original = global.document;
  const p = page();
  global.document = { title: '未知布局', body: { innerText: '测试直播间\n开播时间 2026/10/14 19:03\n近5分钟数据\n未知无边界内容\n' }, querySelectorAll: () => [] };
  p.evaluate = async (fn, args) => fn(args);
  try {
    const result = await setup([p]).auxiliary_snapshot.run({ binding, input: spec() });
    assert.equal(result.regions.financial.raw, null);
    assert.equal(result.regions.five_minutes.raw, null);
    assert.ok(result.missing_regions.includes('financial'));
    assert.ok(result.missing_regions.includes('five_minutes'));
    assert.equal(result.text.includes('未知无边界内容'), false);
  } finally { global.document = original; }
});

function scenePage({ count = 1, nameCount = 1, buttonCount = 1, href = '', popupProfile = 'profile-a', label = '大屏' } = {}) {
  const source = page({ url: overview, id: 'overview-a' });
  source.clicks = 0;
  source.popup = page({ url: label === '大屏' ? screen : 'https://compass.jinritemai.com/shop/live-detail?live_room_id=123', profile: popupProfile, id: 'new-scene' });
  const rowElement = { isConnected: true, contains: node => node === targetElement };
  const targetElement = { isConnected: true, closest: () => href ? { getAttribute: () => href } : null };
  const rowHandle = { element: rowElement, dispose: async () => {} };
  const targetHandle = { evaluate: async (fn, arg) => fn(targetElement, arg?.element ?? arg), click: async () => { source.clicks++; }, dispose: async () => {} };
  const button = { filter() { return this; }, count: async () => buttonCount, elementHandle: async () => targetHandle };
  const name = { filter() { return this; }, count: async () => nameCount };
  const row = { filter() { return this; }, count: async () => count, innerText: async () => '测试直播间\n2026/10/14 19:03\n详情 大屏',
    getByText(text) { return text === '测试直播间' ? name : button; }, elementHandle: async () => rowHandle };
  source.getByRole = role => { assert.equal(role, 'row'); return row; };
  return source;
}
const uiSpec = () => ({ target_id: 'overview-a', expected_url: overview, expected_name: '测试直播间', expected_start_time: '2026/10/14 19:03', label: '大屏' });

test('scene UI only clicks exact visible name/start row once and returns unverified destination', async () => {
  for (const label of ['大屏', '详情']) {
    const source = scenePage({ label });
    const result = await setup([source]).auxiliary_ui.run({ binding, input: { ...uiSpec(), label } });
    assert.equal(source.clicks, 1);
    assert.equal(result.room_id, '123');
    assert.equal(result.requires_snapshot, true);
    assert.equal(result.scene_verified, false);
    assert.equal(result.advertising_writes, 0);
  }
});

test('ambiguous scene rows, names or buttons reject before click', async () => {
  for (const opts of [{ count: 2 }, { nameCount: 2 }, { buttonCount: 2 }]) {
    const source = scenePage(opts);
    await assert.rejects(setup([source]).auxiliary_ui.run({ binding, input: uiSpec() }), error => /not_unique$/.test(error.code));
    assert.equal(source.clicks, 0);
  }
});

test('scene UI rejects account/ad actions and unexpected hrefs before click', async () => {
  const source = scenePage({ href: 'https://example.com/' });
  await assert.rejects(setup([source]).auxiliary_ui.run({ binding, input: uiSpec() }), { code: 'auxiliary_url_not_allowed' });
  assert.equal(source.clicks, 0);
  for (const label of ['删除', '投放', '切换账号', '设置']) {
    await assert.rejects(setup([source]).auxiliary_ui.run({ binding, input: { ...uiSpec(), label } }), { code: 'auxiliary_ui_options_invalid' });
  }
});

test('scene popup in another profile fails after exactly one click', async () => {
  const source = scenePage({ popupProfile: 'profile-b' });
  await assert.rejects(setup([source]).auxiliary_ui.run({ binding, input: uiSpec() }), { code: 'auxiliary_profile_mismatch' });
  assert.equal(source.clicks, 1);
});

test('observed live-overview paths are allowed, unobserved /shop/live route is not promoted', async () => {
  for (const suffix of ['', '/']) {
    const plan = page({ id: 'plan-a' });
    plan.popup = page({ url: overview + suffix, id: 'opened-overview' });
    const result = await setup([plan], { observedUrls: [{ browser_context_id: 'profile-a', url: overview + suffix }] }).auxiliary_open.run({ page: plan, binding, input: { url: overview + suffix } });
    assert.equal(result.opened, true);
  }
  const url = 'https://compass.jinritemai.com/shop/live', plan = page({ id: 'plan-a' });
  await assert.rejects(setup([plan], { observedUrls: [{ browser_context_id: 'profile-a', url }] }).auxiliary_open.run({ page: plan, binding, input: { url } }), { code: 'auxiliary_navigation_route_unverified' });
});
