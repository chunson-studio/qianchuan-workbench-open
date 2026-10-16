'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeBrowserBoostCapture } = require('../server-app/server/lib/browserBoostSnapshot');

const headers = ['调控任务', '调控状态', '预算', '调控消耗', '调控成交订单数', '调控综合营销ROI'];
function capture(overrides = {}) {
  const base = {
    schema_version: '1.0',
    binding: { account_id: 'account_acct-1', advertiser_id: 'acct-1', primary_ad_id: 'plan-2', target_ids: ['task-7', 'task-8'] },
    page: {
      url: 'https://qianchuan.jinritemai.com/overall-prom/detail?aavid=acct-1&adId=plan-2&dateRange=%5B%222026-09-22%22%2C%222026-09-23%22%5D',
      advertiser_id: 'acct-1', primary_ad_id: 'plan-2', date_range: ['2026-09-22', '2026-09-23'],
      updated_at_label: '09:30更新', status_filter: '全部', headers,
      rows: [['夏日计划 任务ID: task-7', '投放中', '1,000', '250.50', '0', '1.234']], total_count: 2,
    },
    timing: { refresh_started_at: '2026-09-23T01:29:00.000Z', refresh_completed_at: '2026-09-23T01:29:03.000Z', captured_at: '2026-09-23T01:29:04.000Z' },
  };
  return { ...base, ...overrides, binding: { ...base.binding, ...(overrides.binding || {}) },
    page: { ...base.page, ...(overrides.page || {}) }, timing: { ...base.timing, ...(overrides.timing || {}) } };
}
const NOW = new Date('2026-09-23T01:29:05.000Z');

test('maps columns by exact header after reorder, preserves supplied ROI, and records page-limited coverage', () => {
  const c = capture({ page: { headers: ['调控综合营销ROI', '调控消耗', '任务名称', '调控成交订单数', '调控预算', '状态'],
    rows: [['1.234', '250.50', '夏日计划 (任务ID: task-7)', '0', '1,000', '投放中']] } });
  const s = normalizeBrowserBoostCapture(c, { now: NOW });
  assert.equal(s.boosts[0].roi, 1.234);
  assert.equal(s.boosts[0].orders, 0);
  assert.deepEqual(s.boosts[0].metrics.comprehensive_roi, { value: 1.234, unit: 'ratio', status: 'available', source_label: '调控综合营销ROI' });
  assert.equal(s.boosts[0].metrics.payment_orders.status, 'available');
  assert.equal(s.boosts[0].metrics.net_orders.status, 'missing');
  assert.equal(s.boosts[0].budget, 1000);
  assert.equal(s.boosts[0].budget_progress_pct, null);
  assert.deepEqual(s.boost_coverage.target_missing, ['task-8']);
  assert.equal(s.boost_coverage.list_complete, false);
  assert.equal(s.meta.schema_version, '2.1');
  assert.equal(s.meta.session_key, null);
  assert.equal(s.boost_coverage.live_recommendation_eligible, false);
  assert.equal(s.metrics_scope.start, '2026-09-22');
});

test('maps dash and blank as null while retaining zero', () => {
  const c = capture({ page: { rows: [['任务ID: task-7', '投放中', '-', '--', '0', '0']] } });
  const boost = normalizeBrowserBoostCapture(c, { now: NOW }).boosts[0];
  assert.equal(boost.budget, null);
  assert.equal(boost.cost, null);
  assert.equal(boost.orders, 0);
  assert.equal(boost.roi, 0);
  assert.equal(boost.metrics.cost.status, 'unknown');
  assert.equal(boost.metrics.payment_orders.value, 0);
  assert.equal(boost.metrics.comprehensive_roi.value, 0);
});

