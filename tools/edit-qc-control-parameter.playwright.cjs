'use strict';

const { getChromePageTarget } = require('./attach-qc-chrome.playwright.cjs');
const { readQianchuanControlRaw } = require('./read-qc-control-raw.playwright.cjs');

const MODAL = '.main-vmok-plugin-modal';
const NAME = '请输入任务名称，1-50个字符';
const ROI = '请输入期望的综合营销ROI目标';
const PARAMETER_HEADERS = { budget: '调控预算(元)', roi_goal: '综合营销ROI目标', duration_hours: '调控时长(小时)' };
const ROI_TARGET_HEADERS = ['综合营销ROI目标', '净成交ROI目标'];
const STATIC_HEADERS = ['任务名称', '素材', '调控状态', '调控预算(元)', '支付ROI目标', '出价', '调控时长(小时)', '追投方式', '创建时间'];
const handles = new WeakMap();

function fail(code, message) { throw Object.assign(new Error(message || code), { code }); }
function requireThat(condition, code, message) { if (!condition) fail(code, message); }
function mark(error, dispatched = false) {
  if (!(error instanceof Error)) error = new Error(String(error));
  error.details = { ...error.details, effect_status: dispatched ? 'unconfirmed' : 'not_submitted', retry_write: false };
  return error;
}
function visible(locator) { return locator.filter({ visible: true }); }
async function unique(locator, code) {
  const result = visible(locator);
  requireThat(await result.count() === 1, code);
  return result;
}
function numeric(value) {
  const normalized = String(value).trim().replaceAll(',', '');
  return /^\d+(?:\.\d+)?$/.test(normalized) ? Number(normalized) : null;
}
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function sameIds(a, b) { return same([...a].sort(), [...b].sort()); }
// Both target-column labels were captured from the real control tables. Select
// exactly one; never equate their ROI meanings or invent a net-ROI form layout.
function selectQianchuanParameterHeaders(headers) {
  requireThat(Array.isArray(headers) && headers.every(header => typeof header === 'string'), 'table_structure_changed');
  const roiHeaders = headers.filter(header => ROI_TARGET_HEADERS.includes(header));
  requireThat(roiHeaders.length === 1 && STATIC_HEADERS.every(header => headers.filter(value => value === header).length === 1), 'table_structure_changed');
  return { roi_target_header: roiHeaders[0], parameter_headers: { ...PARAMETER_HEADERS, roi_goal: roiHeaders[0] },
    static_headers: [...STATIC_HEADERS, roiHeaders[0]] };
}
function validate(spec) {
  requireThat(spec && ['advertiser_id', 'primary_ad_id', 'task_id'].every(key => typeof spec[key] === 'string' && /^\d+$/.test(spec[key])) &&
    typeof spec.browser_context_id === 'string' && spec.browser_context_id.trim() && spec.task_id !== spec.primary_ad_id,
  'binding_required', 'Explicit Chrome profile, advertiser, primary plan and a distinct task ID are required');
  requireThat(typeof spec.expected_status === 'string' && spec.expected_status.trim() && typeof spec.pool === 'string' && spec.pool.trim() &&
    /^\d{4}-\d{2}-\d{2}$/.test(spec.date || '') && Number.isFinite(Date.parse(spec.date)) && new Date(spec.date).toISOString().slice(0, 10) === spec.date, 'view_required');
  requireThat(Object.hasOwn(PARAMETER_HEADERS, spec.parameter), 'parameter_invalid');
  requireThat(['material_cost', 'live_volume'].includes(spec.form_kind), 'form_kind_required');
  requireThat(spec.form_kind !== 'live_volume' || spec.parameter !== 'roi_goal', 'parameter_not_available');
  requireThat(spec.form_kind !== 'material_cost' || spec.parameter !== 'duration_hours', 'parameter_not_available');
  requireThat([spec.expected_value, spec.new_value, spec.bounds?.min, spec.bounds?.max].every(value => typeof value === 'number' && Number.isFinite(value)) &&
    spec.expected_value > 0 && spec.new_value > 0 && spec.bounds.min > 0 && spec.bounds.max >= spec.bounds.min &&
    spec.new_value >= spec.bounds.min && spec.new_value <= spec.bounds.max && spec.new_value !== spec.expected_value, 'parameter_bounds_invalid');
  if (spec.bounds.max_change_fraction !== undefined) requireThat(Number.isFinite(spec.bounds.max_change_fraction) && spec.bounds.max_change_fraction >= 0 &&
    Math.abs(spec.new_value - spec.expected_value) / spec.expected_value <= spec.bounds.max_change_fraction + Number.EPSILON, 'parameter_change_exceeds_bound');
  if (spec.form_kind === 'material_cost') requireThat(Array.isArray(spec.material_ids) && spec.material_ids.length > 0 &&
    spec.material_ids.every(id => typeof id === 'string' && /^\d+$/.test(id)) && new Set(spec.material_ids).size === spec.material_ids.length, 'material_ids_required');
  else requireThat(typeof spec.live_material_id === 'string' && /^\d+$/.test(spec.live_material_id), 'live_material_id_required');
  requireThat(Number.isSafeInteger(spec.timeoutMs ?? 8000) && (spec.timeoutMs ?? 8000) > 0, 'timeout_invalid');
  return structuredClone({ ...spec, timeoutMs: spec.timeoutMs ?? 8000 });
}

