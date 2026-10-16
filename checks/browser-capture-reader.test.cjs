'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../tools/codex-qc-read-once.cua.js'), 'utf8');
const context = { URL };
vm.runInNewContext(source, context, { filename: 'codex-qc-read-once.cua.js' });
const capturePage = context.runQianchuanCapturePage;
const date = '2026-09-23';
const headers = ['', '任务名称', '调控预算(元)', '调控消耗'];
const row = (id, spend = '10') => ['', `测试任务 任务ID: ${id}`, '100.00', spend];

function makeTab({
  pathname = '/uni-prom/detail',
  advertiserId = 'adv-1',
  primaryAdId = 'plan-1',
  dateValues = [date, date],
  rows = [headers, row('task-1'), row('task-2', '20')],
  snapshots = ['09-23 21:22 更新', '09-23 21:22 更新'],
  hiddenIdentity = [],
  urls,
  filterValues = ['全部', '全部', '全部（包括已删除）'],
  keywordValue = '',
  loadingCanDisappear = false,
  changeControlsAfterFirstTableRead = false,
  changeKeywordAfterFirstTableRead = false,
} = {}) {
  const dateParam = pathname === '/uni-prom/detail'
    ? `dr=${encodeURIComponent(`${date},${date}`)}`
    : `dateRange=${encodeURIComponent(JSON.stringify([date, date]))}`;
  const defaultUrl = `https://qianchuan.jinritemai.com${pathname}?aavid=${advertiserId}&adId=${primaryAdId}&${dateParam}`;
  let rowReadCount = 0;
  let snapshotReadCount = 0;
  let urlReadCount = 0;
  const events = [];
  const state = { filterValues: [...filterValues], keywordValue };
  const currentUrl = () => urls ? urls[Math.min(urlReadCount++, urls.length - 1)] : defaultUrl;
  const headerParent = {};
  const headerElements = headers.map(text => ({ innerText: text, parentElement: headerParent }));
  const readRows = () => {
    const readIndex = rowReadCount++;
    events.push(`table-read-${readIndex + 1}`);
    if (changeControlsAfterFirstTableRead && readIndex === 0) state.filterValues[0] = '筛选已变化';
    if (changeKeywordAfterFirstTableRead && readIndex === 0) state.keywordValue = '搜索已变化';
    const pageRows = Array.isArray(rows[0]?.[0]) ? rows[Math.min(readIndex, rows.length - 1)] : rows;
    return pageRows.map(cells => ({ cells: cells.map(innerText => ({ innerText })) }));
  };
  const tab = {
    events,
    async url() { return currentUrl(); },
    async reload() { events.push('reload'); },
    async getAXState() { events.push('ax'); return {}; },
    playwright: {
      getByText(value, options = {}) {
        if (value === '加载中...' && options.exact === true) {
          const snapshotBeforeWait = snapshots[Math.min(snapshotReadCount - 1, snapshots.length - 1)];
          return {
            async waitFor(waitOptions) {
              events.push(`loading-wait:${waitOptions.state}:${waitOptions.timeoutMs}`);
              if (waitOptions.state !== 'hidden' || waitOptions.timeoutMs !== 3000) throw new Error('unexpected loading wait options');
              if (!snapshotBeforeWait.includes('加载中...')) return;
              if (!loadingCanDisappear) throw new Error('timed out waiting for loader to hide');
            },
          };
        }
        const visible = !hiddenIdentity.includes(value) && (value === `计划ID：${primaryAdId}` || value === `ID：${advertiserId}`);
        return {
          async waitFor() { if (!visible) throw new Error('identity text not visible'); },
          async count() { return visible ? 1 : 0; },
        };
      },
      getByRole(role, options = {}) {
        if (role === 'textbox') {
          if (options.name === '请选择' && options.exact === true) return {
            async count() { return state.filterValues.length; },
            async evaluateAll(fn) { return fn(state.filterValues.map(value => ({ value }))); },
          };
          if (options.name === '输入任务名称或ID搜索' && options.exact === true) return {
            async count() { return 1; },
            async evaluate(fn) { return fn({ value: state.keywordValue }); },
          };
          return {
            async evaluateAll(fn) { return fn([...dateValues, ...state.filterValues, state.keywordValue].map(value => ({ value }))); },
          };
        }
        if (role === 'row') return {
          async evaluateAll(fn) { return fn(readRows()); },
        };
        if (role === 'columnheader') {
          if (options.name === '任务名称') return {
            async waitFor() { return; }, async count() { return 1; },
          };
          return {
            async evaluateAll(fn) {
              if (options.name === undefined) return fn(headerElements);
              return fn(headerElements.filter(element => element.innerText === options.name));
            },
          };
        }
        throw new Error(`unexpected role ${role}`);
      },
      locator(selector) {
        assert.equal(selector, 'table tr');
        return { async evaluateAll(fn) { return fn(readRows()); } };
      },
      async domSnapshot() { return snapshots[Math.min(snapshotReadCount++, snapshots.length - 1)]; },
    },
  };
  return tab;
}

