// Local account/plan coordination and durable state. No browser or advertising IO.
import * as fs from 'node:fs/promises';
import * as syncFs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {bindingMatches} from './codex-qc-browser-data.mjs';
import {reconcileFeedback} from './codex-qc-feedback.mjs';

export const sceneKey=b=>JSON.stringify([b.advertiser_id,b.primary_ad_id,b.room_id,b.session_started_at]);
export const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone=value=>JSON.parse(JSON.stringify(value));
const readJson=async file=>{try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const keys=['task_state','pending_queue','completed_startup_feedback','external_changes','unresolved_submissions'];
// Only live calls in this JS process are tracked. Closing the kernel discards
// this map; no executor or scene holds a persistent reservation.
const callsKey=Symbol.for('qianchuan.activeControlCalls');
const activeCalls=globalThis[callsKey]??=new Set();

// Serialize only the synchronous revision-check + atomic JSON replacement.
// SQLite's OS-managed transaction is released even if the process dies. It
// never spans a browser call, stores no owner, and has no recovery deadline.
export function atomicControlWrite(file,expected_revision,value) {
  const db=new DatabaseSync(path.join(path.dirname(file),'state-commit.sqlite'));
  let transaction=false,temporary;
  try {
    db.exec('BEGIN IMMEDIATE');transaction=true;
    let disk=null;
    try{disk=JSON.parse(syncFs.readFileSync(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
    if((disk?.revision??0)!==expected_revision)throw Error('state_revision_conflict');
    temporary=file+'.'+randomUUID()+'.tmp';
    const handle=syncFs.openSync(temporary,'wx');
    try{syncFs.writeFileSync(handle,JSON.stringify(value,null,2)+'\n');syncFs.fsyncSync(handle);}finally{syncFs.closeSync(handle);}
    syncFs.renameSync(temporary,file);temporary=null;
    db.exec('COMMIT');transaction=false;
  } finally {
    if(transaction)try{db.exec('ROLLBACK');}catch{}
    db.close();
    if(temporary)try{syncFs.unlinkSync(temporary);}catch{}
  }
}

export function migrateControlMemory(input,binding) {
  if(!input || !bindingMatches(input.binding,binding))throw Error('business_memory_binding_mismatch');
  if(!input.task_state || Array.isArray(input.task_state) || !Array.isArray(input.pending_queue) || !Array.isArray(input.unresolved_submissions))throw Error('business_memory_incomplete');
  const result={binding:clone(binding)};
  for(const k of keys)result[k]=clone(input[k]??(k==='task_state'?{}:[]));
  // Only the event reconciler decides completion; raw old pools never migrate.
  const completed=reconcileFeedback({completed_startup_feedback:result.completed_startup_feedback},result,input.captured_at??new Date().toISOString());
  result.pending_queue=completed.pending;
  return result;
}

export function estimateActionDelay(configured,samples=[]) {
  if(configured!==undefined && configured!==null) {
    if(!Number.isFinite(configured) || configured<0)throw Error('invalid_action_delay_seconds');
    return {seconds:configured,source:'explicit_account_config'};
  }
  const usable=samples.filter(s=>s.channel==='codex-cua' && s.status==='write_verified'
    && Number.isFinite(s.elapsed_ms) && s.elapsed_ms>=0).slice(-20);
  return usable.length?{seconds:Math.max(...usable.map(s=>s.elapsed_ms))/1000,source:'max_last_20_verified_codex_cua_operations',sample_count:usable.length}
    :{seconds:null,source:'unknown',sample_count:0};
}

export function createControlState({runtime_root,binding,execution_owner}) {
  if(!path.isAbsolute(runtime_root??'') || !bindingMatches(binding,binding) || !execution_owner)throw Error('Shared absolute runtime_root, full binding and execution_owner required');
  const key=digest([binding.advertiser_id,binding.primary_ad_id]);
  const directory=path.join(runtime_root,'codex-control',key),file=path.join(directory,'state.json');
  const session=sceneKey(binding);
  async function exclusive(work,{historical_reconciliation=false}={}) {
    if(activeCalls.has(file))throw Error('account_plan_busy');
    activeCalls.add(file);
    try {
      await fs.mkdir(directory,{recursive:true});
      let state=await readJson(file)??{schema_version:1,revision:0,owner:null,scenes:{},operations:{},action_samples:[]};
      if(state.schema_version!==1)throw Error('unsupported_control_state_version');
      const isolation=state.scenes[state.owner?.session]?.scene_isolation;
      const historicalReconciliation=historical_reconciliation&&state.owner?.session!==session
        &&state.owner?.id===execution_owner&&state.scenes[session]?.status==='ended'
        &&isolation?.operation_keys?.some(key=>state.operations[key]?.session===session);
      // owner is diagnostic metadata only, never an execution permit.
      if(!historicalReconciliation)state.owner={id:execution_owner,session,status:'active'};
      const persist=async()=>{
        const candidate={...state,revision:state.revision+1};
        atomicControlWrite(file,state.revision,candidate);
        state.revision=candidate.revision;return state.revision;
      };
      return await work({state,persist,session,directory,historicalReconciliation});
    } finally {
      activeCalls.delete(file);
    }
  }
  return {exclusive,file,directory,session};
}

const settledOperation=o=>['confirmed','not_submitted','rejected'].includes(o.status);
const operationTasks=o=>o.task_ids??(o.task_id?[o.task_id]:o.prepared?.task_id?[o.prepared.task_id]:[]);
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'
  ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const operationFingerprint=r=>digest(canonical({binding:r.binding,action:r.action,task_ids:r.task_ids,parameters:r.parameters}));

// Same canonical intent for API and browser executors. No browser/ad IO,
// persistent owner reservation, retry or business decision is added here.
export async function recordControlScene(control,{binding,status,observed_at,source}) {
  if(!bindingMatches(binding,binding)||sceneKey(binding)!==control.session||!['live','ended','unknown'].includes(status)||
    !Number.isFinite(Date.parse(observed_at))||!source||typeof source!=='object')throw Error('scene_observation_invalid');
  return control.exclusive(async({state,persist,session})=>{
    const old=state.scenes[session]??{};
    if(old.observed_at&&Date.parse(observed_at)<Date.parse(old.observed_at))throw Error('scene_observation_older');
    state.scenes[session]={...old,binding:clone(binding),status,observed_at,source:clone(source)};
    await persist();return clone(state.scenes[session]);
  });
}

export async function inspectControlOperation(control,request) {
  return control.exclusive(async({state,session})=>{
    const old=state.operations[request.request_id];if(!old)return null;
    if(old.session!==session)throw Error('original_request_scene_conflict');
    if(!old.fingerprint||old.fingerprint!==operationFingerprint(request))throw Error('original_request_conflict');
    return clone(old);
  });
}

export async function claimControlOperation(control,request) {
  if(typeof request?.request_id!=='string'||!request.request_id||Object.hasOwn(Object.prototype,request.request_id)||
    !['api','browser'].includes(request.channel)||!bindingMatches(request.binding,request.binding)||
    !Array.isArray(request.task_ids)||!request.task_ids.length||new Set(request.task_ids).size!==request.task_ids.length||
    request.task_ids.some(id=>typeof id!=='string'||!/^\d+$/.test(id)||id===request.binding.primary_ad_id)||
    !['pause','resume','budget','duration','bid'].includes(request.action)||!request.parameters)throw Error('control_intent_invalid');
  if(sceneKey(request.binding)!==control.session)throw Error('control_intent_scene_mismatch');
  const fingerprint=operationFingerprint(request);
  return control.exclusive(async({state,persist,session})=>{
    const old=state.operations[request.request_id];
    if(old){if(old.session!==session||old.fingerprint!==fingerprint)throw Error('original_request_conflict');return {is_new:false,operation:clone(old)};}
    const scene=state.scenes[session];
    if(!scene||!bindingMatches(scene.binding,request.binding)||!['live','ended'].includes(scene.status))throw Error('scene_observation_required');
    if(request.action==='resume'&&scene.status!=='live')throw Error('scene_not_live');
    const collision=Object.values(state.operations).find(o=>!settledOperation(o)&&operationTasks(o).some(id=>request.task_ids.includes(id)));
    if(collision)throw Error('original_target_unresolved');
    state.operations[request.request_id]={...clone(request),operation_id:request.request_id,session,fingerprint,status:'dispatch_pending',created_at:new Date().toISOString()};
    await persist();return {is_new:true,operation:clone(state.operations[request.request_id])};
  });
}

export async function settleControlOperation(control,request,{status,result}) {
  if(!['confirmed','not_submitted','unconfirmed'].includes(status))throw Error('control_result_invalid');
  return control.exclusive(async({state,persist,session})=>{
    const old=state.operations[request.request_id];
    if(!old||old.session!==session||old.fingerprint!==operationFingerprint(request))throw Error('original_request_conflict');
    if(settledOperation(old))return clone(old);
    old.status=status;old.result=clone(result??null);old.updated_at=new Date().toISOString();
    await persist();return clone(old);
  });
}
