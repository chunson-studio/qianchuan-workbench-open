// Explicit same-scene executor transfer. No browser or advertising IO.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {digest,sceneKey,atomicControlWrite} from './codex-qc-control-state.mjs';
const pending = o => ['dispatch_pending','submitted_pending_readback','unconfirmed'].includes(o.status);
const read = async f => JSON.parse(await fs.readFile(f,'utf8'));
const atomic = async (file,value) => {
  const temp=file+'.'+randomUUID()+'.tmp';
  const h=await fs.open(temp,'wx');
  try {await h.writeFile(JSON.stringify(value,null,2)+'\n');await h.sync();} finally {await h.close();}
  await fs.rename(temp,file);
};
export async function recordExecutionHandoff({config_file,from_owner,to_owner,expected_revision,user_evidence,prior_executor_snapshot,schedule_file,expected_capture_lock}) {
  if(!path.isAbsolute(config_file??'')||!path.isAbsolute(schedule_file??'')||!from_owner||!to_owner||from_owner===to_owner||!user_evidence?.trim()||!Number.isSafeInteger(expected_revision))throw Error('explicit_handoff_evidence_required');
  // Accept both historical poll snapshots and the current read_thread payload.
  const polls=prior_executor_snapshot?.polls??(prior_executor_snapshot?.thread
    ?[{thread:prior_executor_snapshot.thread,latestTurn:prior_executor_snapshot.turns?.[0]}]:null);
  if(!Array.isArray(polls)||!polls.some(p=>p.thread?.id===from_owner&&p.thread.status?.type==='idle'&&p.latestTurn?.status==='completed'))throw Error('prior_executor_not_verified_idle');
  const cfg=await read(config_file),session=sceneKey(cfg.binding);
  if(!path.isAbsolute(cfg.runtime_root??'')||!path.isAbsolute(cfg.run_root??'')||cfg.execution_owner!==from_owner&&cfg.execution_owner!==to_owner)throw Error('handoff_config_mismatch');
  const directory=path.join(cfg.runtime_root,'codex-control',digest([cfg.binding.advertiser_id,cfg.binding.primary_ad_id]));
  const file=path.join(directory,'state.json'),token=randomUUID();
  {
    const schedule=await fs.readFile(schedule_file,'utf8');
    const field=k=>schedule.match(new RegExp('^'+k+' = "([^"]*)"','m'))?.[1];
    const scheduleStatus=field('status');
    if(field('id')!==cfg.schedule_id||!['ACTIVE','PAUSED'].includes(scheduleStatus)||field('target_thread_id')!==to_owner)throw Error('successor_schedule_not_verified');
    const state=await read(file);
    if(state.schema_version!==1||state.owner?.session!==session||!state.scenes[session])throw Error('handoff_scene_mismatch');
    // Same-scene executor transfer preserves an already recorded isolation;
    // it does not settle or replay unknown submissions from ended older scenes.
    const isolation=state.scenes[session].scene_isolation;
    const isolated=([key,o])=>o.session!==session&&state.scenes[o.session]?.status==='ended'
      &&isolation?.mode==='new_scene_only'&&isolation.original_result==='unknown'
      &&isolation.operation_keys?.includes(key)&&isolation.original_requests?.some(r=>
        r.request_id===o.request_id&&r.session===o.session&&r.status===o.status);
    const unresolved=Object.entries(state.operations).filter(([,o])=>pending(o));
    if(unresolved.some(entry=>!isolated(entry)))throw Error('handoff_has_pending_submissions');
    // A completed handoff can repair its config receipt after an interrupted save.
    const previous=state.execution_handoffs?.findLast(h=>h.from_owner===from_owner&&h.to_owner===to_owner&&h.session===session);
    if(state.owner.id===to_owner&&previous) {
      if(cfg.execution_owner!==to_owner)await atomic(config_file,{...cfg,execution_owner:to_owner});
      return {...previous,replayed:true,state_revision:state.revision};
    }
    if(state.revision!==expected_revision)throw Error('state_revision_conflict');
    if(state.owner.id!==from_owner||state.owner.status!=='active')throw Error('handoff_owner_mismatch');
    if(!['live','unknown'].includes(state.scenes[session].status))throw Error('handoff_scene_not_active');
    const receipt={id:token,session,from_owner,to_owner,at:new Date().toISOString(),user_evidence,prior_executor_snapshot,schedule_file,schedule_id:cfg.schedule_id,schedule_status:scheduleStatus,
      preserved_pending_requests:unresolved.map(([,o])=>o.request_id),status:'execution_handoff_verified'};
    if(expected_capture_lock) {
      const capture=path.join(cfg.run_root,'clean-reader','capture.lock');
      const stat=await fs.stat(capture);
      if(stat.size!==expected_capture_lock.size||stat.mtimeMs!==expected_capture_lock.mtimeMs)throw Error('capture_lock_changed');
      const archive=path.join(cfg.run_root,'interrupted-capture-lock-'+token+'.receipt');
      await fs.rename(capture,archive);receipt.capture_lock_archive=archive;
    }
    if((await read(file)).revision!==expected_revision)throw Error('state_revision_conflict');
    // Preserve every scene, operation, task owner, feedback deadline and policy.
    state.owner={...state.owner,id:to_owner};
    (state.execution_handoffs??=[]).push(receipt);state.revision++;
    atomicControlWrite(file,expected_revision,state);
    await atomic(config_file,{...cfg,execution_owner:to_owner});
    await atomic(path.join(cfg.run_root,'执行交接回执.json'),{...receipt,state_revision:state.revision});
    return {...receipt,state_revision:state.revision};
  }
}
