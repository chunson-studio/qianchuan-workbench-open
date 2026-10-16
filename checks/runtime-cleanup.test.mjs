import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {testOutputRoot} from './test-output.cjs';
import {planRuntimeCleanup} from '../tools/plan-runtime-cleanup.mjs';

test('closed scene cleanup retains active, unresolved action and referenced read artifacts',()=>{
  const root=testOutputRoot(),sceneRoot=path.join(root,'work/browser-actions/runs/old');
  const runtime=path.join(root,'private-runtime'),stateFile=path.join(runtime,'codex-control/account-plan/state.json');
  const binding={advertiser_id:'1',primary_ad_id:'2',room_id:'3',session_started_at:'2026-10-08T09:00:00+08:00'};
  const key=JSON.stringify(Object.values(binding));
  fs.mkdirSync(path.dirname(stateFile),{recursive:true});
  for(const name of ['clean-reader','control-actions']){
    const p=path.join(sceneRoot,name);fs.mkdirSync(p,{recursive:true});const f=path.join(p,'raw.json');
    fs.writeFileSync(f,'{}');fs.utimesSync(f,new Date('2026-10-08T00:00:00Z'),new Date('2026-10-08T00:00:00Z'));
  }
  fs.writeFileSync(path.join(sceneRoot,'session-config.json'),JSON.stringify({binding,run_root:sceneRoot,runtime_root:runtime}));
  const state={owner:{session:key,status:'released'},scenes:{[key]:{binding,status:'ended',host_actions:[{status:'verified_paused'}],memory:{unresolved_submissions:[]}}},operations:{}};
  const save=()=>fs.writeFileSync(stateFile,JSON.stringify(state));
  const plan=()=>planRuntimeCleanup({root,before:'2026-10-09T00:00:00+08:00'}).paths;
  save();assert.equal(plan().length,2);
  state.owner.status='active';save();assert.equal(plan().length,0);
  state.owner.status='released';state.operations.pending={session:key,status:'unconfirmed'};save();assert.deepEqual(plan(),['work/browser-actions/runs/old/clean-reader']);
  state.operations.pending.evidence=path.join(sceneRoot,'clean-reader/raw.json');save();assert.equal(plan().length,0);
  delete state.operations.pending;state.scenes[key].host_actions=[];save();assert.equal(plan().length,0);
  state.scenes[key].host_actions=[{status:'verified_paused'}];save();
  fs.utimesSync(path.join(sceneRoot,'clean-reader/raw.json'),new Date('2026-10-09T03:00:00Z'),new Date('2026-10-09T03:00:00Z'));
  assert.deepEqual(plan(),['work/browser-actions/runs/old/control-actions']);
  const mods=path.join(sceneRoot,'control-modules');
  for(const [i,name] of ['referenced','obsolete','latest'].entries()){
    const p=path.join(mods,name);fs.mkdirSync(p,{recursive:true});fs.writeFileSync(path.join(p,'source.json'),'{}');
    const at=new Date(`2026-10-08T0${i}:00:00Z`);fs.utimesSync(path.join(p,'source.json'),at,at);fs.utimesSync(p,at,at);
  }
  fs.writeFileSync(path.join(sceneRoot,'session-config.json'),JSON.stringify({binding,run_root:sceneRoot,runtime_root:runtime,loaded_source:{directory:path.join(mods,'referenced')}}));
  assert.deepEqual(plan(),['work/browser-actions/runs/old/control-actions','work/browser-actions/runs/old/control-modules/obsolete']);
  state.operations.pending={session:key,status:'unconfirmed'};save();assert.equal(plan().length,0);
});
