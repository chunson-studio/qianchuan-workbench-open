'use strict';
require('./setup-runtime.cjs');
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {BrowserBoostService}=require('../server-app/server/lib/browserBoostService');
const {withTargetWriteLock}=require('../server-app/server/lib/targetWriteLock');
let sequence=0;
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
async function within(promise,ms=1000){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('concurrency deadline')),ms);})]);}finally{clearTimeout(timer);}}
function setup(accounts=['a','b']) {
  const id='concurrency_'+(++sequence),root=path.join(process.env.QC_RUNTIME_DATA_ROOT,id);
  fs.mkdirSync(root,{recursive:true});
  const registry={schema_version:1,bindings:accounts.map((name,i)=>({account_id:id+'_'+name,browser_type:'playwright-cdp',
    profile_name:id+'_'+name,cdp_endpoint:'http://127.0.0.1:'+(19000+sequence*10+i),status:'active',
    advertisers:[{advertiser_id:'1000'+i,primary_ad_ids:['20001']}]}))};
  const bindingsFile=path.join(root,'bindings.json');fs.writeFileSync(bindingsFile,JSON.stringify(registry));
  const config={qianchuan_accounts:registry.bindings.map(entry=>({id:entry.account_id,aavid:entry.advertisers[0].advertiser_id}))};
  const request=(index=0)=>({account_id:registry.bindings[index].account_id,primary_ad_id:'20001',action:'list',start:'2026-10-15',end:'2026-10-15'});
  return {root,registry,bindingsFile,config,request};
}
const session=prepare=>({prepare,cancel:async()=>{}});
function installReadSession(service,prepare){service.connection=async(r,clock,selected,endpoint)=>({
  session:session(()=>prepare(r,selected,endpoint)),reused:false,endpoint,release:async()=>{}});}

test('同一登记文件的两个已验证端点并发，各自连接绑定不混用',async()=>{
  const f=setup(),entered=deferred(),release=deferred(),seen=[];
  const service=new BrowserBoostService({...f,dataRoot:f.root,evidenceOrigin:'isolated_fixture'});
  installReadSession(service,async(r,selected,endpoint)=>{
    seen.push({account:r.account_id,endpoint,profile:selected.entry.profile_name});
    if(r.account_id===f.request().account_id){entered.resolve();await release.promise;}
    return {read:{account:r.account_id}};
  });
  const first=service.run(f.request());
  try{
    await within(entered.promise);
    const other=await within(service.run(f.request(1)));
    assert.equal(other.ok,true);assert.equal(seen.length,2);
    assert.deepEqual(seen.map(item=>item.endpoint),f.registry.bindings.map(entry=>entry.cdp_endpoint));
    assert.deepEqual(seen.map(item=>item.profile),f.registry.bindings.map(entry=>entry.profile_name));
  }finally{release.resolve();await first;await service.close();}
});

test('同端点 localhost 与 127.0.0.1 别名串行，sessionFactory 只注入测试端点',async()=>{
  const f=setup(),entered=deferred(),release=deferred();let active=0,maxActive=0,connections=0;
  const port=21000+sequence;
  const service=new BrowserBoostService({...f,dataRoot:f.root,
    sessionEndpoint:r=>'http://'+(r.account_id===f.request().account_id?'localhost':'127.0.0.1')+':'+port,
    sessionFactory:async r=>{connections++;return session(async()=>{
      active++;maxActive=Math.max(maxActive,active);
      try{if(r.account_id===f.request().account_id){entered.resolve();await release.promise;}return {read:{}};}finally{active--;}
    });}});
  const first=service.run(f.request());let second;
  try{await within(entered.promise);second=service.run(f.request(1));await turn();assert.equal(connections,1);
    release.resolve();const results=await within(Promise.all([first,second]));assert.ok(results.every(result=>result.ok));assert.equal(maxActive,1);assert.equal(connections,2);
  }finally{release.resolve();await Promise.all([first,second]);await service.close();}
});

test('同账户主计划即使端点不同也串行',async()=>{
  const f=setup(['a']),entered=deferred(),release=deferred();let endpointIndex=0,connections=0,active=0,maxActive=0;
  const service=new BrowserBoostService({...f,dataRoot:f.root,sessionEndpoint:()=>'http://127.0.0.1:'+(22000+sequence*10+endpointIndex++),
    sessionFactory:async()=>{const ordinal=++connections;return session(async()=>{
      active++;maxActive=Math.max(maxActive,active);try{if(ordinal===1){entered.resolve();await release.promise;}return {read:{}};}finally{active--;}
    });}});
  const first=service.run(f.request());let second;
  try{await within(entered.promise);second=service.run(f.request());await turn();assert.equal(connections,1);
    release.resolve();const results=await within(Promise.all([first,second]));assert.ok(results.every(result=>result.ok));assert.equal(maxActive,1);
  }finally{release.resolve();await Promise.all([first,second]);await service.close();}
});

test('端点队列超时后不迟发；另一端点不受阻',async()=>{
  const f=setup(),endpoint=f.registry.bindings[0].cdp_endpoint,entered=deferred(),release=deferred();let connections=0;
  const held=withTargetWriteLock('browser-profile',endpoint,()=>{entered.resolve();return release.promise;});await entered.promise;
  const service=new BrowserBoostService({...f,dataRoot:f.root,totalMs:80,evidenceOrigin:'isolated_fixture'});
  installReadSession(service,async()=>{connections++;return {read:{}};});
  try{const waiting=service.run(f.request());const other=await within(service.run(f.request(1)));
    assert.equal(other.ok,true);const result=await within(waiting);assert.equal(result.code,'browser_queue_timeout');assert.equal(result.advertising_writes,0);assert.equal(connections,1);
    release.resolve();await held;await turn();await turn();assert.equal(connections,1,'expired request must not connect or prepare later');
  }finally{release.resolve();await held;await service.close();}
});

test('排队后登记文件变化不会换到未锁住的新端点',async()=>{
  const f=setup(['a']),endpoint=f.registry.bindings[0].cdp_endpoint,entered=deferred(),release=deferred();let seen;
  const held=withTargetWriteLock('browser-profile',endpoint,()=>{entered.resolve();return release.promise;});await entered.promise;
  const service=new BrowserBoostService({...f,dataRoot:f.root,evidenceOrigin:'isolated_fixture'});
  installReadSession(service,async(r,selected,actualEndpoint)=>{seen={endpoint:actualEndpoint,entryEndpoint:selected.entry.cdp_endpoint};return {read:{}};});
  let pending;
  try{pending=service.run(f.request());f.registry.bindings[0].cdp_endpoint='http://127.0.0.1:24001';fs.writeFileSync(f.bindingsFile,JSON.stringify(f.registry));
    release.resolve();await held;const result=await within(pending);assert.equal(result.ok,true);assert.deepEqual(seen,{endpoint,entryEndpoint:endpoint});
  }finally{release.resolve();await held;await pending;await service.close();}
});

test('正式连接忽略测试端点参数，仍拒绝错误账户与主计划绑定',async()=>{
  const f=setup(['a']);let connects=0,injected=0;
  const service=new BrowserBoostService({...f,dataRoot:f.root,sessionEndpoint:()=>{injected++;return 'http://127.0.0.1:24002';}});
  installReadSession(service,async()=>{connects++;return {read:{}};});
  try{const result=await service.run({...f.request(),primary_ad_id:'29999'});assert.equal(result.code,'playwright_binding_plan_mismatch');assert.equal(result.advertising_writes,0);assert.equal(connects,0);assert.equal(injected,0);}finally{await service.close();}
});
