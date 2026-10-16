'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const editor = require('./edit-qc-control-parameter.playwright.cjs');
const { readQianchuanControlRaw } = require('./read-qc-control-raw.playwright.cjs');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(value) && !Object.hasOwn(Object.prototype, value) && value !== 'prototype';
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const operationTargets = value => value.task_ids ?? [value.task_id ?? value.prepared?.task_id];
const bindingKeys = ['room', 'account_id', 'advertiser_id', 'primary_ad_id', 'browser_context_id', 'target_id'];
const sceneKeys=['room_id','date','session_started_at'];
const specKeys = [...bindingKeys, ...sceneKeys, 'task_id', 'pool', 'expected_status', 'form_kind', 'material_ids', 'live_material_id',
  'parameter', 'expected_value', 'new_value', 'bounds', 'timeoutMs'];
const parameterHeader = { budget: '调控预算(元)', roi_goal: '综合营销ROI目标', duration_hours: '调控时长(小时)' };
const number = value => /^\d+(?:\.\d+)?$/.test(String(value).replaceAll(',', '').trim()) ? Number(String(value).replaceAll(',', '').trim()) : null;
const canonical = value => JSON.stringify(value, (key, item) => plain(item) ? Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]])) : item);
const publicRecord = value => { const { error, ...record } = value; return error ? { ...record, error: 'native_parameter_previous_error' } : record; };
const safeOperation = run => async args => {
  try { return await run(args); }
  catch (error) {
    // Error messages/causes can contain browser URLs or credentials. Return only
    // a bounded diagnostic code; the host supplies its own identity metadata.
    const code = /^[a-z][a-z0-9_]{0,62}$/.test(error?.code || '') && error.code.includes('_') ? error.code : 'native_parameter_failed';
    throw Object.assign(new Error(code), { code, retry_write: false,
      effect_status: error?.details?.effect_status === 'not_submitted' ? 'not_submitted' : 'unconfirmed' });
  }
};

/** Fixed operations only. Business decisions and scene authorization remain with
 * the caller. The existing state store retains original intents across owner
 * restarts. Retained operation IDs are never submitted again; unresolved
 * intents are not pruned by the existing store. Use one owner per plan. */
