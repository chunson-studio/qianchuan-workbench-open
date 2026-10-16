'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createQianchuanNativeOperations, validateNativeUiTarget } = require('../tools/qc-native-operations.cjs');

function formFixture() {
  const calls = [];
  const element = { innerText: '提交', getAttribute: () => null, isConnected: true };
  const rootElement = { tagName: 'DIV', innerText: '编辑素材追投\n提交', isConnected: true, contains: node => node === element };
  const targetHandle = { node: element, evaluate: async (fn, arg) => fn(element, arg?.node || arg), dispose: async () => {},
    click: async options => { calls.push({ action: 'click', options }); },
    fill: async (value, options) => { calls.push({ action: 'fill', value, options }); } };
  const rootHandle = { node: rootElement, dispose: async () => {} };
  const target = { filter() { return this; }, count: async () => 1,
    elementHandle: async () => targetHandle,
  };
  const root = { filter() { return this; }, count: async () => 1,
    evaluate: async fn => fn(rootElement), elementHandle: async () => rootHandle,
    getByText: () => ({ filter() { return this; }, count: async () => 1 }),
    getByRole: () => target, locator: () => target };
  const page = { getByRole: () => root };
  const input = { scope: { type: 'boost_form', title: '编辑素材追投' }, target: [{ by: 'role', value: 'button', name: '提交' }], action: 'click' };
  return { page, input, target, root, calls, rootElement, element };
}

test('fixed operations expose no arbitrary code/path/navigation operation', async () => {
  const operations = createQianchuanNativeOperations();
  assert.deepEqual(Object.keys(operations), ['snapshot', 'read_control', 'read_control_pages', 'refresh', 'activate_page', 'ui', 'ui_prepare_batch']);
  assert.equal(operations.snapshot.kind, 'read');
  assert.equal(operations.read_control.kind, 'read');
  assert.equal(operations.read_control_pages.kind, 'write');
  const f = formFixture();
  for (const extra of [{ code: 'return document.cookie' }, { modulePath: 'arbitrary.cjs' }, { url: 'https://elsewhere.example' }]) {
    await assert.rejects(operations.ui.run({ page: f.page, input: { ...f.input, ...extra } }), { code: 'native_ui_request_invalid' });
  }
  assert.equal(f.calls.length, 0);
});

test('UI requires a scope and precise task ID; main-plan confirmations are rejected', async () => {
  const { ui } = createQianchuanNativeOperations(), f = formFixture();
  await assert.rejects(ui.run({ page: f.page, input: { ...f.input, scope: undefined } }), { code: 'native_scope_required' });
  await assert.rejects(ui.run({ page: f.page, input: { ...f.input, scope: { type: 'task' } } }), { code: 'native_task_id_required' });
  await assert.rejects(ui.run({ page: f.page, input: { ...f.input, scope: { type: 'page' } } }), { code: 'native_scope_invalid' });
  await assert.rejects(ui.run({ page: f.page, input: { ...f.input, scope: { type: 'boost_form', title: '删除主计划及追投' } } }), { code: 'native_boost_form_required' });
  assert.equal(f.calls.length, 0);
});

test('verified boost-form action dispatches once and only reports pending readback', async () => {
  const { ui } = createQianchuanNativeOperations(), f = formFixture();
  const result = await ui.run({ page: f.page, input: f.input });
  assert.deepEqual(f.calls, [{ action: 'click', options: { timeout: 5000 } }]);
  assert.equal(result.requires_readback, true);
  assert.equal(result.effect_status, 'unconfirmed');
  assert.equal(result.retry_write, false);
  assert.equal(result.write_verified, undefined);
});

test('scope escaping selectors and browser navigation key combinations never dispatch', async () => {
  const { ui } = createQianchuanNativeOperations(), f = formFixture();
  for (const selector of ['xpath=..', ' xpath = //body', '..', 'button >> xpath=//body', 'text=关闭主计划']) {
    await assert.rejects(ui.run({ page: f.page, input: { ...f.input, target: [{ by: 'css', value: selector }] } }), { code: 'native_locator_invalid' });
  }
  for (const value of ['Control+L', 'Alt+Left', 'F5']) {
    await assert.rejects(ui.run({ page: f.page, input: { ...f.input, action: 'press', value } }), { code: 'native_ui_key_invalid' });
  }
  assert.equal(f.calls.length, 0);
});

