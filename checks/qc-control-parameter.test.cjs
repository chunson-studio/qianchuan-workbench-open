'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const chrome = require('../tools/attach-qc-chrome.playwright.cjs');
const raw = require('../tools/read-qc-control-raw.playwright.cjs');
const modulePath = require.resolve('../tools/edit-qc-control-parameter.playwright.cjs');

function fixture(options = {}) {
  const spec = { browser_context_id: 'profile-a', advertiser_id: '10001', primary_ad_id: '20001', task_id: '30001', date: '2026-10-15', pool: '手动暂停',
    expected_status: '已暂停\n手动暂停', form_kind: 'material_cost', material_ids: ['90001'], parameter: 'budget', expected_value: 200, new_value: 199,
    bounds: { min: 100, max: 300 }, timeoutMs: 20, ...options.spec };
  const headers = ['任务名称', '素材', '调控状态', '调控预算(元)', options.roiHeader ?? '综合营销ROI目标', '支付ROI目标', '出价', '调控时长(小时)', '追投方式', '创建时间'];
  const volume = spec.form_kind === 'live_volume';
  const cells = ['original\nID: 30001', volume ? '直播间画面\nID: 90001' : '素材ID: 90001', spec.expected_status, '200', volume ? '-' : '1.93', '-', '-', volume ? '12' : '长期投放', volume ? '放量追投' : '控成本追投', '2026-10-15 00:00'];
  const state = { opened: !!options.opened, fills: 0, submits: 0, editorClicks: 0, reads: 0,
    budget: '200', roi_goal: '1.93', duration_hours: '12', name: 'original', cells, records: [], rowMatches: true,
    rowTextContent: 'originalID: 30001视频素材ID: 90001', ...options.state };
  const url = 'https://qianchuan.jinritemai.com/uni-prom/detail?aavid=10001&adId=20001';
  const target = { targetId: 'target-a', browserContextId: 'profile-a', url };
  const inputKeys = volume ? ['budget', 'duration_hours', 'name'] : ['budget', 'roi_goal', 'name'];
  const snapshot = () => inputKeys.map(key => ({ tag: 'INPUT', type: 'text', placeholder: key === 'name' ? '请输入任务名称，1-50个字符' : key === 'roi_goal' ? '请输入期望的综合营销ROI目标' : '请输入',
    name: '', value: state[key], checked: false, ariaChecked: null, disabled: false }));
  const sharedText = options.sharedBudgetText ?? (volume ? '' : '\n当前最多可再追加预算 3300 元');
  const formText = () => volume ? '追投直播间画面\nID: 90001\n调控总预算' + sharedText :
    '编辑素材追投\n已添加：' + (options.missingMaterials ? '0' : '1') + '/20\n' + (options.missingMaterials ? '暂无视频' : '素材ID: 90001') +
    sharedText + (options.roiWarning ? '\n请谨慎修改综合营销ROI目标，以免失去保障资格' : '') + (state.targetingText || '');
  class Locator {
    constructor(kind, textQuery) { this.kind = kind; this.textQuery = textQuery; }
    filter(query) {
      if (this.kind === 'row' && query?.hasText) state.rowMatches = query.hasText instanceof RegExp ? query.hasText.test(state.rowTextContent) : state.rowTextContent.includes(query.hasText);
      if (this.kind === 'row' && query?.has) state.rowMatches = query.has.kind === 'taskid';
      return this;
    }
    async count() {
      if (this.kind === 'modal') return state.opened ? 1 : 0;
      if (this.kind === 'plain') return volume ? 2 : 1;
      if (this.kind === 'none') return 0;
      if (this.kind === 'row') return state.rowMatches ? 1 : 0;
      return 1;
    }
    async isVisible() { return !!await this.count(); }
    async isEnabled() { return true; }
    async waitFor() {
      if (this.kind === 'materialCount' && (options.missingMaterials || (this.textQuery instanceof RegExp && !this.textQuery.test(options.materialCountText ?? '已添加：1/20')))) {
        throw Object.assign(new Error('material wait timed out'), { name: 'TimeoutError' });
      }
    }
    locator(selector) { return new Locator(selector.includes('iconpark-icon') ? 'editor' : selector.startsWith('input,') ? 'controls' : 'none'); }
    getByRole(role, query) { return new Locator(role === 'button' ? 'submit' : query.name === '请输入期望的综合营销ROI目标' ? 'roi_goal' : 'none'); }
    getByPlaceholder(name) { return new Locator(name === '请输入' ? 'plain' : name === '请输入任务名称，1-50个字符' ? 'name' : 'none'); }
    getByText(query) { return new Locator('materialCount', query); }
    nth(index) { return new Locator(this.kind === 'plain' ? index === 0 ? 'budget' : 'duration_hours' : this.kind); }
    async innerText() { return formText(); }
    async inputValue() { return state[this.kind]; }
    async evaluate() { return inputKeys.indexOf(this.kind); }
    async evaluateAll() { return snapshot(); }
    async fill(value) { state.fills++; state[this.kind] = value; }
    async press() { if (options.mutateOtherOnFill) state.name = 'unexpected'; }
    async click() {
      if (this.kind === 'editor') { state.editorClicks++; state.opened = true; return; }
      if (this.kind !== 'submit') throw new Error('Unexpected click');
      state.submits++;
      if (!options.noUpdate) {
        state.cells[headers.indexOf({ budget: '调控预算(元)', roi_goal: options.roiHeader ?? '综合营销ROI目标', duration_hours: '调控时长(小时)' }[spec.parameter])] = state[spec.parameter];
        state.opened = false;
      }
      if (options.submitError) throw options.submitError;
    }
  }
  const page = { url: () => url, locator: () => new Locator('modal'),
    getByText: (text, query) => new Locator(text === 'ID: 30001' && query?.exact === true ? 'taskid' : 'account'), getByRole: role => new Locator(role === 'row' ? 'row' : 'none') };
  const oldTarget = chrome.getChromePageTarget, oldRead = raw.readQianchuanControlRaw, cached = require.cache[modulePath];
  let api;
  try {
    chrome.getChromePageTarget = async () => ({ ...target, ...options.target });
    raw.readQianchuanControlRaw = async () => { state.reads++; return { headers, tasks: [{ task_id: '30001', raw_cells: [...state.cells] }] }; };
    delete require.cache[modulePath]; api = require(modulePath);
  } finally {
    chrome.getChromePageTarget = oldTarget; raw.readQianchuanControlRaw = oldRead;
    if (cached) require.cache[modulePath] = cached; else delete require.cache[modulePath];
  }
  const record = async entry => { state.records.push(entry); if (options.recordHook) await options.recordHook(entry, state); };
  return { api, page, spec, state, record, headers };
}