function createQianchuanNativeParameterOperations({ stateDirectory, runtimeRoot } = {}) {
  if (typeof stateDirectory !== 'string' || !path.isAbsolute(stateDirectory)) fail('native_parameter_state_directory_required');
  const stores = new Map();
  const storeFor = async (binding,scene) => {
    const full=scene?{account_id:binding.account_id,advertiser_id:binding.advertiser_id,primary_ad_id:binding.primary_ad_id,...scene}:null;
    const key = binding.advertiser_id + '_' + binding.primary_ad_id+(scene?'_'+crypto.createHash('sha256').update(canonical(scene)).digest('hex').slice(0,16):'');
    if (!stores.has(key)) stores.set(key, import(pathToFileURL(path.join(__dirname, 'codex-qc-material-control.cua.mjs')).href)
      .then(module => module.createMaterialStateStore({
        file: path.join(stateDirectory, key + '.json'),
        binding: full??{ advertiser_id: binding.advertiser_id, primary_ad_id: binding.primary_ad_id },
        execution_owner: 'native-browser-session',
        ...(scene?{runtime_root:runtimeRoot}:{}),
      })));
    return stores.get(key);
  };
  return {
    parameter_edit: { kind: 'write', run: safeOperation(async ({ page, binding, input }) => {
      if (!plain(input) || Object.keys(input).some(key => !['operation_id', 'spec'].includes(key)) || !id(input.operation_id) ||
          !plain(input.spec) || Object.keys(input.spec).some(key => !specKeys.includes(key))) fail('native_parameter_request_invalid');
      for (const key of bindingKeys) if (Object.hasOwn(input.spec, key) && input.spec[key] !== binding[key]) fail('native_parameter_binding_mismatch');
      const scene=Object.fromEntries(sceneKeys.map(key=>[key,input.spec[key]]));
      if(!path.isAbsolute(runtimeRoot||'')||!/^\d+$/.test(scene.room_id||'')||!/^\d{4}-\d{2}-\d{2}$/.test(scene.date||'')||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(scene.session_started_at||'')||!Number.isFinite(Date.parse(scene.session_started_at)))fail('scene_scope_required');
      const spec = { ...input.spec, browser_context_id: binding.browser_context_id,
        advertiser_id: binding.advertiser_id, primary_ad_id: binding.primary_ad_id, timeoutMs: input.spec.timeoutMs ?? 8000 };
      const fingerprint = crypto.createHash('sha256').update(canonical({ operation: 'parameter_edit',
        binding: { advertiser_id: binding.advertiser_id, primary_ad_id: binding.primary_ad_id }, spec })).digest('hex');
      // Unscoped historical originals cannot silently be assigned to this scene.
      const legacy=await storeFor(binding);
      if(Object.values(legacy.current().operations).some(o=>operationTargets(o).includes(spec.task_id)&&!['confirmed','not_submitted','rejected'].includes(o.status)))fail('legacy_original_needs_reconciliation');
      const store = await storeFor(binding,scene);
      const prior = store.current().operations[input.operation_id];
      if (prior) {
        if (prior.request_fingerprint !== fingerprint) fail('native_parameter_request_conflict');
        return { ok: prior.status === 'confirmed', reused_original: true, record: publicRecord(prior), retry_write: false };
      }
      if (Object.values(store.current().operations).some(item => operationTargets(item).includes(spec.task_id) &&
          !['confirmed', 'not_submitted','rejected'].includes(item.status))) fail('original_target_unresolved');
      const record = result => store.record({ ...result,
        ...(result.status === 'intent' ? { request_fingerprint: fingerprint } : {}),
        ...(result.error ? { error: result.status === 'not_submitted' ? 'native_parameter_not_submitted' : 'native_parameter_unconfirmed' } : {}) });
      const start = Date.now();
      const prepared = await editor.prepareQianchuanControlParameter(page, spec);
      const preparedAt = Date.now();
      await editor.commitQianchuanControlParameter(prepared, { operation_id: input.operation_id, record });
      const submittedAt = Date.now();
      // Waiting for the form to close is readiness only; original-ID readback is
      // the success check. Timeout never triggers another submission.
      await page.locator('.main-vmok-plugin-modal').filter({ visible: true }).waitFor({ state: 'hidden', timeout: spec.timeoutMs ?? 8000 });
      const result = await editor.readbackQianchuanControlParameter(prepared);
      return { ok: true, ...result, timings_ms: { prepare: preparedAt - start, submit: submittedAt - preparedAt,
        readback: Date.now() - submittedAt, total: Date.now() - start } };
    }) },
    parameter_reconcile: { kind: 'write', run: safeOperation(async ({ page, binding, input }) => {
      if (!plain(input) || Object.keys(input).some(key => !['operation_id','scene'].includes(key)) || !id(input.operation_id)||
        input.scene&&(!plain(input.scene)||Object.keys(input.scene).some(key=>!sceneKeys.includes(key)))) fail('native_parameter_request_invalid');
      const store = await storeFor(binding,input.scene);
      const record = store.current().operations[input.operation_id];
      if (!record) fail('native_parameter_intent_missing');
      if (['confirmed', 'not_submitted'].includes(record.status)) return { ok: record.status === 'confirmed', reused_original: true, record: publicRecord(record), retry_write: false };
      const prepared = record.prepared;
      if (!prepared || !Object.hasOwn(parameterHeader, prepared.parameter) || !plain(prepared.before?.cells) ||
          !/^\d+$/.test(record.task_id || '') || prepared.task_id !== record.task_id || record.task_id === binding.primary_ad_id ||
          !Number.isFinite(prepared.new_value) || !Number.isFinite(prepared.old_value) || prepared.new_value <= 0 || prepared.old_value <= 0 ||
          prepared.advertiser_id !== binding.advertiser_id || prepared.primary_ad_id !== binding.primary_ad_id) fail('native_parameter_intent_invalid');
      const columns = editor.selectQianchuanParameterHeaders(Object.keys(prepared.before.cells));
      const header = columns.parameter_headers[prepared.parameter];
      if (columns.static_headers.some(field => typeof prepared.before.cells[field] !== 'string') ||
          (prepared.roi_target_header !== undefined && prepared.roi_target_header !== columns.roi_target_header) ||
          (prepared.parameter_header !== undefined && prepared.parameter_header !== header) ||
          (prepared.before.roi_target_header !== undefined && prepared.before.roi_target_header !== columns.roi_target_header) ||
          (prepared.before.parameter_header !== undefined && prepared.before.parameter_header !== header)) fail('native_parameter_intent_invalid');
      if (await page.locator('.main-vmok-plugin-modal').filter({ visible: true }).count()) fail('editor_still_open');
      const raw = await readQianchuanControlRaw(page, { advertiser_id: binding.advertiser_id, primary_ad_id: binding.primary_ad_id,
        date: prepared.date, pool: prepared.pool });
      if (!Array.isArray(raw.tasks)) fail('table_structure_changed');
      const currentColumns = editor.selectQianchuanParameterHeaders(raw.headers);
      if (currentColumns.roi_target_header !== columns.roi_target_header) fail('table_structure_changed');
      const matches = raw.tasks.filter(task => task.task_id === record.task_id);
      if (matches.length !== 1) fail('original_task_unavailable');
      if (!Array.isArray(matches[0].raw_cells) || matches[0].raw_cells.length !== raw.headers.length ||
          matches[0].raw_cells.some(value => typeof value !== 'string')) fail('table_structure_changed');
      const cells = Object.fromEntries(raw.headers.map((header, index) => [header, matches[0].raw_cells[index]]));
      const taskIds = [...cells['任务名称'].matchAll(/(?:^|\n)ID[:：]\s*(\d+)/g)].map(match => match[1]);
      if (taskIds.length !== 1 || taskIds[0] !== record.task_id) fail('original_task_unavailable');
      if (number(cells[header].split('\n')[0]) !== prepared.new_value) fail('parameter_not_verified');
      for (const field of columns.static_headers) if (field !== header && cells[field] !== prepared.before.cells[field]) fail('other_task_parameter_changed');
      const result = { operation_id: input.operation_id, task_id: record.task_id, status: 'confirmed', effect_status: 'confirmed',
        roi_target_header: columns.roi_target_header, parameter_header: header,
        parameter: prepared.parameter, old_value: prepared.old_value, new_value: prepared.new_value,
        after: { task_id: record.task_id, cells }, reconciled_without_resubmit: true, retry_write: false };
      await store.record(result);
      return { ok: true, ...result };
    }) },
  };
}

module.exports = { createQianchuanNativeParameterOperations };
