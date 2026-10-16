'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { run } = require('../tools/playwright-channel.cjs');
const { createPlaywrightBrowserAdapter } = require('../tools/lib/playwright-browser-adapter.cjs');
const { validatePlaywrightBinding, validateRegistry } = require('../tools/lib/playwright-profile-binding.cjs');
const { replayQianchuanBoostCreate, replayQianchuanBoostAction } = require('../tools/codex-qc-boost-replay.cua.js');
const base = require('./test-output.cjs').testOutputRoot();
fs.mkdirSync(base, { recursive: true });
function setup() {
  const dir = fs.mkdtempSync(path.join(base, 'cdp-'));
  const registry = { schema_version: 1, bindings: ['a','b'].map((id,i) => ({ account_id:id, browser_type:'playwright-cdp',
    profile_name:'profile-'+id, cdp_endpoint:'http://127.0.0.1:'+(9222+i), status:'active',
    advertisers:[{advertiser_id:'adv-'+id,primary_ad_ids:['plan-'+id]}] })) };
  const file=path.join(dir,'bindings.json');fs.writeFileSync(file,JSON.stringify(registry));
  return {dir,registry, options:{bindings_file:file,evidence_root:path.join(dir,'evidence')}};
}
const request = (account='a', extra={}) => ({request_id:'request-0001',account_id:account,advertiser_id:'adv-'+account,primary_ad_id:'plan-'+account,action:'snapshot',...extra});
function factory(state) {
  return options => ({
    async connect(binding) { state.connections=(state.connections||0)+1;state.bindings ||= [];state.bindings.push(binding); },
    async assertIdentity() { return {url:'https://qianchuan.jinritemai.com/detail'}; },
    async reload() { state.reloads=(state.reloads||0)+1; },
    async domSnapshot() { if(state.wait)await state.wait;return state.text ?? options.profile_name; },
    page() { const target={async count(){return 1;},async innerText(){return '已暂停';},async click(){state.clicks=(state.clicks||0)+1;if(state.fail)throw Error('模拟点击后断线');}};return {getByRole:()=>target}; },
    async close() {},
  });
}
test('独立 CDP 读取刷新后留存本通道证据，重复请求不冒充新采集',async()=>{
  const {options}=setup(), state={};
  const a=await run(request(),{...options,adapter_factory:factory(state)});
  const cached=await run(request(),{...options,adapter_factory:factory(state)});
  const b=await run(request('b'),{...options,adapter_factory:factory(state)});
  assert.equal(a.channel,'playwright-cdp');assert.equal(a.value,'profile-a');assert.equal(b.value,'profile-b');
  assert.equal(state.reloads,2);assert.equal(cached.replayed,true);assert.equal(cached.captured_at,a.captured_at);
  assert.equal(JSON.parse(fs.readFileSync(a.evidence_file)).channel,'playwright-cdp');
  assert.notEqual(a.evidence_file,b.evidence_file);
});
test('提交后错误保留未知结果；重试同编号只回读本地记录，参数变化拒绝',async()=>{
  const {options}=setup(),state={fail:true}, req=request('a',{action:'click',locator:{role:'button',name:'暂停'}});
  const first=await run(req,{...options,adapter_factory:factory(state)});
  assert.equal(first.advertising_writes,null);assert.equal(first.effect_status,'unconfirmed');assert.equal(first.retry_write,false);
  await run(req,{...options,adapter_factory:factory(state)});assert.equal(state.clicks,1);
  await assert.rejects(run({...req,locator:{role:'button',name:'开启'}},{...options,adapter_factory:factory(state)}),{code:'request_conflict'});
});
test('同端点并发拒绝，独立账户端点可继续；空数据不当零',async()=>{
  const {options}=setup();let release;
  const state={wait:new Promise(resolve=>{release=resolve;})};
  const active=run(request(),{...options,adapter_factory:factory(state)});
  await new Promise(resolve=>setImmediate(resolve));
  await assert.rejects(run(request('a',{request_id:'request-0002'}),{...options,adapter_factory:factory({})}),{code:'browser_channel_busy'});
  const other=await run(request('b'),{...options,adapter_factory:factory({text:'-'})});
  assert.equal(other.code,'page_data_unavailable');assert.equal(other.advertising_writes,0);
  release();assert.equal((await active).ok,true);
});
test('extension 登记不能用于 CDP；缺端点及同端点别名复用拒绝',()=>{
  const {registry}=setup();
  assert.throws(()=>validatePlaywrightBinding(registry,{account_id:'a',advertiser_id:'adv-a',primary_ad_id:'plan-a'},
    {browserType:'playwright-cdp',profileName:'profile-a'}),{code:'playwright_identity_missing'});
  const wrong=structuredClone(registry);wrong.bindings[0].browser_type='extension';
  assert.throws(()=>validateRegistry(wrong),{code:'playwright_bindings_invalid_registry'});
  registry.bindings[1].cdp_endpoint='http://localhost:9222';
  assert.throws(()=>validateRegistry(registry),{code:'playwright_bindings_endpoint_reused'});
});
test('控件返回成功但回读不符时保留未知，不二次点击',async()=>{
  const {options}=setup(),state={};
  const req=request('a',{action:'click',locator:{role:'button',name:'开启'},
    readback:{locator:{role:'row',name:'目标'},expected_text:'已开启'}});
  const result=await run(req,{...options,adapter_factory:factory(state)});
  assert.equal(result.ok,false);assert.equal(result.code,'readback_mismatch');
  assert.equal(result.effect_status,'unconfirmed');assert.equal(result.advertising_writes,null);
  await run(req,{...options,adapter_factory:factory(state)});assert.equal(state.clicks,1);
});
function pageFor(account) {
  const state={url:'https://qianchuan.jinritemai.com/overall-prom/detail?aavid=adv-'+account+'&adId=plan-'+account, clicks:0};
  const raw={count:async()=>1,click:async()=>{state.clicks++;},innerText:async()=>account,filter(){return this;},getByRole(){return this;}};
  return {state,url:()=>state.url,locator:()=>raw,getByRole:()=>raw};
}
test('CDP 不选择第一个标签；定位器缓存后仍拦住串户；重复匹配拒绝',async()=>{
  const a=pageFor('a'),b=pageFor('b'),browser={contexts:()=>[{pages:()=>[b,a]}],isConnected:()=>true};
  const adapter=createPlaywrightBrowserAdapter({browser});
  await adapter.connect({advertiser_id:'adv-a',primary_ad_id:'plan-a'});
  const target=adapter.getByRole('button').filter({hasText:'目标'});
  await target.click();assert.equal(a.state.clicks,1);assert.equal(b.state.clicks,0);
  a.state.url=b.state.url;
  await assert.rejects(target.click(),{code:'browser_identity_mismatch'});assert.equal(a.state.clicks,1);
  const duplicate=createPlaywrightBrowserAdapter({browser});
  await assert.rejects(duplicate.connect({advertiser_id:'adv-b',primary_ad_id:'plan-b'}),{code:'browser_page_ambiguous'});
});
test('一个 CDP 连接断开不会切到其他账户页面',async()=>{
  let connected=true;
  const adapter=createPlaywrightBrowserAdapter({browser:{contexts:()=>[{pages:()=>[pageFor('a')]}],isConnected:()=>connected}});
  await adapter.connect({advertiser_id:'adv-a',primary_ad_id:'plan-a'});connected=false;
  await assert.rejects(adapter.domSnapshot(),{code:'browser_disconnected'});
  const other=createPlaywrightBrowserAdapter({page:pageFor('b')});
  await other.connect({advertiser_id:'adv-b',primary_ad_id:'plan-b'});assert.equal(await other.domSnapshot(),'b');
});
function creationForm(names, mutateOnBlur=false) {
  const state={name:'',budget:'',duration:'',index:0,submissions:[],nameFills:[],checkpoints:[]};
  const item={async count(){return 1;},async isVisible(){return true;},async waitFor(){},async click(){},filter(){return this;},first(){return this;},nth(){return this;},async fill(){},async press(){}};
  const input={...item,async evaluate(fn){return fn({value:state.name});},async fill(v){state.name=v;state.nameFills.push(v);}};
  const budget={...item,async fill(v){state.budget=v;},async evaluate(fn){return fn({value:state.budget});}};
  const duration={...item,async fill(v){state.duration=v;},async evaluate(fn){return fn({value:state.duration});},async press(){
    if(mutateOnBlur==='budget')state.budget='100';
    else if(mutateOnBlur==='duration')state.duration='5';
    else if(mutateOnBlur)state.name+=' changed';
  }};
  const open={...item,async click(){state.name=names[state.index++];}};
  const row={...item,getByText(){return open;},locator(){return this.getByText('追投');}};
  const tab={async url(){return 'https://qianchuan.jinritemai.com/uni-prom/detail?aavid=1&adId=2';},async getAXState(){},
    playwright:{async evaluate(){return state.name;},async domSnapshot(){return '';},getByText(){return item;},getByRole(role,options){
      if(role==='row')return row;
      if(role==='textbox'&&options.name==='请输入任务名称，1-50个字符')return input;
      if(role==='textbox'&&options.name==='请输入')return {...item,async count(){return 2;},nth(i){return i===0?budget:duration;}};
      if(role==='button'&&options.name==='提交')return {...item,async count(){return 0;},async click(){state.submissions.push(state.name);}};
      return item;
    },locator(selector){if(selector==='input[placeholder="请输入任务名称，1-50个字符"]')return input;assert.equal(selector,'input[placeholder="请输入"]');return {...item,first(){return budget;},nth(){return duration;}};},getByPlaceholder(name){return name.includes('任务名称')?input:{...item,first(){return budget;},nth(){return duration;}};}}};
  const run=extra=>replayQianchuanBoostCreate(tab,{advertiser_id:'1',primary_ad_id:'2',material_id:'3',count:names.length,budget:100,duration_hours:8,refresh:false,
    name_prefix:'示例用户',request_id:'qc-internal-correlation',on_checkpoint:async c=>state.checkpoints.push(c),...extra});
  return {state,run,tab};
}

test('CUA 创建和暂停提交后回读失败均不能声称零写入',async()=>{
  const form=creationForm(['原生名称']),byRole=form.tab.playwright.getByRole;
  form.tab.playwright.getByRole=(role,opts)=>{const loc=byRole(role,opts);return role==='button'&&opts.name==='提交'?{...loc,async click(){await loc.click();throw Error('disconnected_after_submit');}}:loc;};
  const create=await form.run({execute:true,readback_next_round:true});
  assert.equal(form.state.submissions.length,1);assert.equal(create.ad_writes,null);assert.equal(create.confirmed_writes,0);
  const {createFakeTab}=await import('../tools/fixtures/codex-qc-fake-tab.mjs');
  const f=createFakeTab({onEvent(e,m){if(m.submitted.length)m.disconnected=true;}});
  const pause=await replayQianchuanBoostAction(f.tab,{binding:f.binding,target_id:'60000042',action:'pause',execute:true,on_checkpoint:f.checkpoint});
  assert.equal(f.model.submitted.length,1);assert.equal(pause.ad_writes,null);assert.equal(pause.effect_status,'unconfirmed');
});
