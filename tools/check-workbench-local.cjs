'use strict';
// Isolated browser, real local service, GET only. Never reuse a customer's browser or credentials.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('../server-app/node_modules/playwright-core');
const { entryIdentity } = require('../server-app/scripts/start-workbench');
const args = process.argv.slice(2), value = key => args.includes(key) ? args[args.indexOf(key) + 1] : null;
const origin = new URL(value('--url') || 'http://127.0.0.1:18991').origin;
assert.ok(['127.0.0.1', '[::1]', 'localhost'].includes(new URL(origin).hostname), 'loopback only');
const allowed = new Set(['/api/accounts', '/api/onboarding', '/api/workbench-snapshot', '/api/version']);
async function main() {
  const health = await fetch(origin + '/health/live').then(r => r.json());
  assert.equal(health.entrypoint_id, entryIdentity(path.resolve(__dirname, '../server-app/server.js')));
  const response = await fetch(origin + '/api/workbench-snapshot');
  assert.equal(response.status, 200); assert.match(response.headers.get('cache-control'), /no-store/);
  const data = await response.json();
  assert.equal(data.ok, true); assert.equal(data.source, 'local_only'); assert.equal(data.upstream_requests, 0);
  const unknown = await fetch(origin + '/api/workbench-snapshot?account=__not_a_registered_account__');
  assert.equal(unknown.status, 400);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const calls = [], blocked = [], errors = [];
  try {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 960 } });
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error' && /ReferenceError|TypeError/.test(m.text())) errors.push(m.text()); });
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin !== origin || req.method() !== 'GET' || (url.pathname.startsWith('/api/') && !allowed.has(url.pathname))) {
        blocked.push({ path: url.pathname, method: req.method() }); return route.abort('blockedbyclient');
      }
      if (url.pathname.startsWith('/api/')) calls.push(url.pathname);
      return route.continue();
    });
    await page.goto(origin + '/v4#/overview');
    await page.locator('.workbench-sidebar [data-r=overview]').waitFor();
    assert.equal(await page.evaluate(() => V4.websiteFeatures.compass), false);
    assert.equal(await page.locator('.workbench-sidebar [data-r]').count(), 2);
    if (data.accounts.length) {
      await page.locator('.snapshot-account').first().waitFor();
      assert.equal(await page.locator('.snapshot-account').count(), data.accounts.length);
      assert.equal(await page.locator('.snapshot-account.is-open').count(), 0);
      await page.locator('.snapshot-toggle').first().click();
      assert.equal(await page.locator('.snapshot-account.is-open').count(), 1);
      await page.getByRole('button', { name: '刷新本机记录', exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('#snapshotRefresh').disabled);
      assert.equal(await page.locator('.snapshot-account.is-open').count(), 1);
      if (data.accounts.length > 1) {
        await page.locator('.snapshot-toggle').nth(1).click();
        assert.equal(await page.locator('.snapshot-account.is-open').count(), 1);
        assert.equal(await page.locator('.snapshot-toggle').first().getAttribute('aria-expanded'), 'false');
      }
      assert.doesNotMatch(await page.locator('#snapshotAccounts').innerText(), /操作回执|最近轮次|最近操作|同计划历史场次/);
      assert.doesNotMatch(await page.locator('#snapshotAccounts').innerText(), /在线人数/);
    }
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    }
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.locator('.workbench-sidebar [data-r=onboarding]').click();
    await page.locator('.ob-content .ob-card').first().waitFor();
    assert.equal(await page.locator('a[href*="compass.jinritemai.com"]').count(), 0);
    assert.doesNotMatch(await page.locator('#view').innerText(), /罗盘/);
    assert.deepEqual(blocked, []); assert.deepEqual(errors, []);
  } finally { await browser.close(); }
  const result = { ok: true, at: new Date().toISOString(), pid: health.pid, accounts: data.accounts.length,
    sessions: data.sessions.length, issues: data.issues, freshness: data.sessions.reduce((a,s) => ({...a,[s.freshness]:(a[s.freshness]||0)+1}), {}),
    api_paths: [...new Set(calls)], website_compass_enabled: false, blocked, errors, screenshots: 0, platform_actions: 0 };
  if (value('--output')) fs.writeFileSync(value('--output'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