test('keeps comprehensive cost distinct and rejects malformed grouping or negative counts and amounts', () => {
  const costHeaders = [...headers, '调控综合成本'];
  const c = capture({ page: { headers: costHeaders, rows: [['任务ID: task-7', '投放中', '1,000', '250', '2', '1.2', '30']] } });
  const boost = normalizeBrowserBoostCapture(c, { now: NOW }).boosts[0];
  assert.equal(boost.comprehensive_cost, 30);
  assert.equal('cost_per_order' in boost, false);
  for (const [fieldIndex, value] of [[2, '-1'], [3, '-0.5'], [4, '-1'], [3, '12,34']]) {
    const row = ['任务ID: task-7', '投放中', '100', '10', '2', '1.2'];
    row[fieldIndex] = value;
    assert.throws(() => normalizeBrowserBoostCapture(capture({ page: { rows: [row] } }), { now: NOW }), { code: 'invalid_numeric_value' });
  }
  const malformed = capture({ page: { rows: [['任务ID: task-7', '投放中', '100元', '10', '2', '1.2']] } });
  assert.throws(() => normalizeBrowserBoostCapture(malformed, { now: NOW }), { code: 'invalid_numeric_value' });
});

test('accepts observed legacy headers with units but marks missing order and comprehensive ROI as readonly-only gaps', () => {
  const c = capture({ page: {
    headers: ['', '任务名称', '素材', '调控状态', '调控预算(元)', '净成交ROI目标', '支付ROI目标', '出价', '调控时长(小时)', '追投方式', '创建时间', '调控消耗', '调控支付ROI', '调控点击次数', '调控点击率', '调控转化率', '调控成交金额'],
    rows: [['', '夏日计划 任务ID: task-7', '', '投放中', '1,000', '2', '2.1', '', '2', '', '', '250.50', '1.23', '0', '', '', '300']],
  } });
  const s = normalizeBrowserBoostCapture(c, { now: NOW });
  assert.equal(s.readonly_only, true);
  assert.equal(s.boosts[0].budget, 1000);
  assert.equal(s.boosts[0].orders, null);
  assert.equal(s.boosts[0].roi, null);
  assert.deepEqual(s.boost_coverage.needs_columns, ['调控成交订单数', '调控综合营销ROI']);
  assert.equal(s.boosts[0].payment_roi, 1.23);
  assert.equal(s.boosts[0].metrics.duration_seconds.value, 7200);
  assert.equal(s.boosts[0].metrics.duration_seconds.unit, 's');
});

test('normalizes a captured 乘方 page without conflating cost, ROI, and net-order metrics', () => {
  const qfangHeaders = ['', '任务名称', '素材', '调控状态', '调控预算(元)', '综合营销ROI目标', '支付ROI目标', '出价',
    '调控时长(小时)', '追投方式', '创建时间', '调控综合成本', '调控综合营销ROI', '调控综合订单成本', '调控展示次数',
    '调控点击次数', '调控净成交ROI', '调控净成交金额', '调控净成交订单数', '调控消耗'];
  const qfang = capture({
    source: 'browser_dom',
    page: {
      url: 'https://qianchuan.jinritemai.com/overall-prom/detail?aavid=acct-1&adId=plan-2&dateRange=%5B%222026-09-22%22%2C%222026-09-23%22%5D',
      plan_type: 'cheng_fang', metric_applicability: { comprehensive_roi: 'applicable' },
      coverage: { scope: 'current_page_only', page_number: 1, page_size: 20 },
      headers: qfangHeaders,
      rows: [['', '画面测试 任务ID: task-7', '直播间画面 ID：material-2', '调控中', '200.00', '-', '-', '-',
        '7.5\n预计 09-24 03:45 结束', '放量追投', '2026-09-23\n20:44:42', '25.92', '7.60', '12.96', '316', '37',
        '6.90', '197.00', '2', '25.92']],
      total_count: 4,
    },
  });
  const snapshot = normalizeBrowserBoostCapture(qfang, { now: NOW });
  const boost = snapshot.boosts[0];
  assert.equal(snapshot.plan.plan_type, 'cheng_fang');
  assert.equal(snapshot.plan.metric_applicability.comprehensive_roi, 'applicable');
  assert.equal(boost.metrics.cost.value, 25.92);
  assert.equal(boost.metrics.comprehensive_cost.value, 25.92);
  assert.equal(boost.metrics.comprehensive_roi.value, 7.6);
  assert.equal(boost.metrics.net_roi.value, 6.9);
  assert.equal(boost.metrics.payment_roi.status, 'missing');
  assert.equal(boost.orders, null);
  assert.equal(boost.metrics.payment_orders.status, 'missing');
  assert.equal(boost.metrics.net_orders.value, 2);
  assert.equal(boost.duration, '7.5\n预计 09-24 03:45 结束');
  assert.equal(boost.metrics.duration_seconds.value, 27000);
  assert.equal(boost.create_time, '2026-09-23T20:44:42+08:00');
  assert.equal(snapshot.boost_coverage.list_complete, false);
  assert.equal(snapshot.meta.partial, true);
  assert.equal(snapshot.boost_coverage.live_recommendation_eligible, false);
  assert.ok(snapshot.meta.missing.includes('live_session_binding'));
});

