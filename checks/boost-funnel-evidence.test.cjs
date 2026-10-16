'use strict';
require('./setup-runtime.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildBoostFunnel, platformRate } = require('../server-app/server/lib/boostFunnel');
const { parseTask } = require('../server-app/server/lib/boostTaskContract');
const { slimBoostTask } = require('../server-app/server/lib/mcpClean');

test('numeric rates never guess units; explicit units, hidden cells and true zero stay distinct', () => {
  for (const value of [0, 0.05, 5, 1e-7]) {
    const r = platformRate(value);
    assert.equal(r.value, value); assert.equal(r.unit, 'unknown'); assert.equal(r.percent, null);
  }
  assert.equal(platformRate({ ValueStr: '0%' }).percent, 0);
  assert.equal(platformRate({ value: 0.05, unit: 'ratio' }).percent, 5);
  assert.equal(platformRate({ value: 5, unit: 'percent' }).percent, 5);
  for (const cell of [null, '', ' ', '--', true, -1, Infinity, { value: 0, controlType: 0 }, { value: 101, unit: 'percent' }, { value: 2, unit: 'ratio' }]) {
    assert.equal(platformRate(cell).value, null);
  }
  assert.equal(platformRate({ value: '5%', unit: 'ratio' }).reason, 'rate_unit_conflict');
});

test('list parsing and MCP trimming keep a single window and zero/missing funnel evidence', () => {
  const metrics = { showCntForRoi2Assist: { value: 0 }, clickCntForRoi2Assist: { value: 0 },
    ctrForRoi2Assist: { value: '0%' }, convertRateForRoi2Assist: { value: 0, controlType: 0 } };
  const task = parseTask({ id: 'funnel-task', adDeliveryName: '投放中' }, { id: 'plan' },
    { data: { adStatsMap: { 'funnel-task': { metrics } } } },
    { accountId: 'fixture', sourceAt: '2020-01-02T00:00:00Z', start: '2020-01-02', end: '2020-01-03' });
  assert.equal(task.funnel.show_cnt, 0); assert.equal(task.funnel.ctr.percent, 0);
  assert.equal(task.funnel.cvr.value, null);
  assert.deepEqual(task.funnel.window, { start: '2020-01-02', end: '2020-01-03', scope: 'date_range' });
  assert.equal(task.funnel.upstream_updated_at, null); assert.equal(task.funnel.freshness, 'unknown');
  assert.equal(task.funnel.joint_evidence_valid, false);
  assert.deepEqual(slimBoostTask(task).funnel, task.funnel);
});

test('daily report wins as a whole; list and separate real-time details cannot fill its missing funnel cells', async () => {
  const tabs = require('../server-app/server/lib/qianchuanTabs');
  const count = { report: 0, list: 0, summary: 0, detail: 0 };
  const at = '2020-01-02T01:00:00Z';
  tabs.fetchBoostTaskReport = async () => { count.report++; return { source_at: at, truncated: false, tasks: [
    { assistAid: 't1', cost: 1, gmv: 10, payRoi: 10, netRoi: 9, settleAmount: 9, orderCount: 1,
      showCnt: 0, clickCnt: 0, ctr: 0, convertRate: 0 },
    { assistAid: 't2', cost: 2, orderCount: 100, showCnt: 50, clickCnt: null, ctr: null, convertRate: null },
  ] }; };
  const metrics = { showCntForRoi2Assist: { value: 999 }, clickCntForRoi2Assist: { value: 99 },
    ctrForRoi2Assist: { value: '9.9%' }, convertRateForRoi2Assist: { value: '20%' } };
  tabs.fetchBoostList = async () => { count.list++; return { source_at: at, truncated: false, data: {
    adInfos: ['t1', 't2', 't3'].map(id => ({ id, adDeliveryName: '投放中',
      ...(id === 't1' ? { startTime: 1000, endTime: 22600 } : id === 't2' ? { startTime: 1000, endTime: 22600, duration_seconds: 23400 } : { deliverySeconds: 1234 }) })),
    adStatsMap: Object.fromEntries(['t1', 't2', 't3'].map(id => [id, { metrics }])) } }; };
  tabs.fetchBoostSummary = async () => { count.summary++; return { data: {} }; };
  tabs.fetchBoostMaterialDetail = async () => { count.detail++; return { source_at: '2020-01-02T02:00:00Z', data: { StatsData: { Totals: {
    show_cnt_for_roi2_assist: { Value: 1234 }, click_cnt_for_roi2_assist: { Value: 111 },
    total_pay_order_count_for_roi2_assist: { Value: 222 } } } } }; };
  const { getBoostMetricsToday, invalidateBoostMetrics } = require('../server-app/server/lib/metricsService');
  invalidateBoostMetrics('funnel-fixture');
  const opts = { today: '2020-01-02', sessionKey: 'funnel-fixture|room|2020-01-02 00:00:00',
    adInfos: [{ id: 'plan' }], fetchMaterialDetail: true, isLive: true };
  const result = await getBoostMetricsToday('funnel-fixture', opts);
  const [a, b, c] = result.tasks;
  assert.equal(a.show_cnt, 0); assert.equal(a.click_cnt, 0); assert.equal(a.funnel.ctr.value, 0);
  assert.equal(a.funnel.ctr.percent, null); assert.equal(a.funnel.collected_at, at);
  assert.equal(a.realtime_detail.values.show_cnt, 1234); assert.equal(a.funnel.source_type, 'boost_task_report');
  assert.equal(a.duration_seconds, 21600); assert.equal(a.duration_unit, 'seconds');
  assert.equal(b.duration_seconds, null); assert.equal(b.duration_reason, 'duration_fields_conflict');
  assert.equal(c.duration_seconds, null); // elapsed delivery cannot stand in for total duration.
  assert.equal(b.click_cnt, null); assert.equal(b.funnel.ctr.value, null); assert.equal(b.funnel.cvr.value, null);
  assert.deepEqual(b.funnel.missing_fields, ['click_cnt', 'ctr', 'cvr']); // 100 orders do not create a CVR.
  assert.equal(c.funnel.ctr.percent, 9.9); assert.equal(c.funnel.cvr.percent, 20);
  assert.equal(c.funnel.source_type, 'boost_list_stats');
  for (const t of result.tasks) {
    assert.equal(t.funnel.window.scope, 'daily'); assert.equal(t.funnel.joint_evidence_valid, false);
    assert.equal(t.session_metrics.data_valid, false);
  }
  assert.equal(await getBoostMetricsToday('funnel-fixture', opts), result);
  assert.deepEqual(count, { report: 1, list: 1, summary: 1, detail: 3 });
});

test('task card displays both rates together, labels unknown units and handles an older service without invented zero', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../server-app/server/public/v4/pages/warroom.js'), 'utf8');
  const from = source.indexOf('function boostFunnelMarkup('), to = source.indexOf('/* ===== 追投任务', from);
  assert.ok(from > 0 && to > from);
  const render = vm.runInNewContext('(' + source.slice(from, to).trim() + ')', {
    esc: value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;') });
  const f = buildBoostFunnel({ show_cnt: 0, click_cnt: 0, ctr: '0%', cvr: 0 },
    { start: '2020-01-02', end: '2020-01-02', scope: 'daily', sourceType: 'boost_task_report' });
  const html = render(f);
  assert.match(html, /展示 <b>0<\/b>/); assert.match(html, /点击率 <b>0\.00%/);
  assert.match(html, /转化率 <b>0（单位待核）/); assert.match(html, /日期累计/);
  assert.match(html, /非本场归因/); assert.match(html, /分母待核/);
  const old = render(undefined);
  assert.match(old, /展示 <b>--<\/b>/); assert.match(old, /转化率 <b>--<\/b>/);
  assert.doesNotMatch(old, />0/); assert.match(render({ window: { start: '<script>' } }), /&lt;script>/);
});

test('same-scope concurrent readers share one collection; different plans cannot reuse its cache', async () => {
  const tabs = require('../server-app/server/lib/qianchuanTabs');
  const { getBoostMetricsToday, invalidateBoostMetrics } = require('../server-app/server/lib/metricsService');
  const account = 'funnel-concurrent', reportResolvers = [], plans = [];
  tabs.fetchBoostTaskReport = () => new Promise(resolve => reportResolvers.push(resolve));
  tabs.fetchBoostList = async id => { plans.push(id); return { truncated: false, source_at: '2020-01-02T01:00:00Z', data: { adInfos: [] } }; };
  tabs.fetchBoostSummary = async () => ({ data: {} });
  const opts = { today: '2020-01-02', adInfos: [{ id: 'plan-a' }], isLive: true, sessionKey: 'same-scene' };
  invalidateBoostMetrics(account);
  const reads = Array.from({ length: 10 }, () => getBoostMetricsToday(account, opts));
  assert.equal(reportResolvers.length, 1);
  reportResolvers[0]({ source_at: '2020-01-02T01:00:00Z', tasks: [], truncated: false });
  const results = await Promise.all(reads);
  assert.ok(results.every(result => result === results[0])); assert.deepEqual(plans, ['plan-a']);
  const other = getBoostMetricsToday(account, { ...opts, adInfos: [{ id: 'plan-b' }] });
  assert.equal(reportResolvers.length, 2);
  reportResolvers[1]({ tasks: [], truncated: false }); await other;
  assert.deepEqual(plans, ['plan-a', 'plan-b']);
});

test('invalidation does not reuse or cache an older in-flight result; rejected reads release the shared slot', async () => {
  const tabs = require('../server-app/server/lib/qianchuanTabs');
  const { getBoostMetricsToday, invalidateBoostMetrics } = require('../server-app/server/lib/metricsService');
  const account = 'funnel-invalidate', resolvers = [];
  tabs.fetchBoostTaskReport = () => new Promise(resolve => resolvers.push(resolve));
  tabs.fetchBoostList = async () => ({ truncated: false, data: { adInfos: [] } });
  tabs.fetchBoostSummary = async () => ({ data: {} });
  const opts = { today: '2020-01-02', adInfos: [{ id: 'plan' }], sessionKey: 'scene' };
  invalidateBoostMetrics(account); const before = getBoostMetricsToday(account, opts);
  invalidateBoostMetrics(account); const after = getBoostMetricsToday(account, opts);
  assert.equal(resolvers.length, 2);
  resolvers[1]({ tasks: [], totals: { cost: 2 }, truncated: false }); const current = await after;
  resolvers[0]({ tasks: [], totals: { cost: 1 }, truncated: false }); assert.equal((await before).summary.total_cost, 1);
  assert.equal(await getBoostMetricsToday(account, opts), current); assert.equal(current.summary.total_cost, 2);
  let errors = 0;
  tabs.fetchBoostTaskReport = async () => { errors++; throw new Error('cookie_expired'); };
  invalidateBoostMetrics(account);
  await Promise.all([assert.rejects(getBoostMetricsToday(account, opts), /cookie_expired/), assert.rejects(getBoostMetricsToday(account, opts), /cookie_expired/)]);
  assert.equal(errors, 1); await assert.rejects(getBoostMetricsToday(account, opts), /cookie_expired/); assert.equal(errors, 2);
});
