'use strict';
require('./setup-runtime.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const tabs = require('../server-app/server/lib/qianchuanTabs');
const cookie = require('../server-app/server/lib/cookie');
cookie.readQcCookie = ()=>'test-only';
cookie.isCookieProbablyValid = ()=>true;
let boosts;
tabs.fetchBoostList = async()=>boosts;
tabs.fetchBoostSummary = async()=>({code:0,data:{}});
const listRoute = require('../server-app/server/routes/boostList');

async function requestList() {
  let payload;
  await listRoute({method:'GET'}, {writeHead(){},end(text){payload=JSON.parse(text);}},
    new URL('http://local/api/boost-list?account=duration_test&adId=plan-a&includeAllStatus=1'));
  return payload;
}

test('追投列表忽略单位不明的 Duration，只暴露有明确单位和来源的 duration_seconds',async()=>{
  boosts={code:0,data:{adInfos:[{id:'task-a',budget:10000000,smartBidType:7,adDeliveryName:'投放中',Duration:1800}]}};
  let result=await requestList();
  assert.equal(result.tasks[0].duration_seconds,null);
  assert.equal(result.tasks[0].duration_unit,'unknown');
  assert.equal(result.tasks[0].duration_source,null);

  boosts={code:0,data:{adInfos:[{id:'task-b',budget:10000000,smartBidType:7,adDeliveryName:'投放中',duration_seconds:18000}]}};
  result=await requestList();
  assert.equal(result.tasks[0].duration_seconds,18000);
  assert.equal(result.tasks[0].duration_unit,'seconds');
  assert.equal(result.tasks[0].duration_source,'upstream.duration_seconds');
});