test('parses duration only from a pure numeric first line and an explicitly unit-bearing column', () => {
  function duration(header, value) {
    const durationHeaders = ['任务名称', '调控状态', '预算', '调控消耗', '调控成交订单数', '调控综合营销ROI', header];
    const row = ['追投任务ID: task-7', '投放中', '100', '10', '1', '1.2', value];
    return normalizeBrowserBoostCapture(capture({ page: { headers: durationHeaders, rows: [row] } }), { now: NOW })
      .boosts[0].metrics.duration_seconds;
  }
  assert.deepEqual(duration('调控时长(小时)', '0.5'),
    { value: 1800, unit: 's', status: 'available', source_label: '调控时长(小时)' });
  assert.equal(duration('调控时长(小时)', '5').value, 18000);
  assert.equal(duration('调控时长(小时)', '1.25').value, 4500);
  assert.equal(duration('调控时长(小时)', '7.5\n预计 09-24 05:04 结束').value, 27000);
  assert.equal(duration('调控时长(秒)', '2').value, 2);

  for (const value of ['1小时30分钟', '2秒', '2x', '2小时\n预计 09-24 05:04 结束',
    '7.5\n预计 99-24 05:04 结束']) {
    assert.equal(duration('调控时长(小时)', value).status, 'unknown', value);
  }
  assert.equal(duration('调控时长', '2').status, 'unknown');
  assert.equal(duration('调控时长(秒)', '2小时').status, 'unknown');
});

test('derives 全域 applicability from /uni-prom URL and keeps paid and net orders separate', () => {
  const globalHeaders = ['任务名称', '调控状态', '调控预算(元)', '调控消耗', '调控成交订单数', '调控支付ROI', '调控净成交ROI', '调控净成交订单数', '调控时长(秒)'];
  const global = capture({ page: {
    url: 'https://qianchuan.jinritemai.com/uni-prom/detail?aavid=acct-1&adId=plan-2&dr=2026-09-22%2C2026-09-23',
    plan_type: 'quan_yu', metric_applicability: { comprehensive_roi: 'not_applicable' },
    headers: globalHeaders,
    rows: [['旧版全域任务 ID: task-7', '投放中', '100', '8.25', '3', '1.5', '1.2', '2', '45']],
  } });
  const snapshot = normalizeBrowserBoostCapture(global, { now: NOW });
  const boost = snapshot.boosts[0];
  assert.equal(snapshot.plan.plan_type, 'quan_yu');
  assert.equal(boost.orders, 3);
  assert.equal(boost.metrics.payment_orders.value, 3);
  assert.equal(boost.metrics.net_orders.value, 2);
  assert.deepEqual(boost.metrics.comprehensive_roi, { value: null, unit: 'ratio', status: 'not_applicable', source_label: '调控综合营销ROI' });
  assert.equal(snapshot.boost_coverage.missing_columns.includes('调控综合营销ROI'), false);
  assert.equal(boost.metrics.duration_seconds.value, 45);
});

