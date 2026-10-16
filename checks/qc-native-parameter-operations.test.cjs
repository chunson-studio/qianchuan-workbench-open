'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const modulePath = require.resolve('../tools/qc-native-parameter-operations.cjs');
const editorPath = require.resolve('../tools/edit-qc-control-parameter.playwright.cjs');
const { selectQianchuanParameterHeaders } = require(editorPath);
const raw = require('../tools/read-qc-control-raw.playwright.cjs');

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-native-parameter-'));
  t.after(() => fs.rmSync(directory, { recursive: true }));
  const binding = { room: 'test-room', account_id: 'account_10001', advertiser_id: '10001', primary_ad_id: '20001', browser_context_id: 'profile-a', target_id: 'target-a' };
  const scene={room_id:'40001',date:'2026-10-15',session_started_at:'2026-10-15T10:00:00+08:00'};
  const spec = { task_id: '30001', ...scene, pool: '手动暂停', expected_status: '已暂停\n手动暂停',
    form_kind: 'material_cost', material_ids: ['90001'], parameter: 'budget', expected_value: 200, new_value: 199, bounds: { min: 100, max: 300 }, ...options.spec };
  const headers = ['任务名称', '素材', '调控状态', '调控预算(元)', options.roiHeader ?? '综合营销ROI目标', '支付ROI目标', '出价', '调控时长(小时)', '追投方式', '创建时间'];
  const volume = spec.form_kind === 'live_volume';
  const cells = ['original\nID: 30001', volume ? '直播间画面\nID: 90001' : '素材ID: 90001', spec.expected_status, '200', volume ? '-' : '1.93', '-', '-', volume ? '12' : '长期投放', volume ? '放量追投' : '控成本追投', '2026-10-15 00:00'];
  const columns = selectQianchuanParameterHeaders(headers);
  const before = { task_id: spec.task_id, cells: Object.fromEntries(headers.map((header, index) => [header, cells[index]])),
    roi_target_header: columns.roi_target_header, parameter_header: columns.parameter_headers[spec.parameter] };
  const state = { prepares: 0, submits: 0, reads: 0, failSubmit: true, headers, cells, taskId: spec.task_id };
  const mockEditor = {
    selectQianchuanParameterHeaders,
    async prepareQianchuanControlParameter(page, input) { state.prepares++; return { spec: input }; },
    async commitQianchuanControlParameter(prepared, { operation_id, record }) {
      prepared.record = record; prepared.operation_id = operation_id;
      const p = prepared.spec;
      await record({ operation_id, task_id: p.task_id, status: 'intent', prepared: {
        task_id: p.task_id, parameter: p.parameter, old_value: p.expected_value, new_value: p.new_value,
        roi_target_header: columns.roi_target_header, parameter_header: columns.parameter_headers[p.parameter],
        advertiser_id: p.advertiser_id, primary_ad_id: p.primary_ad_id, browser_context_id: p.browser_context_id,
        date: p.date, pool: p.pool, before,
      } });
      state.submits++; state.cells[headers.indexOf(columns.parameter_headers[p.parameter])] = String(p.new_value);
      if (state.failSubmit) {
        await record({ operation_id, task_id: p.task_id, status: 'unknown', error: 'SECRET_TOKEN_NEVER_RETURN_THIS' });
        throw Object.assign(new Error('SECRET_TOKEN_NEVER_RETURN_THIS'), { code: 'ETIMEDOUT', details: { effect_status: 'unconfirmed' } });
      }
      await record({ operation_id, task_id: p.task_id, status: 'submitted_pending_readback' });
    },
    async readbackQianchuanControlParameter(prepared) {
      const result = { operation_id: prepared.operation_id, task_id: prepared.spec.task_id, status: 'confirmed', new_value: prepared.spec.new_value };
      await prepared.record(result); return result;
    },
  };
  const cachedEditor = require.cache[editorPath], cachedModule = require.cache[modulePath], oldRaw = raw.readQianchuanControlRaw;
  let create;
  try {
    require.cache[editorPath] = { id: editorPath, filename: editorPath, loaded: true, exports: mockEditor };
    raw.readQianchuanControlRaw = async () => {
      state.reads++;
      return { headers: [...state.headers], tasks: [{ task_id: state.taskId, raw_cells: [...state.cells] }] };
    };
    delete require.cache[modulePath];
    create = require(modulePath).createQianchuanNativeParameterOperations;
  } finally {
    if (cachedEditor) require.cache[editorPath] = cachedEditor; else delete require.cache[editorPath];
    if (cachedModule) require.cache[modulePath] = cachedModule; else delete require.cache[modulePath];
    raw.readQianchuanControlRaw = oldRaw;
  }
  const page = { locator: () => ({ filter() { return this; }, count: async () => 0, waitFor: async () => {} }) };
  const originalCreate=create;create=options=>originalCreate({...options,runtimeRoot:options.stateDirectory});
  const sharedDir=path.join(directory,'codex-control',require('node:crypto').createHash('sha256').update(JSON.stringify([binding.advertiser_id,binding.primary_ad_id])).digest('hex'));
  fs.mkdirSync(sharedDir,{recursive:true});
  const fullBinding={account_id:binding.account_id,advertiser_id:binding.advertiser_id,primary_ad_id:binding.primary_ad_id,...scene};
  const session=JSON.stringify([binding.advertiser_id,binding.primary_ad_id,scene.room_id,scene.session_started_at]);
  const stateFile=path.join(sharedDir,'state.json');
  fs.writeFileSync(stateFile,JSON.stringify({schema_version:1,revision:0,owner:null,scenes:{[session]:{binding:fullBinding,status:'live'}},operations:{},action_samples:[]}));
  const ops = create({ stateDirectory: directory });
  const input = { operation_id: 'original_edit_001', spec };
  const args = (nextInput = input) => ({ page, binding, input: nextInput.spec?nextInput:{...nextInput,scene} });
  return { directory, stateFile, create, originalCreate, ops, state, binding, spec, input, args };
}

