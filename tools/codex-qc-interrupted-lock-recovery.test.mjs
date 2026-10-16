import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {inspectInterruptedLocks,recoverInterruptedLock,recoverInterruptedCapture} from './codex-qc-interrupted-lock-recovery.mjs';
import {digest,sceneKey} from './codex-qc-control-state.mjs';
import {fixtureBinding as binding} from './fixtures/codex-qc-control-simulator.mjs';

async function setup() {
  assert.ok(process.env.QC_TEST_RUN_ROOT);
  const root=path.join(process.env.QC_TEST_RUN_ROOT,'lock-recovery-'+randomUUID());
  const config={runtime_root:root,run_root:path.join(root,'room'),execution_owner:'owner-test',binding};
  const dir=path.join(root,'codex-control',digest([binding.advertiser_id,binding.primary_ad_id]));
  await fs.mkdir(dir,{recursive:true});await fs.mkdir(path.join(config.run_root,'clean-reader'),{recursive:true});
  const state={revision:8,owner:{id:config.execution_owner,session:sceneKey(binding),status:'active'},operations:{original:{status:'unconfirmed',request_id:'original'}}};
  const lock={token:'test-token',execution_owner:config.execution_owner,session:sceneKey(binding),acquired_at:'2000-01-01T00:00:00Z'};
  const stateFile=path.join(dir,'state.json'),lockFile=path.join(dir,'execution.lock'),captureFile=path.join(config.run_root,'clean-reader','capture.lock');
  await fs.writeFile(stateFile,JSON.stringify(state));await fs.writeFile(lockFile,JSON.stringify(lock));await fs.writeFile(captureFile,'');
  return {config,state,lock,stateFile,lockFile,captureFile,dir};
}

test('inspection is read-only and old lock plus active owner do not imply a dead call',async()=>{
  const s=await setup(),raw=await fs.readFile(s.stateFile,'utf8');
  const d=await inspectInterruptedLocks({config:s.config});
  assert.equal(d.next_step,'check_original_call');assert.equal(d.original_call_status,'unknown');
  assert.equal(d.execution.expected_token,s.lock.token);assert.equal(d.execution.expected_revision,8);
  assert.equal(d.capture.expected_size,0);assert.equal(d.capture.same_owner_scene,true);
  assert.equal(d.operations,undefined);assert.equal(await fs.readFile(s.stateFile,'utf8'),raw);
  assert.deepEqual((await fs.readdir(s.dir)).sort(),['execution.lock','state.json']);
  assert.equal(await fs.readFile(s.captureFile,'utf8'),'');
});

test('missing local state and locks are no_local_lock, not an invented recovery',async()=>{
  const root=path.join(process.env.QC_TEST_RUN_ROOT,'missing-'+randomUUID());
  const d=await inspectInterruptedLocks({config:{runtime_root:root,run_root:root,execution_owner:'owner',binding}});
  assert.equal(d.next_step,'no_local_lock');assert.equal(d.execution.exists,false);assert.equal(d.capture.exists,false);
  await assert.rejects(fs.stat(root),{code:'ENOENT'});
});

test('foreign owner, other scene and stopped owner cannot recover either lock',async()=>{
  for(const patch of [{id:'another-owner'},{session:'another-scene'},{status:'stopped'}]) {
    const s=await setup();Object.assign(s.state.owner,patch);await fs.writeFile(s.stateFile,JSON.stringify(s.state));
    const d=await inspectInterruptedLocks({config:s.config});assert.equal(d.next_step,'ownership_conflict');
    await assert.rejects(recoverInterruptedLock({config:s.config,expected_token:s.lock.token,expected_revision:8,host_reset_evidence:'synthetic reset',user_evidence:'synthetic continue'}),/recovery_ownership_changed/);
    await assert.rejects(recoverInterruptedCapture({config:s.config,expected_size:d.capture.expected_size,expected_mtime_ms:d.capture.expected_mtime_ms,host_reset_evidence:'synthetic reset'}),/recovery_ownership_changed/);
    assert.equal(JSON.parse(await fs.readFile(s.lockFile,'utf8')).token,s.lock.token);assert.equal(await fs.readFile(s.captureFile,'utf8'),'');
  }
});

test('real evidence inputs and unchanged fingerprints are required before recovery',async()=>{
  const s=await setup(),d=await inspectInterruptedLocks({config:s.config});
  await assert.rejects(recoverInterruptedLock({config:s.config,expected_token:s.lock.token,expected_revision:8}),/recovery_evidence_required/);
  const args={config:s.config,expected_token:s.lock.token,expected_revision:8,host_reset_evidence:'synthetic reset',user_evidence:'synthetic continue'};
  await assert.rejects(recoverInterruptedLock({...args,expected_token:'wrong'}),/recovery_ownership_changed/);
  await assert.rejects(recoverInterruptedLock({...args,expected_revision:7}),/recovery_ownership_changed/);
  await assert.rejects(recoverInterruptedCapture({config:s.config,expected_size:0,expected_mtime_ms:d.capture.expected_mtime_ms}),/host_reset_evidence_required/);
  await fs.writeFile(s.captureFile,'changed');
  await assert.rejects(recoverInterruptedCapture({config:s.config,expected_size:d.capture.expected_size,expected_mtime_ms:d.capture.expected_mtime_ms,host_reset_evidence:'synthetic reset'}),/capture_lock_changed/);
  assert.ok(await fs.stat(s.lockFile));
});

test('same-owner recovery archives the two locks without changing or replaying an unknown',async()=>{
  const s=await setup(),before=await fs.readFile(s.stateFile,'utf8');
  const d=await inspectInterruptedLocks({config:s.config});
  const a=await recoverInterruptedLock({config:s.config,expected_token:d.execution.expected_token,expected_revision:d.execution.expected_revision,host_reset_evidence:'synthetic reset',user_evidence:'synthetic continue'});
  assert.equal(a.operations_unchanged,true);assert.deepEqual(JSON.parse(await fs.readFile(a.archive,'utf8')),s.lock);
  const b=await recoverInterruptedCapture({config:s.config,expected_size:d.capture.expected_size,expected_mtime_ms:d.capture.expected_mtime_ms,host_reset_evidence:'synthetic reset'});
  assert.equal(await fs.readFile(b.archive,'utf8'),'');
  assert.equal(await fs.readFile(s.stateFile,'utf8'),before);
  assert.equal((await inspectInterruptedLocks({config:s.config})).next_step,'no_local_lock');
});

test('documented CLI returns complete compact diagnosis without mutation and rejects wrong arguments',async()=>{
  const s=await setup(),file=path.join(s.config.run_root,'session-config.json');await fs.writeFile(file,JSON.stringify(s.config));
  const script=path.resolve('tools/codex-qc-interrupted-lock-recovery.mjs');
  const {stdout}=await promisify(execFile)(process.execPath,[script,'--config',file],{windowsHide:true});
  assert.deepEqual(JSON.parse(stdout),await inspectInterruptedLocks({config:s.config}));
  await assert.rejects(promisify(execFile)(process.execPath,[script,'--force',file],{windowsHide:true}),/usage:/);
});