test('rejects URL/page product mismatch, self-reported applicability overrides, and malformed creation time', () => {
  assert.throws(() => normalizeBrowserBoostCapture(capture({ page: { plan_type: 'quan_yu' } }), { now: NOW }), { code: 'plan_type_mismatch' });
  assert.throws(() => normalizeBrowserBoostCapture(capture({ page: { metric_applicability: { comprehensive_roi: 'not_applicable' } } }), { now: NOW }), { code: 'metric_applicability_mismatch' });
  const headersWithTime = [...headers, '创建时间'];
  assert.throws(() => normalizeBrowserBoostCapture(capture({ page: { headers: headersWithTime,
    rows: [['任务ID: task-7', '投放中', '100', '10', '2', '1.2', 'not a time']] } }), { now: NOW }), { code: 'invalid_create_time' });
  for (const createTime of ['2026-09-23 20:44:42+08:00', '2026-09-23 20:44:42Z', '2026-09-23 20:44:42 trailing']) {
    assert.throws(() => normalizeBrowserBoostCapture(capture({ page: { headers: headersWithTime,
      rows: [['任务ID: task-7', '投放中', '100', '10', '2', '1.2', createTime]] } }), { now: NOW }), { code: 'invalid_create_time' }, createTime);
  }
  const globalWithRoi = capture({ page: {
    url: 'https://qianchuan.jinritemai.com/uni-prom/detail?aavid=acct-1&adId=plan-2&dr=2026-09-22%2C2026-09-23',
    headers: ['任务名称', '调控预算', '调控消耗', '调控成交订单数', '调控综合营销ROI'],
    rows: [['任务ID: task-7', '100', '10', '1', '2']],
  } });
  assert.throws(() => normalizeBrowserBoostCapture(globalWithRoi, { now: NOW }), { code: 'plan_metric_conflict' });
});

test('rejects identity, date, missing and duplicated required columns, and duplicate task IDs', () => {
  assert.throws(() => normalizeBrowserBoostCapture(capture({ page: { advertiser_id: 'other' } }), { now: NOW }), { code: 'page_binding_mismatch' });
  assert.throws(() => normalizeBrowserBoostCapture(capture({ page: { date_range: ['2026-09-21', '2026-09-23'] } }), { now: NOW }), { code: 'url_binding_mismatch' });
  assert.throws(() => normalizeBrowserBoostCapture(capture({ page: { headers: headers.slice(1), rows: [['投放中', '1,000', '250.50', '0', '1.234']] } }), { now: NOW }), { code: 'missing_key_column' });
  assert.throws(() => normalizeBrowserBoostCapture(capture({ page: { headers: [...headers, '状态'], rows: [['任务ID: task-7', '投放中', '1,000', '250.50', '0', '1.234', '投放中']] } }), { now: NOW }), { code: 'duplicate_key_column' });
  assert.throws(() => normalizeBrowserBoostCapture(capture({ page: { rows: [capture().page.rows[0], capture().page.rows[0]] } }), { now: NOW }), { code: 'duplicate_task_id' });
  assert.throws(() => normalizeBrowserBoostCapture(capture({ page: { rows: [['campaign ID task-7', '投放中', '1,000', '250', '0', '1.2']] } }), { now: NOW }), { code: 'missing_task_id' });
  assert.throws(() => normalizeBrowserBoostCapture(capture({ page: { date_range: ['2026-09-23', '2026-09-22'] } }), { now: NOW }), { code: 'invalid_date_range' });
  assert.throws(() => normalizeBrowserBoostCapture(capture({ page: { total_count: 0 } }), { now: NOW }), { code: 'invalid_total_count' });
});

test('accepts empty page only with total_count zero and never treats missing targets as deleted', () => {
  const c = capture({ page: { rows: [], total_count: 0 } });
  const s = normalizeBrowserBoostCapture(c, { now: NOW });
  assert.equal(s.boosts.length, 0);
  assert.deepEqual(s.boost_coverage.target_visibility, { 'task-7': 'not_visible', 'task-8': 'not_visible' });
  assert.match(s.boost_coverage.reason, /absence does not prove deletion/);
  assert.throws(() => normalizeBrowserBoostCapture(capture({ page: { rows: [], total_count: null } }), { now: NOW }), { code: 'empty_table_unconfirmed' });
});

