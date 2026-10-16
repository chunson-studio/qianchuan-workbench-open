'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {readQianchuanExtensionProbe:read,checkQianchuanExtensionWave:wave,readQianchuanExtensionAxSnapshot:ax,refreshQianchuanExtensionTable:refresh}=require('../tools/check-qc-extension-parallel.cua.cjs');
const headers=['','任务名称','调控状态','调控预算(元)','调控时长(小时)','调控消耗','调控支付ROI','调控成交订单数'];
function fixture({account='11',loading=false,total=1,ids=['101'],status='调控中',roi='调控支付ROI'}={}) {
  let rowReads=0;
  const dom=`- generic: ID：${account}\n- generic: 计划ID：22\n- textbox "开始日期": 2026-10-15\n- textbox "结束日期": 2026-10-15\n- tab "调控" [active] [selected]\n- textbox "请选择"\n- textbox "请选择"\n- textbox "请选择": 调控中\n- textbox "输入任务名称或ID搜索"\n${loading?'- generic: 加载中...\n':''}- table:\n  - columnheader "共${total}条任务"\n${total?'- generic: 共 '+total+' 条记录':'- generic: 哎呀, 暂无数据'}`;
  const tab={id:'33',url:async()=> 'https://qianchuan.jinritemai.com/overall-prom/detail?aavid=11&adId=22',
    playwright:{domSnapshot:async()=>dom,getByRole:()=>({evaluateAll:async()=>{rowReads++;return [
      {headers:headers.map(h=>h==='调控支付ROI'?roi:h),cells:[]},
      ...ids.map(id=>({headers:[],cells:['','默认名称 ID: '+id,status,'100','10','1','9','1']}))
    ];}})}};
  return {binding:{room:'fixture',browser_id:'4',tab,advertiser_id:'11',primary_ad_id:'22',date:'2026-10-15',pool:'调控中'},rowReads:()=>rowReads};
}
test('visible account conflict stops before task reads',async()=>{
  const f=fixture({account:'99'}),r=await read(f.binding);
  assert.equal(r.error,'visible_identity_unverified');assert.equal(f.rowReads(),0);
});
test('loading table is not accepted even when old rows and count remain',async()=>{
  const f=fixture({loading:true}),r=await read(f.binding);
  assert.equal(r.error,'page_loading');assert.equal(f.rowReads(),0);
});
test('partially loaded page and duplicate task IDs are incomplete',async()=>{
  for(const args of [{total:2},{total:2,ids:['101','101']}])assert.equal((await read(fixture(args).binding)).error,'partial_or_duplicate_rows');
});
test('selected active filter with old paused rows remains unknown',async()=>{
  assert.equal((await read(fixture({status:'已暂停 手动暂停'}).binding)).error,'stale_or_wrong_pool_rows');
});
test('ROI column cannot silently change its business meaning',async()=>{
  assert.equal((await read(fixture({roi:'调控综合营销ROI'}).binding)).error,'required_columns_missing');
  const f=fixture({roi:'调控综合营销ROI'});f.binding.roi_column='调控综合营销ROI';assert.equal((await read(f.binding)).complete,true);
});
test('one failed page preserves the complete result of another page',async()=>{
  const a=fixture(),b=fixture({account:'99'});const r=await wave([a.binding,b.binding],'isolation');
  assert.equal(r.complete,false);assert.equal(r.reads[0].complete,true);assert.equal(r.reads[1].complete,false);
  assert.equal(r.reads[0].advertising_writes,0);
});
test('verified zero count is distinct from a missing table',async()=>{
  const r=await read(fixture({total:0,ids:[]}).binding);assert.equal(r.complete,true);assert.equal(r.total,0);
});
test('AX fallback returns raw state without claiming pool completeness',async()=>{
  const f=fixture();f.binding.tab.getAXState=async()=> '1 AXWebArea 加载中';
  const r=await ax(f.binding);assert.equal(r.scope,'ax_snapshot');assert.equal(r.complete,null);assert.equal(r.advertising_writes,0);
});
test('standalone CUA source initializes without module import or string compilation',()=>{
  const context=vm.createContext({URL}, {codeGeneration:{strings:false,wasm:false}});
  vm.runInContext(fs.readFileSync(require.resolve('../tools/check-qc-extension-parallel.cua.cjs'),'utf8'),context);
  assert.equal(typeof context.checkQianchuanExtensionWave,'function');assert.equal(typeof context.readQianchuanExtensionAxSnapshot,'function');
});
test('legacy full-domain page verifies observed dates and selected hash tab',async()=>{
  const f=fixture(),old=f.binding.tab.playwright.domSnapshot;
  f.binding.tab.playwright.domSnapshot=async()=> (await old()).replace('"开始日期"','"请选择开始日期"').replace('"结束日期"','"请选择结束日期"').replace('- tab "调控" [active] [selected]','- generic: 调控');
  f.binding.tab.url=async()=> 'https://qianchuan.jinritemai.com/uni-prom/detail?aavid=11&adId=22#uniDetail='+encodeURIComponent(JSON.stringify({tb:'uni_task_center'}));
  assert.equal((await read(f.binding)).complete,true);
  f.binding.tab.url=async()=> 'https://qianchuan.jinritemai.com/uni-prom/detail?aavid=11&adId=22#uniDetail='+encodeURIComponent(JSON.stringify({tb:'creative'}));
  assert.equal((await read(f.binding)).error,'control_tab_unverified');
});
function sortableFixture({waitFailure=false,form=false}={}) {
  const f=fixture(),getRole=f.binding.tab.playwright.getByRole,snapshot=f.binding.tab.playwright.domSnapshot;
  let clicks=0,waits=0,loading=false;
  f.binding.tab.reload=async()=> {throw Error('full_reload_forbidden');};
  f.binding.tab.playwright.getByRole=(role)=>role==='columnheader'?{click:async()=>{clicks++;loading=true;}}:getRole(role);
  f.binding.tab.playwright.domSnapshot=async()=> (await snapshot())+(loading?'\n- generic: 加载中...':'')+(form?'\n- button "提交"':'');
  f.binding.tab.playwright.getByText=()=>({waitFor:async()=>{waits++;if(waitFailure)throw Error('readiness_timeout');loading=false;}});
  return {...f,counters:()=>({clicks,waits})};
}
test('table refresh waits once, reads back, and never reloads the document',async()=>{
  const f=sortableFixture(),r=await refresh(f.binding);
  assert.equal(r.complete,true);assert.equal(r.refresh_method,'observed_cost_column_sort');
  assert.deepEqual(f.counters(),{clicks:1,waits:1});assert.equal(r.advertising_writes,0);
});
test('unknown table refresh is not clicked or waited again',async()=>{
  const f=sortableFixture({waitFailure:true}),r=await refresh(f.binding);
  assert.equal(r.complete,false);assert.equal(r.failed_stage,'query_ready');assert.equal(r.error,'readiness_timeout');
  assert.deepEqual(f.counters(),{clicks:1,waits:1});
});
test('existing submission form is protected before a query UI action',async()=>{
  const f=sortableFixture({form:true}),r=await refresh(f.binding);
  assert.equal(r.error,'existing_form_protected');assert.deepEqual(f.counters(),{clicks:0,waits:0});
});
