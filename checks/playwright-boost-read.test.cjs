'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readBoostTable, validateBoostReadRequest, parseBoostTable, extractTableFromHeaders } = require('../tools/lib/playwright-boost-read.cjs');
const { createPlaywrightBrowserAdapter } = require('../tools/lib/playwright-browser-adapter.cjs');
const { run } = require('../tools/playwright-channel.cjs');
const request = (extra = {}) => ({ action: 'read_boost_table', request_id: 'boost-read-0001',
  account_id: 'fixture-account', advertiser_id: 'fixture-adv', primary_ad_id: 'fixture-plan', date: '2026-09-26', ...extra });
const headers = ['任务名称', '调控预算(元)', '调控消耗'];
const taskRow = ['测试任务\n任务ID：60000003789', '100', '-'];
function table(rows = [headers, taskRow, ['共1条任务']]) {
  return { headers, rows, table_found: true, truncated: false };
}
function fixture(state = {}) {
  const pageType = state.plan_type || 'cheng_fang';
  const route = pageType === 'cheng_fang' ? '/overall-prom/detail' : '/uni-prom/detail';
  const dateKey = pageType === 'cheng_fang' ? 'dateRange' : 'dr';
  state.url ||= 'https://qianchuan.jinritemai.com' + route + '?aavid=fixture-adv&adId=fixture-plan&' + dateKey + '=' + encodeURIComponent('["2026-09-26","2026-09-26"]');
  state.reloads = 0; state.tableReads = 0; state.domReads = 0;
  const rawPage = {
    url: () => state.url, isClosed: () => false,
    async reload() { if (state.beforeReload) state.beforeReload(); state.reloads++; if (state.onReload) state.onReload(); },
    async waitForFunction(){
      // Unit stub models readiness; the separate HTML fixture exercises real DOM waits.
      for(let n=0;n<12;n++){const dom=state.dom?state.dom(++state.domReads):'ready';if(/^(加载中|正在加载)/.test(dom))continue;
        if(state.tables){const tables=state.tables(state.tableReads+1);try{parseBoostTable(tables);}catch(error){if(error.code==='page_data_unavailable'){state.tableReads++;continue;}throw error;}}
        return {jsonValue:async()=>true,dispose:async()=>{}};
      }throw Object.assign(Error('not_ready'),{code:'page_data_unavailable'});
    },
    getByText(text) { return { waitFor: async () => {}, count: async () => state.badDomIdentity ? 0 : 1 }; },
    getByRole(role, options) {
      if (role === 'columnheader') return { evaluateAll: async () => {
        state.tableReads++;
        if (state.onTableRead) state.onTableRead();
        return state.tables ? state.tables(state.tableReads) : [table()];
      } };
      if (role === 'textbox' && options?.name === '请选择') return {
        count: async () => 3,
        evaluateAll: async fn => fn((state.filters || ['全部', '全部', '全部（包括已删除）']).map(value => ({ value }))),
      };
      if (role === 'textbox' && options?.name === '输入任务名称或ID搜索') return { count: async () => 1, inputValue: async () => state.keyword || '' };
      if (role === 'textbox') return { evaluateAll: async fn => fn((state.dates || ['2026-09-26', '2026-09-26']).map(value => ({ value }))) };
      throw Error('unexpected role: ' + role);
    },
    locator(css) { assert.equal(css, 'body'); return { innerText: async () => {
      state.domReads++;
      return state.dom ? state.dom(state.domReads) : '追投列表\n09-26 12:00 更新';
    } }; },
  };
  const adapter = createPlaywrightBrowserAdapter({ page: rawPage });
  return { state, rawPage, adapter };
}
async function capture(state = {}, extra = {}, options = {}) {
  const f = fixture(state), req = request(extra);
  await f.adapter.connect(req);
  return { ...await readBoostTable(f.adapter, req, { sleep: async () => {}, ...options }), state };
}

