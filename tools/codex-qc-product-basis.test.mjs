import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parsePlanProductBasis,reduceBrowserCapture} from './codex-qc-browser-data.mjs';

const binding={advertiser_id:'60000000',primary_ad_id:'60000001',room_id:'60000030',
  date:'2026-10-07',session_started_at:'2026-10-07T19:37:00+08:00',live_start_display:'2026/10/07 19:37',live_name:'测试直播间'};
const at='2026-10-07T12:00:00Z';
const layouts={multiplication:{title:'千川乘方',target:'综合营销ROI目标',path:'/overall-prom/detail',mode:'乘方数据',basis:'platform_综合成本_综合营销ROI'},
  full_domain:{title:'全域投放',target:'净成交ROI目标',path:'/uni-prom/detail',mode:'全域净成交数据',basis:'platform_整体消耗_净成交ROI'}};
const url=type=>`https://qianchuan.jinritemai.com${layouts[type].path}?aavid=${binding.advertiser_id}&adId=${binding.primary_ad_id}`;
const headers=['任务名称','调控状态','调控消耗','调控成交订单数','调控支付ROI','调控预算(元)','调控时长(小时)'];
// Redacted main-card field layouts: both product names also occur in navigation.
// Identities, amounts and dates are synthetic; the ROI target is not a result.
function plan(type='multiplication',pool='调控中') {
  return {url:url(type),captured_at:at,page:1,rows:[],dom:`- generic: 首页
- generic: 乘方
- generic: 全域投放
- button "数据":
  - generic: 数据
- generic "测试账户": ID：${binding.advertiser_id}
- generic: ${layouts[type].title}
- generic: 标准投放
- textbox "请选择开始日期": ${binding.date}
- textbox "请选择结束日期": ${binding.date}
- generic: 推直播间
- generic: ${binding.live_name}
- generic: 投放中
- generic: 计划ID：${binding.primary_ad_id}
- generic: 投放方式： 控成本
- generic: 预算(元)：
- generic: 每日1,000.00
- generic: ${layouts[type].target}：
- generic: "999.99"
- button "升级乘方":
  - text: 升级乘方
- tab "数据"
- tab "调控" [selected]
- textbox "请选择"
- textbox "请选择"
- textbox "请选择": ${pool}
- textbox "输入任务名称或ID搜索"
- table:
  - rowgroup:
    - row "表头":
${headers.map(h=>'      - columnheader "'+h+'":').join('\n')}
- generic: 共 0 条记录
- generic: 暂无数据
- listitem: "1"`};
}
function board(type='multiplication') {
  const net=type==='full_domain';
  return {captured_at:at,dom:`- paragraph: ${binding.live_name}
- paragraph: 开播时间：2026-10-07 19:37:22
- generic: ${net?'整体消耗':'综合成本'}(元)
- paragraph: "120"
- generic: ${net?'净成交ROI':'综合营销ROI'}
- paragraph: "2.40"
- generic: 净成交金额(元)
- paragraph: "288"
- textbox "请选择": ${layouts[type].mode}
- button "整体趋势"
- generic: 综合营销ROI
- paragraph: "88"`};
}
const capture=(type='multiplication')=>({binding,financial_source:'qianchuan_board',financial:board(type),
  compass:{captured_at:at,dom:`- generic: ${binding.live_name}\n- generic: 开播时间2026/10/07 19:37开播，已开播23分钟\n- generic: 直播间成交金额`},
  active:[plan(type)],paused:[plan(type,'手动暂停')],finished_at:at});
const reduce=c=>reduceBrowserCapture(c,{max_age_seconds:120});
const codes=out=>out.brief.quality.issues.map(i=>i.code);
function removeTarget(p,type) {p.dom=p.dom.replace(`- generic: ${layouts[type].target}：\n- generic: "999.99"\n`,'');return p;}

