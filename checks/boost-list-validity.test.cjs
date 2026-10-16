'use strict';
require('./setup-runtime.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const tabs = require('../server-app/server/lib/qianchuanTabs');
const cookie = require('../server-app/server/lib/cookie');
cookie.readQcCookie = ()=>'test-only';
cookie.isCookieProbablyValid = ()=>true;
let plans, boosts, detail;
tabs.fetchUniPromAdList = async()=>plans;
tabs.fetchBoostList = async()=>boosts;
tabs.fetchBoostSummary = async()=>({code:0,data:{}});
tabs.fetchBoostMaterialDetail = async()=>detail;
const listRoute = require('../server-app/server/routes/boostList');
const detailRoute = require('../server-app/server/routes/boostData');
async function request(route, suffix) {
  let payload, status;
  await route({method:'GET'}, {writeHead(code){status=code;},end(text){payload=JSON.parse(text);}},new URL('http://local/api/'+suffix));
  return {status,payload};
}

test('上游列表错误不能伪装零任务；不完整列表保留覆盖缺口',async()=>{
  plans={code:1,data:{adInfos:[]}};
  let r=await request(listRoute,'boost-list?account=accept_a');
  assert.equal(r.status,502); assert.equal(r.payload.ok,false); assert.equal(r.payload.data_valid,false);
  plans={code:0,data:{adInfos:[]},truncated:true};
  r=await request(listRoute,'boost-list?account=accept_a');
  assert.equal(r.payload.data_valid,false); assert.equal(r.payload.truncated,true);
  plans={code:0,data:{adInfos:[{id:'plan-a'}]}};
  boosts={code:1,data:{adInfos:[]}};
  r=await request(listRoute,'boost-list?account=accept_a');
  assert.equal(r.payload.data_valid,false); assert.equal(r.payload.truncated,true);
  r=await request(listRoute,'boost-list?account=accept_a&adId=plan-a');
  assert.equal(r.status,502); assert.equal(r.payload.ok,false);
});

test('隐藏成交不返回零单，真实零值保留，暂停及已完成任务仍按状态区分',async()=>{
  boosts={code:0,data:{adInfos:[{id:'1',adDeliveryName:'投放中'},{id:'2',adDeliveryName:'已暂停'},{id:'3',adDeliveryName:'已完成'}],adStatsMap:{'1':{metrics:{statCostForRoi2Assist:{value:0},totalPayOrderCountForRoi2Assist:{value:0,controlType:0}}}}}};
  const r=await request(listRoute,'boost-list?account=accept_a&adId=plan-a&includeAllStatus=1');
  assert.equal(r.payload.tasks[0].cost,0); assert.equal(r.payload.tasks[0].order_count,null);
  assert.deepEqual(r.payload.status_groups,[{status:'投放中',count:1},{status:'已暂停',count:1},{status:'已完成',count:1}]);
  assert.equal(r.payload.total_tasks,3); // total_tasks is deliberately all statuses, not active count.
});

test('空列表也携带来源时间，重读不伪造采集时间', async () => {
  const at = '2026-09-29T10:00:00Z';
  boosts = { code: 0, truncated: false, source_at: at, data: { adInfos: [] } };
  let r = await request(listRoute, 'boost-list?account=accept_a&adId=plan-a');
  assert.equal(r.payload.source_at, at); assert.equal(r.payload.total_tasks, 0);
  boosts.data.adInfos = [{ id: '1', adDeliveryName: '投放中' }];
  r = await request(listRoute, 'boost-list?account=accept_a&adId=plan-a');
  assert.equal(r.payload.tasks[0].source_at, at);
});

test('精简追投明细保留支付 ROI，并与净 ROI、隐藏订单分开',async()=>{
  const cells={total_prepay_and_pay_order_roi2_assist:{value:4.2},total_prepay_and_pay_settle_roi2_1h_assist:{value:3.1},total_pay_order_count_for_roi2_assist:{value:0,controlType:0},stat_cost_for_roi2_assist:{value:0}};
  detail={data:{StatsData:{Rows:[{Dimensions:{material_id:{Value:'m1'}},Metrics:cells}],Totals:cells}}};
  const r=await request(detailRoute,'boost-material-detail?account=accept_a&assistAid=1&slim=1');
  for(const m of [r.payload.data.materials[0],r.payload.data.totals]) {
    assert.equal(m.roi,4.2);assert.equal(m.net_roi,3.1);assert.equal(m.orders,null);assert.equal(m.cost,0);
    assert.equal(m.field_validity.roi,true);assert.equal(m.field_validity.orders,false);
  }
});