test('a body root cannot pretend to be a boost form; duplicated visible targets reject', async () => {
  const { ui } = createQianchuanNativeOperations();
  const body = formFixture();
  body.root.evaluate = async fn => fn({ tagName: 'BODY', innerText: '编辑素材追投' });
  await assert.rejects(ui.run({ page: body.page, input: body.input }), { code: 'native_boost_form_required' });
  const duplicate = formFixture(); duplicate.target.count = async () => 2;
  await assert.rejects(ui.run({ page: duplicate.page, input: duplicate.input }), { code: 'native_target_not_unique' });
  assert.equal(body.calls.length + duplicate.calls.length, 0);
});

test('a selector resolving a sibling outside the authorized scope cannot click', async () => {
  const { ui } = createQianchuanNativeOperations(), f = formFixture();
  f.rootElement.contains = () => false;
  await assert.rejects(ui.run({ page: f.page, input: { ...f.input, target: [{ by: 'css', value: ':scope + button' }] } }), { code: 'native_ui_scope_mismatch' });
  assert.equal(f.calls.length, 0);
});

test('task lookup uses the exact ID child element and rechecks the task-name cell ID', async () => {
  const { ui } = createQianchuanNativeOperations(), f = formFixture();
  const id = '60000023', text = '示例丁_测试ID: ' + id + '视频五_素材';
  const idElement = {};
  let taskNameCell = '示例丁_测试ID: ' + id;
  const row = { ...f.root, filter(options) {
    if (options.has) assert.equal(options.has, idElement);
    assert.equal(options.hasText, undefined);
    return this;
  }, getByRole(role) {
    return role === 'cell' ? { nth: () => ({ innerText: async () => taskNameCell }) } : f.target;
  } };
  const header = { filter() { return this; }, count: async () => 1 };
  const table = { filter() { return this; }, count: async () => 1, getByRole(role, options) {
    if (role === 'columnheader') return options ? { count: async () => 1 } : { allTextContents: async () => ['', '任务名称', '调控状态'] };
    if (role === 'row') return row;
    throw Error('unexpected locator');
  } };
  const page = { getByRole: () => header, locator: () => table, getByText(pattern) {
    assert.equal(pattern.test('ID: ' + id), true);
    assert.equal(pattern.test('ID：' + id), true);
    assert.equal(pattern.test('ID: ' + id + '0'), false);
    assert.equal(pattern.test(text), false);
    return idElement;
  } };
  const input = { ...f.input, scope: { type: 'task', task_id: id } };
  await ui.run({ page, input });
  assert.equal(f.calls.length, 1);
  taskNameCell = '另一任务ID: 99999';
  await assert.rejects(ui.run({ page, input }), { code: 'native_task_id_mismatch' });
  assert.equal(f.calls.length, 1);
});

test('filter scope accepts only date inputs, the third pool input or known status menu items', () => {
  const button = { innerText: '关闭主计划', getAttribute: () => null };
  assert.equal(validateNativeUiTarget(button, { type: 'control_table' }), false);
  assert.equal(validateNativeUiTarget({ ...button, innerText: '删除' }, { type: 'filters' }), false);
  const date = { tagName: 'INPUT', innerText: '', getAttribute: () => '请选择开始日期' };
  assert.equal(validateNativeUiTarget(date, { type: 'filters' }), true);
  const pools = [0, 1, 2].map(() => ({ tagName: 'INPUT', innerText: '', getAttribute: () => '请选择', getClientRects: () => [{}] }));
  for (const item of pools) item.ownerDocument = { querySelectorAll: () => pools };
  assert.equal(validateNativeUiTarget(pools[0], { type: 'filters' }), false);
  assert.equal(validateNativeUiTarget(pools[2], { type: 'filters' }), true);
  const menu = { innerText: '全部（包括已删除）\n调控中' };
  const option = { innerText: '调控中', getAttribute: () => null, closest: selector => selector === 'a[href]' ? null : menu };
  assert.equal(validateNativeUiTarget(option, { type: 'filters' }), true);
  assert.equal(validateNativeUiTarget({ ...option, closest: () => null }, { type: 'filters' }), false);
  const foreignLink = { innerText: '查看', getAttribute: () => null, closest: () => ({ getAttribute: () => 'https://elsewhere.example' }) };
  assert.equal(validateNativeUiTarget(foreignLink, { type: 'boost_form' }), false);
});

