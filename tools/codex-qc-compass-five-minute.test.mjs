import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCompassDom, reduceBrowserCapture } from './codex-qc-browser-data.mjs';

// Synthetic scene identity; card structure mirrors the saved partial AX / later
// native five-minute-panel observation. No browser or private files are read.
const binding = { advertiser_id:'60000000', primary_ad_id:'60000001',
  room_id:'60000030', date:'2026-10-07', session_started_at:'2026-10-07 19:37',
  live_start_display:'2026/10/07 19:37', live_name:'测试直播间' };
const at = '2026-10-07T11:46:05.000Z';
const header = `- generic: ${binding.live_name}
- generic: 开播时间2026/10/07 19:37开播，已开播9分钟
- generic: 直播间成交金额
- generic: 实时在线人数
- generic: "20"
- generic: 在线人数
- generic: "999"
- generic: 近5分钟用户支付金额
- generic: ¥888`;
const emptyPanel = `- generic: 近5分钟数据
- button "预警配置":
  - generic: 预警配置
- text: 实时看播用户画像
- generic: 直播间在线人数过少，无法展示画像
- text: 展开更多`;
const comments = '- generic: 实时评论\n- generic: 19:59更新\n- generic: 在线人数\n- generic: "777"';
const card = (metric,value,percent,direction='up') => ({metric,
  value_lines:[metric,value,`环比${percent === null ? '-' : percent+'%'}`], percent,
  direction:percent === null ? null : direction});
const snapshot = () => ({captured_at:at,dom:[header,emptyPanel,comments].join('\n'),
  comparison:{updated_at_text:'19:46',cards:[card('用户支付金额','¥0',null),
    card('在线人数','14',366.67),card('进入人数','147',241.86),card('离开人数','140',337.50)]}});
const parse = raw => parseCompassDom(raw,binding).five_minutes;
test('top facts are scoped separately from five-minute online and fail closed on scene mismatch',()=>{
 const raw=snapshot();raw.dom=raw.dom.replace('- generic: 直播间成交金额', '- generic: 直播间成交金额（含异常交易）\n- generic: ¥474\n- generic: 投放消耗(店铺绑定)\n- generic: ¥99.18');
 const scene=parseCompassDom(raw,binding);assert.equal(scene.live_top.gmv,474);assert.equal(scene.live_top.shop_bound_cost,99.18);
 assert.equal(scene.live_top.realtime_online,20);assert.equal(scene.five_minutes.online_snapshot,14);
 assert.equal(parseCompassDom({...raw,dom:raw.dom.replace(binding.live_name,'其他直播间')},binding).live_top,null);
});
const observed = five => [five.updated_at_text,five.online_snapshot,five.enters,five.leaves];
const absent = raw => assert.deepEqual(observed(parse(raw)),[null,null,null,null]);
const completePanel = `- generic: 近5分钟数据
- generic: 19:46更新
- generic: 用户支付金额
- generic: ¥0
- generic: 环比
- generic: "-"
- generic: 在线人数
- generic: "14"
- generic: 环比
- text: 366.67%
- generic: 进入人数
- generic: "147"
- generic: 环比
- text: 241.86%
- generic: 离开人数
- generic: "140"
- generic: 环比
- text: 337.50%`;

