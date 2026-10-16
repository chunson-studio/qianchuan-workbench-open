'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const { chromium } = createRequire(path.resolve(__dirname, '../server-app/package.json'))('playwright-core');
const { readQianchuanControlPages } = require('../tools/read-qc-control-pages.playwright.cjs');

const spec = { advertiser_id: '10001', primary_ad_id: '20001', date: '2026-10-15', pool: '调控中' };
const headers = ['', '任务名称', '素材', '调控状态', '调控预算(元)', '综合营销ROI目标', '支付ROI目标', '出价', '调控时长(小时)', '追投方式', '创建时间', '调控综合成本', '调控综合营销ROI', '调控成交订单数', '调控展示次数', '调控点击次数', '调控点击率', '调控转化率', '调控消耗'];
const ids = Array.from({ length: 233 }, (_, i) => String(30001 + i));
const normalPages = [ids.slice(0, 100), ids.slice(100, 200), ids.slice(200)];
const url = 'https://qianchuan.jinritemai.com/uni-prom/detail?aavid=10001&adId=20001&dateRange=2026-10-15%2C2026-10-15';

function html(options = {}) {
  const data = { pages: normalPages, initialPage: 1, size: 100, total: 233, headers, rowDelayMs: 0, ...options };
  return `<!doctype html><meta charset="utf-8">
  <p>计划ID：20001</p><p>ID：10001</p><button role="tab" aria-selected="true">调控</button>
  <input placeholder="开始日期" aria-label="开始日期" value="2026-10-15"><input placeholder="结束日期" aria-label="结束日期" value="2026-10-15">
  <input placeholder="请选择" aria-label="请选择"><input placeholder="请选择" aria-label="请选择"><input placeholder="请选择" aria-label="请选择" value="调控中">
  <input placeholder="输入任务名称或ID搜索" aria-label="输入任务名称或ID搜索">
  <div class="main-vmok-plugin-oc-table-wrapper"><table id="control"><thead><tr></tr></thead><tbody></tbody></table><div id="total"></div></div>
  <input id="page-size" readonly><ul class="main-vmok-plugin-page-turner"></ul>
  <script>
    const fixture = ${JSON.stringify(data).replaceAll('<', '\\u003c')};
    const state = window.fixtureState = { clicks: 0, page: fixture.initialPage, renderedPage: null, renders: [] };
    const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    const values = id => ['', '任务' + id + '\\nID: ' + id, '素材', '调控中', '100', '2.45', '-', '-', '12', '控成本追投', '2026-10-15 01:00', '5', '3', '1', '100', '10', '10%', '10%', '5'];
    document.querySelector('#page-size').value = fixture.size + '条/页';
    function renderRows(index) {
      const columns = fixture.headersByPage?.[index - 1] || fixture.headers;
      document.querySelector('#control thead tr').innerHTML = columns.map(h => '<th>' + escape(h) + '</th>').join('');
      document.querySelector('#control tbody').innerHTML = fixture.pages[index - 1].map(id => '<tr>' + columns.map(h => '<td>' + escape(values(id)[fixture.headers.indexOf(h)] ?? 'extra').replaceAll('\\n', '<br>') + '</td>').join('') + '</tr>').join('');
      document.querySelector('#total').textContent = '共 ' + (fixture.totalsByPage?.[index - 1] ?? fixture.total) + ' 条记录';
      state.renderedPage = index;
      state.renders.push(index);
    }
    function renderPager() {
      const pager = document.querySelector('.main-vmok-plugin-page-turner');
      pager.innerHTML = '<li>‹</li>' + fixture.pages.map((_, i) => '<li class="' + (i + 1 === state.page ? 'main-vmok-plugin-page-turner__item--active' : '') + '">' + (i + 1) + '</li>').join('') + '<li id="next" class="' + (state.page === fixture.pages.length ? 'main-vmok-plugin-page-turner__item--disabled' : '') + '"><span class="main-vmok-plugin-page-turner__next-icon">›</span></li>';
      pager.lastElementChild.addEventListener('click', () => {
        state.clicks++;
        if (state.page === fixture.pages.length) return;
        state.page++;
        renderPager();
        if (fixture.activeOnly) return;
        if (fixture.rowDelayMs) setTimeout(() => renderRows(state.page), fixture.rowDelayMs);
        else renderRows(state.page);
      });
    }
    renderRows(state.page);
    renderPager();
  </script>`;
}

