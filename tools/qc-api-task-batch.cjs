'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function fail(code) { throw Object.assign(new Error(code), { code, advertising_writes: 0 }); }
function id(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) fail('invalid_object_id');
  return value;
}
function money(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0
      || Math.abs(value * 100 - Math.round(value * 100)) > 1e-6) fail('invalid_budget');
  const micro = Math.round(value * 100000);
  if (!Number.isSafeInteger(micro)) fail('invalid_budget');
  return micro;
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}
function hash(value) { return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex'); }
function available(task, name) {
  const action = task.assistTaskInfoMap?.['2']?.operation?.[name];
  return action?.visible === true && action.editable === true;
}
function taskState(task) {
  const paused = available(task, 'start'), active = available(task, 'pause');
  if (paused === active) return 'unknown';
  if (paused && task.adOptType === 1) return 'paused';
  if (active && task.adOptType === 0) return 'active';
  return 'unknown';
}
function snapshot(task) {
  const budget = typeof task.budget === 'string' && /^\d+$/.test(task.budget) ? Number(task.budget) : task.budget;
  if (!Number.isSafeInteger(budget) || budget <= 0) fail('task_budget_unavailable');
  const invariant = Object.fromEntries(['name', 'smartBidType', 'budgetMode', 'ecpRoi2Goal', 'bid',
    'audience', 'externalAction', 'deepExternalAction', 'aggregateCid', 'startTime', 'endTime']
    .map(key => [key, task[key] ?? null]));
  return { task_id: id(task.id), advertiser_id: id(task.advId), state: taskState(task),
    status_label: task.adDeliveryName ?? null, budget_micro: budget,
    ad_opt_type: Number.isInteger(task.adOptType) ? task.adOptType : null,
    name: task.name ?? null, invariant_hash: hash(invariant) };
}
function normalizeRequest(input) {
  if (!input || !['pause', 'resume', 'budget'].includes(input.operation)) fail('unsupported_operation');
  const b = input.binding;
  if (!b || typeof b.account_id !== 'string' || !/^[a-zA-Z0-9_-]{1,50}$/.test(b.account_id)) fail('account_required');
  const binding = { account_id: b.account_id, advertiser_id: id(b.advertiser_id), primary_ad_id: id(b.primary_ad_id) };
  if(b.room_id!==undefined||b.session_started_at!==undefined){
    binding.room_id=id(b.room_id);
    if(typeof b.session_started_at!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(b.session_started_at)||!Number.isFinite(Date.parse(b.session_started_at)))fail('scene_start_time_required');
    binding.session_started_at=b.session_started_at;
  }
  if(input.runtime_root!==undefined&&!path.isAbsolute(input.runtime_root))fail('shared_runtime_root_required');
  if (typeof input.request_id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{7,119}$/.test(input.request_id)) fail('request_id_required');
  const dateMs = typeof input.date === 'string' ? Date.parse(input.date + 'T00:00:00Z') : NaN;
  if (typeof input.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.date)
      || !Number.isFinite(dateMs) || new Date(dateMs).toISOString().slice(0, 10) !== input.date) fail('invalid_date');
  if (!Array.isArray(input.targets) || input.targets.length < 1 || input.targets.length > 20) fail('invalid_batch_size');
  const targets = input.targets.map(t => {
    const task_id = id(t.task_id);
    if (task_id === binding.primary_ad_id) fail('primary_plan_write_forbidden');
    if (!['active', 'paused'].includes(t.expected_state)) fail('expected_state_required');
    const expected_budget_micro = money(t.expected_budget);
    const requested_budget_micro = input.operation === 'budget' ? money(t.budget) : null;
    if (input.operation !== 'budget' && t.budget !== undefined) fail('mixed_batch_parameters');
    if (input.operation === 'budget' && requested_budget_micro === expected_budget_micro) fail('no_change_requested');
    if (input.operation === 'pause' && t.expected_state !== 'active'
        || input.operation === 'resume' && t.expected_state !== 'paused') fail('no_change_requested');
    return { task_id, expected_state: t.expected_state, expected_budget_micro, requested_budget_micro };
  });
  if (new Set(targets.map(t => t.task_id)).size !== targets.length) fail('duplicate_task_id');
  return { binding, request_id: input.request_id, operation: input.operation, date: input.date, targets,
    ...(input.runtime_root!==undefined?{runtime_root:input.runtime_root}:{}) };
}
function controlIntent(request,before){
  return {request_id:request.request_id,channel:'api',binding:{...request.binding,date:request.date},action:request.operation,
    task_ids:request.targets.map(t=>t.task_id),parameters:{targets:request.targets},...(before?{verification_before:before}:{})};
}
function requireSceneScope(request){
  if(!request.binding.room_id||!request.binding.session_started_at||!path.isAbsolute(request.runtime_root||''))fail('scene_scope_required');
}
function wireRequest(request) {
  const suffix = '?aavid=' + request.binding.advertiser_id;
  if (request.operation === 'budget') return {
    path: '/ad/api/pmc/v1/batch_update_budget' + suffix,
    body: { ForceAsync: false, AdsData: request.targets.map(t => ({ AdId: t.task_id, AdBudget: t.requested_budget_micro })) },
  };
  const objects = request.targets.map(t => ({ objectID: t.task_id, type: 1 }));
  return { path: '/ad/api/pmc/v1/batch_update_operation' + suffix,
    body: request.operation === 'pause' ? { OptType: 2, Objects: objects } : { optType: 1, objects } };
}
async function readQianchuanBatchTargets(request, { phase = 'before', read } = {}) {
  const states = request.targets.map(t => phase === 'before' || request.operation === 'budget'
    ? t.expected_state : request.operation === 'pause' ? 'paused' : 'active');
  const pool = new Set(states).size === 1 ? states[0] === 'paused' ? 'manual_paused' : 'active' : 'all';
  const result = await read({ pool, pageSize: 100 });
  const complete = r => (r?.status_code ?? r?.code) === 0 && r.truncated === false && Array.isArray(r.data?.adInfos)
    && !Object.keys(r.data.moduleErrors || {}).length && r.data.pagination?.totalNum != null
    && Number(r.data.pagination.totalNum) === r.data.adInfos.length
    && new Set(r.data.adInfos.map(t => t.id)).size === r.data.adInfos.length
    && r.data.adInfos.every(t => t.advId === request.binding.advertiser_id);
  if (!complete(result) || pool === 'all') return result;
  const missing = request.targets.filter(t => !result.data.adInfos.some(row => row.id === t.task_id));
  if (!missing.length) return result;
  if (missing.length > 2) return read({ pool: 'all', pageSize: 100 });
  const precise = await Promise.all(missing.map(t => read({ pool: 'all', pageSize: 100, taskId: t.task_id })));
  if (precise.some(r => !complete(r))) return precise.find(r => !complete(r));
  const all = [result, ...precise];
  return { status_code: 0, truncated: false, task_pool: 'requested_ids',
    data: { adInfos: request.targets.flatMap(t => all.flatMap(r => r.data.adInfos).filter(row => row.id === t.task_id)),
      adStatsMap: Object.assign({}, ...all.map(r => r.data.adStatsMap || {})),
      pagination: { totalNum: String(request.targets.length) } },
    read_timings: { page_count: all.reduce((n,r) => n + (r.read_timings?.page_count ?? 0),0), exact_fallback_count: missing.length } };
}
function defaultDependencies(request) {
  const qc = require('../server-app/server/lib/qianchuan');
  const tabs = require('../server-app/server/lib/qianchuanTabs');
  const { validateAccount } = require('../server-app/server/lib/api-helpers');
  const { resolveAavid } = require('../server-app/server/lib/cookie');
  let shared;
  const sharedState=()=>shared??=import('./codex-qc-control-state.mjs').then(module=>{
    requireSceneScope(request);
    return {module,control:module.createControlState({runtime_root:request.runtime_root,binding:{...request.binding,date:request.date},execution_owner:'api-task-batch'})};
  });
  return {
    verifyBinding(b) { validateAccount(b.account_id); if (resolveAavid(b.account_id) !== b.advertiser_id) fail('advertiser_binding_mismatch'); },
    readTasks(b, date, context) { return readQianchuanBatchTargets(request, { ...context,
      read: opts => tabs.fetchBoostList(b.primary_ad_id, date, date, b.account_id, opts) }); },
    send(b, wire) { return qc.enqueue(signal => qc.requestAPI('POST', wire.path, wire.body, b.account_id, signal),
      b.account_id, { label: 'explicit_task_batch_' + (wire.body.AdsData ? 'budget' : 'status') }); },
    async lookupIntent(){const {module,control}=await sharedState();return module.inspectControlOperation(control,controlIntent(request));},
    async verifyScene(){
      const {control}=await sharedState();
      const scene=await control.exclusive(({state,session})=>state.scenes[session]||null);
      if(!scene||!['live','ended'].includes(scene.status)||scene.binding?.room_id!==request.binding.room_id||scene.binding?.session_started_at!==request.binding.session_started_at)fail('scene_observation_required');
      const sceneDate=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(request.binding.session_started_at));
      const response=await tabs.fetchLiveSessions(sceneDate,{accountId:request.binding.account_id});
      if(response.data_valid!==true||response.error)fail('scene_read_unavailable');
      const matches=response.sessions.filter(r=>String(r.roomId)===request.binding.room_id);
      const parseStart=s=>typeof s==='string'?Date.parse(s.includes('T')?s:s.replace(' ','T')+'+08:00'):NaN;
      if(matches.length!==1||parseStart(matches[0].startTime)!==Date.parse(request.binding.session_started_at))fail('scene_identity_mismatch');
      if(String(matches[0].status)!=='2'&&(request.operation==='resume'||request.targets.some(t=>t.expected_state==='active')))fail('scene_not_live');
      if(!['2','4'].includes(String(matches[0].status)))fail('scene_status_unknown');
    },
    async claimIntent(before){const {module,control}=await sharedState();return module.claimControlOperation(control,controlIntent(request,before));},
    async finishIntent(status,result){const {module,control}=await sharedState();return module.settleControlOperation(control,controlIntent(request),{status,result});},
  };
}
function selectTasks(result, request) {
  if ((result?.status_code ?? result?.code) !== 0 || result.truncated !== false
      || !Array.isArray(result.data?.adInfos) || Object.keys(result.data.moduleErrors || {}).length) fail('task_read_incomplete');
  const allIds = result.data.adInfos.map(t => t.id);
  const total = result.data.pagination?.totalNum;
  if (total == null || !Number.isSafeInteger(Number(total)) || Number(total) !== allIds.length
      || new Set(allIds).size !== allIds.length) fail('task_pagination_inconsistent');
  const tasks = request.targets.map(target => {
    const matches = result.data.adInfos.filter(t => t.id === target.task_id);
    if (matches.length !== 1) fail('task_identity_not_unique');
    const value = snapshot(matches[0]);
    if (value.advertiser_id !== request.binding.advertiser_id) fail('task_advertiser_mismatch');
    return { raw: matches[0], value };
  });
  return tasks;
}
function errorCode(error) { return /^[a-z0-9_]{1,80}$/.test(error?.code || '') ? error.code : 'api_request_failed'; }