for(const type of Object.keys(layouts)) {
  test(`${type}: observed main-card ROI label identifies product and agrees with selected board basis`,()=>{
    const raw=capture(type),original=JSON.stringify(raw),out=reduce(raw),meta=out.current.product_basis;
    assert.equal(meta.type,type);assert.equal(meta.status,'matched');assert.equal(meta.expected_metric_basis,layouts[type].basis);
    assert.deepEqual(out.brief.board.source_fields.product_basis,meta);
    assert.deepEqual(codes(out),[]);assert.equal(out.brief.quality.write_ready,true);
    assert.deepEqual([out.brief.board.cost,out.brief.board.net_roi,out.brief.board.net_gmv],[120,2.4,288]);
    assert.equal(JSON.stringify(raw),original);
  });
  test(`${type}: target value is neither inspected nor used as actual ROI`,()=>{
    const p=plan(type),before=parsePlanProductBasis(p,binding);
    p.dom=p.dom.replace('"999.99"','"尚未设置"');assert.deepEqual(parsePlanProductBasis(p,binding),before);
    const raw=capture(type);raw.active[0]=p;
    assert.equal(reduce(raw).brief.board.net_roi,2.4);
    assert.equal(JSON.stringify(reduce(raw).current.product_basis).includes('999.99'),false);
  });
  test(`${type}: navigation target-like text preceding the main card cannot override it`,()=>{
    const p=plan(type),other=type==='multiplication'?'full_domain':'multiplication';
    p.dom=`- generic: ${layouts[other].target}\n`+p.dom;
    assert.equal(parsePlanProductBasis(p,binding).type,type);
  });
  test(`${type}: URL conflict blocks writes but never changes the observed type or financial values`,()=>{
    const raw=capture(type),other=type==='multiplication'?'full_domain':'multiplication';
    raw.active[0].url=url(other);
    const out=reduce(raw);assert.equal(out.current.product_basis.type,type);
    assert.ok(codes(out).includes('plan_product_url_conflict'));assert.equal(out.brief.quality.write_ready,false);
    assert.equal(out.brief.board.net_roi,2.4);
  });
  test(`${type}: plan/board basis conflict blocks writes`,()=>{
    const raw=capture(type);raw.financial=board(type==='multiplication'?'full_domain':'multiplication');
    const out=reduce(raw);assert.equal(out.current.product_basis.status,'conflict');
    assert.ok(codes(out).includes('product_financial_basis_conflict'));assert.equal(out.brief.quality.write_ready,false);
    assert.equal(out.brief.board.net_roi,2.4);
  });
}
test('navigation product names and URL alone leave product unknown',()=>{
  for(const type of Object.keys(layouts)) {
    const p=removeTarget(plan(type),type),out=parsePlanProductBasis(p,binding);
    assert.equal(out.type,null);assert.equal(out.expected_metric_basis,null);assert.equal(out.roi_target_field,null);
    assert.deepEqual(out.issues,[]);
  }
});
test('old capture without main-card or URL evidence retains independently parsed finances and explicitly skips cross-check',()=>{
  const raw=capture('full_domain');for(const p of [...raw.active,...raw.paused]){removeTarget(p,'full_domain');delete p.url;}
  const out=reduce(raw);
  assert.equal(out.current.product_basis.type,null);assert.equal(out.current.product_basis.status,'financial_only');
  assert.equal(out.current.product_basis.expected_metric_basis,null);
  assert.equal(out.brief.board.metric_basis,layouts.full_domain.basis);assert.equal(out.brief.board.net_roi,2.4);
  assert.equal(codes(out).some(code=>/product/.test(code)),false);
});
test('unknown main card and unknown financial selection cannot manufacture a multiplication basis',()=>{
  const raw=capture();for(const p of [...raw.active,...raw.paused])removeTarget(p,'multiplication');
  raw.financial.dom=raw.financial.dom.replace('textbox "请选择": 乘方数据','textbox "请选择": 未知模式');
  const out=reduce(raw);assert.equal(out.current.product_basis.type,null);assert.equal(out.current.product_basis.status,'unknown');
  assert.equal(out.brief.board.metric_basis,null);assert.equal(out.brief.board.net_roi,null);assert.equal(out.brief.quality.write_ready,false);
});
test('column headers and their generic children cannot supply the main-card label',()=>{
  for(const role of ['table:','row "假字段":','columnheader "净成交ROI目标":']) {
    const p=removeTarget(plan('full_domain'),'full_domain');
    p.dom=p.dom.split('- tab "数据"')[0]+`- ${role}\n  - generic: 净成交ROI目标\n  - generic: "15"`;
    assert.equal(parsePlanProductBasis(p,binding).type,null);
  }
});
test('labels below plan tabs or in financial content are not main-card evidence',()=>{
  const p=removeTarget(plan(),'multiplication');p.dom=p.dom.replace('- tab "调控" [selected]','- tab "调控" [selected]\n- generic: 综合营销ROI目标');
  assert.equal(parsePlanProductBasis(p,binding).type,null);
  p.dom=p.dom.replace('- tab "数据"','- generic: 数据');assert.equal(parsePlanProductBasis(p,binding).type,null);
});
test('incorrect account and plan bindings cannot identify product',()=>{
  for(const id of [binding.advertiser_id,binding.primary_ad_id]) {
    const raw=capture();raw.active[0].dom=raw.active[0].dom.replaceAll(id,'60000046');
    assert.equal(parsePlanProductBasis(raw.active[0],binding).type,null);
    assert.equal(reduce(raw).brief.quality.write_ready,false);
  }
});
test('observed responsive account identity can independently validate the main card',()=>{
  const p=plan('full_domain');p.dom=p.dom.replace(`- generic "测试账户": ID：${binding.advertiser_id}\n`,'');
  assert.equal(parsePlanProductBasis(p,binding).type,null);
  p.account_dom={selector:'.account-info-box',display:'none',text:'测试账户 ID：'+binding.advertiser_id};
  assert.equal(parsePlanProductBasis(p,binding).type,'full_domain');
});
test('two conflicting or duplicated target fields on a main card are ambiguous',()=>{
  for(const target of ['净成交ROI目标','综合营销ROI目标']) {
    const raw=capture();raw.active[0].dom=raw.active[0].dom.replace('- tab "数据"',`- generic: ${target}\n- tab "数据"`);
    assert.equal(parsePlanProductBasis(raw.active[0],binding).type,null);
    const out=reduce(raw);assert.ok(codes(out).includes('plan_product_card_ambiguous'));assert.equal(out.brief.quality.write_ready,false);
  }
});
test('different pool pages reporting different products block cross-page consistency',()=>{
  const raw=capture();raw.paused=[plan('full_domain','手动暂停')];
  const out=reduce(raw);assert.equal(out.current.product_basis.type,null);assert.equal(out.current.product_basis.status,'conflict');
  assert.ok(codes(out).includes('plan_product_cross_page_conflict'));assert.equal(out.brief.quality.write_ready,false);
});
test('later pagination cannot override the first page product',()=>{
  const raw=capture();raw.active.push({...plan('full_domain'),page:2});
  const out=reduce(raw);assert.ok(codes(out).includes('plan_product_cross_page_conflict'));assert.equal(out.brief.quality.write_ready,false);
});
test('a plan-data observation with a different product also participates in cross-page verification',()=>{
  const raw=capture();raw.financial_source='plan_data';raw.financial=plan('full_domain');
  raw.financial.data_tab_verified=true;raw.financial.metric_cards=[{label:'整体消耗(元)',value:'120'},
    {label:'净成交ROI',value:'2.40'},{label:'净成交金额(元)',value:'288'}];
  const out=reduce(raw);assert.ok(codes(out).includes('plan_product_cross_page_conflict'));assert.equal(out.brief.quality.write_ready,false);
  assert.equal(out.brief.board.metric_basis,layouts.full_domain.basis);
});
test('known product with missing financial evidence remains unverified',()=>{
  const raw=capture();raw.financial.dom=raw.financial.dom.replace('"2.40"','"--"');
  const out=reduce(raw);assert.equal(out.current.product_basis.type,'multiplication');
  assert.equal(out.current.product_basis.status,'financial_unverified');assert.equal(out.brief.quality.write_ready,false);
});
for(const invalid of ['https://example.invalid/overall-prom/detail','not-a-url',
  'https://qianchuan.jinritemai.com/overall-prom/detail?aavid=999&adId='+binding.primary_ad_id]) {
  test('invalid or unbound plan URL blocks cross-check: '+invalid,()=>{
    const raw=capture();raw.active[0].url=invalid;
    const out=reduce(raw);assert.ok(codes(out).includes('plan_product_url_unverified'));assert.equal(out.brief.quality.write_ready,false);
  });
}
