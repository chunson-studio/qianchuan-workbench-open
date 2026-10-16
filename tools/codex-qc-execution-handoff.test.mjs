import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {recordExecutionHandoff} from './codex-qc-execution-handoff.mjs';
import {createControlState,sceneKey} from './codex-qc-control-state.mjs';
const binding={advertiser_id:'60000007',primary_ad_id:'60000008',room_id:'60000034',session_started_at:'2026-10-07T15:10:00+08:00',date:'2026-10-07'};
async function setup(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'qc-handoff-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const cfg={binding,execution_owner:'old',runtime_root:root,run_root:root,schedule_id:'schedule'};
  const store=createControlState(cfg);await store.exclusive(async c=>{c.state.scenes[c.session]={status:'live',memory:{pending_queue:[{deadline:'original'}]},created_ids:['task']};c.state.task_owners={task:c.session};await c.persist();});
  const config_file=path.join(root,'config.json'),schedule_file=path.join(root,'schedule.toml');
  await fs.writeFile(config_file,JSON.stringify(cfg));await fs.writeFile(schedule_file,'id = "schedule"\nstatus = "ACTIVE"\ntarget_thread_id = "new"\n');
  const args={config_file,schedule_file,from_owner:'old',to_owner:'new',expected_revision:1,user_evidence:'user explicitly requests transfer',prior_executor_snapshot:{polls:[{thread:{id:'old',status:{type:'idle'}},latestTurn:{status:'completed'}}]}};
  return {root,cfg,store,args};
}
test('same live scene transfers once, preserving feedback, tasks, operations, without persistent ownership exclusion',async t=>{
  const s=await setup(t),before=JSON.parse(await fs.readFile(s.store.file));
  await createControlState({...s.cfg,execution_owner:'new'}).exclusive(async()=>{});
  const receipt=await recordExecutionHandoff(s.args),after=JSON.parse(await fs.readFile(s.store.file));
  assert.equal(receipt.status,'execution_handoff_verified');assert.equal(after.owner.id,'new');
  for(const k of ['scenes','operations','task_owners'])assert.deepEqual(after[k],before[k]);
  assert.equal(after.scenes[sceneKey(binding)].status,'live');
  assert.equal((await recordExecutionHandoff(s.args)).replayed,true);
  await s.store.exclusive(async()=>{});
  await assert.rejects(fs.stat(path.join(path.dirname(s.store.file),'execution.lock')),/ENOENT/);
});
test('pending submits, stale revision and missing stop evidence remain blocked',async t=>{
  const s=await setup(t);
  await assert.rejects(recordExecutionHandoff({...s.args,expected_revision:0}),/state_revision_conflict/);
  await assert.rejects(recordExecutionHandoff({...s.args,prior_executor_snapshot:{}}),/not_verified_idle/);
  await s.store.exclusive(async c=>{c.state.operations.x={status:'unconfirmed'};await c.persist();});
  await assert.rejects(recordExecutionHandoff({...s.args,expected_revision:2}),/pending_submissions/);
  assert.equal(JSON.parse(await fs.readFile(s.store.file)).owner.id,'old');
});
test('another scene or a schedule still targeting the prior chat prevents transfer',async t=>{
  const s=await setup(t);await fs.writeFile(s.args.schedule_file,'id = "schedule"\nstatus = "ACTIVE"\ntarget_thread_id = "old"\n');
  await assert.rejects(recordExecutionHandoff(s.args),/schedule_not_verified/);
  await fs.writeFile(s.args.schedule_file,'id = "schedule"\nstatus = "ACTIVE"\ntarget_thread_id = "new"\n');
  await s.store.exclusive(async c=>{c.state.owner.session='different-scene';await c.persist();});
  await assert.rejects(recordExecutionHandoff({...s.args,expected_revision:2}),/scene_mismatch/);
});
test('recovery archives only the unchanged interrupted capture lock',async t=>{
  const s=await setup(t);await fs.mkdir(path.join(s.root,'clean-reader'));const file=path.join(s.root,'clean-reader','capture.lock');await fs.writeFile(file,'');const stat=await fs.stat(file);
  await assert.rejects(recordExecutionHandoff({...s.args,expected_capture_lock:{size:1,mtimeMs:stat.mtimeMs}}),/capture_lock_changed/);
  const r=await recordExecutionHandoff({...s.args,expected_capture_lock:{size:stat.size,mtimeMs:stat.mtimeMs}});
  await assert.rejects(fs.stat(file),/ENOENT/);assert.equal((await fs.stat(r.capture_lock_archive)).size,0);
});

test('paused successor remains paused and current read_thread evidence must be idle and completed',async t=>{
  const s=await setup(t);
  const schedule='id = "schedule"\nstatus = "PAUSED"\ntarget_thread_id = "new"\n';
  await fs.writeFile(s.args.schedule_file,schedule);
  const snapshot={thread:{id:'old',status:{type:'idle'}},turns:[{status:'completed'}]};
  await assert.rejects(recordExecutionHandoff({...s.args,prior_executor_snapshot:{...snapshot,thread:{id:'old',status:{type:'active'}}}}),/not_verified_idle/);
  await assert.rejects(recordExecutionHandoff({...s.args,prior_executor_snapshot:{...snapshot,turns:[{status:'inProgress'}]}}),/not_verified_idle/);
  const out=await recordExecutionHandoff({...s.args,prior_executor_snapshot:snapshot});
  assert.equal(out.schedule_status,'PAUSED');
  assert.equal(await fs.readFile(s.args.schedule_file,'utf8'),schedule);
});

test('formally isolated old unknown stays unknown across same-scene executor transfer',async t=>{
  const s=await setup(t),oldSession='ended-scene';
  await s.store.exclusive(async c=>{
    c.state.scenes[oldSession]={status:'ended'};
    c.state.operations.unknown={session:oldSession,request_id:'original-unknown',status:'unconfirmed'};
    c.state.scenes[c.session].scene_isolation={mode:'new_scene_only',original_result:'unknown',operation_keys:['unknown'],original_requests:[{request_id:'original-unknown',session:oldSession,status:'unconfirmed'}]};
    await c.persist();
  });
  const before=JSON.parse(await fs.readFile(s.store.file));
  const out=await recordExecutionHandoff({...s.args,expected_revision:2});
  const after=JSON.parse(await fs.readFile(s.store.file));
  assert.deepEqual(out.preserved_pending_requests,['original-unknown']);
  for(const key of ['scenes','operations','task_owners'])assert.deepEqual(after[key],before[key]);
});

test('isolation cannot authorize current-scene, unregistered, or mismatched pending transfer',async t=>{
  for(const bad of ['current','unregistered','mismatched','not_ended']) {
    const s=await setup(t);
    await s.store.exclusive(async c=>{
      const older=bad==='current'?c.session:'older-scene';
      if(older!==c.session)c.state.scenes[older]={status:bad==='not_ended'?'live':'ended'};
      c.state.operations.unknown={session:older,request_id:'unknown',status:'unconfirmed'};
      c.state.scenes[c.session].scene_isolation={mode:'new_scene_only',original_result:'unknown',operation_keys:bad==='unregistered'?[]:['unknown'],original_requests:[{request_id:bad==='mismatched'?'different':'unknown',session:older,status:'unconfirmed'}]};
      await c.persist();
    });
    await assert.rejects(recordExecutionHandoff({...s.args,expected_revision:2}),/pending_submissions/);
    assert.equal(JSON.parse(await fs.readFile(s.store.file)).owner.id,'old');
  }
});