test('uses capture observation time for freshness and ignores the page update label', () => {
  const fresh = normalizeBrowserBoostCapture(capture({ page: { updated_at_label: '2099-01-01 00:00' } }), { now: NOW });
  const stale = normalizeBrowserBoostCapture(capture(), { now: new Date('2026-09-23T01:35:00.000Z') });
  assert.equal(fresh.meta.stale, false);
  assert.equal(fresh.components.browser_capture.platform_generated_at, null);
  assert.equal(stale.meta.freshness, 'stale');
});

test('rejects malformed row widths, numeric cells, size, and invalid URLs', () => {
  assert.throws(() => normalizeBrowserBoostCapture(capture({ page: { rows: [['x']] } }), { now: NOW }), { code: 'invalid_table_row' });
  assert.throws(() => normalizeBrowserBoostCapture(capture({ page: { rows: [['任务ID: task-7', '投放中', 'bad', '2', '1', '1']] } }), { now: NOW }), { code: 'invalid_numeric_value' });
  assert.throws(() => normalizeBrowserBoostCapture(capture({ page: { url: 'https://example.com/overall-prom/detail?aavid=acct-1&adId=plan-2&dateRange=%5B%222026-09-22%22%2C%222026-09-23%22%5D' } }), { now: NOW }), { code: 'invalid_page_url' });
  assert.throws(() => normalizeBrowserBoostCapture(capture({ page: { url: 'https://user@qianchuan.jinritemai.com/overall-prom/detail?aavid=acct-1&adId=plan-2&dateRange=%5B%222026-09-22%22%2C%222026-09-23%22%5D' } }), { now: NOW }), { code: 'invalid_page_url' });
  assert.throws(() => normalizeBrowserBoostCapture(capture({ page: { url: 'https://qianchuan.jinritemai.com/overall-prom/detail?aavid=acct-1&aavid=acct-1&adId=plan-2&dateRange=%5B%222026-09-22%22%2C%222026-09-23%22%5D' } }), { now: NOW }), { code: 'duplicate_url_parameter' });
  assert.throws(() => normalizeBrowserBoostCapture(capture({ page: { url: 'https://qianchuan.jinritemai.com/uni-prom/detail?aavid=acct-1&adId=plan-2&dr=2026-09-21%2C2026-09-23' } }), { now: NOW }), { code: 'url_binding_mismatch' });
  assert.throws(() => normalizeBrowserBoostCapture({ ...capture(), extra: 'x'.repeat(256 * 1024) }, { now: NOW }), { code: 'capture_too_large' });
});

test('validates board-next session identity and emits the repository session key; keeps a JSON clone', () => {
  const session = { account_id: 'account_acct-1', room_id: 'room-3', start_time: '2026-09-23 01:00:00', observed_at: '2026-09-23T01:29:00Z',
    board_url: 'https://qianchuan.jinritemai.com/board-next?aavid=acct-1&live_room_id=room-3' };
  const c = capture({ session });
  const s = normalizeBrowserBoostCapture(c, { now: NOW });
  assert.equal(s.meta.account_id, 'account_acct-1');
  assert.equal(s.meta.session_key, 'account_acct-1|room-3|2026-09-22T17:00:00.000Z');
  assert.equal(s.boost_coverage.live_recommendation_eligible, true);
  assert.equal(s.components.browser_capture.provenance.readonly_only, true);
  c.page.rows[0][0] = 'mutated';
  assert.equal(s.components.browser_capture.capture.page.rows[0][0], '夏日计划 任务ID: task-7');
  assert.throws(() => normalizeBrowserBoostCapture(capture({ session: { ...session, board_url: session.board_url.replace('/board-next', '/prefix/board-next') } }), { now: NOW }), { code: 'invalid_session_url' });
  assert.throws(() => normalizeBrowserBoostCapture(capture({ session: { ...session, start_time: 'not a time' } }), { now: NOW }), { code: 'invalid_session' });
  assert.throws(() => normalizeBrowserBoostCapture(capture({ timing: { captured_at: '2026-09-23 09:29:04' } }), { now: NOW }), { code: 'invalid_timestamp' });
});
