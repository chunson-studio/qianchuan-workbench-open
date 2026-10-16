'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { launchWorkbench } = require('./workbench-browser.cjs');
const noPlatformReads = run => assert.ok(run.apiCalls.every(c => c.method === 'GET'
  && ['/api/accounts', '/api/onboarding', '/api/workbench-snapshot', '/api/version'].includes(c.path)), JSON.stringify(run.apiCalls));

test('首次接入只有浏览器登录说明，无Cookie文件框；窄屏无溢出', async () => {
  const run = await launchWorkbench();
  try {
    const p = run.page; await p.goto(run.origin + '/v4#/onboarding');
    await p.locator('.onboard-welcome').waitFor();
    for (const width of [1440, 390]) { await p.setViewportSize({ width, height: 844 }); assert.equal(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth), false); }
    await p.getByRole('button', { name: '连接我的千川账户 →', exact: true }).click();
    await p.getByRole('heading', { name: '连接千川账户', exact: true }).waitFor();
    assert.equal(await p.locator('input[type=file],textarea').count(), 0);
    await p.getByRole('button', { name: '返回', exact: true }).click(); await p.locator('.onboard-welcome').waitFor();
    assert.deepEqual(run.errors, []); noPlatformReads(run);
  } finally { await run.close(); }
});
test('总览刷新、展开与切换只读本机；网站不显示罗盘数据，保留历史与待确认提示', async () => {
  const run = await launchWorkbench({ firstUse: false });
  try {
    const p = run.page; await p.goto(run.origin + '/v4#/overview'); await p.locator('.snapshot-toggle').waitFor();
    await p.locator('.workbench-sidebar [data-r=overview]').waitFor();
    assert.equal(await p.locator('.workbench-sidebar [data-r]').count(), 2);
    assert.equal(await p.locator('.snapshot-toggle').getAttribute('aria-expanded'), 'false');
    assert.match(await p.locator('.snapshot-toggle').innerText(), /历史数据/);
    assert.equal(await p.locator('.snapshot-panel').isVisible(), false);
    await p.locator('.snapshot-toggle').click(); await p.locator('.snapshot-card').waitFor();
    assert.match(await p.locator('.snapshot-card').innerText(), /有 1 项操作尚未确认/);
    assert.doesNotMatch(await p.locator('.snapshot-metrics').innerText(), /在线人数/);
    assert.equal(await p.locator('.snapshot-metrics > div').count(), 4);
    assert.doesNotMatch(await p.locator('#snapshotAccounts').innerText(), /操作回执|最近轮次|最近操作|同计划历史场次/);
    const firstTime = await p.locator('.snapshot-scene-meta').innerText();
    await p.getByRole('button', { name: '刷新本机记录', exact: true }).click();
    await p.waitForFunction(() => !document.querySelector('#snapshotRefresh').disabled);
    assert.equal(await p.locator('.snapshot-toggle').getAttribute('aria-expanded'), 'true');
    assert.equal(await p.locator('.snapshot-scene-meta').innerText(), firstTime);
    for (const width of [1440, 390]) { await p.setViewportSize({ width, height: 844 }); assert.equal(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth), false); }
    await p.locator('#nav [data-r=onboarding]').click(); await p.getByText('账户已连接', { exact: true }).waitFor();
    assert.equal(await p.locator('a[href*="compass.jinritemai.com"]').count(), 0);
    assert.doesNotMatch(await p.locator('#view').innerText(), /罗盘/);
    await p.locator('#nav [data-r=overview]').click(); await p.locator('.snapshot-toggle').waitFor();
    noPlatformReads(run); assert.deepEqual(run.errors, []);
  } finally { await run.close(); }
});

