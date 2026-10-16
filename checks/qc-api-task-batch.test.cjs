'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runQianchuanTaskBatch, restoreOriginalTestPause, normalizeRequest, wireRequest, readQianchuanBatchTargets, taskState } = require('../tools/qc-api-task-batch.cjs');
const {controlIntent}=require('../tools/qc-api-task-batch.cjs');
function fixture(operation = 'pause') {
  const state = { requests: [] }, writes = [], saves = [];
  const rows = ['101', '102'].map(id => ({ id, advId: '900', name: '系统默认名称', budget: '10000000', smartBidType: 7,
    startTime: '100', endTime: '200', audience: { region: ['fixture'] },
    operation: { budgetEditOperation: { editable: true } },
    assistTaskInfoMap: { '2': { operation: {} } } }));
  const setState = value => rows.forEach(t => { t.adOptType = value === 'active' ? 0 : 1; t.assistTaskInfoMap['2'].operation = {
    [value === 'active' ? 'pause' : 'start']: { visible: true, editable: true }, edit: { visible: true, editable: true } }; });
  setState(operation === 'resume' ? 'paused' : 'active');
  const input = { request_id: 'qc-fixture-001', operation, date: '2026-10-15',
    binding: { account_id: 'fixture-account', advertiser_id: '900', primary_ad_id: '999',room_id:'888',session_started_at:'2026-10-15T10:00:00+08:00' },runtime_root:require('node:path').resolve('private-runtime','fixture-unused'),
    targets: rows.map(t => ({ task_id: t.id, expected_state: operation === 'resume' ? 'paused' : 'active', expected_budget: 100,
      ...(operation === 'budget' ? { budget: 101 } : {}) })) };
  const dependencies = {
    async lookupIntent(){return null;},async verifyScene(){},async claimIntent(){return {is_new:true};},async finishIntent(){},
    async verifyBinding(b) { assert.equal(b.account_id, 'fixture-account'); },
    async readTasks() { return { status_code: 0, truncated: false, data: { adInfos: structuredClone(rows), pagination: { totalNum: String(rows.length) } } }; },
    async send(_binding, wire) {
      assert.equal(saves.at(-1).requests[0].state, 'dispatch_recorded'); writes.push(wire);
      if (operation === 'budget') rows.forEach(t => { t.budget = '10100000'; });
      else setState(operation === 'pause' ? 'paused' : 'active');
      return { status_code: 0, data: { results: [{ status: 2 }, { status: 2 }] } };
    },
  };
  const options = { state, dependencies, save: async s => { saves.push(structuredClone(s)); } };
  return { input, options, rows, writes, saves, setState, run: () => runQianchuanTaskBatch(input, options) };
}
for (const action of ['pause', 'resume', 'budget']) test(action + ' submits one real batch body and verifies every ID', async () => {
  const f = fixture(action), out = await f.run();
  assert.equal(out.ok, true); assert.equal(f.writes.length, 1); assert.equal(out.outcomes.length, 2);
  assert.ok(out.outcomes.every(x => x.verified));
  const body = f.writes[0].body;
  assert.equal((body.Objects || body.objects || body.AdsData).length, 2);
  assert.ok(!JSON.stringify(body).includes('系统默认名称'));
});

test('a start button on an enabled but unavailable live room is not a manual pause', async () => {
  const f = fixture('resume');
  f.rows[0].adOptType = 0; f.rows[0].adDeliveryName = '关联直播间未开播';
  assert.equal(taskState(f.rows[0]), 'unknown');
  await assert.rejects(f.run(), { code: 'task_changed_before_submit' });
  assert.equal(f.writes.length, 0);
});