function checkUrl(value, spec) {
  let url;
  try { url = new URL(value); } catch { fail('identity_mismatch'); }
  requireThat(url.origin === 'https://qianchuan.jinritemai.com' && !url.username && !url.password, 'identity_mismatch');
  const params = new URLSearchParams(url.search), query = url.hash.indexOf('?');
  if (query >= 0) for (const [key, val] of new URLSearchParams(url.hash.slice(query + 1))) params.append(key, val);
  for (const [keys, expected] of [[['aavid', 'advertiser_id', 'advertiserId'], spec.advertiser_id], [['adId', 'primary_ad_id', 'primaryAdId'], spec.primary_ad_id]]) {
    const values = keys.flatMap(key => params.getAll(key));
    requireThat(values.length && values.every(value => value === expected), 'identity_mismatch');
  }
}
async function identity(page, spec, originalTarget) {
  checkUrl(page.url(), spec);
  const target = await getChromePageTarget(page);
  requireThat(target.browserContextId === spec.browser_context_id && (!originalTarget || target.targetId === originalTarget), 'chrome_profile_mismatch');
  checkUrl(target.url, spec); checkUrl(page.url(), spec);
  const account = await unique(page.getByText('ID：' + spec.advertiser_id, { exact: true }), 'account_identity_ambiguous');
  requireThat(await account.isVisible(), 'account_identity_unavailable');
  return target.targetId;
}
function taskFromRaw(raw, spec) {
  requireThat(raw && Array.isArray(raw.tasks), 'table_structure_changed');
  const columns = selectQianchuanParameterHeaders(raw.headers);
  const tasks = raw.tasks.filter(task => task.task_id === spec.task_id);
  requireThat(tasks.length === 1, 'original_task_unavailable');
  requireThat(Array.isArray(tasks[0].raw_cells) && tasks[0].raw_cells.length === raw.headers.length &&
    tasks[0].raw_cells.every(value => typeof value === 'string'), 'table_structure_changed');
  const cells = Object.fromEntries(raw.headers.map((header, index) => [header, tasks[0].raw_cells[index]]));
  const name = cells['任务名称'].split(/\nID:\s*\d+/)[0].trim();
  requireThat(cells['调控状态'] === spec.expected_status && cells['追投方式'] === (spec.form_kind === 'material_cost' ? '控成本追投' : '放量追投'), 'original_task_changed');
  if (spec.form_kind === 'material_cost') {
    const ids = [...cells['素材'].matchAll(/素材ID[：:]\s*(\d+)/g)].map(match => match[1]);
    requireThat(sameIds(ids, spec.material_ids), 'original_material_mismatch');
  } else requireThat(new RegExp('(?:^|\\n)ID[：:]\\s*' + spec.live_material_id + '(?=\\s|$)').test(cells['素材']), 'original_live_material_mismatch');
  return { task_id: spec.task_id, name, cells, roi_target_header: columns.roi_target_header,
    parameter_header: columns.parameter_headers[spec.parameter], value: numeric(cells[columns.parameter_headers[spec.parameter]].split('\n')[0]),
    budget: numeric(cells['调控预算(元)']), roi_goal: numeric(cells[columns.roi_target_header]),
    duration_hours: numeric(cells['调控时长(小时)'].split('\n')[0]) };
}
function unchanged(before, after, parameter, newValue) {
  const columns = selectQianchuanParameterHeaders(Object.keys(before.cells));
  requireThat(after.roi_target_header === before.roi_target_header && after.parameter_header === before.parameter_header, 'table_structure_changed');
  for (const header of columns.static_headers) {
    if (header === columns.parameter_headers[parameter]) requireThat(after.value === newValue, 'parameter_not_verified');
    else requireThat(before.cells[header] === after.cells[header], 'other_task_parameter_changed');
  }
}
async function readOriginal(page, spec) { return taskFromRaw(await readQianchuanControlRaw(page, spec), spec); }
async function modal(page) { return unique(page.locator(MODAL), 'editor_not_unique'); }
async function fields(root, spec) {
  const name = await unique(root.getByPlaceholder(NAME, { exact: true }), 'editor_name_ambiguous');
  const plain = visible(root.getByPlaceholder('请输入', { exact: true }));
  requireThat(await plain.count() === (spec.form_kind === 'material_cost' ? 1 : 2), 'editor_fields_changed');
  const result = { name, budget: plain.nth(0) };
  if (spec.form_kind === 'material_cost') result.roi_goal = await unique(root.getByRole('textbox', { name: ROI, exact: true }), 'editor_roi_ambiguous');
  else result.duration_hours = plain.nth(1);
  return result;
}
async function verifyMaterials(root, spec) {
  if (spec.form_kind === 'material_cost') {
    // Wait only for this form's actual material membership. Never reconstruct it.
    try {
      await root.getByText(new RegExp('^\\s*已添加[：:]?\\s*' + spec.material_ids.length + '\\s*/\\s*20\\s*$')).filter({ visible: true }).waitFor({ state: 'visible', timeout: spec.timeoutMs });
    } catch (error) { throw Object.assign(new Error('The original material set did not load; no value was filled or submitted', { cause: error }), { code: 'editor_material_incomplete' }); }
    const text = await root.innerText();
    const counts = [...text.matchAll(/已添加[：:]?\s*(\d+)\s*\/\s*20/g)].map(match => Number(match[1]));
    const ids = [...text.matchAll(/素材ID[：:]\s*(\d+)/g)].map(match => match[1]);
    requireThat(counts.length === 1 && counts[0] === spec.material_ids.length && sameIds(ids, spec.material_ids), 'editor_material_incomplete');
  } else {
    const text = await root.innerText();
    requireThat(text.includes('追投直播间画面') && text.includes('调控总预算') &&
      new RegExp('(?:^|\\n)ID[：:]\\s*' + spec.live_material_id + '(?=\\s|$)').test(text), 'editor_live_material_mismatch');
  }
}
async function controls(root) {
  return root.locator('input,textarea,select,[role="checkbox"],[role="radio"],[role="switch"]').evaluateAll(elements => elements
    .filter(el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden')
    .map(el => ({ tag: el.tagName, type: el.type || '', placeholder: el.getAttribute('placeholder') || '', name: el.getAttribute('aria-label') || el.name || '',
      value: el.value ?? null, checked: el.checked ?? null, ariaChecked: el.getAttribute('aria-checked'), disabled: !!el.disabled })));
}
async function verifyForm(page, spec, before, desiredValue, baseline, originalText) {
  const root = await modal(page);
  await verifyMaterials(root, spec);
  const current = await fields(root, spec);
  requireThat(await current.name.inputValue() === before.name, 'editor_task_name_changed');
  for (const parameter of ['budget', spec.form_kind === 'material_cost' ? 'roi_goal' : 'duration_hours']) {
    const expected = parameter === spec.parameter ? desiredValue : before[parameter];
    requireThat(expected !== null && numeric(await current[parameter].inputValue()) === expected, 'editor_value_changed');
  }
  const snapshot = await controls(root);
  if (baseline) requireThat(same(snapshot, baseline), 'editor_controls_changed');
  const text = await root.innerText();
  if (originalText !== undefined) requireThat(text === originalText, 'editor_context_changed');
  const submit = await unique(root.getByRole('button', { name: '提交', exact: true }), 'submit_not_unique');
  requireThat(await submit.isEnabled(), 'submit_disabled');
  return { root, current, snapshot, submit, text };
}

/** Prepare exactly one parameter. Requires a previously observed full editor layout.
 * Leaves an opened editor in place on failure; never submits, restores, or retries.
 * The caller verifies live-scene authority and business/targeting conditions.
 */
async function prepareQianchuanControlParameter(page, input) {
  try {
    const spec = validate(input);
    const targetId = await identity(page, spec);
    requireThat(await visible(page.locator(MODAL)).count() === 0, 'existing_form_preserved');
    const before = await readOriginal(page, spec);
    requireThat(spec.form_kind !== 'material_cost' || before.roi_target_header === '综合营销ROI目标', 'editor_roi_layout_unverified');
    requireThat(before.value === spec.expected_value, 'original_value_changed');
    // Playwright hasText uses textContent, which can concatenate adjacent cells.
    // Bind the exact ID element instead of assuming innerText line breaks.
    const row = await unique(page.getByRole('row').filter({ has: page.getByText('ID: ' + spec.task_id, { exact: true }) }), 'original_task_not_unique');
    const editor = await unique(row.locator('iconpark-icon[name="oc-icon-light-edit"]'), 'editor_trigger_ambiguous');
    await editor.click({ timeout: spec.timeoutMs });
    await visible(page.locator(MODAL)).waitFor({ state: 'visible', timeout: spec.timeoutMs });
    const initial = await verifyForm(page, spec, before, spec.expected_value);
    if (spec.form_kind === 'material_cost' && spec.parameter === 'budget' && spec.new_value > before.budget) {
      const matches = [...(await initial.root.innerText()).matchAll(/当前最多可再追加预算\s*([\d,.]+)\s*元/g)];
      requireThat(matches.length === 1 && numeric(matches[0][1]) !== null && spec.new_value - before.budget <= numeric(matches[0][1]), 'shared_budget_insufficient_or_unknown');
    }
    // A guarantee warning requires a separate observed/authorized workflow; do not
    // silently accept a consequence while implementing a parameter update.
    if (spec.parameter === 'roi_goal') requireThat(!/修改[^\n]*ROI[^\n]*(?:失去|不再享受|不享受)[^\n]*保障|修改[^\n]*ROI[^\n]*保障资格/.test(await initial.root.innerText()), 'roi_guarantee_consequence');
    await identity(page, spec, targetId);
    const inputField = initial.current[spec.parameter];
    const controlIndex = await inputField.evaluate(el => Array.from(el.closest('.main-vmok-plugin-modal').querySelectorAll('input,textarea,select,[role="checkbox"],[role="radio"],[role="switch"]'))
      .filter(node => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden').indexOf(el));
    requireThat(controlIndex >= 0 && initial.snapshot[controlIndex], 'editor_control_missing');
    await inputField.fill(String(spec.new_value), { timeout: spec.timeoutMs });
    await inputField.press('Tab', { timeout: spec.timeoutMs });
    const desiredControls = structuredClone(initial.snapshot);
    desiredControls[controlIndex].value = await inputField.inputValue();
    const ready = await verifyForm(page, spec, before, spec.new_value, desiredControls, initial.text);
    const prepared = Object.freeze({ status: 'prepared_not_submitted', task_id: spec.task_id, parameter: spec.parameter,
      roi_target_header: before.roi_target_header, parameter_header: before.parameter_header,
      old_value: spec.expected_value, new_value: spec.new_value, retry_write: false, advertising_writes: 0 });
    handles.set(prepared, { page, spec, before, targetId, snapshot: ready.snapshot, text: ready.text, attempted: false, dispatched: false });
    return prepared;
  } catch (error) { throw mark(error); }
}

/** record must durably reserve a unique operation_id and reject unresolved writes
 * to this original task. This function dispatches one click, never a retry.
 */
async function commitQianchuanControlParameter(prepared, { operation_id, record } = {}) {
  const state = handles.get(prepared);
  let started = false;
  try {
    requireThat(state && !state.attempted, 'prepared_already_used_or_invalid');
    requireThat(typeof operation_id === 'string' && operation_id.trim() && typeof record === 'function', 'durable_intent_required');
    state.attempted = true;
    started = true;
    const { page, spec, before, targetId, snapshot, text } = state;
    await identity(page, spec, targetId);
    const current = await readOriginal(page, spec);
    unchanged(before, current, spec.parameter, spec.expected_value);
    await verifyForm(page, spec, before, spec.new_value, snapshot, text);
    const intent = { ...prepared, advertiser_id: spec.advertiser_id, primary_ad_id: spec.primary_ad_id, browser_context_id: spec.browser_context_id,
      date: spec.date, pool: spec.pool, before, material_ids: spec.material_ids, live_material_id: spec.live_material_id };
    await record({ operation_id, task_id: spec.task_id, status: 'intent', prepared: intent });
    state.operation_id = operation_id; state.record = record;
    // A durable write can take time: recheck identity, original row, and form before dispatch.
    await identity(page, spec, targetId);
    unchanged(before, await readOriginal(page, spec), spec.parameter, spec.expected_value);
    const ready = await verifyForm(page, spec, before, spec.new_value, snapshot, text);
    state.dispatched = true;
    await ready.submit.click({ timeout: spec.timeoutMs });
    const result = { operation_id, task_id: spec.task_id, status: 'submitted_pending_readback', effect_status: 'unconfirmed', retry_write: false };
    await record(result);
    return result;
  } catch (error) {
    const annotated = mark(error, started && !!state?.dispatched);
    if (started && state?.operation_id) {
      try { await state.record({ operation_id: state.operation_id, task_id: state.spec.task_id, status: state.dispatched ? 'unknown' : 'not_submitted', error: annotated.message, retry_write: false }); }
      catch (recordError) { annotated.record_error = recordError; }
    }
    throw annotated;
  }
}

/** Read the same original task in the caller's current view. No refresh, filter
 * change, editor close or resubmission. A missing row is not success.
 */
async function readbackQianchuanControlParameter(prepared) {
  const state = handles.get(prepared);
  try {
    requireThat(state?.dispatched, 'submission_not_attempted');
    const { page, spec, before, targetId } = state;
    await identity(page, spec, targetId);
    requireThat(await visible(page.locator(MODAL)).count() === 0, 'editor_still_open');
    const after = await readOriginal(page, spec);
    unchanged(before, after, spec.parameter, spec.new_value);
    await identity(page, spec, targetId);
    const result = { operation_id: state.operation_id, task_id: spec.task_id, status: 'confirmed', effect_status: 'confirmed', parameter: spec.parameter,
      roi_target_header: before.roi_target_header, parameter_header: before.parameter_header,
      old_value: spec.expected_value, new_value: after.value, before, after, retry_write: false };
    await state.record(result);
    return result;
  } catch (error) { throw mark(error, !!state?.dispatched); }
}

module.exports = { prepareQianchuanControlParameter, commitQianchuanControlParameter, readbackQianchuanControlParameter, selectQianchuanParameterHeaders };