const config = { account_id: 'account_adv-1', advertiser_id: 'adv-1', primary_ad_id: 'plan-1', date };

test('captures all visible old 全域 rows with schema 1.0 after refresh and labels coverage as current page only', async () => {
  const tab = makeTab();
  const result = await capturePage(tab, config);
  assert.equal(result.ok, true, result.error);
  assert.equal(tab.events.filter(event => event === 'reload').length, 1);
  assert.ok(tab.events.indexOf('reload') < tab.events.findIndex(event => event.startsWith('table-read')));
  assert.equal(result.capture.schema_version, '1.0');
  assert.equal(result.capture.source, 'browser_dom');
  assert.equal(result.capture.page.plan_type, 'quan_yu');
  assert.deepEqual(Array.from(result.capture.page.rows, values => values[1]), ['测试任务 任务ID: task-1', '测试任务 任务ID: task-2']);
  assert.equal(result.capture.page.coverage.scope, 'current_page_only');
  assert.equal(result.capture.page.total_count, null);
  assert.equal(result.capture.page.metric_applicability.comprehensive_roi, 'not_applicable');
  assert.equal(result.capture.page.status_filter, '全部（包括已删除）');
  assert.deepEqual(Array.from(result.capture.page.filters), ['全部', '全部', '全部（包括已删除）']);
  assert.equal(result.capture.page.keyword, '');
  assert.equal(result.capture.page.coverage.page_number, null);
  assert.equal(result.capture.page.coverage.page_size, null);
  assert.ok(Date.parse(result.capture.timing.refresh_started_at) <= Date.parse(result.capture.timing.refresh_completed_at));
  assert.ok(Date.parse(result.capture.timing.refresh_completed_at) <= Date.parse(result.capture.timing.captured_at));
});

test('captures the evidenced 乘方 summary separately and retains all task rows', async () => {
  const qfangHeaders = ['', '任务名称', '调控预算(元)', '调控消耗'];
  const qfangRows = [qfangHeaders, ['', '任务A ID: task-1', '100', '10'], ['', '任务B ID: task-2', '100', '20'], ['', '共4条任务']];
  const tab = makeTab({ pathname: '/overall-prom/detail', rows: qfangRows });
  const result = await capturePage(tab, config);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.capture.page.plan_type, 'cheng_fang');
  assert.equal(result.capture.page.metric_applicability.comprehensive_roi, 'applicable');
  assert.equal(result.capture.page.status_filter, null);
  assert.equal(result.capture.page.filters, null);
  assert.equal(result.capture.page.keyword, null);
  assert.equal(result.capture.page.rows.length, 2);
  assert.equal(result.capture.page.total_count, 4);
  assert.deepEqual(Array.from(result.capture.page.summary_rows[0]), ['', '共4条任务']);
});