test('missing or conflicting operating state cannot be inferred from an action button', () => {
  const f = fixture();
  delete f.rows[0].adOptType; assert.equal(taskState(f.rows[0]), 'unknown');
  f.rows[0].adOptType = 1; assert.equal(taskState(f.rows[0]), 'unknown');
  f.setState('paused'); f.rows[0].adOptType = '1'; assert.equal(taskState(f.rows[0]), 'unknown');
});
test('known uppercase pause and lowercase resume wire contracts are preserved', () => {
  assert.deepEqual(Object.keys(wireRequest(normalizeRequest(fixture('pause').input)).body), ['OptType', 'Objects']);
  assert.deepEqual(Object.keys(wireRequest(normalizeRequest(fixture('resume').input)).body), ['optType', 'objects']);
  const budget = wireRequest(normalizeRequest(fixture('budget').input));
  assert.equal(budget.body.AdsData[0].AdBudget, 10100000);
});
for (const mutation of ['primary', 'duplicate', 'account', 'operation', 'no_change']) test('rejects ' + mutation + ' before writes', async () => {
  const f = fixture();
  if (mutation === 'primary') f.input.targets[0].task_id = '999';
  if (mutation === 'duplicate') f.input.targets[1].task_id = '101';
  if (mutation === 'account') delete f.input.binding.account_id;
  if (mutation === 'operation') f.input.operation = 'delete';
  if (mutation === 'no_change') f.input.targets[0].expected_state = 'paused';
  await assert.rejects(f.run()); assert.equal(f.writes.length, 0);
});
for (const defect of ['partial', 'missing', 'duplicate', 'other_account', 'state', 'budget', 'blocked']) test('preflight rejects ' + defect, async () => {
  const f = fixture();
  if (defect === 'partial') f.options.dependencies.readTasks = async () => ({ status_code: 0, truncated: true, data: { adInfos: f.rows } });
  if (defect === 'missing') f.rows.pop();
  if (defect === 'duplicate') f.rows.push(structuredClone(f.rows[0]));
  if (defect === 'other_account') f.rows[0].advId = '901';
  if (defect === 'state') f.setState('paused');
  if (defect === 'budget') f.rows[0].budget = '11000000';
  if (defect === 'blocked') f.rows[0].assistTaskInfoMap['2'].operation.pause.editable = false;
  await assert.rejects(f.run()); assert.equal(f.writes.length, 0);
});
test('save failure prevents advertising submission', async () => {
  const f = fixture(); f.options.save = async () => { throw Error('disk'); };
  await assert.rejects(f.run()); assert.equal(f.writes.length, 0);
});
test('transport timeout never retries; later invocation only reconciles the original IDs', async () => {
  const f = fixture(); f.options.dependencies.send = async (_b, wire) => { f.writes.push(wire); throw Object.assign(Error('timeout'), { code: 'upstream_timeout' }); };
  const first = await f.run(); assert.equal(first.ok, false); assert.equal(first.state, 'unknown');
  f.setState('paused'); const second = await f.run();
  assert.equal(second.ok, true); assert.equal(second.reconciled_without_submit, true); assert.equal(f.writes.length, 1);
});
test('one successful member does not turn partial batch into success', async () => {
  const f = fixture(), original = f.options.dependencies.send;
  f.options.dependencies.send = async (...args) => { const r = await original(...args);
    f.rows[1].assistTaskInfoMap['2'].operation = { pause: { visible: true, editable: true } }; return r; };
  const r = await f.run(); assert.equal(r.ok, false); assert.deepEqual(r.outcomes.map(x => x.verified), [true, false]);
});
test('unexpected name, audience or schedule changes invalidate an apparent success', async () => {
  for (const key of ['name', 'audience', 'endTime']) {
    const f = fixture(), send = f.options.dependencies.send;
    f.options.dependencies.send = async (...args) => { const r = await send(...args); f.rows[0][key] = 'changed'; return r; };
    assert.equal((await f.run()).ok, false);
  }
});
test('request identifier cannot be reused for a different batch', async () => {
  const f = fixture(); await f.run(); f.input.targets.pop();
  await assert.rejects(f.run(), { code: 'request_id_conflict' }); assert.equal(f.writes.length, 1);
});
test('explicit per-ID rejection plus unchanged readback is rejected rather than an unknown write', async () => {
  const f = fixture('budget');
  f.options.dependencies.send = async (_b, wire) => { f.writes.push(wire);
    return { status_code: 0, data: { results: f.rows.map(t => ({ objId: t.id, status: 3, error: { errorCode: '3001' } })) } }; };
  const result = await f.run();
  assert.equal(result.state, 'rejected'); assert.ok(result.outcomes.every(t => t.state === 'rejected'));
  await f.run(); assert.equal(f.writes.length, 1);
});
test('accepted resume with invalid material remains unknown and its original pause can be restored once', async () => {
  const f = fixture('resume');
  f.options.dependencies.send = async (_b, wire) => {
    f.writes.push(wire);
    for (const row of f.rows) { row.adOptType = wire.body.OptType === 2 ? 1 : 0;
      row.adDeliveryName = '调控结束（素材删除）'; row.assistTaskInfoMap['2'].operation = {}; }
    return { status_code: 0, data: { results: f.rows.map(t => ({ flag: true, object: { objectId: t.id, type: 1 } })) } };
  };
  const original = await f.run(); assert.equal(original.ok, false);
  // Only historical unscoped receipts can use this legacy cleanup path.
  delete original.binding.room_id;delete original.binding.session_started_at;delete original.runtime_root;
  delete f.options.state.requests[0].runtime_root;
  const cleanup = { source_request_id: original.request_id, request_id: 'qc-cleanup-001', date: f.input.date };
  const restored = await restoreOriginalTestPause(cleanup, f.options);
  assert.equal(restored.ok, true); assert.equal(f.writes.length, 2);
  await restoreOriginalTestPause(cleanup, f.options); assert.equal(f.writes.length, 2);
});
test('cleanup refuses an unaccepted source or changed budget', async () => {
  for (const changed of ['response', 'budget']) {
    const f = fixture('resume'); await f.run();
    delete f.options.state.requests[0].binding.room_id;delete f.options.state.requests[0].binding.session_started_at;delete f.options.state.requests[0].runtime_root;
    f.options.state.requests[0].response = { code: 0, results: f.rows.map(t => ({ flag: changed !== 'response', object: { objectId: t.id } })) };
    if (changed === 'budget') f.rows[0].budget = '12000000';
    await assert.rejects(restoreOriginalTestPause({ source_request_id: f.input.request_id, request_id: 'qc-cleanup-001', date: f.input.date }, f.options));
    assert.equal(f.writes.length, 1);
  }
});
test('inconsistent total or duplicate pagination cannot pass a targeted preflight', async () => {
  const f = fixture();
  f.options.dependencies.readTasks = async () => ({ status_code: 0, truncated: false,
    data: { adInfos: f.rows, pagination: { totalNum: '3' } } });
  await assert.rejects(f.run(), { code: 'task_pagination_inconsistent' }); assert.equal(f.writes.length, 0);
});

