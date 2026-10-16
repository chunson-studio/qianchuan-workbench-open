'use strict';
require('./setup-runtime.cjs');
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {createRequire}=require('node:module');
const pw=createRequire(path.resolve(__dirname,'../server-app/package.json'))('playwright-core');
const {fixtureHtml}=require('./fixtures/browser-boost-page.cjs');
const {BrowserBoostPage}=require('../tools/lib/playwright-boost-operations.cjs');
const {createPlaywrightBrowserAdapter}=require('../tools/lib/playwright-browser-adapter.cjs');
const {BrowserBoostService}=require('../server-app/server/lib/browserBoostService');
const {ACTIONS,normalizeRequest,OperationDeadline}=require('../server-app/server/lib/browserBoostContract');
const {assertNoUnknownBrowserRequest,assertBrowserRequestIdUnused}=require('../server-app/server/lib/browserBoostRequests');
const opLog=require('../server-app/server/lib/operationLog');
let browser,index=0;
test.before(async()=>{browser=await pw.chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--disable-gpu']});});
test.after(async()=>{await browser?.close();});
async function fixture(options={}) {
 const account='fixture_'+(++index), context=await browser.newContext(),page=await context.newPage();
 const url='https://qianchuan.jinritemai.com/'+(options.type==='cheng_fang'?'overall-prom':'uni-prom')+'/detail?aavid=10001&adId=20001&'+(options.type==='cheng_fang'?'dateRange':'dr')+'='+encodeURIComponent('["2026-10-01","2026-10-01"]');
 await context.route('**/*',route=>route.fulfill({contentType:'text/html',body:fixtureHtml(options)}));
 await page.goto(url,{waitUntil:'domcontentloaded'});
 const config={qianchuan_accounts:[{id:account,aavid:'10001'}],agent_policy:{account_policies:{[account]:{boost_write_scope:{primary_ad_id:'20001',room_id:'40001',session_started_at:'2026-10-01T01:00:00Z',allowed_actions:ACTIONS,budget_adjustment:{max_increase_yuan:100}}}}}};
 const service=new BrowserBoostService({config,dataRoot:path.join(process.env.QC_RUNTIME_DATA_ROOT,account),totalMs:options.timeout||50000,
  sessionFactory:async(r,clock)=>{const adapter=createPlaywrightBrowserAdapter({page});await adapter.connect({...r,date_range:[r.start,r.end]});return new BrowserBoostPage(adapter,r,clock,async(id,status,evidence)=>{
   const directory=path.join(process.env.QC_RUNTIME_DATA_ROOT,account,'dom-evidence');fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,id+'-'+Date.now()+'-'+Math.random()+'.json'),JSON.stringify({channel:'playwright-cdp',evidence_origin:'isolated_fixture',id,status,evidence}));
  });}});
 const request=(action,extra={})=>({account_id:account,primary_ad_id:'20001',target_id:'30001',start:'2026-10-01',end:'2026-10-01',action,request_id:'isolated-request-'+index,...extra});
 const clicks=()=>page.evaluate(()=>Number(localStorage.getItem('fixture-clicks')||0));
 return {service,page,context,request,clicks,close:()=>context.close()};
}
const actions={pause:{},resume:{},stop:{},delete:{},update_budget:{budget:200,expected_budget:100},update_duration:{duration_seconds:23400,expected_duration_seconds:21600},update_roi:{roi_goal:10.5,roi_basis:'platform_net_1h'},update_bid:{bid:21},update_audience:{audience_template:'full_region'},create:{target_id:undefined,budget:100,smart_bid_type:'7',duration:21600,mids:['60001'],name:'椿-新建隔离'}};
for(const[action,params]of Object.entries(actions))test('隔离 DOM 与守卫：'+action,async()=>{
 const f=await fixture();try{if(action==='resume')await f.page.evaluate(()=>{tasks[0].status=2;save();render();});
  const result=await f.service.run(f.request(action,params));
  if(result.effect_status!=='confirmed')console.error('fixture failure',action,JSON.stringify(result));
  assert.equal(result.effect_status,'confirmed',JSON.stringify(result));assert.equal(result.readback.verified,true);
  assert.ok(result.operation_id);assert.equal(await f.clicks(),1);assert.equal(result.execution_channel,'browser');
  const repeated=await f.service.run(f.request(action,params));assert.equal(repeated.replayed,true);assert.equal(await f.clicks(),1);
  if(action==='pause'){f.service.options.config.agent_policy={};const revoked=await f.service.run(f.request(action,params));assert.equal(revoked.replayed,true);assert.equal(revoked.operation_id,result.operation_id);assert.equal(await f.clicks(),1);}
 }finally{await f.close();}
});
for(const type of ['quan_yu','cheng_fang'])test('隔离 '+type+' 列表、详情与诊断',async()=>{
 const f=await fixture({type});try{for(const action of ['list','detail','diagnose']){const result=await f.service.run(f.request(action));assert.equal(result.result_status,'read_verified',JSON.stringify(result));}assert.equal(await f.clicks(),0);}finally{await f.close();}
});
test('预演填写并取消；状态预演不触发确认或提交',async()=>{
 const f=await fixture();try{for(const[action,params]of Object.entries(actions)){const result=await f.service.run(f.request(action,{...params,preview:true}));assert.equal(result.preview,true,JSON.stringify(result));assert.equal(result.advertising_writes,0);assert.equal(await f.clicks(),0);assert.equal(await f.page.getByRole('dialog').count(),0);}}finally{await f.close();}
});
test('慢加载使用真实 DOM 条件；重复执行记录实际耗时',async()=>{
 const f=await fixture({delay:350});try{const first=await f.service.run(f.request('list'));const second=await f.service.run(f.request('list'));assert.equal(first.ok,true);assert.equal(second.ok,true);assert.ok(first.timings.load_ms>=300);fs.writeFileSync(path.join(process.env.QC_RUNTIME_DATA_ROOT,'browser-fixture-timings.json'),JSON.stringify({evidence_origin:'isolated_fixture',cold:first.timings,repeat:second.timings}));}finally{await f.close();}
});
test('平台未开播提示仅记拒绝；提交次数为1',async()=>{
 const f=await fixture({offline:true});try{const result=await f.service.run(f.request('create',actions.create));assert.equal(result.effect_status,'rejected',JSON.stringify(result));assert.equal(result.result_status,'platform_rejected');assert.equal(await f.clicks(),1);assert.equal(result.actual,null);}finally{await f.close();}
});
test('旧数据不确认；原编号只回查，其他编号及API被阻断',async()=>{
 const f=await fixture({stale:true});try{const req=f.request('update_budget',{budget:130,expected_budget:100});const result=await f.service.run(req);assert.equal(result.effect_status,'unconfirmed');assert.equal(result.actual.budget,100);const repeated=await f.service.run(req);assert.equal(repeated.replayed,true);const other=await f.service.run({...req,request_id:'other-request-123'});assert.equal(other.code,'browser_write_pending');assert.equal(await f.clicks(),1);assert.throws(()=>assertNoUnknownBrowserRequest(req.account_id,req.primary_ad_id),{code:'browser_write_pending'});assert.throws(()=>assertBrowserRequestIdUnused(req.account_id,req.request_id),{code:'request_id_channel_conflict'});}finally{await f.close();}
});
test('同名控件拒绝，不点第一个；错账户不提交',async()=>{
 for(const options of [{ambiguous:true},{account:'10002',timeout:1200}]){const f=await fixture(options);try{const result=await f.service.run(f.request('update_budget',{budget:130,expected_budget:100}));assert.equal(result.advertising_writes,0);assert.equal(result.effect_status,'rejected');assert.equal(await f.clicks(),0);}finally{await f.close();}}
});
test('没有成功提示时，用目标状态变化完成监听并独立回读',async()=>{
 const f=await fixture({noToast:true});try{const result=await f.service.run(f.request('pause'));assert.equal(result.effect_status,'confirmed',JSON.stringify(result));assert.equal(await f.clicks(),1);}finally{await f.close();}
});
test('回执保存失败不报告确认，不再次提交',async()=>{
 const f=await fixture();const original=opLog.attachReceipt;try{opLog.attachReceipt=()=>{throw Error('isolated storage failure');};const req=f.request('update_budget',{budget:130,expected_budget:100});const result=await f.service.run(req);assert.equal(result.effect_status,'unconfirmed');assert.ok(result.audit_error);assert.equal((await f.service.run(req)).replayed,true);assert.equal(await f.clicks(),1);}finally{opLog.attachReceipt=original;await f.close();}
});
test('提交后断线保持未知；重复请求不再次点击',async()=>{
 const f=await fixture();try{const original=f.service.options.sessionFactory;f.service.options.sessionFactory=async(...args)=>{const s=await original(...args);const submit=s.submitOnce.bind(s);s.submitOnce=async mark=>{await submit(mark);await f.page.close();throw Error('isolated post-submit disconnect');};return s;};const req=f.request('pause');const result=await f.service.run(req);assert.equal(result.effect_status,'unconfirmed');assert.equal(result.advertising_writes,undefined);const repeated=await f.service.run(req);assert.equal(repeated.replayed,true);}finally{await f.close();}
});
test('参数、别名与期限边界',()=>{
 const base={account_id:'fixture',primary_ad_id:'20001',target_id:'30001',request_id:'request-123456',action:'pause'};
 for(const[value,action]of [[1,'resume'],[2,'pause'],[6,'stop']])assert.equal(normalizeRequest({...base,action:'update_status',value}).action,action);
 for(const extra of [{start:'2026-99-01'},{endpoint:'http://127.0.0.1:9222'},{preview:'true'}])assert.throws(()=>normalizeRequest({...base,...extra}));
 let now=0;const clock=new OperationDeadline(50,()=>now);assert.equal(clock.timeout(100),50);now=50;assert.throws(()=>clock.timeout(1),{code:'browser_operation_timeout'});
});