test('a budget edit submits once after intent and confirms only the same original ID with unchanged fields', async () => {
  const f = fixture({ roiWarning: true });
  const prepared = await f.api.prepareQianchuanControlParameter(f.page, f.spec);
  assert.equal(f.state.submits, 0);
  assert.equal(f.state.fills, 1);
  assert.equal(f.state.roi_goal, '1.93');
  const pending = await f.api.commitQianchuanControlParameter(prepared, { operation_id: 'op-1', record: f.record });
  assert.equal(pending.status, 'submitted_pending_readback');
  const confirmed = await f.api.readbackQianchuanControlParameter(prepared);
  assert.equal(confirmed.task_id, '30001');
  assert.equal(confirmed.new_value, 199);
  assert.deepEqual(f.state.records.map(record => record.status), ['intent', 'submitted_pending_readback', 'confirmed']);
  assert.equal(f.state.submits, 1);
  await assert.rejects(f.api.commitQianchuanControlParameter(prepared, { operation_id: 'op-2', record: f.record }), { code: 'prepared_already_used_or_invalid' });
  assert.equal(f.state.records.length, 3, 'rejected repeat must not overwrite confirmed state');
  assert.equal(f.state.submits, 1);
});

test('observed 0/20 missing-material editor fails with no fill or submit', async () => {
  const f = fixture({ missingMaterials: true });
  await assert.rejects(f.api.prepareQianchuanControlParameter(f.page, f.spec), error => error.code === 'editor_material_incomplete' && error.details.effect_status === 'not_submitted');
  assert.equal(f.state.fills, 0); assert.equal(f.state.submits, 0); assert.equal(f.state.opened, true);
});