test('日期必须有效、有序且一致', () => {
  for (const extra of [{ date: undefined }, { date: '2026-02-30' }, { date: undefined, date_range: ['2026-09-27', '2026-09-26'] }]) {
    assert.throws(() => validateBoostReadRequest(request(extra)), { code: 'boost_read_date_required' });
  }
  assert.throws(() => validateBoostReadRequest(request({ date_range: ['2026-09-25', '2026-09-26'] })), { code: 'boost_read_date_conflict' });
});
test('保留长任务 ID、未知值及合计，空表不能当零', () => {
  const result = parseBoostTable([table()]);
  assert.equal(result.rows[0][0], taskRow[0]); assert.equal(result.rows[0][2], '-');
  assert.equal(result.total_count, 1);
  for (const tables of [[], [table([headers])], [table([headers, ['共0条任务']])], [table([headers, ['暂无数据']])]]) {
    assert.throws(() => parseBoostTable(tables), { code: 'page_data_unavailable' });
  }
});
test('拒绝多表歧义、重复 ID、坏行宽及过大表格', () => {
  assert.throws(() => parseBoostTable([table(), table()]), { code: 'boost_read_table_ambiguous' });
  for (const rows of [[headers, taskRow, taskRow], [headers, [taskRow[0], '100']], [headers, taskRow, ['共0条任务']]]) {
    assert.throws(() => parseBoostTable([table(rows)]), { code: 'boost_read_table_invalid' });
  }
  assert.throws(() => parseBoostTable([{ ...table(), truncated: true }]), { code: 'boost_read_table_limit' });
});
test('DOM 提取只读取表头所属表，排除嵌套和其他表', () => {
  const parent = {}, nested = {}, own = {};
  const row = { closest: () => own, cells: taskRow.map(innerText => ({ innerText })) };
  const foreignRow = { closest: () => nested, cells: [{ innerText: 'other account' }] };
  own.querySelectorAll = () => [row, foreignRow];
  const elements = headers.map(innerText => ({ innerText, parentElement: parent, closest: () => own }));
  assert.deepEqual(extractTableFromHeaders(elements)[0].rows, [taskRow]);
});
test('刷新后双读稳定表格，保存独立采集时间且只声明当前页', async () => {
  const events = [];
  const result = await capture({}, {}, { onVerified: async (id, evidence) => events.push({ id, evidence }) });
  assert.equal(result.state.reloads, 1); assert.equal(result.attempts, 1);
  assert.equal(result.capture.page.coverage.scope, 'current_page_only');
  assert.equal(result.capture.page.filters, null);
  assert.equal(result.capture.page.updated_at_label, '09-26 12:00 更新');
  assert.ok(Date.parse(result.capture.timing.refresh_started_at) <= Date.parse(result.capture.timing.refresh_completed_at));
  assert.ok(Date.parse(result.capture.timing.refresh_completed_at) <= Date.parse(result.capture.timing.captured_at));
  assert.deepEqual(events.map(x => x.id), ['common.identity.verify', 'common.page.reload', 'common.table.read_headers_and_row']);
});
test('加载标记消失和表头出现前有限等待，不把任务名 Loading 当加载状态', async () => {
  const result = await capture({ dom: n => n < 3 ? '加载中...' : 'Loading 测试任务', tables: n => n < 2 ? [] : [table()] });
  assert.equal(result.state.reloads, 1); assert.equal(result.capture.page.rows.length, 1);
});
test('持续空表只刷新三次，失败时不登记表格读取成功', async () => {
  const state = { tables: () => [table([headers, ['共0条任务']])] }, events = [], failures = [];
  await assert.rejects(capture(state, {}, { onVerified: async id => events.push(id), onAttemptFailed: async e => failures.push(e) }), { code: 'page_data_unavailable' });
  assert.equal(state.reloads, 3); assert.equal(failures.length, 3);
  assert.deepEqual(events, ['common.identity.verify']);
});
test('表格变化后先刷新再读，第二轮成功', async () => {
  const changed = [taskRow[0], '200', '-'];
  const result = await capture({ tables: n => [table([headers, n === 1 ? taskRow : changed, ['共1条任务']])] });
  assert.equal(result.attempts, 2); assert.equal(result.state.reloads, 2);
  assert.equal(result.capture.page.rows[0][1], '200');
});
test('刷新期间切户立即失败，禁止换账户续读', async () => {
  const state = {}; state.onReload = () => { state.url = state.url.replace('fixture-adv', 'another-adv'); };
  await assert.rejects(capture(state), { code: 'browser_identity_mismatch' });
  assert.equal(state.reloads, 1);
});
test('URL 正确但 DOM 身份或日期不符时不刷新', async () => {
  for (const state of [{ badDomIdentity: true }, { dates: ['2026-09-25', '2026-09-26'] }]) {
    await assert.rejects(capture(state), { code: 'boost_read_identity_mismatch' });
    assert.equal(state.reloads, 0);
  }
});
test('全域保留实际筛选和关键词，不声称完整任务集合', async () => {
  const result = await capture({ plan_type: 'quan_yu', keyword: '某个任务' });
  assert.equal(result.capture.page.keyword, '某个任务');
  assert.equal(result.capture.page.status_filter, '全部（包括已删除）');
  assert.equal(result.capture.page.metric_applicability.comprehensive_roi, 'not_applicable');
});
test('缺少服务端要求的消耗列时不报告采集契约通过', async () => {
  const events = [];
  await assert.rejects(capture({ tables: () => [{ ...table(), headers: ['任务名称', '调控预算(元)', '未知消耗列'], rows: [taskRow] }] }, {},
    { onVerified: async id => events.push(id) }), { code: 'missing_key_column' });
  assert.equal(events.includes('common.table.read_headers_and_row'), false);
});
test('证据保存失败立即停止，不继续刷新', async () => {
  const state = {};
  await assert.rejects(capture(state, {}, { onVerified: async () => { throw Object.assign(Error('fixture evidence unavailable'), { code: 'EACCES' }); } }), { code: 'EACCES' });
  assert.equal(state.reloads, 0);
});
test('通道逐动作先落证据再继续；相同请求不会重新刷新', async () => {
  const base = require('./test-output.cjs').testOutputRoot(); fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'cdp-boost-'));
  const bindingFile = path.join(dir, 'bindings.json'), evidenceRoot = path.join(dir, 'evidence');
  fs.writeFileSync(bindingFile, JSON.stringify({ schema_version: 1, bindings: [{
    account_id: 'fixture-account', browser_type: 'playwright-cdp', profile_name: 'fixture-profile',
    cdp_endpoint: 'http://127.0.0.1:9222', status: 'active', advertisers: [{ advertiser_id: 'fixture-adv', primary_ad_ids: ['fixture-plan'] }],
  }] }));
  const state = {}, f = fixture(state);
  state.beforeReload = () => assert.ok(fs.readdirSync(evidenceRoot).some(name => name.endsWith('-action-0.json')));
  state.onTableRead = () => { if (state.tableReads === 2) assert.ok(fs.readdirSync(evidenceRoot).some(name => name.endsWith('-action-1.json'))); };
  const options = { bindings_file: bindingFile, evidence_root: evidenceRoot, adapter_factory: () => f.adapter };
  const result = await run(request(), options);
  assert.equal(result.ok, true); assert.equal(result.advertising_writes, 0);
  assert.equal(result.channel, 'playwright-cdp'); assert.equal(result.evidence_origin, 'injected_adapter');
  assert.equal(result.captured_at, result.capture.timing.captured_at);
  assert.equal(result.action_evidence.length, 3);
  for (const action of result.action_evidence) {
    const event = JSON.parse(fs.readFileSync(action.evidence_file, 'utf8'));
    assert.equal(event.channel, 'playwright-cdp'); assert.equal(event.evidence_origin, 'injected_adapter');
    assert.equal(event.status, 'read_verified'); assert.equal(event.advertising_writes, 0);
  }
  const again = await run(request(), options);
  assert.equal(again.replayed, true); assert.equal(state.reloads, 1);
  assert.deepEqual(again.capture, result.capture);
});
