'use strict';
require('./setup-runtime.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../server-app/server/lib/config');
config.QIANCHUAN_ACCOUNTS.push({id:'batch_test',aavid:'12345',cookieFile:'unused.txt'});
const qc = require('../server-app/server/lib/qianchuan');
const tabs = require('../server-app/server/lib/qianchuanTabs');
const cv = require('../server-app/server/lib/creativeVideoLibrary');
const log = require('../server-app/server/lib/operationLog');
let calls = 0;
const defaultDuration = 18000;
let requestedDuration = defaultDuration;
let listedDuration = 18000;
let ambiguousListedDuration;
qc.createBoostTask = async params => {
  assert.equal(params.budget,100);
  assert.equal(params.duration,requestedDuration);
  assert.deepEqual(params.mids,['1234567890']);
  return {code:0,data:{id:String(++calls)}};
};
tabs.fetchLiveStatus = async()=>({isLive:true});
tabs.fetchBoostList = async()=>({code:0,data:{adInfos:[{id:String(calls),budget:10000000,smartBidType:7,adDeliveryName:'投放中',
  ...(listedDuration === undefined ? {} : {duration_seconds:listedDuration}),
  ...(ambiguousListedDuration === undefined ? {} : {Duration:ambiguousListedDuration})}]}});
cv.getByMaterialId = async()=>({id:'1234567890'});
log.query = ()=>Array.from({length:100},()=>({action:'create_boost',success:true,ts:new Date().toISOString(),primary_ad_id:'123',params:{mids:['1234567890'],budget:100}}));
const handler = require('../server-app/server/routes/boostCreate');
async function create(duration) {
  if (arguments.length === 0) duration=defaultDuration;
  let output,status;
  requestedDuration=duration;
  const body={accountId:'batch_test',primaryAdId:'123',mids:['1234567890'],budget:100,smartBidType:7,source:'agent'};
  if(duration != null) body.duration=duration;
  const req={method:'POST',socket:{remoteAddress:'127.0.0.1'},headers:{},_qcJsonBodyPromise:Promise.resolve({data:body})};
  await handler(req,{writeHead(s){status=s;},end(t){output=JSON.parse(t);}},new URL('http://localhost/api/boost-create'));
  return {status,...output};
}
test('素材放量100元连续同参数创建可用；旧只读字段不替代参数及回读校验',async()=>{
  process.env.QC_TRIAL_READ_ONLY='1';
  process.env.QC_WARN_NO_AUTH='0';
  const missingDuration=await create(undefined);
  assert.equal(missingDuration.status,400);
  assert.equal(calls,0);
  for(let i=0;i<3;i++) {
    process.env.QC_TRIAL_READ_ONLY = i === 0 ? '1' : '0';
    const result=await create();
    assert.equal(result.ok,true,JSON.stringify(result));
    assert.equal(result.effect_status,'confirmed');
    assert.equal(result.task_id,String(i+1));
    assert.equal(result.requested.duration_seconds,18000);
    assert.equal(result.actual.duration_seconds,18000);
    assert.equal(result.actual.duration_unit,'seconds');
    assert.equal(result.actual.duration_source,'upstream.duration_seconds');
  }
  assert.equal(calls,3);
});

test('仅有未证实单位的上游 Duration 时保留 unknown 回执，不伪确认',async()=>{
  process.env.QC_TRIAL_READ_ONLY='0';
  process.env.QC_WARN_NO_AUTH='0';
  requestedDuration=1800;
  listedDuration=undefined;
  ambiguousListedDuration=1800;
  const result=await create(1800);
  assert.equal(result.ok,true);
  assert.equal(result.requested.duration_seconds,1800);
  assert.equal(result.actual.duration_seconds,null);
  assert.equal(result.actual.duration_unit,'unknown');
  assert.equal(result.actual.duration_source,null);
  assert.equal(result.effect_status,'unconfirmed');
  assert.equal(result.readback.verified,false);
  assert.ok(result.readback.mismatches.includes('duration_seconds'));
});