test('exact task-ID child remains locatable when row textContent has no cell line breaks', async () => {
  const f = fixture();
  assert.equal(/(?:^|\n)ID:\s*30001(?=\s|$)/.test(f.state.rowTextContent), false);
  const prepared = await f.api.prepareQianchuanControlParameter(f.page, f.spec);
  assert.equal(prepared.task_id, '30001');
  assert.equal(f.state.editorClicks, 1); assert.equal(f.state.submits, 0);
});

test('material count accepts observed leading textContent whitespace and trailing whitespace', async () => {
  const f = fixture({ materialCountText: ' 已添加：1/20 \n' });
  const prepared = await f.api.prepareQianchuanControlParameter(f.page, f.spec);
  assert.equal(prepared.status, 'prepared_not_submitted');
  assert.equal(f.state.fills, 1); assert.equal(f.state.submits, 0);
});

test('existing user editor and mismatched actual Chrome profile stop before editor click', async () => {
  for (const options of [{ opened: true }, { target: { browserContextId: 'wrong-profile' } }]) {
    const f = fixture(options);
    await assert.rejects(f.api.prepareQianchuanControlParameter(f.page, f.spec));
    assert.equal(f.state.editorClicks, 0); assert.equal(f.state.fills, 0); assert.equal(f.state.submits, 0);
  }
});

test('changed original value, bounds, original task ID, and material membership reject before opening', async () => {
  for (const spec of [{ expected_value: 199 }, { new_value: 500 }, { task_id: '20001' }, { material_ids: ['90002'] }]) {
    const f = fixture({ spec });
    await assert.rejects(f.api.prepareQianchuanControlParameter(f.page, f.spec));
    assert.equal(f.state.editorClicks, 0); assert.equal(f.state.fills, 0);
  }
});

test('ROI guarantee warning stops before filling while explicit unguarded ROI layout is supported', async () => {
  const spec = { parameter: 'roi_goal', expected_value: 1.93, new_value: 1.94, bounds: { min: 1, max: 3 } };
  const blocked = fixture({ spec, roiWarning: true });
  await assert.rejects(blocked.api.prepareQianchuanControlParameter(blocked.page, blocked.spec), { code: 'roi_guarantee_consequence' });
  assert.equal(blocked.state.fills, 0); assert.equal(blocked.state.submits, 0);
  const f = fixture({ spec });
  const prepared = await f.api.prepareQianchuanControlParameter(f.page, f.spec);
  await f.api.commitQianchuanControlParameter(prepared, { operation_id: 'roi', record: f.record });
  assert.equal((await f.api.readbackQianchuanControlParameter(prepared)).new_value, 1.94);
  assert.equal(f.state.budget, '200');
});

test('explicit live-volume duration layout changes one input and preserves budget', async () => {
  const f = fixture({ spec: { form_kind: 'live_volume', live_material_id: '90001', parameter: 'duration_hours', expected_value: 12, new_value: 10, bounds: { min: 5, max: 24 } } });
  const prepared = await f.api.prepareQianchuanControlParameter(f.page, f.spec);
  await f.api.commitQianchuanControlParameter(prepared, { operation_id: 'duration', record: f.record });
  assert.equal((await f.api.readbackQianchuanControlParameter(prepared)).new_value, 10);
  assert.equal(f.state.budget, '200'); assert.equal(f.state.submits, 1);
});

