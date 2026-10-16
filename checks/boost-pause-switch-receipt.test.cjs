'use strict';
require('./setup-runtime.cjs');
const test = require('node:test'), assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const https = require('node:https');
// Synthetic readers and transport only. No production account, cookie or service.
const cookie = require('../server-app/server/lib/cookie');
cookie.readQcCookie = () => 'synthetic-only';
cookie.resolveAavid = () => '123';
cookie.getCsrf = () => '';
const api = require('../server-app/server/lib/qianchuan');
const wireStatus = api.updateCampaignStatus;
const tabs = require('../server-app/server/lib/qianchuanTabs');
const opLog = require('../server-app/server/lib/operationLog');
const owner = require('../server-app/server/lib/boostExecutionOwner');
require('../server-app/server/lib/api-helpers').validateAccount = () => {};
require('../server-app/server/lib/actionLimits').safeActionLimits = () => ({});
let before, after, writes, reads, ownerChecks, ownerError, result, savedReceipt;
tabs.fetchBoostList = async () => { reads++; return { data: { adInfos: [writes ? after : before] } }; };
api.updateCampaignStatus = async (plan,id,status,account) => {
  assert.deepEqual([plan,id,status,account],['88','77',2,'pause-fixture']);writes++;return result;
};
owner.assertBoostExecutionOwner = () => { ownerChecks++;if(ownerError)throw ownerError; };
opLog.log = () => 41;opLog.attachReceipt = (id,r) => { savedReceipt=r; };
opLog.getById = () => ({ params:{receipt:savedReceipt} });
require.cache[require.resolve('../server-app/server/routes/liveDashboard')] = { exports:{invalidatePlanCache(){}} };
const { boostStatus, normalizedTarget } = require('../server-app/server/lib/writeReceipt');
const { handleCampaignStatus } = require('../server-app/server/routes/campaignOps');
const row = patch => ({id:'77',status:2,adDeliveryName:'关联直播间未开播',...patch});
function reset() {
  before=row();after=row({adDeliveryName:'已暂停'});writes=reads=ownerChecks=0;ownerError=null;savedReceipt=null;
  result={status_code:0,data:{results:[{flag:true,object:{objectId:'77',type:1}}]}};
}
async function request() {
  const req=new PassThrough();req.method='POST';req.headers={'content-type':'application/json'};
  req.socket={remoteAddress:'127.0.0.1'};
  req.end(JSON.stringify({accountId:'pause-fixture',primaryAdId:'88',assistTaskId:'77',status:2,source:'agent'}));
  let payload,http;
  await handleCampaignStatus(req,{writeHead(s){http=s;},end(s){payload=JSON.parse(s);}},new URL('http://offline/api/campaign/status'));
  return {http,...payload};
}
test('raw status 2 is not proof of manual pause; only the observed exact paused label proves it',()=>{
  assert.equal(boostStatus(row()),2); // Capacity semantics stay unchanged.
  for(const task of [row(),{status:2},{status:2,adDeliveryName:'投放中'},{adDeliveryName:'暂停中'},{adDeliveryName:'暂停投放'}])
    assert.equal(normalizedTarget(task).status,null,JSON.stringify(task));
  assert.equal(normalizedTarget(row({adDeliveryName:'已暂停'})).status,2);
  assert.equal(normalizedTarget({adDeliveryName:'已暂停'}).status,2);
  assert.equal(normalizedTarget({status:2},true).status,2);
});
test('system paused task submits one exact pause and confirms only the manual paused readback',async()=>{
  for(const status of [2,1,undefined]) {
    reset();before=row({status});const receipt=await request();
    assert.equal(writes,1);assert.equal(ownerChecks,2);assert.equal(reads,2);
    assert.equal(receipt.effect_status,'confirmed');assert.equal(receipt.readback.verified,true);
    assert.equal(receipt.actual.status,2);assert.equal(receipt.retry_write,false);
  }
});
test('accepted pause with unchanged system pause stays unconfirmed, never unchanged/manual-off',async()=>{
  reset();after=row();const receipt=await request();
  assert.equal(writes,1);assert.equal(receipt.effect_status,'unconfirmed');assert.equal(receipt.readback.verified,false);
  assert.equal(receipt.actual.status,null);assert.equal(receipt.retry_write,false);
});
test('only already manual-paused task can return verified unchanged with zero writes',async()=>{
  reset();before=row({adDeliveryName:'已暂停'});const receipt=await request();
  assert.equal(writes,0);assert.equal(receipt.effect_status,'unchanged');assert.equal(receipt.readback.verified,true);
  assert.equal(receipt.advertising_writes,0);assert.equal(receipt.upstream_accepted,false);
});
test('unknown status, upstream action denial and owner conflict still block before submission',async()=>{
  for(const scenario of ['unknown','editable','owner']) {
    reset();
    if(scenario==='unknown')before={id:'77',status:2};
    if(scenario==='editable')before.assistTaskInfoMap={'2':{operation:{pause:{editable:false}}}};
    if(scenario==='owner')ownerError=Object.assign(new Error('execution_owner_conflict'),{statusCode:423,code:'execution_owner_conflict'});
    const receipt=await request();assert.equal(writes,0,scenario);assert.equal(receipt.ok,false,scenario);
    assert.notEqual(receipt.readback?.verified,true,scenario);
  }
});
test('outer code 0 with missing/false/wrong/duplicate object flag cannot confirm even with a paused readback',async()=>{
  for(const results of [undefined,[],[{flag:false,object:{objectId:'77',type:1}}],[{object:{objectId:'77',type:1}}],
    [{flag:true,object:{objectId:'78',type:1}}],[{flag:true,object:{objectId:'77',type:2}}],
    [{flag:true,object:{objectId:'77',type:1}},{flag:true,object:{objectId:'77',type:1}}]]) {
    reset();result={status_code:0,data:{results}};const receipt=await request();
    assert.equal(writes,1);assert.equal(receipt.effect_status,'unconfirmed');assert.equal(receipt.readback.verified,false);
    assert.equal(receipt.readback.reason,'pause_target_result_unconfirmed');assert.equal(receipt.retry_write,false);
  }
});
test('upstream rejected pause is not confirmed and does not read back or retry',async()=>{
  reset();result={status_code:1};const receipt=await request();
  assert.equal(writes,1);assert.equal(reads,1);assert.equal(receipt.effect_status,'rejected');assert.equal(receipt.readback.verified,false);
});
test('pause wire body follows real OptType/Objects packet; other status actions keep their existing keys',async()=>{
  const captured=[],original=https.request;
  https.request=(options,onResponse)=>{
    const req=new EventEmitter();let body='';req.setTimeout=()=>req;req.write=chunk=>{body+=chunk;};req.destroy=()=>{};
    req.end=()=>queueMicrotask(()=>{
      captured.push({path:options.path.split('?')[0],method:options.method,body:JSON.parse(body)});
      const res=new EventEmitter();res.statusCode=200;res.setEncoding=()=>{};onResponse(res);
      res.emit('data',JSON.stringify({status_code:0,data:{results:[{flag:true,object:{objectId:'77',type:1}}]}}));res.emit('end');
    });return req;
  };
  try {
    for(const status of [2,1,6])await wireStatus('88','77',status,'pause-fixture');
    assert.deepEqual(captured[0],{path:'/ad/api/pmc/v1/batch_update_operation',method:'POST',body:{OptType:2,Objects:[{objectID:'77',type:1}]}});
    for(let i=1;i<3;i++)assert.deepEqual(captured[i].body,{optType:i===1?1:6,objects:[{objectID:'77',type:1}]});
  } finally { https.request=original; }
});
