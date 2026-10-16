'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {loadConfig,startExtensionSession}=require('../tools/start-qc-extension-session.cjs');
test('owner config refuses ambiguous targets and output paths that could overwrite credentials',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qc-extension-config-')),file=path.join(dir,'config.json');
  t.after(()=>{fs.unlinkSync(file);fs.rmdirSync(dir);});
  const binding={room:'test',account_id:'123',advertiser_id:'123',primary_ad_id:'456',date:'2026-10-15',pool:'手动暂停',profileConfigFile:path.join(dir,'profile.json'),tab_id:12,expected_group_id:34};
  const config={runtimeFile:path.join(dir,'runtime.json'),statusFile:path.join(dir,'status.json'),depsRoot:path.join(dir,'deps'),bindings:[binding]};
  const check=value=>{fs.writeFileSync(file,JSON.stringify(value));return ()=>loadConfig(file);};
  assert.equal(check(config)().bindings.length,1);
  assert.throws(check({...config,statusFile:binding.profileConfigFile}),/extension_host_output_path_conflict/);
  assert.throws(check({...config,statusFile:config.runtimeFile}),/extension_host_output_path_conflict/);
  assert.throws(check({...config,bindings:[binding,{...binding,room:'other'}]}),/extension_host_binding_invalid/);
});
test('starting another owner cannot replace the runtime of a live process',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qc-extension-existing-')),runtimeFile=path.join(dir,'runtime.json');
  fs.writeFileSync(runtimeFile,JSON.stringify({status:'running',pid:process.pid}));t.after(()=>{fs.unlinkSync(runtimeFile);fs.rmdirSync(dir);});
  await assert.rejects(startExtensionSession({runtimeFile}),/extension_host_already_running/);
});

function isolatedFixture(t,stage){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qc-extension-isolation-'));
  const config={runtimeFile:path.join(dir,'runtime.json'),statusFile:path.join(dir,'status.json'),depsRoot:dir,
    bindings:[1,2].map(n=>({room:'room'+n,account_id:String(n),advertiser_id:String(n),primary_ad_id:String(n+100),date:'2026-10-16',pool:'手动暂停',profileConfigFile:String(n),tab_id:n,expected_group_id:n+10}))};
  const clients=new Map(),probes=new Map();let failRecovery=false;
  const error=()=>Object.assign(Error('diagnostic must not leak'),{code:'fixture_account_failed'});
  const dependencies={
    async connectPlaywrightExtension({configFile}){
      const n=Number(configFile);if(n===2&&(stage==='connect'||failRecovery))throw error();
      const client={number:n,profile_dir_name:'Profile '+n,server_pid:1000+n,connected:true,closed:0,
        isTransportConnected(){return this.connected;},async callTool(){if(n===2&&stage==='initialize')return {isError:true};return {content:[]};},async close(){this.closed++;this.connected=false;},diagnostics(){return {};}};
      clients.set(n,client);return client;
    },
    async bindExtensionTestTab(client){if(client.number===2&&stage==='bind')throw error();return {group_id:client.number+20};},
    async ensureExtensionTestPage(){},
    async readExtensionControl(client){if(client.number===2&&stage==='pool')return {complete:false};return {ok:true,complete:true,tasks:[{task_id:String(client.number)}]};},
    async inspectExtensionTestBinding(client){const count=(probes.get(client.number)||0)+1;probes.set(client.number,count);if(client.number===2&&stage==='host_verify')throw error();return {};},
  };
  let session;
  t.after(async()=>{if(session)await session.close();for(const f of fs.readdirSync(dir))fs.unlinkSync(path.join(dir,f));fs.rmdirSync(dir);});
  return {config,clients,dependencies,setSession:s=>{session=s;},failRecovery:()=>{failRecovery=true;}};
}
for(const stage of ['connect','initialize','bind','pool','host_verify'])test('one account failing at '+stage+' leaves the healthy owner usable',async t=>{
  const f=isolatedFixture(t,stage),session=await startExtensionSession(f.config,f.dependencies);f.setSession(session);
  const {createQianchuanNativeClient}=require('../tools/qc-native-session-client.cjs');
  const c=createQianchuanNativeClient({runtimeFile:f.config.runtimeFile}),b=f.config.bindings[0];
  const response=await c.call({...b,request_id:'isolation-'+stage,operation:'read_control',input:{advertiser_id:b.advertiser_id,primary_ad_id:b.primary_ad_id,date:b.date,pool:b.pool}});
  assert.equal(response.ok,true);assert.equal(response.result.complete,true);
  assert.equal(f.clients.get(1).closed,0);if(f.clients.has(2))assert.equal(f.clients.get(2).closed,1);
  const status=JSON.parse(fs.readFileSync(f.config.statusFile,'utf8'));
  assert.equal(status.degraded,true);assert.deepEqual(status.bindings.map(b=>b.room),['room1']);
  assert.equal(status.binding_failures.length,1);assert.equal(status.binding_failures[0].room,'room2');
  assert.equal(JSON.stringify(status).includes('diagnostic must not leak'),false);
});
test('a later failed account recovery is not retried and other accounts keep reading',async t=>{
  const f=isolatedFixture(t,'none'),session=await startExtensionSession(f.config,f.dependencies);f.setSession(session);
  const {createQianchuanNativeClient}=require('../tools/qc-native-session-client.cjs');
  const c=createQianchuanNativeClient({runtimeFile:f.config.runtimeFile});
  f.clients.get(2).connected=false;f.failRecovery();
  const call=(n,id)=>{const b=f.config.bindings[n-1];return c.call({...b,request_id:id,operation:'read_control',input:{advertiser_id:b.advertiser_id,primary_ad_id:b.primary_ad_id,date:b.date,pool:b.pool}});};
  assert.equal((await call(2,'failed-room-first')).ok,false);
  assert.equal((await call(1,'healthy-room-first')).ok,true);
  const again=await call(2,'failed-room-second');assert.equal(again.ok,false);
  const publicStatus=JSON.parse(fs.readFileSync(f.config.statusFile,'utf8'));
  assert.equal(publicStatus.bindings.find(b=>b.room==='room2').transport_restarts,1);
  assert.equal(publicStatus.bindings.find(b=>b.room==='room2').transport_recovery_blocked,true);
  assert.equal((await call(1,'healthy-room-second')).ok,true);
  assert.equal(f.clients.get(1).closed,0);assert.equal((await c.status()).connected,true);
});
test('all account startup failures publish no usable host',async t=>{
  const f=isolatedFixture(t,'none');f.dependencies.connectPlaywrightExtension=async()=>{throw Object.assign(Error('failed'),{code:'fixture_account_failed'});};
  await assert.rejects(startExtensionSession(f.config,f.dependencies),e=>e.code==='extension_host_no_healthy_bindings'&&e.binding_failures.length===2);
  assert.equal(fs.existsSync(f.config.runtimeFile),false);
});
