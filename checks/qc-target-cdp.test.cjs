'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {readQianchuanTargetCDP,connectQianchuanReadCDP}=require('../tools/read-qc-target-cdp.cjs');

function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qc-target-read-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const configFile=path.join(dir,'config.json'),markerPath=path.join(dir,'DevToolsActivePort');
  const binding={room:'test',advertiser_id:'123',primary_ad_id:'456',browser_context_id:'profile-a',target_id:'target-a'};
  const target={type:'page',targetId:'target-a',browserContextId:'profile-a',url:'https://qianchuan.jinritemai.com/overall-prom/detail?aavid=123&adId=456'};
  const raw={url:target.url,header_text:'ID：123\n计划ID：456\n',dates:['2026-10-15','2026-10-15'],filters:['a','b','调控中'],table_count:1,tables:[{rows:[['ID: 789']]}]};
  const config={markerPath,expectedPort:9222,timeoutMs:1000,runtimeFile:path.join(dir,'runtime.json'),bindings:[binding]};
  fs.writeFileSync(configFile,JSON.stringify(config));fs.writeFileSync(markerPath,'9222\n/devtools/browser/test-endpoint\n');
  const f={configFile,config,target,raw,calls:[],inventory:[target],connected:true,closed:0};
  f.connection={isConnected:()=>f.connected,close:()=>{f.closed++;},send:async(method,params,session)=>{
    f.calls.push({method,params,session});
    if(f.failure===method)throw Object.assign(new Error('timeout'),{code:'cdp_read_command_timeout'});
    if(method==='Browser.getVersion')return {product:'test-browser'};
    if(method==='Target.getTargets')return {targetInfos:f.inventory};
    if(method==='Target.attachToTarget')return {sessionId:'session-a'};
    if(method==='Runtime.evaluate')return {result:{value:f.raw}};
    if(method==='Target.getTargetInfo')return {targetInfo:f.after??f.target};
    if(method==='Target.detachFromTarget')return {};
    throw new Error('unexpected method');
  }};
  f.read=(extra={})=>readQianchuanTargetCDP({configFile,date:'2026-10-15',pool:'调控中',connection:f.connection,...extra});
  return f;
}
test('reuses one connection across reads and never auto-attaches all pages',async t=>{
  const f=fixture(t);
  for(let n=0;n<3;n++){const r=await f.read();assert.equal(r.ok,true);assert.equal(r.pool_verified,false);}
  assert.equal(f.closed,0);
  assert.equal(f.calls.filter(c=>c.method==='Target.attachToTarget').length,3);
  assert.ok(f.calls.every(c=>!['Page.reload','Target.setAutoAttach','Target.createTarget','Browser.close'].includes(c.method)));
});
test('missing or duplicate target returns failure before attaching, without closing shared connection',async t=>{
  const f=fixture(t);
  f.inventory=[];assert.equal((await f.read()).code,'cdp_read_target_missing');
  f.inventory=[f.target,{...f.target,targetId:'target-other'}];assert.equal((await f.read()).code,'cdp_read_target_not_unique');
  assert.equal(f.calls.some(c=>c.method==='Runtime.evaluate'),false);assert.equal(f.closed,0);
});
test('changed profile or target rejects without DOM reads',async t=>{
  for(const change of [{browserContextId:'other'},{targetId:'other'}]){
    const f=fixture(t);Object.assign(f.target,change);
    await assert.rejects(f.read(),{code:'cdp_read_binding_changed'});
    assert.equal(f.calls.some(c=>c.method==='Runtime.evaluate'),false);
  }
});
test('identity changes during capture and visible ID prefix collisions reject',async t=>{
  const f=fixture(t);f.after={...f.target,browserContextId:'different'};
  await assert.rejects(f.read(),{code:'cdp_read_identity_changed'});
  f.after=f.target;f.raw.header_text='ID：1234\n计划ID：4567\n';
  await assert.rejects(f.read(),{code:'cdp_read_visible_identity_mismatch'});
});
test('date, pool, table and navigation changes cannot pass as control reads',async t=>{
  const cases=[['dates',['2026-10-14','2026-10-14'],'cdp_read_view_mismatch'],['filters',[],'cdp_read_view_mismatch'],['table_count',0,'cdp_read_table_not_unique'],['url','https://qianchuan.jinritemai.com/overall-prom/detail?aavid=123&adId=456#changed','cdp_read_view_changed']];
  for(const [key,value,code]of cases){const f=fixture(t);f.raw[key]=value;await assert.rejects(f.read(),{code});}
});
test('page snapshots are explicit and never claim verified pool coverage',async t=>{
  const f=fixture(t);f.raw.filters=[];f.raw.table_count=0;
  const r=await f.read({scope:'page'});assert.equal(r.ok,true);assert.equal(r.scope,'page');assert.equal(r.pool_verified,false);
});
test('timeout detaches only this target; another concurrent read can finish',async t=>{
  const f=fixture(t),g=fixture(t);f.failure='Runtime.evaluate';
  const r=await Promise.allSettled([f.read(),g.read()]);
  assert.equal(r[0].reason.code,'cdp_read_command_timeout');assert.equal(r[1].value.ok,true);
  assert.equal(f.calls.at(-1).method,'Target.detachFromTarget');assert.equal(f.closed,0);
});
test('disconnected connection cannot trigger automatic reconnection',async t=>{
  const f=fixture(t);f.connected=false;
  await assert.rejects(f.read(),{code:'cdp_read_connection_invalid'});assert.equal(f.calls.length,0);
});
test('transport keeps one socket, correlates responses and fails promptly on disconnect',async t=>{
  const f=fixture(t);let sockets=0,socket;
  class FakeSocket extends EventTarget{
    constructor(){super();sockets++;socket=this;this.readyState=0;queueMicrotask(()=>{this.readyState=1;this.dispatchEvent(new Event('open'));});}
    send(value){const m=JSON.parse(value);if(m.method==='hang')return;queueMicrotask(()=>this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({id:m.id,result:{method:m.method}})})));}
    close(){this.readyState=3;this.dispatchEvent(new Event('close'));}
  }
  const c=await connectQianchuanReadCDP({configFile:f.configFile,timeoutMs:1000},{WebSocket:FakeSocket});
  const events=[],closed=[];
  const unsubscribe=c.subscribe(e=>events.push(e),reason=>closed.push(reason));
  socket.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({method:'Target.attachedToTarget',params:{sessionId:'selected'}})}));
  assert.equal(events.length,1);assert.equal(events[0].params.sessionId,'selected');
  unsubscribe();
  socket.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({method:'Target.detachedFromTarget',params:{}})}));
  assert.equal(events.length,1);
  c.subscribe(e=>events.push(e),reason=>closed.push(reason));
  assert.deepEqual(await Promise.all([c.send('first'),c.send('second')]),[{method:'first'},{method:'second'}]);
  assert.equal(sockets,1);const pending=c.send('hang');socket.close();
  await assert.rejects(pending,{code:'cdp_read_disconnected'});assert.equal(c.isConnected(),false);
  assert.deepEqual(closed,['cdp_read_disconnected']);
  await assert.rejects(c.send('again'),{code:'cdp_read_disconnected'});assert.equal(sockets,1);
});