async function runQianchuanTaskBatch(input, options = {}) {
  const request = normalizeRequest(input), began = Date.now();
  const { state, save } = options;
  if (!state || !Array.isArray(state.requests) || typeof save !== 'function') fail('durable_state_required');
  const deps = options.dependencies || defaultDependencies(request);
  await deps.verifyBinding(request.binding);
  const fingerprint = hash(request);
  let record = state.requests.find(r => r.request_id === request.request_id), hasSharedIntent=false;
  if (record && record.fingerprint !== fingerprint) fail('request_id_conflict');
  if(!record){
    requireSceneScope(request);
    if(typeof deps.verifyScene!=='function'||typeof deps.claimIntent!=='function'||typeof deps.lookupIntent!=='function'||typeof deps.finishIntent!=='function')fail('shared_scene_contract_required');
    const prior=await deps.lookupIntent();
    if(prior){
      hasSharedIntent=true;
      if(!Array.isArray(prior.verification_before)||prior.verification_before.length!==request.targets.length)fail('original_intent_needs_readback');
      record={...request,fingerprint,before:prior.verification_before,state:'dispatch_recorded',retry_write:false,reconciled_from_shared_intent:true,started_at:prior.created_at};
      state.requests.push(record);await save(state);
    }
  }
  const reading = Date.now();
  const initialRead = await deps.readTasks(request.binding, request.date, { phase: record ? 'after' : 'before' });
  const selected = selectTasks(initialRead, request);
  const read_ms = Date.now() - reading;
  if (!record) {
    for (let index = 0; index < selected.length; index++) {
      const { raw, value } = selected[index], target = request.targets[index];
      if (value.state !== target.expected_state || value.budget_micro !== target.expected_budget_micro) fail('task_changed_before_submit');
      const action = request.operation === 'pause' ? 'pause' : request.operation === 'resume' ? 'start' : 'edit';
      if (!available(raw, action) || request.operation === 'budget' && raw.operation?.budgetEditOperation?.editable !== true) fail('task_action_unavailable');
    }
    await deps.verifyScene();
    const claim=await deps.claimIntent(selected.map(t=>t.value));
    hasSharedIntent=true;
    if(!claim.is_new&&(!Array.isArray(claim.operation?.verification_before)||claim.operation.verification_before.length!==request.targets.length))fail('original_intent_needs_readback');
    record = { ...request, fingerprint, started_at: new Date().toISOString(),
      before: claim.is_new?selected.map(t => t.value):claim.operation.verification_before, preflight_ms: read_ms, preflight_scope: initialRead.task_pool ?? null,
      preflight_read: initialRead.read_timings ?? null, state: 'dispatch_recorded', retry_write: false };
    state.requests.push(record);
    try{await save(state);}catch(error){if(claim.is_new)await deps.finishIntent('not_submitted',{reason:'local_intent_save_failed'});throw error;}
    const submitting = Date.now();
    if(claim.is_new)try {
      const response = await deps.send(request.binding, wireRequest(request));
      record.response = { code: response?.status_code ?? response?.code ?? null, results: response?.data?.results ?? null };
    } catch (error) { record.transport_error = errorCode(error); }
    else record.reconciled_without_submit=true;
    record.submit_ms = Date.now() - submitting;
    await save(state);
    try {
      const checking = Date.now();
      const readback = await deps.readTasks(request.binding, request.date, { phase: 'after' });
      record.after = selectTasks(readback, request).map(t => t.value);
      record.readback_scope = readback.task_pool ?? null;
      record.readback_read = readback.read_timings ?? null;
      record.readback_ms = Date.now() - checking;
    } catch (error) { record.readback_error = errorCode(error); record.after = null; }
  } else {
    record.after = selected.map(t => t.value);
    record.readback_ms = read_ms;
    record.reconciled_without_submit = true;
  }
  record.outcomes = request.targets.map((target, index) => {
    const before = record.before[index], after = record.after?.[index];
    const wantedState = request.operation === 'budget' ? target.expected_state : request.operation === 'pause' ? 'paused' : 'active';
    const wantedBudget = request.operation === 'budget' ? target.requested_budget_micro : target.expected_budget_micro;
    const verified = !!after && after.state === wantedState && after.budget_micro === wantedBudget
      && after.invariant_hash === before.invariant_hash;
    const replies = Array.isArray(record.response?.results)
      ? record.response.results.filter(item => item.objId === target.task_id) : [];
    const rejected = !verified && replies.length === 1 && replies[0].status === 3 && !!after
      && after.state === before.state && after.budget_micro === before.budget_micro && after.invariant_hash === before.invariant_hash;
    return { task_id: target.task_id, verified, state: verified ? 'verified' : rejected ? 'rejected' : 'unknown', before, after: after || null };
  });
  record.state = record.outcomes.every(t => t.verified) ? 'verified'
    : record.outcomes.every(t => t.state === 'rejected') ? 'rejected' : 'unknown';
  record.finished_at = new Date().toISOString();
  record.total_ms = Date.now() - began;
  await save(state);
  if(!hasSharedIntent&&request.binding.room_id&&typeof deps.lookupIntent==='function')hasSharedIntent=!!await deps.lookupIntent();
  if(hasSharedIntent&&typeof deps.finishIntent==='function')await deps.finishIntent(record.state==='verified'?'confirmed':record.state==='rejected'?'not_submitted':'unconfirmed',
    {request_id:record.request_id,state:record.state,outcomes:record.outcomes});
  return { ok: record.state === 'verified', ...record };
}