test('date shortcuts accept only today/yesterday inside the observed quick-picker list', () => {
  const labels = ['今天', '昨天', '最近3天', '最近7天'];
  const list = { querySelectorAll: () => labels.map(innerText => ({ innerText })) };
  const item = { innerText: '今天', closest: () => list };
  const shortcut = { innerText: '今天', getAttribute: () => null,
    closest: selector => selector === 'a[href]' ? null : item };
  assert.equal(validateNativeUiTarget(shortcut, { type: 'filters' }), true);
  shortcut.innerText = item.innerText = '昨天';
  assert.equal(validateNativeUiTarget(shortcut, { type: 'filters' }), true);
  shortcut.innerText = item.innerText = '最近3天';
  assert.equal(validateNativeUiTarget(shortcut, { type: 'filters' }), false);
  shortcut.innerText = item.innerText = '今天';
  labels.splice(2);
  assert.equal(validateNativeUiTarget(shortcut, { type: 'filters' }), false);
  shortcut.closest = () => null;
  assert.equal(validateNativeUiTarget(shortcut, { type: 'filters' }), false);
});

test('boost entry opens only an observed exact boost label with a click', async () => {
  const operations = createQianchuanNativeOperations(), f = formFixture();
  for (const name of ['素材追投', '一键调速']) {
    assert.equal(validateNativeUiTarget({ innerText: name, getAttribute: () => null }, { type: 'boost_entry' }), true);
  }
  for (const name of ['创建计划', '删除', '提交', '关闭主计划']) {
    assert.equal(validateNativeUiTarget({ innerText: name, getAttribute: () => null }, { type: 'boost_entry' }), false);
  }
  await assert.rejects(operations.ui.run({ page: f.page, input: { ...f.input, action: 'press', value: 'Enter', scope: { type: 'boost_entry' } } }), { code: 'native_boost_entry_click_required' });
  await assert.rejects(operations.ui.run({ page: f.page, input: { ...f.input, scope: { type: 'boost_entry' } } }), { code: 'native_existing_form_preserved' });
  assert.equal(f.calls.length, 0);
  const header = { filter() { return this; }, count: async () => 1 };
  const table = { filter() { return this; }, count: async () => 1, getByRole: () => ({ count: async () => 1 }) };
  const page = { getByRole: role => role === 'button' ? { filter() { return this; }, count: async () => 0 } : header,
    locator: selector => selector === 'body' ? f.root : table };
  f.element.innerText = '素材追投';
  const result = await operations.ui.run({ page, input: { ...f.input, scope: { type: 'boost_entry' },
    target: [{ by: 'role', value: 'button', name: '素材追投' }] } });
  assert.equal(result.action_returned, true); assert.equal(result.requires_readback, true);
  assert.equal(f.calls.length, 1);
});

test('refresh preserves an existing form and snapshot uses native visible ARIA content', async () => {
  const operations = createQianchuanNativeOperations(); let reloads = 0, snapshots = 0;
  const page = { getByRole: () => ({ filter() { return this; }, count: async () => 1 }), reload: async () => { reloads++; },
    url: () => 'https://qianchuan.jinritemai.com/uni-prom/detail',
    locator: () => ({ filter() { return this; }, count: async () => 1, ariaSnapshot: async () => { snapshots++; return '- text: visible'; } }) };
  await assert.rejects(operations.refresh.run({ page, input: {} }), { code: 'native_existing_form_preserved' });
  const result = await operations.snapshot.run({ page, input: {} });
  assert.equal(reloads, 0); assert.equal(snapshots, 1);
  assert.equal(result.source, 'native_aria_snapshot');
  assert.equal(result.advertising_writes, 0);
});