test('missing total cannot be promoted to complete even when the requested IDs are present', async () => {
  const f = fixture();
  f.options.dependencies.readTasks = async () => ({ status_code: 0, truncated: false, data: { adInfos: f.rows } });
  await assert.rejects(f.run(), { code: 'task_pagination_inconsistent' }); assert.equal(f.writes.length, 0);
});

test('budget verification reads the operable pool instead of ended history',async()=>{
  const f=fixture('budget');f.input.targets.forEach(t=>t.expected_state='paused');
  const calls=[];const r=await readQianchuanBatchTargets(normalizeRequest(f.input),{phase:'after',read:async opts=>{
    calls.push(opts);return{code:0,truncated:false,data:{adInfos:f.rows,pagination:{totalNum:2}}};
  }});
  assert.equal(calls.length,1);assert.deepEqual(calls[0],{pool:'manual_paused',pageSize:100});assert.equal(r.data.adInfos.length,2);
});
test('a missing resumed ID is looked up across all statuses without resubmission',async()=>{
  const f=fixture('resume'),calls=[];
  const r=await readQianchuanBatchTargets(normalizeRequest(f.input),{phase:'after',read:async opts=>{
    calls.push(opts);return{code:0,truncated:false,data:{adInfos:opts.taskId?[f.rows[1]]:[f.rows[0]],pagination:{totalNum:1}}};
  }});
  assert.equal(calls.length,2);assert.equal(calls[0].pool,'active');assert.equal(calls[1].taskId,'102');
  assert.equal(r.task_pool,'requested_ids');assert.deepEqual(r.data.adInfos.map(t=>t.id),['101','102']);
});
test('incomplete pool is returned as unknown without a hidden retry',async()=>{
  let calls=0;const r=await readQianchuanBatchTargets(normalizeRequest(fixture().input),{read:async()=>{
    calls++;return{code:0,truncated:true,data:{adInfos:[],pagination:{totalNum:0}}};
  }});
  assert.equal(calls,1);assert.equal(r.truncated,true);
});