// Test cleanup only: restore the original paused setting when an accepted test
// resume reveals a completed/invalid task. Never used as business resume proof.
async function restoreOriginalTestPause(input, options = {}) {
  const { state, save } = options;
  if (!state || !Array.isArray(state.requests) || typeof save !== 'function') fail('durable_state_required');
  const source = state.requests.find(r => r.request_id === input.source_request_id);
  if (!source || source.operation !== 'resume' || !Array.isArray(source.before)
      || source.before.some(t => t.state !== 'paused') || source.response?.code !== 0) fail('test_cleanup_source_unverified');
  // Legacy cleanup receipts predate shared scene intents. They remain readable,
  // but cannot bypass a new scoped unresolved intent to create another write.
  if(source.binding?.room_id||source.runtime_root)fail('scoped_cleanup_requires_original_reconciliation');
  const request = normalizeRequest({ request_id: input.request_id, operation: 'pause', date: input.date,
    binding: source.binding, targets: source.before.map(t => ({ task_id: t.task_id, expected_state: 'active', expected_budget: t.budget_micro / 100000 })) });
  for (const target of request.targets) {
    const accepted = source.response.results?.filter(r => r.object?.objectId === target.task_id && r.flag === true);
    if (accepted?.length !== 1) fail('test_cleanup_source_unverified');
  }
  const fingerprint = hash({ request, source_request_id: input.source_request_id });
  let record = state.requests.find(r => r.request_id === request.request_id);
  if (record && record.fingerprint !== fingerprint) fail('request_id_conflict');
  const deps = options.dependencies || defaultDependencies(request);
  await deps.verifyBinding(request.binding);
  const selected = selectTasks(await deps.readTasks(request.binding, request.date, { phase: 'after' }), request);
  for (let index = 0; index < selected.length; index++) {
    const { raw, value } = selected[index], original = source.before[index];
    if (![0, 1].includes(raw.adOptType) || value.invariant_hash !== original.invariant_hash
        || value.budget_micro !== original.budget_micro) fail('test_cleanup_concurrent_change');
  }
  if (!record) {
    record = { ...request, operation: 'restore_test_pause', source_request_id: input.source_request_id,
      fingerprint, before: source.before, started_at: new Date().toISOString(), retry_write: false, state: 'dispatch_recorded' };
    state.requests.push(record);
    await save(state);
    const changed = selected.filter(t => t.raw.adOptType === 0).map(t => t.value.task_id);
    if (changed.length) {
      const wire = wireRequest({ ...request, targets: request.targets.filter(t => changed.includes(t.task_id)) });
      try { const r = await deps.send(request.binding, wire); record.response = { code: r?.status_code ?? r?.code ?? null, results: r?.data?.results ?? null }; }
      catch (error) { record.transport_error = errorCode(error); }
      await save(state);
      try { record.after = selectTasks(await deps.readTasks(request.binding, request.date, { phase: 'after' }), request).map(t => t.value); }
      catch (error) { record.readback_error = errorCode(error); record.after = null; }
    } else { record.after = selected.map(t => t.value); record.already_restored = true; }
  } else { record.after = selected.map(t => t.value); record.reconciled_without_submit = true; }
  record.outcomes = source.before.map((before, index) => {
    const after = record.after?.[index];
    return { task_id: before.task_id, verified: !!after && after.ad_opt_type === 1
      && after.budget_micro === before.budget_micro && after.invariant_hash === before.invariant_hash, before, after: after || null };
  });
  record.state = record.outcomes.every(t => t.verified) ? 'verified' : 'unknown';
  record.finished_at = new Date().toISOString(); await save(state);
  return { ok: record.state === 'verified', ...record };
}

async function main(args = process.argv.slice(2)) {
  if (args.length !== 2 || args.some(file => !path.isAbsolute(file))) fail('absolute_request_and_state_files_required');
  const [requestFile, stateFile] = args;
  const request = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
  const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { requests: [] };
  const save = async value => {
    const temporary = stateFile + '.tmp.' + process.pid;
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temporary, stateFile);
  };
  const result = request.operation === 'restore_test_pause'
    ? await restoreOriginalTestPause(request, { state, save }) : await runQianchuanTaskBatch(request, { state, save });
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 2;
}
if (require.main === module) main().catch(error => { console.error(JSON.stringify({ ok: false, code: errorCode(error) })); process.exitCode = 1; });
module.exports = { runQianchuanTaskBatch, restoreOriginalTestPause, normalizeRequest, wireRequest, taskState, readQianchuanBatchTargets, controlIntent };