function confirmationFixture(action = 'pause', ids = ['12345']) {
  const f = formFixture();
  const verb = { pause: '暂停', resume: '开启', delete: '删除' }[action];
  f.message = `确定${verb}所选的${ids.length}条任务吗？` + (action === 'delete' ? '删除后不可恢复' : '');
  f.selectedIds = ids; f.selectionReads = 0;
  f.element.innerText = '确定'; f.element.tagName = 'BUTTON'; f.element.getClientRects = () => [{}];
  f.dialog = { tagName: 'DIV', innerText: f.message + '\n确定', parentElement: { tagName: 'BODY' },
    querySelectorAll: () => [f.element] };
  f.element.parentElement = f.dialog;
  const header = { filter() { return this; }, count: async () => 1 };
  const table = { filter() { return this; }, count: async () => 1, getByRole(role, options) {
    if (role === 'columnheader') return options ? { count: async () => 1 } : { allTextContents: async () => ['', '任务名称', '调控状态'] };
    return { evaluateAll: async (fn, index) => {
      f.selectionReads++;
      const selected = typeof f.selectedIds === 'function' ? f.selectedIds(f.selectionReads) : f.selectedIds;
      const rows = selected.map(id => ({ querySelectorAll(selector) {
        return selector.startsWith('td') ? [{ innerText: '' }, { innerText: '任务\nID: ' + id }, { innerText: '调控中' }] : [{ checked: true }];
      } }));
      return fn(rows, index);
    } };
  } };
  f.page = { getByRole: () => header, locator: selector => selector === 'body' ? f.root : table,
    getByText: pattern => ({ filter() { return this; }, count: async () => pattern.test(f.message) ? 1 : 0 }) };
  f.binding = { primary_ad_id: '99999' };
  f.input = { scope: { type: 'task_confirmation', task_ids: ids, task_action: action },
    target: [{ by: 'role', value: 'button', name: '确定' }], action: 'click' };
  return f;
}

test('task confirmations bind exact selected IDs and observed pause/resume/delete wording before one click', async () => {
  for (const [action, ids] of [['pause', ['12345', '67890']], ['resume', ['12345']], ['delete', ['12345']]]) {
    const f = confirmationFixture(action, ids);
    const result = await createQianchuanNativeOperations().ui.run({ page: f.page, binding: f.binding, input: f.input });
    assert.equal(f.calls.length, 1);
    assert.equal(f.selectionReads, 2);
    assert.deepEqual(result.task_ids, ids);
    assert.equal(result.effect_status, 'unconfirmed');
    assert.equal(result.requires_readback, true);
  }
});

test('task confirmation rejects main plan IDs, missing binding, duplicate IDs and unobserved bulk delete', async () => {
  for (const scope of [
    { task_ids: ['99999'], task_action: 'delete' },
    { task_ids: ['12345', '12345'], task_action: 'pause' },
    { task_ids: ['12345', '67890'], task_action: 'delete' },
  ]) {
    const f = confirmationFixture(); f.input.scope = { type: 'task_confirmation', ...scope };
    await assert.rejects(createQianchuanNativeOperations().ui.run({ page: f.page, binding: f.binding, input: f.input }), { code: 'native_confirmation_binding_invalid' });
    assert.equal(f.calls.length, 0);
  }
  const f = confirmationFixture();
  await assert.rejects(createQianchuanNativeOperations().ui.run({ page: f.page, input: f.input }), { code: 'native_confirmation_binding_invalid' });
});

test('confirmation target list is rechecked immediately before dispatch and changed selection never submits', async () => {
  for (const selected of [['67890'], ['12345', '67890'], read => read === 1 ? ['12345'] : ['67890']]) {
    const f = confirmationFixture(); f.selectedIds = selected;
    await assert.rejects(createQianchuanNativeOperations().ui.run({ page: f.page, binding: f.binding, input: f.input }), { code: 'native_confirmation_selection_mismatch' });
    assert.equal(f.calls.length, 0);
  }
});

test('generic confirm, different operation/count and main-plan wording cannot stand in for a task confirmation', async () => {
  for (const message of ['确定', '确定暂停所选的2条任务吗？', '确定开启所选的1条任务吗？', '确定删除主计划吗？']) {
    const f = confirmationFixture(); f.message = message;
    await assert.rejects(createQianchuanNativeOperations().ui.run({ page: f.page, binding: f.binding, input: f.input }), { code: 'native_confirmation_text_mismatch' });
    assert.equal(f.calls.length, 0);
  }
  const f = confirmationFixture(); f.dialog.innerText += '\n主计划';
  await assert.rejects(createQianchuanNativeOperations().ui.run({ page: f.page, binding: f.binding, input: f.input }), { code: 'native_ui_scope_mismatch' });
  assert.equal(f.calls.length, 0);
});