test('网站罗盘开关拦截请求；罗盘缺时间不拖累千川数据，功能仍可按配置恢复', async () => {
  const run = await launchWorkbench({ firstUse: false });
  try {
    const p = run.page, now = new Date().toISOString();
    await p.route('**/api/workbench-snapshot*', route => route.fulfill({ json: { ok: true, schema_version: 1,
      accounts: [{ id: 'ui-test', name: '示例品牌账户' }], max_age_seconds: 300, issues: [], sessions: [{ id: 'scene', account_id: 'ui-test', name: '直播间',
        binding: { primary_ad_id: '123', session_started_at: now }, captured_at: now, financial_at: now, online_at: null, freshness: 'unknown',
        live_state: 'live', metrics: { cost: 25, gmv: 300, roi: 8, cost_label: '整体消耗', roi_label: '净成交ROI', online: 0, active_tasks: 2 }, issues: [], pending_count: 0 }] } }));
    await p.goto(run.origin + '/v4#/overview'); await p.locator('.snapshot-toggle').waitFor();
    assert.match(await p.locator('.snapshot-toggle').innerText(), /最近已更新/);
    const codes = await p.evaluate(async () => {
      V4.setFeatures({ compass: true }); // Server feature updates must not enable this website-only switch.
      const codes = [];
      for (const endpoint of ['/api/compass/screen', '/api/compass/live-orders', '/compass_api/test']) {
        try { await V4.api(endpoint); codes.push('unexpected_success'); } catch (e) { codes.push(e.code); }
      }
      return codes;
    });
    assert.deepEqual(codes, Array(3).fill('website_compass_disabled'));
    noPlatformReads(run);
    // Isolated fixture only: opting in should retain the existing UI without a code rewrite.
    await p.route('**/v4', async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: (await response.text()).replace('data-website-compass="off"', 'data-website-compass="on"') });
    });
    await p.reload(); await p.locator('.snapshot-toggle').click(); await p.locator('.snapshot-metrics').waitFor();
    assert.match(await p.locator('.snapshot-metrics').innerText(), /在线人数\s+0/);
    assert.match(await p.locator('.snapshot-toggle').innerText(), /数据待确认/);
    await p.locator('.workbench-sidebar [data-r=onboarding]').click(); await p.getByText('账户已连接', { exact: true }).waitFor();
    assert.equal(await p.getByRole('link', { name: '打开罗盘', exact: true }).count(), 1);
    noPlatformReads(run); assert.deepEqual(run.errors, []);
  } finally { await run.close(); }
});
test('旧看盘、决策与复盘链接返回本机总览，不加载旧模块', async () => {
  const run = await launchWorkbench({ firstUse: false }), scripts = [];
  try {
    run.page.on('request', r => { if (r.url().includes('/v4/pages/')) scripts.push(r.url()); });
    for (const route of ['warroom', 'decisions', 'replay']) {
      await run.page.goto(run.origin + '/v4#/' + route); await run.page.locator('.snapshot-toggle').waitFor();
      assert.ok(run.page.url().endsWith('#/overview'));
    }
    assert.ok(scripts.every(s => s.includes('/overview.js'))); noPlatformReads(run); assert.deepEqual(run.errors, []);
  } finally { await run.close(); }
});
test('模块失败可以重试；时间解析保持场次一致', async () => {
  const run = await launchWorkbench();
  try {
    let attempts = 0;
    await run.page.route('**/v4/pages/onboarding.js?*', route => ++attempts === 1 ? route.abort('failed') : route.continue());
    await run.page.goto(run.origin + '/v4#/onboarding'); await run.page.getByRole('button', { name: '重新加载', exact: true }).click();
    await run.page.locator('.onboard-welcome').waitFor(); assert.equal(attempts, 2);
    const times = await run.page.evaluate(() => [V4.parseT('2026-10-09T02:00:00Z').toISOString(), V4.parseT('2026-10-09 10:00:00').toISOString()]);
    assert.equal(times[0], times[1]); noPlatformReads(run); assert.deepEqual(run.errors, []);
  } finally { await run.close(); }
});
test('示例完全留在浏览器，重开页面不重复加载模块，移动端与暗色可用', async () => {
  const run = await launchWorkbench(), scripts = [];
  try {
    const p = run.page; await p.addInitScript(() => localStorage.setItem('v4-acct', 'keep-real-choice'));
    p.on('request', r => { if (r.url().includes('/v4/pages/')) scripts.push(new URL(r.url()).pathname); });
    await p.goto(run.origin + '/v4?demo=1#/overview'); await p.locator('.snapshot-toggle').nth(1).waitFor();
    assert.equal(await p.evaluate(() => localStorage.getItem('v4-acct')), 'keep-real-choice');
    await p.locator('.workbench-sidebar [data-r=onboarding]').click(); await p.getByText('把工作台换成你的数据', { exact: true }).waitFor();
    await p.locator('.workbench-sidebar [data-r=overview]').click(); await p.locator('.snapshot-toggle').nth(1).waitFor();
    assert.equal(scripts.filter(s => s.endsWith('/overview.js')).length, 1);
    await p.setViewportSize({ width: 390, height: 844 }); await p.locator('#themeToggle').click();
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const result = await p.evaluate(async () => { const r = await fetch('/api/boost-create', { method: 'POST', body: '{}' }); return { status: r.status, body: await r.json() }; });
    assert.equal(result.status, 403); assert.equal(result.body.code, 'demo_read_only');
    assert.deepEqual(run.apiCalls, []); assert.deepEqual(run.errors, []);
  } finally { await run.close(); }
});

