'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createPlaywrightBrowserAdapter,
  PlaywrightBrowserAdapterError,
  structuredError,
} = require('../tools/lib/playwright-browser-adapter.cjs');

const binding = { advertiser_id: 'adv-1', primary_ad_id: 'plan-1', date: '2026-09-24' };
function makeLocator(text = '任务文本') {
  const raw = {
    async click() { return 'clicked'; },
    async fill(value) { return value; },
    async count() { return 1; },
    async innerText() { return text; },
    async textContent() { return text; },
    async allTextContents() { return [text]; },
    async evaluateAll(fn) { return fn([{ innerText: text }]); },
    async evaluate(fn) { return fn({ innerText: text, value: text }); },
    async getAttribute() { return null; },
    async isChecked() { return false; },
    async isVisible() { return true; },
    async waitFor() {},
    first() { return this; },
    last() { return this; },
    nth() { return this; },
    filter() { return this; },
    getByRole() { return this; },
    getByText() { return this; },
    getByPlaceholder() { return this; },
    getByLabel() { return this; },
    getByTestId() { return this; },
  };
  return raw;
}

function makePage(initialUrl = 'https://qianchuan.jinritemai.com/uni-prom/detail?aavid=adv-1&adId=plan-1&dr=2026-09-24%2C2026-09-24') {
  const state = { url: initialUrl, reloads: 0 };
  const page = {
    state,
    url() { return state.url; },
    async reload() { state.reloads += 1; },
    async title() { return '千川'; },
    async content() { return '<body>任务文本</body>'; },
    locator(selector) { assert.equal(selector, 'body'); return makeLocator('页面文本'); },
    getByRole() { return makeLocator(); },
    getByText() { return makeLocator(); },
    getByPlaceholder() { return makeLocator(); },
    getByLabel() { return makeLocator(); },
    getByTestId() { return makeLocator(); },
  };
  return page;
}

test('connects an injected browser without requiring playwright and verifies identity', async () => {
  const page = makePage();
  const browser = { contexts: () => [{ pages: () => [page] }] };
  const adapter = createPlaywrightBrowserAdapter({ browser });
  const connected = await adapter.connect(binding);
  assert.equal(connected.ok, true);
  assert.equal(await adapter.currentUrl(), page.state.url);
  const identity = await adapter.assertIdentity({ advertiser_id: 'adv-1', primary_ad_id: 'plan-1', date: '2026-09-24' });
  assert.deepEqual(identity.checked, ['advertiser_id', 'primary_ad_id', 'date_range']);
  const refreshed = await adapter.reload({ waitUntil: 'domcontentloaded' });
  assert.equal(refreshed.reloaded, true);
  assert.equal(page.state.reloads, 1);
  assert.equal(await adapter.domSnapshot(), '页面文本');
  const workflowTab = adapter.asReadWorkflowTab();
  assert.equal(typeof workflowTab.url, 'function');
  assert.equal(typeof workflowTab.reload, 'function');
  assert.equal(typeof workflowTab.getAXState, 'function');
  assert.equal(await workflowTab.playwright.domSnapshot(), '页面文本');
  assert.equal((await workflowTab.getAXState()).accessibility.source, 'playwright-dom');
  await adapter.close();
});

test('supports explicit reads and actions through an identity-bound CDP page', async () => {
  const page = makePage();
  const browser = { contexts: () => [{ pages: () => [page] }], close: async () => { browser.closed = true; } };
  const playwright = { chromium: { connectOverCDP: async endpoint => { assert.equal(endpoint, 'http://127.0.0.1:9222'); return browser; } } };
  const adapter = createPlaywrightBrowserAdapter({ playwright, cdp_url: 'http://127.0.0.1:9222', profile_name: 'Profile-1', browser_id: 'runtime-1', close_browser: true });
  assert.deepEqual(adapter.browserIdentity(), {
    browserType: 'playwright-cdp',
    profileName: 'Profile-1',
    cdpEndpoint: 'http://127.0.0.1:9222',
    browserId: 'runtime-1',
  });
  assert.equal((await adapter.connect(binding)).ok, true);
  const exposed = adapter.page();
  assert.equal(typeof exposed.locator, 'function');
  assert.equal(Object.hasOwn(exposed, 'click'), false);
  const locator = adapter.getByRole('row', { name: '任务' });
  assert.equal(typeof locator.count, 'function');
  assert.equal(await locator.click(), 'clicked');
  assert.equal(await locator.getByRole('textbox').fill('new'), 'new');
  assert.equal(await locator.innerText(), '任务文本');
  const closed = await adapter.close();
  assert.equal(closed.browser_closed, true);
  assert.equal(browser.closed, true);
});

test('fails closed with structured errors for unavailable playwright and identity mismatches', async () => {
  const unavailable = createPlaywrightBrowserAdapter({ playwright_package: '__missing_playwright_for_test__', cdp_url: 'http://127.0.0.1:9222' });
  await assert.rejects(unavailable.connect(), error => {
    assert.equal(error instanceof PlaywrightBrowserAdapterError, true);
    assert.equal(error.code, 'playwright_unavailable');
    assert.equal(structuredError(error).ok, false);
    return true;
  });

  const adapter = createPlaywrightBrowserAdapter({ page: makePage('http://qianchuan.jinritemai.com/uni-prom/detail?aavid=other&adId=plan-1&dr=2026-09-24%2C2026-09-24') });
  await assert.rejects(adapter.assertIdentity({ advertiser_id: 'adv-1' }), { code: 'browser_origin_mismatch' });
  const mismatch = createPlaywrightBrowserAdapter({ page: makePage() });
  await assert.rejects(mismatch.assertIdentity({ advertiser_id: 'other' }), { code: 'browser_identity_mismatch' });
});

test('does not expose a page before connect or after close', async () => {
  const adapter = createPlaywrightBrowserAdapter({ page: makePage() });
  await adapter.connect(binding);
  await adapter.close();
  assert.throws(() => adapter.page(), { code: 'browser_adapter_closed' });
});
test('owns and releases its CDP connection but leaves injected browser ownership with caller', async () => {
  let closes=0;
  const browser={contexts:()=>[{pages:()=>[makePage()]}],close:async()=>{closes++;}};
  const adapter=createPlaywrightBrowserAdapter({playwright:{chromium:{connectOverCDP:async()=>browser}},cdp_url:'http://127.0.0.1:9222'});
  await adapter.connect(binding);await adapter.close();assert.equal(closes,1);
  const borrowed=createPlaywrightBrowserAdapter({browser});
  await borrowed.connect(binding);await borrowed.close();assert.equal(closes,1);
});
test('reconnection cannot silently change dates and snapshot rejects an in-flight account switch',async()=>{
  const page=makePage(),adapter=createPlaywrightBrowserAdapter({page});
  await adapter.connect(binding);
  await assert.rejects(adapter.connect({...binding,date:'2026-09-25'}),{code:'browser_binding_conflict'});
  page.locator=()=>({innerText:async()=>{page.state.url=page.state.url.replace('adv-1','adv-2');return 'wrong account';}});
  await assert.rejects(adapter.domSnapshot(),{code:'browser_identity_mismatch'});
});