test('fails closed on account/date identity mismatch, a loading table, duplicate IDs, and row-width mismatch', async (t) => {
  await t.test('URL identity mismatch', async () => {
    const result = await capturePage(makeTab(), { ...config, advertiser_id: 'other' });
    assert.equal(result.ok, false);
    assert.match(result.error, /URL不匹配/);
  });
  await t.test('visible date mismatch', async () => {
    const result = await capturePage(makeTab({ dateValues: ['2026-09-22', date] }), config);
    assert.equal(result.ok, false);
    assert.match(result.error, /日期范围/);
  });
  await t.test('visible account identity missing', async () => {
    const result = await capturePage(makeTab({ hiddenIdentity: ['ID：adv-1'] }), config);
    assert.equal(result.ok, false);
    assert.match(result.error, /not visible/);
  });
  await t.test('loading', async () => {
    const result = await capturePage(makeTab({ snapshots: ['追投表加载中', '追投表加载中'] }), config);
    assert.equal(result.ok, false);
    assert.match(result.error, /仍在加载/);
  });
  await t.test('loading disappears before table read', async () => {
    const tab = makeTab({
      snapshots: ['追投表加载中...', '09-23 21:22 更新', '09-23 21:22 更新'],
      loadingCanDisappear: true,
    });
    const result = await capturePage(tab, config);
    assert.equal(result.ok, true, result.error);
    assert.ok(tab.events.includes('loading-wait:hidden:3000'));
    assert.ok(tab.events.indexOf('loading-wait:hidden:3000') < tab.events.findIndex(event => event.startsWith('table-read-')));
    assert.equal(tab.events.filter(event => event === 'reload').length, 1);
    assert.equal(tab.events.some(event => event.includes('click')), false);
  });
  await t.test('persistent exact loading indicator fails after the bounded wait', async () => {
    const result = await capturePage(makeTab({ snapshots: ['追投表加载中...'] }), config);
    assert.equal(result.ok, false);
    assert.match(result.error, /仍在加载/);
  });
  await t.test('other loading text remains a failure after reread', async () => {
    const result = await capturePage(makeTab({ snapshots: ['Loading task table', 'Loading task table'] }), config);
    assert.equal(result.ok, false);
    assert.match(result.error, /仍在加载/);
  });
  await t.test('duplicate task ID', async () => {
    const result = await capturePage(makeTab({ rows: [headers, row('task-1'), row('task-1')] }), config);
    assert.equal(result.ok, false);
    assert.match(result.error, /重复/);
  });
  await t.test('task row width mismatch', async () => {
    const result = await capturePage(makeTab({ rows: [headers, ['', '任务ID: task-1', '100']] }), config);
    assert.equal(result.ok, false);
    assert.match(result.error, /行宽/);
  });
});

test('fails closed when table contents change during the capture', async () => {
  const changingPages = [
    [headers, row('task-1', '10')],
    [headers, row('task-1', '11')],
  ];
  const result = await capturePage(makeTab({ rows: changingPages }), config);
  assert.equal(result.ok, false);
  assert.match(result.error, /状态发生变化/);
});

test('fails closed when an observed filter changes during the capture', async () => {
  const result = await capturePage(makeTab({ changeControlsAfterFirstTableRead: true }), config);
  assert.equal(result.ok, false);
  assert.match(result.error, /筛选或搜索状态发生变化/);
});

test('fails closed when the search value changes during the capture', async () => {
  const result = await capturePage(makeTab({ changeKeywordAfterFirstTableRead: true }), config);
  assert.equal(result.ok, false);
  assert.match(result.error, /筛选或搜索状态发生变化/);
});

test('retains the global status filter as raw text and leaves it unknown when blank', async () => {
  const result = await capturePage(makeTab({ filterValues: ['追投方式', '优化目标', ''] }), config);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.capture.page.status_filter, null);
  assert.deepEqual(Array.from(result.capture.page.filters), ['追投方式', '优化目标', '']);
});

test('rejects URL plan type that disagrees with the explicit config', async () => {
  const result = await capturePage(makeTab({ pathname: '/overall-prom/detail' }), { ...config, plan_type: 'quan_yu' });
  assert.equal(result.ok, false);
  assert.match(result.error, /计划类型/);
});

test('awaits evidence persistence after each verified action before proceeding', async () => {
  const tab = makeTab();
  const seen = [];
  const result = await capturePage(tab, { ...config, on_verified: async (id, evidence) => {
    await Promise.resolve();
    seen.push(id);
    if (id === 'common.identity.verify') assert.equal(tab.events.includes('reload'), false);
    if (id === 'common.page.reload') assert.equal(tab.events.some(e => e.startsWith('table-read')), false);
    if (id === 'common.table.read_headers_and_row') assert.equal(evidence.row_count, 2);
  } });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(seen, ['common.identity.verify', 'common.page.reload', 'common.table.read_headers_and_row']);
});

test('does not continue refreshing when identity evidence cannot be saved', async () => {
  const tab = makeTab();
  const result = await capturePage(tab, { ...config, on_verified: async () => { throw new Error('disk full'); } });
  assert.equal(result.ok, false);
  assert.match(result.error, /disk full/);
  assert.equal(tab.events.includes('reload'), false);
});