for(const missing of ['room','start','root'])test('new submission requires '+missing+' scene scope',async()=>{
  const f=fixture();
  if(missing==='room'){delete f.input.binding.room_id;delete f.input.binding.session_started_at;}
  if(missing==='start')delete f.input.binding.session_started_at;
  if(missing==='root')delete f.input.runtime_root;
  await assert.rejects(f.run());assert.equal(f.writes.length,0);
});

test('scene verification failure never submits',async()=>{
  const f=fixture();f.options.dependencies.verifyScene=async()=>{throw Error('scene_identity_mismatch');};
  await assert.rejects(f.run(),/scene_identity_mismatch/);assert.equal(f.writes.length,0);
});

test('lost local receipt reconciles a shared original without resubmission',async()=>{
  const f=fixture('budget');await f.run();
  const prior={verification_before:f.options.state.requests[0].before,created_at:new Date().toISOString()};
  f.options.state.requests=[];f.options.dependencies.lookupIntent=async()=>prior;
  f.options.dependencies.verifyScene=async()=>{throw Error('must not authorize a new write');};
  const result=await f.run();assert.equal(result.ok,true);assert.equal(result.reconciled_from_shared_intent,true);assert.equal(f.writes.length,1);
});

test('race against another executor uses its original before snapshot and never sends',async()=>{
  const f=fixture('budget');await f.run();
  const before=f.options.state.requests[0].before;
  f.options.state.requests=[];f.rows.forEach(t=>t.budget='10000000');
  f.options.dependencies.claimIntent=async()=>{f.rows.forEach(t=>t.budget='10100000');return{is_new:false,operation:{verification_before:before}};};
  const result=await f.run();assert.equal(result.ok,true);assert.equal(result.reconciled_without_submit,true);assert.equal(f.writes.length,1);
});

test('scoped unknown resume cannot invoke legacy cleanup to bypass the shared original',async()=>{
  const f=fixture('resume');await f.run();
  await assert.rejects(restoreOriginalTestPause({source_request_id:f.input.request_id,request_id:'cleanup-001',date:f.input.date},f.options),{code:'scoped_cleanup_requires_original_reconciliation'});
  assert.equal(f.writes.length,1);
});

test('real shared state blocks a second channel and restores lost local receipts by readback',async()=>{
  const m=await import('../tools/codex-qc-control-state.mjs'),fs=require('node:fs'),path=require('node:path');
  const root=fs.mkdtempSync(path.join(require('./test-output.cjs').testOutputRoot(),'shared-api-'));
  const f=fixture('budget');f.input.runtime_root=root;
  const request=normalizeRequest(f.input),binding={...request.binding,date:request.date};
  const control=m.createControlState({runtime_root:root,binding,execution_owner:'fixture-api'});
  await m.recordControlScene(control,{binding,status:'live',observed_at:new Date().toISOString(),source:{channel:'browser',identity_verified:true}});
  Object.assign(f.options.dependencies,{
    lookupIntent:()=>m.inspectControlOperation(control,controlIntent(request)),
    claimIntent:before=>m.claimControlOperation(control,controlIntent(request,before)),
    finishIntent:(status,result)=>m.settleControlOperation(control,controlIntent(request),{status,result}),
  });
  f.options.dependencies.send=async(_b,wire)=>{f.writes.push(wire);f.rows.forEach(t=>t.budget='10100000');throw Error('transport_timeout');};
  const read=f.options.dependencies.readTasks;let n=0;
  f.options.dependencies.readTasks=async(...args)=>{if(++n===2)throw Error('read_timeout');return read(...args);};
  assert.equal((await f.run()).state,'unknown');
  await assert.rejects(m.claimControlOperation(control,{...controlIntent(request),channel:'browser',request_id:'other-channel-001'}),/original_target_unresolved/);
  f.options.state.requests=[];
  assert.equal((await f.run()).ok,true);assert.equal(f.writes.length,1);
  assert.equal((await m.inspectControlOperation(control,controlIntent(request))).status,'confirmed');
});