test('task confirmation button must belong to the local confirmation and cannot use Enter', async () => {
  const operations = createQianchuanNativeOperations(), f = confirmationFixture();
  f.element.parentElement = { tagName: 'DIV', innerText: '其他编辑\n确定', parentElement: { tagName: 'BODY' } };
  await assert.rejects(operations.ui.run({ page: f.page, binding: f.binding, input: f.input }), { code: 'native_ui_scope_mismatch' });
  await assert.rejects(operations.ui.run({ page: f.page, binding: f.binding, input: { ...f.input, action: 'press', value: 'Enter' } }), { code: 'native_confirmation_click_required' });
  assert.equal(f.calls.length, 0);
});

function pickerFixture(ids = ['11111']) {
  const f = formFixture();
  const marker = '视频列表仅包括允许追投的全域在投视频';
  f.selectedIds = [...ids]; f.count = ids.length; f.markerPresent = true;
  f.container = { tagName: 'DIV', parentElement: { tagName: 'BODY' }, contains: () => true,
    get innerText() { return marker + `\n已选 ${f.count} / 20`; },
    querySelectorAll: () => f.selectedIds.map(id => ({ innerText: `测试视频 素材ID: ${id} 自选投放视频 审核通过`,
      querySelectorAll: selector => selector.startsWith('td') ? [{}] : [{ checked: true }] })) };
  f.element.tagName = 'BUTTON'; f.element.innerText = '确定'; f.element.parentElement = f.container;
  f.element.closest = selector => selector === 'button,[role="button"]' ? f.element : null;
  f.page = { locator: () => f.root, getByText: text => {
    assert.equal(text, marker);
    return { filter() { return this; }, count: async () => Number(f.markerPresent) };
  } };
  f.scope = { type: 'material_picker', material_ids: ids };
  f.input = { scope: f.scope, target: [{ by: 'role', value: 'button', name: '确定' }], action: 'click' };
  return f;
}

test('material picker confirms only the complete exact checked material set and observed selection count', async () => {
  const f = pickerFixture(['11111', '22222']);
  const result = await createQianchuanNativeOperations().ui.run({ page: f.page, input: f.input });
  assert.equal(f.calls.length, 1);
  assert.deepEqual(result.material_ids, ['11111', '22222']);
  assert.equal(result.requires_readback, true);
});

test('material picker rejects unseen extra selection, missing cross-page IDs and mismatched counts', async () => {
  for (const mutate of [f => { f.selectedIds = ['99999']; }, f => { f.count = 2; }, f => { f.selectedIds = []; }, f => { f.selectedIds = ['11111', '11111']; }]) {
    const f = pickerFixture(); mutate(f);
    await assert.rejects(createQianchuanNativeOperations().ui.run({ page: f.page, input: f.input }), { code: 'native_ui_scope_mismatch' });
    assert.equal(f.calls.length, 0);
  }
});

test('material picker requires its observed marker and explicit unique material IDs', async () => {
  const f = pickerFixture(); f.markerPresent = false;
  await assert.rejects(createQianchuanNativeOperations().ui.run({ page: f.page, input: f.input }), { code: 'native_material_picker_unverified' });
  const duplicate = pickerFixture(['11111', '11111']);
  await assert.rejects(createQianchuanNativeOperations().ui.run({ page: duplicate.page, input: duplicate.input }), { code: 'native_material_binding_invalid' });
});

test('picker search permits only authorized material IDs or clearing and Enter on the exact search input', () => {
  const f = pickerFixture(); f.element.tagName = 'INPUT'; f.element.innerText = '';
  f.element.getAttribute = name => name === 'placeholder' ? '输入视频名称/ID后回车搜索' : null;
  assert.equal(validateNativeUiTarget(f.element, { ...f.scope, ui_action: 'fill', ui_value: '11111' }), true);
  assert.equal(validateNativeUiTarget(f.element, { ...f.scope, ui_action: 'fill', ui_value: '' }), true);
  assert.equal(validateNativeUiTarget(f.element, { ...f.scope, ui_action: 'fill', ui_value: '99999' }), false);
  assert.equal(validateNativeUiTarget(f.element, { ...f.scope, ui_action: 'press', ui_value: 'Enter' }), true);
  assert.equal(validateNativeUiTarget(f.element, { ...f.scope, ui_action: 'press', ui_value: 'Space' }), false);
});