test('observed net-ROI table supports live-volume duration and persists its actual target column', async () => {
  const f = fixture({ roiHeader: '净成交ROI目标', spec: { form_kind: 'live_volume', live_material_id: '90001',
    parameter: 'duration_hours', expected_value: 12, new_value: 10, bounds: { min: 5, max: 24 } } });
  const prepared = await f.api.prepareQianchuanControlParameter(f.page, f.spec);
  assert.equal(prepared.roi_target_header, '净成交ROI目标');
  assert.equal(prepared.parameter_header, '调控时长(小时)');
  await f.api.commitQianchuanControlParameter(prepared, { operation_id: 'net-duration', record: f.record });
  const confirmed = await f.api.readbackQianchuanControlParameter(prepared);
  assert.equal(confirmed.new_value, 10);
  assert.equal(confirmed.roi_target_header, '净成交ROI目标');
  assert.equal(f.state.records[0].prepared.roi_target_header, '净成交ROI目标');
  assert.equal(f.state.records[0].prepared.before.cells['净成交ROI目标'], '-');
  assert.equal(f.state.budget, '200'); assert.equal(f.state.submits, 1);
});

test('live-volume budget growth is independent of absent or zero cost-control shared quota', async () => {
  for (const sharedBudgetText of ['', '\n当前最多可再追加预算 0 元']) {
    const f = fixture({ roiHeader: '净成交ROI目标', sharedBudgetText,
      spec: { form_kind: 'live_volume', live_material_id: '90001', new_value: 250 } });
    const prepared = await f.api.prepareQianchuanControlParameter(f.page, f.spec);
    await f.api.commitQianchuanControlParameter(prepared, { operation_id: 'volume-budget', record: f.record });
    const result = await f.api.readbackQianchuanControlParameter(prepared);
    assert.equal(result.new_value, 250); assert.equal(result.parameter_header, '调控预算(元)');
    assert.equal(f.state.duration_hours, '12'); assert.equal(f.state.submits, 1);
  }
});

test('cost-control budget growth still requires sufficient current shared quota', async () => {
  for (const sharedBudgetText of ['', '\n当前最多可再追加预算 49 元']) {
    const f = fixture({ sharedBudgetText, spec: { new_value: 250 } });
    await assert.rejects(f.api.prepareQianchuanControlParameter(f.page, f.spec), { code: 'shared_budget_insufficient_or_unknown' });
    assert.equal(f.state.fills, 0); assert.equal(f.state.submits, 0);
  }
  const f = fixture({ sharedBudgetText: '\n当前最多可再追加预算 50 元', spec: { new_value: 250 } });
  assert.equal((await f.api.prepareQianchuanControlParameter(f.page, f.spec)).new_value, 250);
});

test('missing, duplicate or mixed ROI target columns reject before editor opening', async () => {
  for (const mutate of [headers => { headers[4] = '未知ROI目标'; }, headers => headers.push('综合营销ROI目标'), headers => headers.push('净成交ROI目标')]) {
    const f = fixture(); mutate(f.headers);
    await assert.rejects(f.api.prepareQianchuanControlParameter(f.page, f.spec), { code: 'table_structure_changed' });
    assert.equal(f.state.editorClicks, 0); assert.equal(f.state.fills, 0); assert.equal(f.state.submits, 0);
  }
});

test('target-column changes during a prepared volume edit reject instead of changing ROI meaning', async () => {
  const f = fixture({ roiHeader: '净成交ROI目标', spec: { form_kind: 'live_volume', live_material_id: '90001' } });
  const prepared = await f.api.prepareQianchuanControlParameter(f.page, f.spec);
  f.headers[4] = '综合营销ROI目标';
  await assert.rejects(f.api.commitQianchuanControlParameter(prepared, { operation_id: 'changed-column', record: f.record }), { code: 'table_structure_changed' });
  assert.equal(f.state.submits, 0);
});

