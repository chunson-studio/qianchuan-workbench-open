import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {atomicControlWrite,createControlState,recordControlScene,claimControlOperation,inspectControlOperation,settleControlOperation} from './codex-qc-control-state.mjs';

async function fixture() {
  assert.ok(process.env.QC_TEST_RUN_ROOT);
  const dir=await fs.mkdtemp(path.join(process.env.QC_TEST_RUN_ROOT,'atomic-state-'));
  const file=path.join(dir,'state.json');
  await fs.writeFile(file,JSON.stringify({revision:1,operations:{original:{status:'unconfirmed'}}}));
  return {dir,file};
}
function child(code,args=[]) {
  return fork('--input-type=module',['-e',code,...args],{silent:true,execArgv:[]});
}
test('two processes cannot overwrite the same revision or erase original submissions',async()=>{
  const {file}=await fixture();
  const code=`import fs from 'node:fs';import {atomicControlWrite} from ${JSON.stringify(new URL('./codex-qc-control-state.mjs',import.meta.url).href)};
    const file=process.argv[1],state=JSON.parse(fs.readFileSync(file));
    process.send('ready');process.on('message',()=>{
      try{atomicControlWrite(file,1,{...state,revision:2,winner:process.pid});process.send('saved');}
      catch(e){process.send(e.message);}process.disconnect();});`;
  const a=child(code,[file]),b=child(code,[file]);
  await Promise.all([once(a,'message'),once(b,'message')]);
  const results=[once(a,'message'),once(b,'message')],exits=[once(a,'exit'),once(b,'exit')];
  a.send('go');b.send('go');
  const values=(await Promise.all(results)).map(x=>x[0]);await Promise.all(exits);
  assert.equal(values.filter(x=>x==='saved').length,1);
  assert.ok(values.some(x=>/state_revision_conflict|database is locked/.test(x)));
  const disk=JSON.parse(await fs.readFile(file));
  assert.equal(disk.revision,2);assert.equal(disk.operations.original.status,'unconfirmed');
});

async function intentFixture(){
  const runtime_root=await fs.mkdtemp(path.join(process.env.QC_TEST_RUN_ROOT,'shared-intent-'));
  const binding={account_id:'fixture',advertiser_id:'900',primary_ad_id:'999',room_id:'888',date:'2026-10-15',session_started_at:'2026-10-15T10:00:00+08:00'};
  const control=createControlState({runtime_root,binding,execution_owner:'fixture-browser'});
  const request={request_id:'original-001',channel:'browser',binding,action:'budget',task_ids:['101'],parameters:{budget:101,expected_budget:100}};
  const observe=()=>recordControlScene(control,{binding,status:'live',observed_at:'2026-10-15T02:01:00Z',source:{channel:'browser',identity_verified:true}});
  return {runtime_root,binding,control,request,observe};
}

test('an unknown or ended scene cannot authorize a new resume',async()=>{
  const f=await intentFixture();
  await assert.rejects(claimControlOperation(f.control,f.request),/scene_observation_required/);
  await recordControlScene(f.control,{binding:f.binding,status:'ended',observed_at:'2026-10-15T02:01:00Z',source:{channel:'browser'}});
  await assert.rejects(claimControlOperation(f.control,{...f.request,action:'resume'}),/scene_not_live/);
  await assert.rejects(recordControlScene(f.control,{binding:f.binding,status:'live',observed_at:'2026-10-15T02:00:00Z',source:{channel:'browser'}}),/scene_observation_older/);
});

test('a restarted executor on another channel can only reuse the original intent',async()=>{
  const f=await intentFixture();await f.observe();
  const original=await claimControlOperation(f.control,f.request);assert.equal(original.is_new,true);
  const restarted=createControlState({runtime_root:f.runtime_root,binding:f.binding,execution_owner:'fixture-api'});
  const request={...f.request,channel:'api',parameters:{expected_budget:100,budget:101}};
  assert.equal((await claimControlOperation(restarted,request)).is_new,false);
  assert.equal((await inspectControlOperation(restarted,request)).channel,'browser');
  await assert.rejects(claimControlOperation(restarted,{...request,request_id:'another-001'}),/original_target_unresolved/);
  await assert.rejects(claimControlOperation(restarted,{...request,parameters:{budget:102}}),/original_request_conflict/);
  await settleControlOperation(restarted,request,{status:'confirmed',result:{readback:true}});
  assert.equal((await settleControlOperation(f.control,f.request,{status:'unconfirmed',result:null})).status,'confirmed');
});

test('an old scene pending operation blocks the same task but does not reserve the new scene',async()=>{
  const f=await intentFixture();await f.observe();await claimControlOperation(f.control,f.request);
  const binding={...f.binding,room_id:'889',session_started_at:'2026-10-15T14:00:00+08:00'};
  const next=createControlState({runtime_root:f.runtime_root,binding,execution_owner:'new-scene'});
  await recordControlScene(next,{binding,status:'live',observed_at:'2026-10-15T06:01:00Z',source:{channel:'browser'}});
  await assert.rejects(claimControlOperation(next,{...f.request,binding,request_id:'new-scene-001'}),/original_target_unresolved/);
  assert.equal((await claimControlOperation(next,{...f.request,binding,task_ids:['102'],request_id:'new-scene-002'})).is_new,true);
  await assert.rejects(inspectControlOperation(next,{...f.request,binding}),/original_request_scene_conflict/);
});
test('process death releases commit coordination without deleting any lock file',async()=>{
  const {dir,file}=await fixture();
  const p=child(`import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[1]);
    db.exec('BEGIN IMMEDIATE');process.send('ready');process.on('message',()=>{});`,[path.join(dir,'state-commit.sqlite')]);
  await once(p,'message');const exited=once(p,'exit');p.kill();await exited;
  const before=JSON.parse(await fs.readFile(file));atomicControlWrite(file,1,{...before,revision:2});
  assert.equal(JSON.parse(await fs.readFile(file)).revision,2);
  assert.ok(!(await fs.readdir(dir)).some(name=>name.endsWith('.lock')));
});
