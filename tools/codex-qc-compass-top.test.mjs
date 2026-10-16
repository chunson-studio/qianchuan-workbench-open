import {test} from 'node:test';
import assert from 'node:assert/strict';
import {filterCompassTop} from './codex-qc-compass-top.cua.mjs';
import {parseCompassTopFinancial} from './codex-qc-browser-data.mjs';

const sample=()=>({status:'read_verified',captured_at:'2026-10-09T07:16:32.024Z',
  binding:{room_id:'room-1',live_start_display:'2026/10/09 13:54',unneeded:'drop'},issues:[],
  financial_basis:'compass_gmv_minus_refund_over_shop_bound_cost',cost_label:'投放消耗(店铺绑定)',
  gmv:999999,net_roi:999999,url:'not-for-model',dom:'DO_NOT_RETURN',comments:['DO_NOT_RETURN'],
  cards:[{label:'直播间成交金额',value:1200,issue:null},{label:'退款金额',value:100,issue:null},
    {label:'投放消耗(店铺绑定)',value:100,issue:null},{label:'实时在线人数',value:32,issue:null},
    {label:'直播间成交金额（含异常交易）',value:9000,issue:null}]});

test('compact output uses exact primary cards and never leaks raw page or supplied ROI',()=>{
  const result=filterCompassTop(sample());
  assert.deepEqual(result.metrics,{gmv:1200,refund:100,cost:100,online:32,net_roi:11});
  assert.equal(result.quality.verified,true);
  assert.deepEqual(Object.keys(result),['scene','at','source','cost_basis','metrics','quality']);
  assert.doesNotMatch(JSON.stringify(result),/DO_NOT_RETURN|999999|9000|unneeded|not-for-model/);
});
test('unknown refund is not zero and irrelevant abnormal-sales failure does not erase valid inputs',()=>{
  const s=sample();s.cards.find(c=>c.label==='退款金额').value=null;
  assert.equal(filterCompassTop(s).metrics.net_roi,null);
  s.cards.find(c=>c.label==='退款金额').value=0;
  s.status='read_unverified';s.issues=['直播间成交金额（含异常交易）:value_unknown'];
  assert.equal(filterCompassTop(s).metrics.net_roi,12);
  assert.equal(filterCompassTop(s).quality.verified,true);
});
test('zero spend stays zero but ROI is unknown; duplicate primary GMV never falls back',()=>{
  const s=sample();s.cards.find(c=>c.label==='投放消耗(店铺绑定)').value=0;
  assert.equal(filterCompassTop(s).metrics.cost,0);assert.equal(filterCompassTop(s).metrics.net_roi,null);
  s.cards.push({label:'直播间成交金额',value:1200});
  assert.equal(filterCompassTop(s).metrics.gmv,null);
});
test('identity conflict, foreign source, invalid capture and malformed result retain blockers',()=>{
  for(const mutate of [s=>{s.issues=['compass_scene_header_mismatch'];},s=>{s.financial_basis='plan_day';},
    s=>{s.captured_at='invalid';},s=>{delete s.status;}]) {
    const s=sample();mutate(s);const out=filterCompassTop(s);
    assert.equal(out.quality.verified,false);assert.equal(out.metrics.gmv,null);assert.equal(out.metrics.net_roi,null);
    assert.ok(out.quality.issues.length);
  }
});

test('normalized financials recompute same-scene ROI, preserve zero and reject forged source/scene/time',()=>{
  const top=filterCompassTop(sample()),binding=sample().binding;
  top.metrics.net_roi=9999;
  const normalized=parseCompassTopFinancial({top,captured_at:top.at},binding);
  assert.deepEqual(normalized.issues,[]);assert.equal(normalized.board.net_roi,11);
  assert.equal(normalized.board.net_gmv,1100);
  for(const mutate of [x=>{x.scene.room_id='other';},x=>{x.source='plan_data';},x=>{x.at='invalid';}]){
    const next=structuredClone(top);mutate(next);
    const out=parseCompassTopFinancial({top:next,captured_at:top.at},binding);
    assert.equal(out.board.gmv,null);assert.equal(out.board.net_roi,null);assert.ok(out.issues.length);
  }
  top.metrics.refund=0;top.metrics.cost=0;
  const zero=parseCompassTopFinancial({top,captured_at:top.at},binding);
  assert.equal(zero.board.refund,0);assert.equal(zero.board.cost,0);assert.equal(zero.board.net_roi,null);
});