test('durable unknown survives a new owner and neither identical nor new requests resend it', async t => {
  const f = fixture(t);
  await assert.rejects(f.ops.parameter_edit.run(f.args()), error => error.code === 'native_parameter_failed' && !JSON.stringify(error).includes('SECRET_TOKEN'));
  assert.equal(fs.readFileSync(f.stateFile, 'utf8').includes('SECRET_TOKEN'), false);
  const restarted = f.create({ stateDirectory: f.directory });
  const original = await restarted.parameter_edit.run(f.args());
  assert.equal(original.reused_original, true);
  assert.equal(original.ok, false);
  assert.equal(original.record.status, 'unknown');
  await assert.rejects(restarted.parameter_edit.run(f.args({ ...f.input, operation_id: 'another_edit_002' })), { code: 'original_target_unresolved' });
  await assert.rejects(restarted.parameter_edit.run(f.args({ ...f.input, spec: { ...f.spec, new_value: 198 } })), { code: 'native_parameter_request_conflict' });
  assert.equal(f.state.prepares, 1); assert.equal(f.state.submits, 1);
});

test('missing shared root or exact scene refuses new writes before form preparation',async t=>{
  const f=fixture(t);
  const unscoped=f.originalCreate({stateDirectory:f.directory});
  await assert.rejects(unscoped.parameter_edit.run(f.args()),{code:'scene_scope_required'});
  for(const key of ['room_id','session_started_at','date']){
    const spec={...f.spec};delete spec[key];
    await assert.rejects(f.ops.parameter_edit.run(f.args({...f.input,spec})),{code:'scene_scope_required'});
  }
  assert.equal(f.state.prepares,0);assert.equal(f.state.submits,0);
});

test('API batch pending blocks native preparation for every original target',async t=>{
  const f=fixture(t),common=JSON.parse(fs.readFileSync(f.stateFile));
  common.operations.apiPending={channel:'api',session:Object.keys(common.scenes)[0],status:'unconfirmed',task_ids:['30000',f.spec.task_id]};
  fs.writeFileSync(f.stateFile,JSON.stringify(common));
  await assert.rejects(f.ops.parameter_edit.run(f.args()),{code:'original_target_unresolved'});
  assert.equal(f.state.prepares,0);assert.equal(f.state.submits,0);
});

