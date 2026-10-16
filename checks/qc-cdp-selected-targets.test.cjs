'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createSelectedTargetSource,attachSelectedQianchuanPages}=require('../tools/qc-cdp-selected-targets.cjs');
function fixture(){const calls=[];const source={isConnected:()=>true,subscribe:()=>()=>{},send:async(method,params,sessionId)=>{calls.push({method,params,sessionId});return {};}};return {source,calls};}
test('root auto attachment excludes all pages; selected child sessions retain iframe and worker handling',async()=>{
  const {source,calls}=fixture(),scoped=createSelectedTargetSource(source,['test-page']);
  await scoped.send('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:true,flatten:true});
  assert.deepEqual(calls[0].params,{autoAttach:true,waitForDebuggerOnStart:false,flatten:true,filter:[{exclude:true}]});
  await scoped.send('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:true,flatten:true},'test-session');
  assert.deepEqual(calls[1].params.filter,[{type:'page',exclude:true},{}]);
  assert.equal(calls[1].sessionId,'test-session');
});
test('production page attachment and creating or closing browsers are rejected before dispatch',async()=>{
  const {source,calls}=fixture(),scoped=createSelectedTargetSource(source,['test-page']);
  for(const [method,params]of [['Target.attachToTarget',{targetId:'production'}],['Target.closeTarget',{targetId:'production'}],['Browser.close',{}],['Target.createTarget',{}],['Target.autoAttachRelated',{}]])await assert.rejects(scoped.send(method,params),{code:'cdp_selected_target_denied'});
  assert.equal(calls.length,0);
  await scoped.send('Target.attachToTarget',{targetId:'test-page',flatten:true});assert.equal(calls.length,1);
});
test('live attachment refuses any unexpected initial page, without touching page state',async()=>{
  const {source}=fixture();let closed=0;
  const chromium={connectOverCDP:async(transport,options)=>{assert.equal(options.noDefaults,true);return {contexts:()=>[{pages:()=>[{}]}],close:async()=>{closed++;}};}};
  await assert.rejects(attachSelectedQianchuanPages({source,targets:[{targetId:'test-page'}],chromium}),{code:'cdp_selected_target_denied'});
  assert.equal(closed,1);
});