test('画面追投待验证时拒绝预演和提交，不连接浏览器或误走素材流程',async()=>{
 let connections=0;
 const service=new BrowserBoostService({sessionFactory:async()=>{connections++;throw Error('unexpected connection');}});
 const request={account_id:'fixture',primary_ad_id:'20001',action:'create',request_id:'live-feed-request-123',live_feed:true,budget:100,duration:21600,name:'椿-画面待验证'};
 for(const preview of [true,false]){
  const result=await service.run({...request,preview});
  assert.equal(result.code,'browser_live_feed_pending_verification');assert.equal(result.advertising_writes,0);assert.equal(result.retry_write,false);
 }
 assert.equal(connections,0);
 for(const extra of [{mids:['60001']},{assist_task:true},{live_feed:'true'},{assist_task:'true',live_feed:false}])assert.throws(()=>normalizeRequest({...request,...extra}),{code:'invalid_create_shape'});
 assert.equal(normalizeRequest({...request,live_feed:false,mids:['60001'],smart_bid_type:'7'}).action,'create');
});

test('同主计划并发修改串行核对前值，不发生界面互抢',async()=>{
 const f=await fixture();try{
  const [first,second]=await Promise.all([
   f.service.run(f.request('update_budget',{budget:130,expected_budget:100,request_id:'serial-request-1'})),
   f.service.run(f.request('update_budget',{budget:160,expected_budget:130,request_id:'serial-request-2'}))]);
  assert.equal(first.effect_status,'confirmed',JSON.stringify(first));
  assert.equal(second.effect_status,'confirmed',JSON.stringify(second));
  assert.equal(second.before.budget,130);assert.equal(second.actual.budget,160);assert.equal(await f.clicks(),2);
 }finally{await f.close();}
});

test('执行归属正文与请求头不一致时，预演和正式写入均不打开表单',async()=>{
 const f=await fixture();try{for(const preview of [true,false]){
  const result=await f.service.run(f.request('update_budget',{budget:130,expected_budget:100,execution_owner:'owner_actual',session_key:'fixture|40001|2026-10-01T01:00:00Z',preview}),{headers:{'x-qc-execution-owner':'owner_other','x-qc-session-key':'fixture|40001|2026-10-01T01:00:00Z'}});
  assert.equal(result.code,'browser_owner_headers_mismatch');assert.equal(result.advertising_writes,0);assert.equal(await f.clicks(),0);
  assert.equal(await f.page.getByRole('dialog').count(),0);
 }}finally{await f.close();}
});