let browser;
test.before(async () => {
  browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
});
test.after(async () => { await browser?.close(); });

async function withPage(options, callback) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    // Every request is fulfilled locally. No real account or platform is used.
    await context.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html(options) }));
    const page = await context.newPage();
    await page.goto(url);
    return await callback(page);
  } finally { await context.close(); }
}

test('100 / 100 / 33 real-browser pages preserve all 233 raw rows with only two next-page clicks', async () => {
  await withPage({}, async page => {
    const before = await page.locator('input').evaluateAll(inputs => inputs.map(input => input.value));
    const result = await readQianchuanControlPages(page, spec);
    assert.equal(result.complete, true);
    assert.equal(result.total, 233);
    assert.equal(result.visible_rows, 233);
    assert.equal(result.advertising_writes, 0);
    assert.deepEqual(result.pages.map(item => item.visible_rows), [100, 100, 33]);
    assert.deepEqual(result.tasks.map(item => item.task_id), ids);
    assert.deepEqual(result.headers, headers);
    assert.deepEqual(await page.locator('input').evaluateAll(inputs => inputs.map(input => input.value)), before);
    assert.deepEqual(await page.evaluate(() => fixtureState), { clicks: 2, page: 3, renderedPage: 3, renders: [1, 2, 3] });
  });
});

test('page limit rejects partial coverage before clicking next', async () => {
  await withPage({}, async page => {
    await assert.rejects(readQianchuanControlPages(page, spec, { maxPages: 2 }), { code: 'page_limit' });
    assert.equal(await page.evaluate(() => fixtureState.clicks), 0);
  });
});

test('starting on page 2 is rejected before changing pagination', async () => {
  await withPage({ initialPage: 2 }, async page => {
    await assert.rejects(readQianchuanControlPages(page, spec), { code: 'pagination_unverified' });
    assert.equal(await page.evaluate(() => fixtureState.clicks), 0);
  });
});

test('a duplicate ID across pages is rejected rather than counted as full coverage', async () => {
  const pages = normalPages.map(items => [...items]);
  pages[1][50] = pages[0][50];
  await withPage({ pages }, async page => {
    await assert.rejects(readQianchuanControlPages(page, spec), { code: 'duplicate_across_pages' });
    assert.equal(await page.evaluate(() => fixtureState.clicks), 1);
  });
});

test('changed totals on a later page invalidate the scan', async () => {
  await withPage({ totalsByPage: [233, 234, 233] }, async page => {
    await assert.rejects(readQianchuanControlPages(page, spec), { code: 'coverage_changed' });
  });
});

test('a changed but individually valid header on a later page invalidates the scan', async () => {
  await withPage({ headersByPage: [headers, [...headers, '新增字段'], headers] }, async page => {
    await assert.rejects(readQianchuanControlPages(page, spec), { code: 'coverage_changed' });
  });
});

test('changing the active page without updating old rows times out instead of accepting them', async () => {
  await withPage({ activeOnly: true }, async page => {
    await assert.rejects(readQianchuanControlPages(page, spec, { timeoutMs: 300 }), { name: 'TimeoutError' });
    assert.deepEqual(await page.evaluate(() => fixtureState), { clicks: 1, page: 2, renderedPage: 1, renders: [1] });
  });
});

test('an active page may change first, but row capture waits for the replacement rows', async () => {
  await withPage({ rowDelayMs: 250 }, async page => {
    const result = await readQianchuanControlPages(page, spec, { timeoutMs: 2000 });
    assert.deepEqual(result.tasks.map(item => item.task_id), ids);
    assert.deepEqual(result.pages.map(item => item.tasks[0].task_id), normalPages.map(items => items[0]));
    assert.equal(await page.evaluate(() => fixtureState.renderedPage), 3);
  });
});

test('a hidden stale control table cannot block the verified visible table from advancing', async () => {
  await withPage({}, async page => {
    await page.locator('.main-vmok-plugin-oc-table-wrapper').evaluate(table => {
      const hidden = table.cloneNode(true);
      hidden.style.display = 'none';
      hidden.querySelectorAll('[id]').forEach(element => element.removeAttribute('id'));
      table.before(hidden);
    });
    const result = await readQianchuanControlPages(page, spec, { timeoutMs: 500 });
    assert.equal(result.complete, true);
    assert.deepEqual(result.tasks.map(item => item.task_id), ids);
  });
});
