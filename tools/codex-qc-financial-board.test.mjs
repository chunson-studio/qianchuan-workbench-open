import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseFinancialDom} from './codex-qc-browser-data.mjs';

const binding={advertiser_id:'101',primary_ad_id:'201',room_id:'301',date:'2026-10-07',session_started_at:'2026-10-07T19:37:00+08:00',live_name:'测试直播间',live_start_display:'2026/10/07 19:37'};
const card=(label,value)=>`- generic: ${label}\n- paragraph: "${value}"\n- paragraph`;
const board=(mode='全域净成交数据')=>({captured_at:'2026-10-07T12:00:00Z',dom:[
  '- paragraph: 测试直播间','- paragraph: 直播中','- paragraph: 开播时间：2026-10-07 19:37:22',
  card('整体消耗(元)','85.11'),card('净成交ROI','4.16'),card('净成交金额(元)','354.00'),
  '- textbox "请选择": '+mode,'- button "整体趋势"',
  card('综合成本(元)','999'),card('综合营销ROI','99'),card('整体消耗(元)','888'),
  card('净成交ROI','88'),'- generic: 实时评论','- paragraph: 测试直播间 开播时间：2026-10-07 19:37:22'
].join('\n')});
const read=s=>parseFinancialDom(s,'qianchuan_board',binding);
test('bound full-domain live board reads net ROI and excludes the trend section',()=>{
  const r=read(board());assert.deepEqual(r.issues,[]);
  assert.deepEqual([r.board.cost,r.board.net_roi,r.board.net_gmv],[85.11,4.16,354]);
  assert.equal(r.board.metric_basis,'platform_整体消耗_净成交ROI');
  assert.deepEqual(r.board.data_window,{kind:'live_net_transaction',room_id:'301'});
  assert.equal(r.board.source_fields.net_roi,'净成交ROI');assert.equal(r.board.coupon_amount,null);
});
test('multiplication board preserves its own financial basis',()=>{
  const s=board('乘方数据');s.dom=s.dom.replace('整体消耗(元)','综合成本(元)').replace('净成交ROI','综合营销ROI');
  const r=read(s);assert.deepEqual(r.issues,[]);assert.equal(r.board.cost,85.11);
  assert.equal(r.board.metric_basis,'platform_综合成本_综合营销ROI');assert.equal(r.board.data_window.kind,'live_multiplication');
});
for(const mode of ['全域支付数据','请选择','乘方数据恶意后缀','全域净成交数据\n- textbox "请选择": 乘方数据'])test('unknown or conflicting basis is not inferred: '+mode,()=>{
  const r=read(board(mode));assert.ok(r.issues.includes('financial_basis_unverified'));
  assert.deepEqual([r.board.cost,r.board.net_roi,r.board.net_gmv],[null,null,null]);assert.equal(r.board.metric_basis,null);
});
for(const [label,field] of [['整体消耗(元)','cost'],['净成交ROI','net_roi'],['净成交金额(元)','net_gmv']]){
  test('duplicate top financial card stays unknown: '+field,()=>{
    const s=board();s.dom=s.dom.replace('- button "整体趋势"',card(label,'123')+'\n- button "整体趋势"');
    assert.equal(read(s).board[field],null);
  });
  test('unavailable top card does not borrow chart: '+field,()=>{
    const s=board();s.dom=s.dom.replace(new RegExp('(- generic: '+label.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\n- paragraph: )"[^"]+"'),'$1"--"');
    assert.equal(read(s).board[field],null);assert.ok(read(s).issues.includes('financial_'+field+'_unknown'));
  });
}
test('other scene cannot be validated by matching comment text',()=>{
  const s=board();s.dom=s.dom.replace('- paragraph: 测试直播间','- paragraph: 另一直播间').replace('- paragraph: 开播时间：2026-10-07 19:37:22','- paragraph: 开播时间：2026-10-07 09:37:22');
  assert.ok(read(s).issues.includes('financial_scene_unverified'));
});
test('missing selected mode cannot borrow its name from a trend legend',()=>{
  const s=board();s.dom=s.dom.replace('- textbox "请选择": 全域净成交数据','- generic: 全域净成交数据');
  assert.ok(read(s).issues.includes('financial_basis_unverified'));
});
