// Same-owner recovery after the host has explicitly reset its execution kernel.
// Preserve the interrupted lock as evidence; never change operations or replay submits.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {digest,sceneKey} from './codex-qc-control-state.mjs';

// Diagnosis is read-only. File age and an active owner are not liveness evidence.
export async function inspectInterruptedLocks({config}) {
  if(!config?.execution_owner || !path.isAbsolute(config.runtime_root??'') || !path.isAbsolute(config.run_root??'')
    || !['advertiser_id','primary_ad_id','room_id','session_started_at'].every(k=>typeof config.binding?.[k]==='string'&&config.binding[k]))throw Error('recovery_config_required');
  const directory=path.join(config.runtime_root,'codex-control',digest([config.binding.advertiser_id,config.binding.primary_ad_id]));
  const state_file=path.join(directory,'state.json'),execution_file=path.join(directory,'execution.lock');
  const capture_file=path.join(config.run_root,'clean-reader','capture.lock');
  const optional=async work=>{try{return await work();}catch(e){if(e.code==='ENOENT')return null;throw e;}};
  const [state,lock,capture]=await Promise.all([
    optional(async()=>JSON.parse(await fs.readFile(state_file,'utf8'))),
    optional(async()=>JSON.parse(await fs.readFile(execution_file,'utf8'))),
    optional(()=>fs.stat(capture_file)),
  ]);
  const session=sceneKey(config.binding);
  const sameOwner=state?.owner?.id===config.execution_owner&&state?.owner?.session===session&&state?.owner?.status==='active';
  const sameLock=!!lock&&lock.execution_owner===config.execution_owner&&lock.session===session;
  const eligible=sameOwner&&(!lock||sameLock);
  return {
    state_file,execution_owner:config.execution_owner,session,state_revision:state?.revision??null,
    owner:state?.owner??null,
    execution:{exists:!!lock,file:execution_file,same_owner_scene:sameLock,expected_token:lock?.token??null,expected_revision:state?.revision??null},
    capture:{exists:!!capture,file:capture_file,same_owner_scene:eligible,expected_size:capture?.size??null,expected_mtime_ms:capture?.mtimeMs??null},
    next_step:!lock&&!capture?'no_local_lock':eligible?'check_original_call':'ownership_conflict',
    original_call_status:'unknown',requires_host_reset_evidence:!!(lock||capture),
    // Do not expose operations or business data just to diagnose a lock.
    operations_unchanged:true,
  };
}
export async function recoverInterruptedCapture({config,expected_size,expected_mtime_ms,host_reset_evidence}) {
  if(!host_reset_evidence)throw Error('host_reset_evidence_required');
  const diagnosis=await inspectInterruptedLocks({config});
  if(diagnosis.next_step!=='check_original_call')throw Error('recovery_ownership_changed');
  const file=path.join(config.run_root,'clean-reader','capture.lock');
  const stat=await fs.stat(file);
  if(stat.size!==expected_size||stat.mtimeMs!==expected_mtime_ms)throw Error('capture_lock_changed');
  const archive=file+'.interrupted-'+Date.now()+'.receipt';
  await fs.rename(file,archive);
  return {archive,host_reset_evidence};
}
export async function recoverInterruptedLock({config,expected_token,expected_revision,host_reset_evidence,user_evidence}) {
  if(!host_reset_evidence||!user_evidence||!expected_token||!Number.isSafeInteger(expected_revision))throw Error('recovery_evidence_required');
  const dir=path.join(config.runtime_root,'codex-control',digest([config.binding.advertiser_id,config.binding.primary_ad_id]));
  const file=path.join(dir,'execution.lock');
  const raw=await fs.readFile(file,'utf8'),lock=JSON.parse(raw);
  const state=JSON.parse(await fs.readFile(path.join(dir,'state.json'),'utf8'));
  if(lock.token!==expected_token||lock.execution_owner!==config.execution_owner||lock.session!==sceneKey(config.binding)||state.revision!==expected_revision||state.owner?.id!==config.execution_owner||state.owner?.session!==sceneKey(config.binding)||state.owner?.status!=='active')throw Error('recovery_ownership_changed');
  const archive=path.join(dir,'interrupted-execution-'+lock.token+'.receipt');
  if(await fs.readFile(file,'utf8')!==raw)throw Error('recovery_lock_changed');
  await fs.rename(file,archive);
  const receipt={archive,lock,state_revision:state.revision,host_reset_evidence,user_evidence,at:new Date().toISOString(),operations_unchanged:true};
  await fs.writeFile(path.join(config.run_root,'执行中断恢复回执.json'),JSON.stringify(receipt,null,2));
  return receipt;
}

// CLI only inspects. Recovery remains an explicit call with real host evidence.
if(typeof process!=='undefined'&&process.argv?.[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if(process.argv.length!==4||process.argv[2]!=='--config'||!path.isAbsolute(process.argv[3]))throw Error('usage: node codex-qc-interrupted-lock-recovery.mjs --config <absolute-session-config.json>');
    const config=JSON.parse(await fs.readFile(process.argv[3],'utf8'));
    process.stdout.write(JSON.stringify(await inspectInterruptedLocks({config}))+'\n');
  } catch(e) {process.stderr.write(e.message+'\n');process.exitCode=1;}
}