test('30个账号保持紧凑，单项展开、键盘收起、搜索和多计划数据彼此独立', async () => {
  const run = await launchWorkbench({ firstUse: false });
  try {
    const p = run.page, at = new Date(Date.now() - 600000).toISOString();
    const accounts = Array.from({ length: 30 }, (_, i) => ({ id: 'account-' + i, name: '测试账号 ' + String(i + 1).padStart(2, '0') }));
    await p.route('**/api/accounts*', route => route.fulfill({ json: { ok: true, accounts, archived_accounts: [] } }));
    await p.route('**/api/onboarding*', route => route.fulfill({ json: { ok: true, first_use: false, accounts, account: accounts[0],
      answers: {}, questions: [], next_questions: [], answered: [], authorization: { explanation: '测试' } } }));
    const scene = (id, plan, cost) => ({ id, account_id: 'account-0', name: '独立直播间 ' + plan,
      binding: { primary_ad_id: plan, session_started_at: at }, captured_at: at, financial_at: at, online_at: at,
      freshness: 'stale', live_state: 'live', metrics: { cost, roi: 8, cost_label: '整体消耗', roi_label: '净成交ROI', online: 0, active_tasks: null }, pending_count: 0, issues: [] });
    await p.route('**/api/workbench-snapshot*', route => route.fulfill({ json: { ok: true, schema_version: 1, accounts,
      sessions: [scene('one', '111', 25), scene('two', '222', 40)], issues: [], max_age_seconds: 300 } }));
    await p.goto(run.origin + '/v4#/overview'); await p.locator('.snapshot-toggle').nth(29).waitFor();
    assert.equal(await p.locator('.snapshot-account.is-open').count(), 0);
    assert.ok(await p.locator('.snapshot-account').first().evaluate(e => e.getBoundingClientRect().height <= 90));
    await p.locator('.snapshot-toggle').first().focus(); await p.keyboard.press('Enter');
    assert.equal(await p.locator('.snapshot-account.is-open').count(), 1);
    assert.equal(await p.locator('.snapshot-account.is-open .snapshot-card').count(), 2);
    assert.match(await p.locator('.snapshot-toggle').first().innerText(), /2 个主计划/);
    assert.doesNotMatch(await p.locator('.snapshot-toggle').first().innerText(), /65\.00/);
    await p.locator('.snapshot-toggle').nth(1).click();
    assert.equal(await p.locator('.snapshot-account.is-open').count(), 1);
    assert.equal(await p.locator('.snapshot-toggle').first().getAttribute('aria-expanded'), 'false');
    await p.locator('.snapshot-account.is-open .snapshot-empty').waitFor();
    await p.keyboard.press('Escape');
    assert.equal(await p.locator('.snapshot-account.is-open').count(), 0);
    await p.locator('#snapshotSearch').fill('测试账号 30');
    assert.equal(await p.locator('.snapshot-account').count(), 1);
    await p.locator('#snapshotSearch').fill('独立直播间');
    assert.equal(await p.locator('.snapshot-account').count(), 1);
    await p.locator('#snapshotSearch').fill('不存在的账号');
    assert.match(await p.locator('#snapshotAccounts').innerText(), /没有找到/);
    await p.locator('#snapshotSearch').fill('');
    await p.emulateMedia({ reducedMotion: 'reduce' });
    await p.setViewportSize({ width: 390, height: 844 });
    await p.locator('.snapshot-toggle').first().click();
    assert.equal(await p.locator('.snapshot-panel').first().evaluate(e => getComputedStyle(e).transitionDuration), '0s');
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await p.getByRole('button', { name: '管理账户', exact: true }).first().click();
    await p.getByText('账户已连接', { exact: true }).waitFor();
    assert.equal(await p.evaluate(() => localStorage.getItem('v4-acct')), 'account-0');
    noPlatformReads(run); assert.deepEqual(run.errors, []);
  } finally { await run.close(); }
});