test('legacy pending original cannot be silently attached to a new scene',async t=>{
  const f=fixture(t);
  fs.writeFileSync(path.join(f.directory,f.binding.advertiser_id+'_'+f.binding.primary_ad_id+'.json'),JSON.stringify({
    binding:{advertiser_id:f.binding.advertiser_id,primary_ad_id:f.binding.primary_ad_id},
    operations:{old:{operation_id:'old',task_id:f.spec.task_id,status:'unknown'}}
  }));
  await assert.rejects(f.ops.parameter_edit.run(f.args()),{code:'legacy_original_needs_reconciliation'});
  assert.equal(f.state.prepares,0);assert.equal(f.state.submits,0);
});

test('reconcile after restart confirms the original ID without submission and changed payloads remain conflicts', async t => {
  const f = fixture(t);
  await assert.rejects(f.ops.parameter_edit.run(f.args()));
  const restarted = f.create({ stateDirectory: f.directory });
  const request = f.args({ operation_id: f.input.operation_id });
  f.state.taskId = '99999';
  await assert.rejects(restarted.parameter_reconcile.run(request), { code: 'original_task_unavailable' });
  f.state.taskId = '30001';
  const result = await restarted.parameter_reconcile.run(request);
  assert.equal(result.status, 'confirmed'); assert.equal(result.task_id, '30001');
  assert.equal(result.reconciled_without_resubmit, true); assert.equal(f.state.submits, 1);
  assert.equal((await restarted.parameter_edit.run(f.args())).ok, true);
  await assert.rejects(restarted.parameter_edit.run(f.args({ ...f.input, spec: { ...f.spec, new_value: 198 } })), { code: 'native_parameter_request_conflict' });
  assert.equal(f.state.submits, 1);
});

test('reconcile rejects duplicate/missing static headers, row widths, and unrelated parameter changes', async t => {
  const f = fixture(t); await assert.rejects(f.ops.parameter_edit.run(f.args()));
  const request = f.args({ operation_id: f.input.operation_id });
  const headers = [...f.state.headers], cells = [...f.state.cells];
  f.state.headers = [...headers, headers[0]]; f.state.cells = [...cells, cells[0]];
  await assert.rejects(f.ops.parameter_reconcile.run(request), { code: 'table_structure_changed' });
  f.state.headers = headers.slice(1); f.state.cells = cells.slice(1);
  await assert.rejects(f.ops.parameter_reconcile.run(request), { code: 'table_structure_changed' });
  f.state.headers = [...headers]; f.state.cells = cells.slice(1);
  await assert.rejects(f.ops.parameter_reconcile.run(request), { code: 'table_structure_changed' });
  f.state.cells = [...cells]; f.state.cells[4] = '9.99';
  await assert.rejects(f.ops.parameter_reconcile.run(request), { code: 'other_task_parameter_changed' });
  assert.equal(f.state.submits, 1);
  assert.equal(JSON.parse(fs.readFileSync(f.stateFile)).operations[f.input.operation_id].status, 'unknown');
});

test('caller binding conflicts and reserved IDs reject before preparing or saving anything', async t => {
  const f = fixture(t);
  for (const key of ['room', 'account_id', 'advertiser_id', 'primary_ad_id', 'browser_context_id', 'target_id']) {
    await assert.rejects(f.ops.parameter_edit.run(f.args({ ...f.input, spec: { ...f.spec, [key]: 'wrong' } })), { code: 'native_parameter_binding_mismatch' });
  }
  for (const operation_id of ['__proto__', 'constructor', 'toString']) {
    await assert.rejects(f.ops.parameter_edit.run(f.args({ ...f.input, operation_id })), { code: 'native_parameter_request_invalid' });
  }
  assert.equal(f.state.prepares, 0); assert.equal(f.state.submits, 0); assert.deepEqual(JSON.parse(fs.readFileSync(f.stateFile)).operations, {});
});

