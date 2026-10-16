import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseFinancialDom} from './codex-qc-browser-data.mjs';

// Structure from saved 2026-10-08 financial snapshots. All identities/values are synthetic;
// private-runtime/audits/report-format-20261008/financial-replay-input.json retains originals.
const binding={advertiser_id:'101',primary_ad_id:'201',room_id:'301',date:'2026-10-08',session_started_at:'2026-10-08T09:00:00+08:00'};
const decimal=(label,value,important=false)=>`- generic: ${label}\n${important?'- generic: 重要\n':''}- generic: "${value.split('.')[0]}"\n- generic: .\n- text: "${value.split('.')[1]}"\n- generic: "--"`;
function snapshot({placeholders=false}={}) {
  return {captured_at:'2026-10-08T02:30:00Z',url:'https://qianchuan.jinritemai.com/overall-prom/detail?aavid=101&adId=201',dom:[
    '- generic: ID：101','- generic: 计划ID：201','- generic: 综合营销ROI目标：','- generic: "10.00"',
    '- textbox "开始日期": 2026-10-08','- textbox "结束日期": 2026-10-08','- tab "数据" [selected]',
    '- generic: 重点数据概览','- generic: 综合营销ROI',`- generic: ${placeholders?'"-"':'4.00 --'}`,
    '- generic: 净成交金额(元)',`- generic: ${placeholders?'"-"':'200.00 --'}`,
    '- generic: 综合成本(元)',`- generic: ${placeholders?'"-"':'50.00 --'}`,
    '- heading "数据概览" [level=3]','- button:','- generic: 成交与回报',
    decimal('综合营销ROI','4.00',true),decimal('净成交金额(元)','200.00',true),decimal('整体成交金额(元)','250.00'),
    '- generic: 支出与成本',decimal('综合成本(元)','50.00',true),decimal('整体消耗(元)','40.00'),
    '- generic: 趋势对比','- button "综合营销ROI":','  - generic: 综合营销ROI',
    '- generic: 详细数据','- table:',decimal('整体成交金额(元)','999.00')
  ].join('\n')};
}
const read=s=>parseFinancialDom(s,'plan_data',binding);
test('bound native overview supplies gross sales independently of net sales and cost',()=>{
  const r=read(snapshot());assert.deepEqual(r.issues,[]);
  assert.deepEqual([r.board.cost,r.board.net_roi,r.board.net_gmv,r.board.gmv,r.board.overall_cost],[50,4,200,250,40]);
  assert.equal(r.board.source_sections.gmv,'数据概览');assert.equal(r.board.source_fields.gmv,'整体成交金额(元)');
});
test('three primary placeholders fall back to same-snapshot verified overview cards',()=>{
  const r=read(snapshot({placeholders:true}));assert.deepEqual(r.issues,[]);
  assert.deepEqual([r.board.cost,r.board.net_roi,r.board.net_gmv,r.board.gmv],[50,4,200,250]);
  for(const field of ['cost','net_roi','net_gmv','gmv'])assert.equal(r.board.source_sections[field],'数据概览');
});
for(const [name,mutate] of [
  ['wrong account',s=>s.replace('ID：101','ID：999')],
  ['wrong plan',s=>s.replace('计划ID：201','计划ID：999')],
  ['wrong date',s=>s.replace('开始日期": 2026-10-08','开始日期": 2026-10-07')],
  ['wrong tab',s=>s.replace('tab "数据" [selected]','tab "调控" [selected]')],
  ['wrong product',s=>s.replace('综合营销ROI目标：','净成交ROI目标：')],
  ['loading',s=>s+'\n- generic: 加载中'],
  ['missing boundary',s=>s.replace('- generic: 趋势对比','- generic: 未知区域')],
  ['duplicate overview',s=>s+'\n- heading "数据概览" [level=3]'],
  ['table inside overview',s=>s.replace('- generic: 成交与回报','- table:\n- generic: 成交与回报')],
  ['duplicate core card',s=>s.replace('- generic: 支出与成本',decimal('综合营销ROI','3.00')+'\n- generic: 支出与成本')],
  ['incomplete overview',s=>s.replace(decimal('综合成本(元)','50.00',true),'')],
  ['extra animated digits',s=>s.replace('- generic: "4"\n- generic: .','- generic: "4"\n- generic: "9"\n- generic: .')],
  ['extra fractional digits',s=>s.replace('- text: "00"\n- generic: "--"','- text: "00"\n- text: "99"\n- generic: "--"')],
  ['missing comparison',s=>s.replace('- text: "00"\n- generic: "--"','- text: "00"')],
])test('overview cannot bypass uncertain source: '+name,()=>{
  const s=snapshot({placeholders:true});s.dom=mutate(s.dom);
  const r=read(s);assert.equal(r.board.gmv,null);assert.equal(r.board.net_roi,null);
});
test('wrong bound URL cannot provide secondary metrics',()=>{
  const s=snapshot({placeholders:true});s.url=s.url.replace('adId=201','adId=999');assert.equal(read(s).board.gmv,null);
});
test('duplicate or malformed primary card is not hidden by valid secondary data',()=>{
  for(const replacement of ['- generic: "4"\n- generic: "2"','- generic: "4.00"\n- generic: 综合营销ROI\n- generic: "4.00"']) {
    const s=snapshot();s.dom=s.dom.replace('- generic: 4.00 --',replacement);assert.equal(read(s).board.net_roi,null);
  }
});
test('disagreement with valid primary retains an explicit conflict',()=>{
  const s=snapshot();s.dom=s.dom.replace('- generic: 4.00 --','- generic: 8.00 --');
  const r=read(s);assert.equal(r.board.net_roi,null);assert.ok(r.issues.includes('financial_net_roi_overview_conflict'));
});
test('bad or duplicate sales card never uses net amount or table values',()=>{
  for(const replace of [decimal('整体成交金额(元)','250.00')+'\n'+decimal('整体成交金额(元)','300.00'),'- generic: 整体成交金额(元)\n- generic: "-"']) {
    const s=snapshot();s.dom=s.dom.replace(decimal('整体成交金额(元)','250.00'),replace);
    const r=read(s);assert.equal(r.board.gmv,null);assert.equal(r.board.net_gmv,200);
  }
});
test('native zero and thousands separators retain their original values',()=>{
  for(const [raw,expected] of [['0.00',0],['1,234.56',1234.56]]){
    const s=snapshot();s.dom=s.dom.replace(decimal('整体成交金额(元)','250.00'),decimal('整体成交金额(元)',raw));assert.equal(read(s).board.gmv,expected);
  }
});