test('a net-ROI table does not invent an unobserved cost-control ROI form', async () => {
  const f = fixture({ roiHeader: '净成交ROI目标' });
  await assert.rejects(f.api.prepareQianchuanControlParameter(f.page, f.spec), { code: 'editor_roi_layout_unverified' });
  assert.equal(f.state.editorClicks, 0); assert.equal(f.state.fills, 0);
});

test('failed durable intent never dispatches and the same preparation cannot be reused', async () => {
  const f = fixture({ recordHook: entry => { if (entry.status === 'intent') throw new Error('disk failed'); } });
  const prepared = await f.api.prepareQianchuanControlParameter(f.page, f.spec);
  await assert.rejects(f.api.commitQianchuanControlParameter(prepared, { operation_id: 'disk', record: f.record }), error => error.message === 'disk failed' && error.details.effect_status === 'not_submitted');
  assert.equal(f.state.submits, 0);
  await assert.rejects(f.api.commitQianchuanControlParameter(prepared, { operation_id: 'retry', record: f.record }), { code: 'prepared_already_used_or_invalid' });
  assert.equal(f.state.submits, 0);
});

test('changes during durable intent are caught before submission', async () => {
  const f = fixture({ recordHook: (entry, state) => { if (entry.status === 'intent') state.cells[3] = '201'; } });
  const prepared = await f.api.prepareQianchuanControlParameter(f.page, f.spec);
  await assert.rejects(f.api.commitQianchuanControlParameter(prepared, { operation_id: 'changed', record: f.record }), { code: 'parameter_not_verified' });
  assert.equal(f.state.submits, 0);
  assert.deepEqual(f.state.records.map(record => record.status), ['intent', 'not_submitted']);
});

test('submit TimeoutError is retained as unknown, never replayed, and can be confirmed by original-ID readback', async () => {
  const timeout = Object.assign(new Error('timeout after request'), { name: 'TimeoutError', code: 'ETIMEDOUT' });
  const f = fixture({ submitError: timeout });
  const prepared = await f.api.prepareQianchuanControlParameter(f.page, f.spec);
  await assert.rejects(f.api.commitQianchuanControlParameter(prepared, { operation_id: 'timeout', record: f.record }), error =>
    error === timeout && error.code === 'ETIMEDOUT' && error.details.effect_status === 'unconfirmed' && error.details.retry_write === false);
  assert.equal(f.state.submits, 1);
  assert.deepEqual(f.state.records.map(record => record.status), ['intent', 'unknown']);
  assert.equal((await f.api.readbackQianchuanControlParameter(prepared)).status, 'confirmed');
  assert.equal(f.state.submits, 1);
});

test('fill side effects and readback changes to other parameters are rejected', async () => {
  const changed = fixture({ mutateOtherOnFill: true });
  await assert.rejects(changed.api.prepareQianchuanControlParameter(changed.page, changed.spec), { code: 'editor_task_name_changed' });
  assert.equal(changed.state.submits, 0);
  const f = fixture();
  const prepared = await f.api.prepareQianchuanControlParameter(f.page, f.spec);
  await f.api.commitQianchuanControlParameter(prepared, { operation_id: 'other', record: f.record });
  f.state.cells[4] = '2.00';
  await assert.rejects(f.api.readbackQianchuanControlParameter(prepared), { code: 'other_task_parameter_changed' });
  assert.equal(f.state.records.some(record => record.status === 'confirmed'), false);
});

test('custom targeting text changing during durable intent blocks submission even when inputs stay unchanged', async () => {
  const f = fixture({ recordHook: (entry, state) => { if (entry.status === 'intent') state.targetingText = '\n新定向人群'; } });
  const prepared = await f.api.prepareQianchuanControlParameter(f.page, f.spec);
  await assert.rejects(f.api.commitQianchuanControlParameter(prepared, { operation_id: 'targeting', record: f.record }), { code: 'editor_context_changed' });
  assert.equal(f.state.submits, 0);
  assert.equal(f.state.records.at(-1).status, 'not_submitted');
});