test('picker checkbox binds one eligible material row and cannot select the table header or another material', () => {
  const f = pickerFixture();
  const row = { tagName: 'TR', innerText: '素材ID: 11111 自选投放视频 审核通过', parentElement: f.container };
  f.element.tagName = 'INPUT'; f.element.innerText = ''; f.element.parentElement = row;
  f.element.closest = selector => selector === 'tr,[role="row"]' ? row : null;
  assert.equal(validateNativeUiTarget(f.element, { ...f.scope, ui_action: 'check' }), true);
  row.innerText = '素材ID: 99999 自选投放视频 审核通过';
  assert.equal(validateNativeUiTarget(f.element, { ...f.scope, ui_action: 'check' }), false);
  row.innerText = '素材ID: 11111 审核未通过';
  assert.equal(validateNativeUiTarget(f.element, { ...f.scope, ui_action: 'check' }), false);
  row.innerText = '素材ID 名称';
  assert.equal(validateNativeUiTarget(f.element, { ...f.scope, ui_action: 'check' }), false);
});

test('prepare batch is one write operation and runs explicit fields sequentially without submitting', async () => {
  const operations = createQianchuanNativeOperations(), f = formFixture();
  f.element.tagName = 'INPUT'; f.element.innerText = ''; f.element.getAttribute = name => name === 'type' ? 'number' : null;
  const handle = await f.target.elementHandle(); let active = 0, maximum = 0;
  handle.fill = async value => { active++; maximum = Math.max(maximum, active); await Promise.resolve(); f.calls.push(value); active--; };
  handle.press = async value => { f.calls.push(value); };
  const steps = ['100', '2.45'].map(value => ({ ...f.input, action: 'fill', value, target: [{ by: 'role', value: 'textbox' }] }));
  steps.push({ ...steps[0], action: 'press', value: 'Tab' });
  const result = await operations.ui_prepare_batch.run({ page: f.page, input: { steps } });
  assert.equal(operations.ui_prepare_batch.kind, 'write');
  assert.deepEqual(f.calls, ['100', '2.45', 'Tab']);
  assert.equal(maximum, 1);
  assert.equal(result.executed_steps, 3);
  assert.equal(result.status, 'prepared_not_submitted');
  assert.equal(result.advertising_writes, 0);
  assert.equal(result.retry_batch, false);
});

test('prepare batch validates all static steps before starting and rejects lifecycle scopes or Enter in forms', async () => {
  const operations = createQianchuanNativeOperations(), f = formFixture();
  const initial = { ...f.input, action: 'fill', value: '100' };
  for (const forbidden of [
    { ...f.input, scope: { type: 'task_confirmation', task_ids: ['12345'], task_action: 'delete' } },
    { ...f.input, scope: { type: 'task', task_id: '12345' } },
    { ...f.input, action: 'press', value: 'Enter' },
  ]) {
    const result = await operations.ui_prepare_batch.run({ page: f.page, input: { steps: [initial, forbidden] } });
    assert.equal(result.status, 'rejected'); assert.equal(result.failed_step, 2);
    assert.equal(result.executed_steps, 0); assert.equal(result.attempted_steps, 0);
  }
  assert.equal(f.calls.length, 0);
});

test('prepare batch rejects submit and generic confirm even through a CSS locator', async () => {
  for (const text of ['提交', '确定', '删除', '暂停', '开启', '取消']) {
    const f = formFixture(); f.element.innerText = text;
    const result = await createQianchuanNativeOperations().ui_prepare_batch.run({ page: f.page, input: { steps: [
      { ...f.input, target: [{ by: 'css', value: 'button' }] },
    ] } });
    assert.equal(result.ok, false); assert.equal(result.status, 'unknown');
    assert.equal(result.executed_steps, 0); assert.equal(f.calls.length, 0);
  }
});

test('prepare batch allows fully verified picker confirmation but no picker cancel', async () => {
  const operations = createQianchuanNativeOperations(), f = pickerFixture();
  const result = await operations.ui_prepare_batch.run({ page: f.page, input: { steps: [f.input] } });
  assert.equal(result.ok, true); assert.equal(f.calls.length, 1);
  const cancel = pickerFixture(); cancel.element.innerText = '取消';
  const rejected = await operations.ui_prepare_batch.run({ page: cancel.page, input: { steps: [cancel.input] } });
  assert.equal(rejected.ok, false); assert.equal(cancel.calls.length, 0);
});

