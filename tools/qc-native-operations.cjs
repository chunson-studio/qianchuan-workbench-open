'use strict';

const { readQianchuanControlRaw } = require('./read-qc-control-raw.playwright.cjs');
const { readQianchuanControlPages } = require('./read-qc-control-pages.playwright.cjs');
const TABLES = '.main-vmok-plugin-oc-table-wrapper, .oc-table-wrapper';
const fail = code => { throw Object.assign(new Error(code), { code }); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const idValue = value => typeof value === 'string' && /^\d+$/.test(value);
const keys = (value, names) => object(value) && Object.keys(value).every(name => names.includes(name));
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function chain(root, steps) {
  if (!Array.isArray(steps) || !steps.length || steps.length > 8) fail('native_locator_invalid');
  for (const step of steps) {
    if (!keys(step, ['by', 'value', 'name', 'exact', 'index']) || typeof step.by !== 'string') fail('native_locator_invalid');
    if (step.by === 'nth') {
      if (!Number.isInteger(step.index) || step.index < 0 || step.index > 1000) fail('native_locator_invalid');
      root = root.nth(step.index); continue;
    }
    if (['first', 'last'].includes(step.by)) { root = root[step.by](); continue; }
    if (typeof step.value !== 'string' || !step.value.length || step.value.length > 500 ||
        (step.exact !== undefined && typeof step.exact !== 'boolean')) fail('native_locator_invalid');
    const exact = step.exact !== false;
    if (step.by === 'css') {
      if (/>>|^\s*[a-z][a-z0-9_-]*(?::light)?\s*=|^\s*\.{1,2}\s*$|^\s*\//i.test(step.value)) fail('native_locator_invalid');
      root = root.locator(step.value);
    } else if (step.by === 'role') {
      if (step.name !== undefined && (typeof step.name !== 'string' || step.name.length > 500)) fail('native_locator_invalid');
      root = root.getByRole(step.value, step.name === undefined ? {} : { name: step.name, exact });
    } else if (step.by === 'text') root = root.getByText(step.value, { exact });
    else if (step.by === 'label') root = root.getByLabel(step.value, { exact });
    else if (step.by === 'placeholder') root = root.getByPlaceholder(step.value, { exact });
    else if (step.by === 'testid') root = root.getByTestId(step.value);
    else if (step.by === 'hasText') root = root.filter({ hasText: step.value });
    else fail('native_locator_invalid');
  }
  return root;
}

async function uniqueVisible(locator) {
  const visible = locator.filter({ visible: true });
  if (await visible.count() !== 1) fail('native_target_not_unique');
  return visible;
}

async function controlTable(page) {
  const header = page.getByRole('row').filter({ has: page.getByRole('columnheader', { name: '任务名称', exact: true }) });
  if (await header.count() !== 1) fail('native_control_table_unverified');
  const root = await uniqueVisible(page.locator(TABLES).filter({ has: header }));
  if (await root.getByRole('columnheader', { name: '调控状态', exact: true }).count() !== 1) fail('native_control_table_unverified');
  return root;
}

function confirmationIds(scope, binding) {
  const ids = scope.task_ids ?? (scope.task_id ? [scope.task_id] : null);
  if (!binding || typeof binding.primary_ad_id !== 'string' || !/^\d+$/.test(binding.primary_ad_id) ||
      (scope.task_ids && scope.task_id) || !Array.isArray(ids) || !ids.length || ids.length > 200 ||
      ids.some(id => typeof id !== 'string' || !/^\d+$/.test(id) || id === binding.primary_ad_id) || new Set(ids).size !== ids.length ||
      !['pause', 'resume', 'delete'].includes(scope.task_action) || (scope.task_action !== 'pause' && ids.length !== 1)) fail('native_confirmation_binding_invalid');
  return ids;
}

async function verifyTaskConfirmation(page, scope, binding) {
  const ids = confirmationIds(scope, binding);
  const table = await controlTable(page);
  const headers = (await table.getByRole('columnheader').allTextContents()).map(text => text.trim());
  const nameIndex = headers.indexOf('任务名称');
  if (nameIndex < 0 || headers.lastIndexOf('任务名称') !== nameIndex) fail('native_control_table_unverified');
  const selection = await table.getByRole('row').evaluateAll((rows, index) => {
    const ids = []; let invalid = false;
    for (const row of rows) {
      const cells = [...row.querySelectorAll('td,[role="cell"]')];
      if (!cells.length) continue; // Header select-all is not a task.
      const selected = [...row.querySelectorAll('input[type="checkbox"],[role="checkbox"]')].some(node => node.checked || node.getAttribute('aria-checked') === 'true');
      if (!selected) continue;
      const matches = [...(cells[index]?.innerText || '').matchAll(/ID[:：]\s*(\d+)/g)].map(match => match[1]);
      if (matches.length !== 1) invalid = true;
      else ids.push(matches[0]);
    }
    return { ids, invalid };
  }, nameIndex);
  if (selection.invalid || selection.ids.length !== ids.length || new Set(selection.ids).size !== ids.length ||
      selection.ids.some(id => !ids.includes(id))) fail('native_confirmation_selection_mismatch');
  // Verified pause/resume wording: qc-control-pools.playwright.cjs. Delete:
  // 浏览器页面学习-20260923/09-浏览器写入验收回执.json. Only one-target
  // resume/delete is evidenced; do not invent a multi-target variant.
  const verb = { pause: '暂停', resume: '开启', delete: '删除' }[scope.task_action];
  const pattern = new RegExp('^确定' + verb + '所选的\\s*' + ids.length + '\\s*条任务吗？' + (scope.task_action === 'delete' ? '\\s*删除后不可恢复' : '') + '$');
  if (await page.getByText(pattern).filter({ visible: true }).count() !== 1) fail('native_confirmation_text_mismatch');
  return ids;
}

async function scopeRoot(page, scope, binding) {
  if (!keys(scope, ['type', 'task_id', 'task_ids', 'task_action', 'material_ids', 'root', 'title'])) fail('native_scope_required');
  if (scope.type === 'task_confirmation') {
    await verifyTaskConfirmation(page, scope, binding);
    // The body is only a lookup base. The pinned button must independently
    // belong to a bounded container containing the exact task confirmation.
    return uniqueVisible(page.locator('body'));
  }
  if (scope.type === 'material_picker') {
    if (!Array.isArray(scope.material_ids) || !scope.material_ids.length || scope.material_ids.length > 20 ||
        scope.material_ids.some(id => typeof id !== 'string' || !/^\d+$/.test(id)) ||
        new Set(scope.material_ids).size !== scope.material_ids.length) fail('native_material_binding_invalid');
    if (await page.getByText('视频列表仅包括允许追投的全域在投视频', { exact: true }).filter({ visible: true }).count() !== 1) fail('native_material_picker_unverified');
    return uniqueVisible(scope.root ? chain(page, scope.root) : page.locator('body'));
  }
  if (scope.type === 'task') {
    if (typeof scope.task_id !== 'string' || !/^\d+$/.test(scope.task_id)) fail('native_task_id_required');
    const table = await controlTable(page);
    // Match the observed ID element itself: row textContent joins adjacent
    // cells, and a name/material can contain an unrelated ID-looking string.
    const idElement = page.getByText(new RegExp('^ID[:：]\\s*' + escape(scope.task_id) + '$'));
    const row = await uniqueVisible(table.getByRole('row').filter({ has: idElement }));
    const headers = (await table.getByRole('columnheader').allTextContents()).map(text => text.trim());
    const index = headers.indexOf('任务名称');
    if (index < 0 || headers.lastIndexOf('任务名称') !== index) fail('native_control_table_unverified');
    const nameCell = await row.getByRole('cell').nth(index).innerText();
    const ids = [...nameCell.matchAll(/ID[:：]\s*(\d+)/g)].map(match => match[1]);
    if (ids.length !== 1 || ids[0] !== scope.task_id) fail('native_task_id_mismatch');
    return row;
  }
  if (scope.type === 'control_table') return controlTable(page);
  if (scope.type === 'control_tab') {
    if (!binding || !idValue(binding.advertiser_id) || !idValue(binding.primary_ad_id)) fail('native_control_binding_required');
    if (await page.getByRole('button', { name: '提交', exact: true }).filter({ visible: true }).count() ||
        await page.getByRole('button', { name: '确定', exact: true }).filter({ visible: true }).count()) fail('native_existing_form_preserved');
    for (const text of ['ID：' + binding.advertiser_id, '计划ID：' + binding.primary_ad_id]) {
      await uniqueVisible(page.getByText(text, { exact: true }));
    }
    return uniqueVisible(page.locator('body'));
  }
  if (scope.type === 'pagination') return uniqueVisible(page.locator('.main-vmok-plugin-page-turner'));
  if (['filters', 'boost_entry'].includes(scope.type)) {
    if (await page.getByRole('button', { name: '提交', exact: true }).filter({ visible: true }).count()) fail('native_existing_form_preserved');
    if (scope.type === 'boost_entry' && await page.getByRole('button', { name: '确定', exact: true }).filter({ visible: true }).count()) fail('native_existing_form_preserved');
    await controlTable(page);
    return uniqueVisible(page.locator('body')); // Final target is limited to the verified controls below.
  }
  if (scope.type === 'boost_form') {
    if (typeof scope.title !== 'string' || !/追投|调控|快速激活素材/.test(scope.title) || /主计划|新建计划|编辑计划|删除计划|计划设置/.test(scope.title)) fail('native_boost_form_required');
    const root = await uniqueVisible(scope.root ? chain(page, scope.root) : page.getByRole('dialog'));
    const valid = await root.evaluate(element => !['HTML', 'BODY'].includes(element.tagName) && !/计划ID[:：]/.test(element.innerText || ''));
    if (!valid || await root.getByText(scope.title, { exact: true }).filter({ visible: true }).count() !== 1) fail('native_boost_form_required');
    return root;
  }
  fail('native_scope_invalid');
}

// This fixed function runs in the page. No caller-provided JavaScript is used.
function validateNativeUiTarget(element, scope) {
  const text = (element.innerText || element.getAttribute('aria-label') || '').trim();
  if (/主计划|删除计划|关闭计划|计划设置|计划开关/.test(text)) return false;
  const link = typeof element.closest === 'function' ? element.closest('a[href]') : null;
  if (link && !/^(?:|#|javascript:void\(0\);?)$/i.test((link.getAttribute('href') || '').trim())) return false;
  if (scope.type === 'control_tab') return scope.ui_action === 'click' &&
    element.getAttribute('role') === 'tab' && text === '调控';
  if (scope.prepare_only) {
    if (scope.type === 'boost_form') {
      const input = ['INPUT', 'TEXTAREA'].includes(element.tagName);
      const type = (element.getAttribute('type') || '').toLowerCase();
      const choice = ['checkbox', 'radio'].includes(type) || ['checkbox', 'radio'].includes(element.getAttribute('role'));
      if (scope.ui_action === 'fill' && (!input || ['button', 'submit', 'reset', 'image', 'file', 'hidden', 'password', 'checkbox', 'radio'].includes(type))) return false;
      if (['check', 'uncheck'].includes(scope.ui_action) && !choice) return false;
      if (scope.ui_action === 'press' && (!input || scope.ui_value !== 'Tab')) return false;
      // Existing observed preparation choices/openers; no submit, generic
      // confirm, discard, lifecycle action, or arbitrary label is admitted.
      if (scope.ui_action === 'click' && !['放量追投', '控成本追投', '综合营销ROI', '直播间成交', '视频', '直播间画面', '添加视频', '+ 设置定向'].includes(text)) return false;
    } else if (scope.type === 'material_picker') {
      if (scope.ui_action === 'click' && text !== '确定') return false;
    } else return false;
  }
  if (scope.type === 'task_confirmation') {
    if (text !== '确定') return false;
    const ids = scope.task_ids ?? [scope.task_id];
    const verb = { pause: '暂停', resume: '开启', delete: '删除' }[scope.task_action];
    const expected = '确定' + verb + '所选的' + ids.length + '条任务吗？' + (scope.task_action === 'delete' ? '删除后不可恢复' : '');
    let node = element.parentElement;
    for (let i = 0; node && i < 12 && !['BODY', 'HTML'].includes(node.tagName); i++, node = node.parentElement) {
      const raw = node.innerText || '';
      if (raw.length > 2000 || /主计划|计划ID[:：]|删除计划|关闭计划/.test(raw)) return false;
      if (!raw.replace(/\s/g, '').includes(expected)) continue;
      const buttons = [...node.querySelectorAll('button,[role="button"]')].filter(button => button.getClientRects().length && (button.innerText || '').trim() === '确定');
      return buttons.length === 1 && (buttons[0] === element || buttons[0].contains(element));
    }
    return false;
  }
  if (scope.type === 'material_picker') {
    let container = element;
    for (let i = 0; container && i < 15 && !['BODY', 'HTML'].includes(container.tagName); i++, container = container.parentElement) {
      if ((container.innerText || '').includes('视频列表仅包括允许追投的全域在投视频')) break;
    }
    if (!container || ['BODY', 'HTML'].includes(container.tagName) || /计划ID[:：]|主计划|删除计划/.test(container.innerText || '')) return false;
    if (element.tagName === 'INPUT' && element.getAttribute('placeholder') === '输入视频名称/ID后回车搜索') {
      return scope.ui_action === 'fill' ? scope.ui_value === '' || scope.material_ids.includes(scope.ui_value) : scope.ui_action === 'press' && scope.ui_value === 'Enter';
    }
    if (['check', 'uncheck'].includes(scope.ui_action)) {
      const row = element.closest('tr,[role="row"]');
      if (!row || !container.contains(row)) return false;
      const raw = row.innerText || '', ids = [...raw.matchAll(/素材ID[:：]\s*(\d+)/g)].map(match => match[1]);
      return ids.length === 1 && scope.material_ids.includes(ids[0]) && /自选投放视频/.test(raw) && /审核通过/.test(raw);
    }
    if (scope.ui_action !== 'click' || !['确定', '取消'].includes(text)) return false;
    const button = element.closest('button,[role="button"]');
    if (!button || !container.contains(button) || (button.innerText || '').trim() !== text) return false;
    if (text === '取消') return true;
    const counts = [...(container.innerText || '').matchAll(/已选\s*(\d+)\s*\/\s*(19|20)(?!\d)/g)];
    if (counts.length !== 1 || Number(counts[0][1]) !== scope.material_ids.length) return false;
    const selected = [];
    for (const row of container.querySelectorAll('tr,[role="row"]')) {
      if (![...row.querySelectorAll('input[type="checkbox"],[role="checkbox"]')].some(node => node.checked || node.getAttribute('aria-checked') === 'true')) continue;
      const ids = [...(row.innerText || '').matchAll(/素材ID[:：]\s*(\d+)/g)].map(match => match[1]);
      if (!ids.length && !row.querySelectorAll('td,[role="cell"]').length) continue;
      if (ids.length !== 1) return false;
      selected.push(ids[0]);
    }
    return selected.length === scope.material_ids.length && new Set(selected).size === selected.length && selected.every(id => scope.material_ids.includes(id));
  }
  if (scope.type === 'boost_entry') return ['素材追投', '一键调速'].includes(text);
  if (scope.type !== 'filters') return true;
  if (element.tagName === 'INPUT') {
    if (/^(?:请选择)?(?:开始日期|结束日期)$/.test(element.getAttribute('placeholder') || '')) return true;
    const pools = [...element.ownerDocument.querySelectorAll('input[placeholder="请选择"]')].filter(node => node.getClientRects().length);
    return pools.length === 3 && pools[2] === element;
  }
  if (['今天', '昨天'].includes(text)) {
    // Observed date quick-picker: list > listitem 今天/昨天/最近3天/最近7天.
    const item = element.closest('li,[role="listitem"]');
    const list = item?.closest('ul,ol,[role="list"]');
    if (!item || !list || !['今天', '昨天'].includes((item.innerText || '').trim())) return false;
    const labels = [...list.querySelectorAll('li,[role="listitem"]')].map(node => (node.innerText || '').trim());
    return ['今天', '昨天', '最近3天', '最近7天'].every(label => labels.includes(label));
  }
  if (!['调控中', '已暂停', '手动暂停', '全部（包括已删除）'].includes(text)) return false;
  const menu = element.closest('ul,[role="list"]');
  return !!menu && /全部（包括已删除）|关联直播间未开播/.test(menu.innerText || '');
}

function validateUiInput(input) {
  if (!keys(input, ['scope', 'target', 'action', 'value', 'timeoutMs']) ||
      !['click', 'fill', 'check', 'uncheck', 'press', 'hover'].includes(input.action)) fail('native_ui_request_invalid');
  const timeout = input.timeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 15000) fail('native_ui_timeout_invalid');
  if (['fill', 'press'].includes(input.action) && (typeof input.value !== 'string' || input.value.length > 2000)) fail('native_ui_value_invalid');
  if (input.action === 'press' && !['Tab', 'Enter', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'ControlOrMeta+A'].includes(input.value)) fail('native_ui_key_invalid');
  if (input.scope?.type === 'boost_entry' && input.action !== 'click') fail('native_boost_entry_click_required');
  if (input.scope?.type === 'task_confirmation' && input.action !== 'click') fail('native_confirmation_click_required');
  if (input.scope?.type === 'control_tab' && input.action !== 'click') fail('native_control_tab_click_required');
  return timeout;
}

async function ui({ page, binding, input, prepareOnly = false }) {
  const timeout = validateUiInput(input);
  const root = await scopeRoot(page, input.scope, binding);
  const target = await uniqueVisible(chain(root, input.target));
  let rootHandle, targetHandle;
  try {
    rootHandle = await root.elementHandle();
    targetHandle = await target.elementHandle();
    if (!rootHandle || !targetHandle || !await targetHandle.evaluate((element, container) =>
      container.isConnected && element.isConnected && container.contains(element), rootHandle)) fail('native_ui_scope_mismatch');
    if (!await targetHandle.evaluate(validateNativeUiTarget, { ...input.scope, ui_action: input.action, ui_value: input.value, prepare_only: prepareOnly })) fail('native_ui_scope_mismatch');
    if (input.scope.type === 'task_confirmation') await verifyTaskConfirmation(page, input.scope, binding);
    // Pin the verified node: a locator must not resolve a different target when
    // the DOM changes between containment verification and the action.
    if (['fill', 'press'].includes(input.action)) await targetHandle[input.action](input.value, { timeout });
    else await targetHandle[input.action]({ timeout });
  } catch (error) {
    if (error?.name === 'TimeoutError' && !error.code) error.code = 'native_ui_action_timeout';
    throw error;
  } finally {
    await targetHandle?.dispose().catch(() => {});
    await rootHandle?.dispose().catch(() => {});
  }
  return { ok: true, action_returned: true, requires_readback: true, effect_status: 'unconfirmed', retry_write: false,
    scope: input.scope.type, task_id: input.scope.task_id ?? null, task_ids: input.scope.task_ids ?? null,
    material_ids: input.scope.material_ids ?? null, action: input.action };
}

async function uiPrepareBatch({ page, binding, input }) {
  const base = { advertising_writes: 0, retry_write: false, retry_batch: false, requires_readback: true };
  if (!keys(input, ['steps']) || !Array.isArray(input.steps) || !input.steps.length || input.steps.length > 25) {
    return { ...base, ok: false, status: 'rejected', effect_status: 'not_submitted', executed_steps: 0, attempted_steps: 0, failed_step: null, code: 'native_prepare_batch_invalid' };
  }
  // Validate every static step before starting. Runtime DOM verification and
  // node pinning remain in ui; this loop adds no lock, state file or retry.
  for (let index = 0; index < input.steps.length; index++) {
    const step = input.steps[index];
    try {
      validateUiInput(step);
      if (!['boost_form', 'material_picker'].includes(step.scope?.type) ||
          !['fill', 'check', 'uncheck', 'click', 'press'].includes(step.action) ||
          (step.action === 'press' && step.value !== (step.scope.type === 'boost_form' ? 'Tab' : 'Enter'))) fail('native_prepare_batch_step_forbidden');
    } catch (error) {
      return { ...base, ok: false, status: 'rejected', effect_status: 'not_submitted', executed_steps: 0, attempted_steps: 0,
        failed_step: index + 1, code: error.code || 'native_prepare_batch_step_invalid' };
    }
  }
  for (let index = 0; index < input.steps.length; index++) {
    try { await ui({ page, binding, input: input.steps[index], prepareOnly: true }); }
    catch (error) {
      return { ...base, ok: false, status: 'unknown', effect_status: 'unconfirmed', executed_steps: index, attempted_steps: index + 1,
        failed_step: index + 1, code: error.code || 'native_prepare_batch_step_failed' };
    }
  }
  return { ...base, ok: true, status: 'prepared_not_submitted', effect_status: 'not_submitted',
    executed_steps: input.steps.length, attempted_steps: input.steps.length, failed_step: null };
}

function createQianchuanNativeOperations() {
  // ui is one action, not a transaction over an entire multi-step form. The
  // caller must keep one active round per room/main plan until its form closes
  // and the result is read back. Profile serialization is per operation only.
  const readSpec = (binding, input) => {
    if (!keys(input, ['date', 'pool', 'maxPages', 'timeoutMs']) || typeof input.date !== 'string' || typeof input.pool !== 'string') fail('native_read_spec_invalid');
    return { advertiser_id: binding.advertiser_id, primary_ad_id: binding.primary_ad_id, date: input.date, pool: input.pool };
  };
  return {
    snapshot: { kind: 'read', run: async ({ page, input }) => {
      if (!keys(input, [])) fail('native_snapshot_options_invalid');
      const body = await uniqueVisible(page.locator('body'));
      return { ok: true, url: page.url(), captured_at: new Date().toISOString(),
        snapshot: await body.ariaSnapshot({ timeout: 5000 }), source: 'native_aria_snapshot', advertising_writes: 0 };
    } },
    read_control: { kind: 'read', run: ({ page, binding, input }) => readQianchuanControlRaw(page, readSpec(binding, input)) },
    read_control_pages: { kind: 'write', run: ({ page, binding, input }) => readQianchuanControlPages(page, readSpec(binding, input),
      { maxPages: input.maxPages ?? 20, timeoutMs: input.timeoutMs ?? 8000 }) },
    refresh: { kind: 'write', run: async ({ page, input }) => {
      if (!keys(input, ['timeoutMs']) || !Number.isSafeInteger(input.timeoutMs ?? 15000) || (input.timeoutMs ?? 15000) < 1 || (input.timeoutMs ?? 15000) > 30000) fail('native_refresh_options_invalid');
      if (await page.getByRole('button', { name: '提交', exact: true }).filter({ visible: true }).count() ||
          await page.getByRole('button', { name: '确定', exact: true }).filter({ visible: true }).count()) fail('native_existing_form_preserved');
      await page.reload({ waitUntil: 'domcontentloaded', timeout: input.timeoutMs ?? 15000 });
      return { ok: true, reloaded: true, ready_verified: false, advertising_writes: 0 };
    } },
    activate_page: { kind: 'write', run: async ({ page, input }) => {
      if (!keys(input, [])) fail('native_activate_options_invalid');
      await page.bringToFront();
      return { ok: true, activated: true, advertising_writes: 0, requires_readback: true };
    } },
    ui: { kind: 'write', run: ui },
    ui_prepare_batch: { kind: 'write', run: uiPrepareBatch },
  };
}

module.exports = { createQianchuanNativeOperations, validateNativeUiTarget };