test('a retained intent without a matching fingerprint cannot masquerade as a new parameter request', async t => {
  const f = fixture(t); await assert.rejects(f.ops.parameter_edit.run(f.args()));
  const value = JSON.parse(fs.readFileSync(f.stateFile));
  delete value.operations[f.input.operation_id].request_fingerprint;
  value.operations[f.input.operation_id].status = 'confirmed';
  fs.writeFileSync(f.stateFile, JSON.stringify(value));
  const restarted = f.create({ stateDirectory: f.directory });
  await assert.rejects(restarted.parameter_edit.run(f.args()), { code: 'native_parameter_request_conflict' });
  assert.equal(f.state.submits, 1);
});

test('successful edit records a reusable exact receipt without repeating the submit', async t => {
  const f = fixture(t); f.state.failSubmit = false;
  const result = await f.ops.parameter_edit.run(f.args());
  assert.equal(result.ok, true); assert.equal(result.status, 'confirmed');
  assert.equal((await f.ops.parameter_edit.run(f.args())).reused_original, true);
  assert.equal(f.state.submits, 1);
});

test('net-column volume intent reconciles after restart using its saved actual target column', async t => {
  const f = fixture(t, { roiHeader: '净成交ROI目标', spec: { form_kind: 'live_volume', live_material_id: '90001',
    parameter: 'duration_hours', expected_value: 12, new_value: 14, bounds: { min: 5, max: 24 } } });
  await assert.rejects(f.ops.parameter_edit.run(f.args()));
  const saved = JSON.parse(fs.readFileSync(f.stateFile)).operations[f.input.operation_id];
  assert.equal(saved.prepared.roi_target_header, '净成交ROI目标');
  assert.equal(saved.prepared.parameter_header, '调控时长(小时)');
  const restarted = f.create({ stateDirectory: f.directory });
  const result = await restarted.parameter_reconcile.run(f.args({ operation_id: f.input.operation_id }));
  assert.equal(result.status, 'confirmed'); assert.equal(result.new_value, 14);
  assert.equal(result.roi_target_header, '净成交ROI目标');
  assert.equal(result.parameter_header, '调控时长(小时)');
  assert.equal(f.state.submits, 1);
});

test('reconcile rejects a changed or ambiguous ROI target column without confirming or resubmitting', async t => {
  const f = fixture(t); await assert.rejects(f.ops.parameter_edit.run(f.args()));
  const request = f.args({ operation_id: f.input.operation_id });
  f.state.headers[4] = '净成交ROI目标';
  await assert.rejects(f.ops.parameter_reconcile.run(request), { code: 'table_structure_changed' });
  f.state.headers.push('综合营销ROI目标'); f.state.cells.push('1.93');
  await assert.rejects(f.ops.parameter_reconcile.run(request), { code: 'table_structure_changed' });
  assert.equal(JSON.parse(fs.readFileSync(f.stateFile)).operations[f.input.operation_id].status, 'unknown');
  assert.equal(f.state.submits, 1);
});

test('reconcile rejects stored column metadata conflicting with saved cells and supports old metadata-free intents', async t => {
  const f = fixture(t); await assert.rejects(f.ops.parameter_edit.run(f.args()));
  const value = JSON.parse(fs.readFileSync(f.stateFile));
  value.operations[f.input.operation_id].prepared.roi_target_header = '净成交ROI目标';
  fs.writeFileSync(f.stateFile, JSON.stringify(value));
  await assert.rejects(f.create({ stateDirectory: f.directory }).parameter_reconcile.run(f.args({ operation_id: f.input.operation_id })), { code: 'native_parameter_intent_invalid' });
  delete value.operations[f.input.operation_id].prepared.roi_target_header;
  delete value.operations[f.input.operation_id].prepared.parameter_header;
  delete value.operations[f.input.operation_id].prepared.before.roi_target_header;
  delete value.operations[f.input.operation_id].prepared.before.parameter_header;
  fs.writeFileSync(f.stateFile, JSON.stringify(value));
  const result = await f.create({ stateDirectory: f.directory }).parameter_reconcile.run(f.args({ operation_id: f.input.operation_id }));
  assert.equal(result.roi_target_header, '综合营销ROI目标'); assert.equal(result.status, 'confirmed');
  assert.equal(f.state.submits, 1);
});