test('prepare batch stops on first unknown action, reports returned steps, and never retries or runs the rest', async () => {
  const f = formFixture(); f.element.tagName = 'INPUT'; f.element.innerText = '';
  const handle = await f.target.elementHandle(); let calls = 0;
  handle.fill = async value => { calls++; if (calls === 2) throw new Error('connection lost after action dispatch'); f.calls.push(value); };
  const steps = ['100', '2.45', '其他值'].map(value => ({ ...f.input, action: 'fill', value }));
  const result = await createQianchuanNativeOperations().ui_prepare_batch.run({ page: f.page, input: { steps } });
  assert.equal(result.status, 'unknown'); assert.equal(result.executed_steps, 1);
  assert.equal(result.attempted_steps, 2); assert.equal(result.failed_step, 2);
  assert.equal(calls, 2); assert.equal(result.retry_batch, false);
  assert.equal(result.requires_readback, true);
});

test('prepare batch has a 25-step bound and accepts no code, arbitrary path, or per-step runtime override', async () => {
  const operations = createQianchuanNativeOperations(), f = formFixture();
  for (const input of [{ steps: [] }, { steps: Array(26).fill(f.input) }, { steps: [f.input], code: 'anything' }]) {
    const result = await operations.ui_prepare_batch.run({ page: f.page, input });
    assert.equal(result.status, 'rejected'); assert.equal(result.executed_steps, 0);
  }
  const result = await operations.ui_prepare_batch.run({ page: f.page, input: { steps: [{ ...f.input, prepareOnly: false }] } });
  assert.equal(result.status, 'rejected'); assert.equal(f.calls.length, 0);
});

test('prepare batch only admits observed form choice/openers and real input fields', () => {
  const base = { type: 'boost_form', prepare_only: true, ui_action: 'click' };
  for (const innerText of ['控成本追投', '放量追投', '添加视频', '+ 设置定向']) {
    assert.equal(validateNativeUiTarget({ innerText, getAttribute: () => null }, base), true);
  }
  const button = { tagName: 'BUTTON', innerText: '', getAttribute: () => null };
  assert.equal(validateNativeUiTarget(button, { ...base, ui_action: 'fill', ui_value: '100' }), false);
  const input = { tagName: 'INPUT', innerText: '', getAttribute: name => name === 'type' ? 'submit' : null };
  assert.equal(validateNativeUiTarget(input, { ...base, ui_action: 'fill', ui_value: '100' }), false);
});

test('control tab scope permits only the observed navigation tab, never plan actions or links', () => {
  const make = (text, role = 'tab') => ({ innerText: text, getAttribute: key => key === 'role' ? role : null });
  const scope = { type: 'control_tab', ui_action: 'click' };
  assert.equal(validateNativeUiTarget(make('调控'), scope), true);
  for (const text of ['删除计划', '更多计划操作', '素材', '确定', '提交']) assert.equal(validateNativeUiTarget(make(text), scope), false);
  assert.equal(validateNativeUiTarget(make('调控', 'button'), scope), false);
  assert.equal(validateNativeUiTarget(make('调控'), { ...scope, ui_action: 'press' }), false);
  assert.equal(validateNativeUiTarget({ ...make('调控'), closest: () => ({ getAttribute: () => 'https://example.com' }) }, scope), false);
});

test('activation uses the already bound page and accepts no navigation parameters', async () => {
  let calls = 0;
  const operation = createQianchuanNativeOperations().activate_page;
  const page = { bringToFront: async () => { calls++; } };
  assert.equal(operation.kind, 'write');
  await assert.rejects(operation.run({ page, input: { url: 'https://example.com' } }), { code: 'native_activate_options_invalid' });
  assert.equal(calls, 0);
  const result = await operation.run({ page, input: {} });
  assert.equal(calls, 1); assert.equal(result.advertising_writes, 0);
});

test('UI timeout remains unknown and does not dispatch a second action', async () => {
  const f = formFixture(); let calls = 0;
  (await f.target.elementHandle()).click = async () => { calls++; throw Object.assign(new Error('slow action'), { name: 'TimeoutError' }); };
  await assert.rejects(createQianchuanNativeOperations().ui.run({ page: f.page, input: f.input }), { code: 'native_ui_action_timeout' });
  assert.equal(calls, 1);
});
