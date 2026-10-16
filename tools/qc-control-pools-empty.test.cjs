'use strict';
// Offline reproduction of the Oct 6 empty-table shape. No customer browser/profile/network.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { chromium } = require('../server-app/node_modules/playwright-core');
const cdp = require('./qc-control-pools.playwright.cjs');
const sandbox = { URL, module: { exports: {} } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'codex-qc-control-pools.cua.js'), 'utf8'), sandbox);
const headers = ['', '任务名称', '素材', '调控状态', '调控预算(元)', '净成交ROI目标', '支付ROI目标', '出价',
  '调控时长(小时)', '追投方式', '创建时间', '调控消耗', '调控支付ROI', '调控成交订单数', '调控转化率', '调控点击率'];
const task = ['', 'fixture\nID: 3001', '', '调控中', '200', '-', '-', '-', '8', '放量追投', '2026-10-06', '175.05', '9.31', '7', '4.76%', '13.64%'];

test('both reader channels handle verified zero tasks, reject ambiguous emptiness and map swapped rate columns', async t => {
  const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    for (const channel of ['codex-cua', 'playwright-cdp']) await t.test(channel, async () => {
      const context = await browser.newContext(), page = await context.newPage();
      try {
        const events = [];
        const cfg = { advertiser_id: '1001', primary_ad_id: '2001', date: '2026-10-06', pool: '调控中', on_checkpoint: async e => events.push(e) };
        let shape;
        await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `
          <div>计划ID：2001</div><div>ID：1001</div>
          <input aria-label="请选择开始日期" value="2026-10-06"><input aria-label="请选择结束日期" value="2026-10-06">
          <input aria-label="请选择"><input aria-label="请选择"><input id="state" aria-label="请选择" value="调控中">
          <div>全部（包括已删除）</div><div onclick="document.getElementById('state').value='${shape.filter ?? '调控中'}'">调控中</div>
          <table><thead><tr>${(shape.headers ?? headers).map(h => `<th>${h}</th>`).join('')}</tr></thead>
          <tbody>${shape.row ? `<tr>${task.map(c => `<td>${c}</td>`).join('')}</tr>` : ''}</tbody></table>
          <div>${shape.count}</div><div>${shape.empty}</div>` }));
        const tab = channel === 'codex-cua' ? { id: 'isolated-fixture', url: () => page.url(),
          getAXState: async () => page.locator('body').innerText(), playwright: {
            getByRole: (...args) => page.getByRole(...args), getByText: (...args) => page.getByText(...args),
            domSnapshot: async () => page.locator('body').innerText() } } : page;
        const read = channel === 'codex-cua' ? sandbox.module.exports.readQianchuanControlPool : cdp.readQianchuanControlPool;
        const check = async (value, expected) => {
          shape = value; events.length = 0;
          await page.goto('https://qianchuan.jinritemai.com/uni-prom/detail?aavid=1001&adId=2001');
          const out = await read(tab, cfg);
          assert.equal(out.ok, expected, JSON.stringify({ shape, out }));
          assert.equal(out.ad_writes, 0);
          assert.equal(events.at(-1).status, expected ? 'read_verified' : 'read_failed');
          return out;
        };
        for (const count of ['共0条任务', '共 0 条记录']) {
          const out = await check({ count, empty: '哎呀, 暂无数据' }, true);
          assert.equal(out.empty_verified, true); assert.equal(out.total, 0);
        }
        for (const value of [
          { count: '', empty: '暂无数据' }, { count: '共0条任务', empty: '' },
          { count: '共0条任务', empty: '加载中 暂无数据' },
          { count: '共0条任务 共1条记录', empty: '暂无数据' },
          { count: '共0条任务', empty: '暂无数据', headers: ['调控消耗'] },
          { count: '共0条任务', empty: '暂无数据', filter: '手动暂停' },
          { count: '共2条记录', empty: '', row: true },
        ]) await check(value, false);
        const out = await check({ count: '共1条任务 共1条记录', empty: '', row: true }, true);
        assert.equal(out.tasks[0].ctr_pct, 13.64);
        assert.equal(out.tasks[0].conversion_rate_pct, 4.76);
      } finally { await context.close(); }
    });
  } finally { await browser.close(); }
});
