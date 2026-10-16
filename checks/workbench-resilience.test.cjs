'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { launchWorkbench } = require('./workbench-browser.cjs');

for (const failure of ['blocked', 'quota']) {
  test(`浏览器存储 ${failure} 时仍可接入、切户和切换主题`, async () => {
    const run = await launchWorkbench({ firstUse: false });
    try {
      await run.page.addInitScript(mode => {
        if (mode === 'blocked') {
          for (const name of ['localStorage', 'sessionStorage']) Object.defineProperty(window, name, {
            get() { throw new DOMException('Storage disabled', 'SecurityError'); },
          });
        } else Storage.prototype.setItem = () => { throw new DOMException('Storage full', 'QuotaExceededError'); };
      }, failure);
      await run.page.goto(run.origin + '/v4?token=synthetic-test-token#/onboarding');
      await run.page.getByText('账户已连接', { exact: true }).waitFor();
      assert.equal(new URL(run.page.url()).searchParams.has('token'), false, '存储失败后仍清除地址栏里的测试令牌');
      const account = await run.page.evaluate(() => {
        V4.setAccounts([{ id: 'a', name: '测试甲' }, { id: 'b', name: '测试乙' }]);
        V4.setAcct('b'); return V4.acct();
      });
      assert.equal(account, 'b');
      await run.page.locator('#themeToggle').click();
      assert.equal(await run.page.evaluate(() => V4.theme()), 'dark');
      await run.page.locator('#themeToggle').click();
      assert.equal(await run.page.evaluate(() => V4.theme()), 'paper');
      let observedToken;
      await run.page.route('**/api/resilience-probe', route => {
        observedToken = route.request().headers()['x-api-token'];
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
      });
      await run.page.evaluate(() => V4.apiJson('/api/resilience-probe', 'POST', {}, { includeAccount: false }));
      assert.equal(observedToken, 'synthetic-test-token', '仅本页模拟接口验证令牌，未调用产品写入');
      assert.deepEqual(run.errors, []);
    } finally { await run.close(); }
  });
}

test('账户弹窗焦点留在弹窗内，关闭、切页或外部移除后恢复页面', async () => {
  const run = await launchWorkbench();
  try {
    const p = run.page;
    await p.goto(run.origin + '/v4?demo=1#/overview');
    await p.locator('.snapshot-toggle').nth(1).waitFor();
    const open = async () => {
      await p.getByRole('button', { name: '管理账号', exact: true }).click();
      await p.getByRole('dialog', { name: '账号管理', exact: true }).waitFor();
      assert.equal(await p.evaluate(() => document.activeElement.className), 'acct-manager-close');
    };
    await open();
    assert.equal(await p.locator('#view').evaluate(node => node.inert), true);
    await p.keyboard.press('Shift+Tab');
    assert.equal(await p.evaluate(() => document.activeElement.hasAttribute('data-onboarding')), true);
    await p.keyboard.press('Tab');
    assert.equal(await p.evaluate(() => document.activeElement.className), 'acct-manager-close');
    await p.keyboard.press('Escape');
    assert.equal(await p.locator('[role="dialog"]').count(), 0);
    assert.equal(await p.evaluate(() => document.activeElement.className), 'acct-manage');
    assert.equal(await p.locator('#view').evaluate(node => node.inert), false);
    await open();
    await p.evaluate(() => document.querySelector('.acct-manager-backdrop').remove());
    await p.waitForFunction(() => !document.querySelector('#view').inert && document.body.style.overflow === '');
    await open();
    await p.evaluate(() => { location.hash = '#/onboarding'; });
    await p.getByText('把工作台换成你的数据', { exact: true }).waitFor();
    assert.equal(await p.locator('[role="dialog"]').count(), 0);
    assert.equal(await p.locator('#view').evaluate(node => node.inert), false);
    assert.deepEqual(run.errors, []);
    assert.deepEqual(run.apiCalls, [], '示例未触发真实 API');
  } finally { await run.close(); }
});