test('empty AX panel uses the same snapshot native panel: 19:46, 14/147/140, never realtime 20',()=>{
  const raw=snapshot(), before=JSON.stringify(raw), five=parse(raw);
  assert.deepEqual(observed(five),['19:46',14,147,140]);
  assert.equal(five.payment_gmv,0);
  assert.deepEqual(five.comparison.在线人数,{percent:366.67,direction:'up'});
  assert.equal(JSON.stringify(raw),before);
});
test('native fallback reaches brief.five through the production reducer',()=>{
  const {brief}=reduceBrowserCapture({binding,finished_at:at,compass:snapshot(),
    financial_source:'plan_data',financial:{dom:'',captured_at:at},active:[],paused:[]},
  {now:at,max_age_seconds:120});
  assert.deepEqual([brief.five.updated_at,brief.five.online_snapshot,brief.five.enter,brief.five.leave],['19:46',14,147,140]);
  assert.equal(brief.five.captured_at,at);
});
test('complete AX panel remains independently readable without native cards',()=>{
  const raw=snapshot();raw.dom=[header,completePanel,comments].join('\n');delete raw.comparison;
  assert.deepEqual(observed(parse(raw)),['19:46',14,147,140]);
  assert.equal(parse(raw).comparison.在线人数.direction,null);
});
test('19:50 empty capture remains unknown; a later populated DOM is a separate observation',()=>{
  const raw=snapshot();raw.comparison={updated_at_text:null,cards:[]};
  absent(raw);
  const later={dom:[header.replace('"20"','"42"'),completePanel.replace('19:46','19:50')
    .replace('¥0','¥236').replace('"14"','"28"').replace('"147"','"202"').replace('"140"','"174"'),comments].join('\n')};
  assert.deepEqual(observed(parse(later)),['19:50',28,202,174]);
  assert.equal(parse(later).payment_gmv,236);
  absent(raw);
});
test('native fallback accepts separate comparison lines and explicit zero',()=>{
  const raw=snapshot();Object.assign(raw.comparison.cards[1],{value_lines:['在线人数','0','环比','持平'],percent:null,direction:null});
  assert.equal(parse(raw).online_snapshot,0);
  assert.deepEqual(parse(raw).comparison.在线人数,{percent:null,direction:'flat'});
});
test('percent text alone cannot infer direction',()=>{
  const raw=snapshot();raw.comparison.cards[1].direction=null;
  assert.deepEqual(parse(raw).comparison.在线人数,{percent:366.67,direction:null});
});
test('complete AX values and time are not replaced by a later native window',()=>{
  const raw=snapshot();raw.dom=[header,completePanel,comments].join('\n');
  raw.comparison.updated_at_text='19:47';raw.comparison.cards[1].value_lines[1]='25';
  assert.deepEqual(observed(parse(raw)),['19:46',14,147,140]);
  assert.equal(parse(raw).comparison.在线人数.direction,null);
});
test('partial AX card or time is not mixed with native values from another observation',()=>{
  const raw=snapshot();raw.dom=raw.dom.replace(emptyPanel,emptyPanel+'\n- generic: 在线人数\n- generic: "12"');
  assert.deepEqual(observed(parse(raw)),[null,12,null,null]);
  raw.dom=snapshot().dom.replace(emptyPanel,emptyPanel+'\n- generic: 19:45更新');
  assert.deepEqual(observed(parse(raw)),['19:45',null,null,null]);
});

for(const [name,change] of [
  ['no native evidence',r=>delete r.comparison],
  ['missing update time',r=>r.comparison.updated_at_text=null],
  ['invalid update time',r=>r.comparison.updated_at_text='29:88'],
  ['missing native flow card',r=>r.comparison.cards.pop()],
  ['duplicate native card',r=>r.comparison.cards.push({...r.comparison.cards[1]})],
  ['wrong card value label',r=>r.comparison.cards[1].value_lines[0]='实时在线人数'],
  ['animated digits',r=>r.comparison.cards[1].value_lines=['在线人数','1','4','环比366.67%']],
  ['negative people',r=>r.comparison.cards[1].value_lines[1]='-14'],
  ['fractional people',r=>r.comparison.cards[1].value_lines[1]='14.5'],
  ['unknown value',r=>r.comparison.cards[1].value_lines[1]='--'],
  ['no comparison delimiter',r=>r.comparison.cards[1].value_lines[2]='366.67%'],
  ['no observed five-minute panel',r=>r.dom=[header,comments].join('\n')],
  ['unverified scene',r=>r.dom=r.dom.replace(binding.live_name,'其他直播间')],
]) test(`native fallback stays unknown: ${name}`,()=>{const raw=snapshot();change(raw);absent(raw);});
