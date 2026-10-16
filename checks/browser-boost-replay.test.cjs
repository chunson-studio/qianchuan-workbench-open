const test = require('node:test');
const assert = require('node:assert/strict');

const { replayQianchuanBoostCreate, replayQianchuanBoostAction, replayQianchuanBoost } = require('../tools/codex-qc-boost-replay.cua.js');

test('browser replay module exposes one stable entry point', () => {
  assert.equal(typeof replayQianchuanBoostCreate, 'function');
  assert.equal(typeof replayQianchuanBoostAction, 'function');
  assert.equal(typeof replayQianchuanBoost, 'function');
});

test('browser replay rejects missing binding before touching the tab', async () => {
  await assert.rejects(
    replayQianchuanBoostCreate({}, { count: 1, budget: 100, duration_hours: 5 }),
    /advertiser_id/
  );
});

test('browser replay defaults to dry run', () => {
  const source = require('fs').readFileSync(require.resolve('../tools/codex-qc-boost-replay.cua.js'), 'utf8');
  assert.match(source, /默认 dry-run/);
  assert.match(source, /if \(!cfg\.execute\)/);
});

test('missing identity waits once and stops before any submission', async () => {
  let waits = 0;
  const tab = {
    url: async () => 'https://qianchuan.jinritemai.com/uni-prom/detail?aavid=1&adId=2',
    getAXState: async () => '',
    playwright: { getByText: () => ({
      count: async () => 0,
      waitFor: async () => { waits++; throw Error('identity absent'); }
    }) }
  };
  const result = await replayQianchuanBoostCreate(tab, {
    advertiser_id:'1', primary_ad_id:'2', material_id:'3', count:1,
    budget:100, duration_hours:6, execute:true, refresh:false
  });
  assert.equal(waits, 1);
  assert.equal(result.ok, false);
  assert.equal(result.ad_writes, 0);
  assert.equal(result.effect_status, 'not_submitted');
});

test('budget and duration update blocks until a stable browser control is verified', async () => {
  const result = await replayQianchuanBoostAction({}, { action: 'update', target_id: '60000017' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'browser_update_not_verified');
  assert.equal(result.ad_writes, 0);
});

// Exercise the real form workflow against controlled fields, with no browser or ads.
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

test('next-round batch submits all names once and reports zero confirmed writes',async()=>{
  const f=creationForm(['批次1','批次2','批次3']);
  const out=await f.run({execute:true,readback_next_round:true});
  assert.equal(out.ok,true);
  assert.deepEqual(f.state.submissions,['批次1','批次2','批次3']);
  assert.equal(out.effect_status,'submitted_pending_readback');
  assert.equal(out.ad_writes,null);
  assert.equal(out.confirmed_writes,0);
  assert.equal(out.receipts.length,3);
  assert.ok(out.receipts.every(r=>r.status==='submitted_pending_readback'));
});

test('next-round batch stops on an unknown second submission and never sends the third',async()=>{
  const f=creationForm(['批次1','批次2','批次3']);
  const byRole=f.tab.playwright.getByRole;
  f.tab.playwright.getByRole=(role,opt)=>{
    const locator=byRole(role,opt);
    if(role==='button'&&opt.name==='提交')return {...locator,async click(){
      await locator.click();
      if(f.state.submissions.length===2)throw Error('disconnected_after_submit');
    }};
    return locator;
  };
  const out=await f.run({execute:true,readback_next_round:true});
  assert.equal(out.ok,false);
  assert.equal(out.effect_status,'unconfirmed');
  assert.equal(out.ad_writes,null);
  assert.equal(out.confirmed_writes,0);
  assert.deepEqual(f.state.submissions,['批次1','批次2']);
  assert.equal(f.state.checkpoints.filter(c=>c.id==='boost.submit.intent').length,2);
});

for(const className of ['oc-promotion-operation-action-item','main-vmok-plugin-oc-promotion-operation-action-item'])test('material action supports observed CSS family '+className,async()=>{
  const f=creationForm(['原生名称']),byRole=f.tab.playwright.getByRole;let opens=0;
  f.tab.playwright.getByRole=(role,opt)=>{
    const row=byRole(role,opt);
    if(role==='row')return {...row,locator(selector){
      const found=selector.split(',').includes('span.'+className),open=row.getByText('追投');
      return {...open,filter(options){assert.equal(String(options.hasText),String(/^追投$/));return this;},
        async count(){return found?1:0;},async waitFor(){if(!found)throw Error('material_action_missing');},
        async click(){assert.equal(found,true);opens++;return open.click();}};
    }};
    return row;
  };
  const out=await f.run({execute:true,readback_next_round:true});
  assert.equal(out.effect_status,'submitted_pending_readback');assert.equal(opens,1);assert.equal(f.state.submissions.length,1);
});

test('creation navigates by an observed ordinal-prefixed material tab without loose text clicks',async()=>{
  const f=creationForm(['原生名称']),byRole=f.tab.playwright.getByRole;let tabClicks=0,materialVisible=false;
  f.tab.playwright.domSnapshot=async()=>'- tab "Tab 2 of 6 素材"';
  f.tab.playwright.getByRole=(role,opt={})=>{
    if(role==='tab')return {async count(){return opt.name==='Tab 2 of 6 素材'?1:0;},async waitFor(){},async click(){tabClicks++;materialVisible=true;}};
    const locator=byRole(role,opt);
    if(role==='row'){const get=locator.getByText;locator.getByText=()=>({...get(),async isVisible(){return materialVisible;}});}
    return locator;
  };
  const out=await f.run({});assert.equal(out.ok,true);assert.equal(tabClicks,1);assert.equal(f.state.submissions.length,0);
});

test('production form fills explicit 15/300/24 values and confirms all exact native names',async()=>{
  const names=Array.from({length:15},(_,i)=>'原生追投_'+i),{state,run}=creationForm(names);
  const out=await run({budget:300,duration_hours:24,execute:true,read_created:async name=>{
    assert.equal(state.budget,'300');assert.equal(state.duration,'24');
    return {complete:true,task:{task_id:String(1000+state.index),name,status:'调控中',budget:300,duration_hours:24,created_at:new Date().toISOString()}};
  }});
  assert.equal(out.ok,true);assert.equal(state.submissions.length,15);
  assert.deepEqual(state.submissions,names);
});
for(const key of ['budget','duration_hours'])test('production form refuses omitted '+key+' instead of an account default',async()=>{
  await assert.rejects(replayQianchuanBoostCreate({}, {advertiser_id:'1',primary_ad_id:'2',material_id:'3',count:1,budget:300,duration_hours:24,[key]:undefined}),new RegExp(key));
});
for(const field of ['budget','duration'])test('controlled form reverting '+field+' cannot submit wrong parameters',async()=>{
  const {state,run}=creationForm(['原生名称'],field);
  const out=await run({budget:300,duration_hours:24,execute:true});
  assert.equal(out.effect_status,'not_submitted');assert.match(out.error,/parameters_changed/);assert.equal(state.submissions.length,0);
});
test('platform names remain untouched even when an old caller supplies a name prefix',async()=>{
  const names=['20261007_素材追投_09:41:40','示例用户20261007_素材追投_09:41:41'];
  const {state,run}=creationForm(names),prepared=[];
  const result=await run({on_name_prepared:async x=>prepared.push(x)});
  assert.equal(result.ok,true);assert.deepEqual(result.receipts.map(x=>x.task_name),names);
  assert.deepEqual(state.nameFills,[]);assert.deepEqual(prepared.map(x=>x.platform_name),names);
  assert.deepEqual(state.checkpoints.filter(x=>x.id==='boost.form.open').map(x=>x.platform_name),names);
});
for(const name of ['', '原'.repeat(51)])test('missing or overlong native name is never rewritten/truncated or submitted: '+name.length,async()=>{
  const {state,run}=creationForm([name]);const result=await run({execute:true});
  assert.equal(result.effect_status,'not_submitted');assert.deepEqual(state.submissions,[]);assert.deepEqual(state.nameFills,[]);
});
test('name must be durable and unchanged before submission',async()=>{
  for(const mutate of [false,true]){
    const {state,run}=creationForm(['20261007_素材追投_09:41:40'],mutate);
    const result=await run({execute:true,on_name_prepared:async()=>{if(!mutate)throw Error('disk unavailable');}});
    assert.equal(result.effect_status,'not_submitted');assert.deepEqual(state.submissions,[]);
    assert.match(result.error,mutate?/task_name_changed/:/disk unavailable/);
  }
});
test('unified creation makes one complete readback and one submission with no duplicate row query',async()=>{
  const {state,run}=creationForm(['20261007_素材追投_10:00:00']);let reads=0;
  const out=await run({execute:true,read_created:async name=>{reads++;assert.equal(state.submissions.length,1);return {complete:true,evidence:'test:exact',task:{task_id:'4',name,status:'调控中',budget:100,duration_hours:8,created_at:new Date().toISOString()}};}});
  assert.equal(out.ok,true);assert.equal(reads,1);assert.equal(out.after[0].task_id,'4');
  assert.equal(state.checkpoints.filter(c=>c.id==='boost.submit.pending').length,1);assert.equal(state.submissions.length,1);
});

test('one visible creation form avoids repeated full-page AX captures for each field',async()=>{
  const {tab,state,run}=creationForm(['原生名称']);let captures=0;
  tab.getAXState=async()=>{captures++;};
  const out=await run({execute:true,read_created:async name=>({complete:true,task:{task_id:'4',name,status:'调控中',budget:100,duration_hours:8,created_at:new Date().toISOString()}})});
  assert.equal(out.ok,true);assert.equal(state.submissions.length,1);
  assert.ok(captures<=5,`unexpected repeated AX captures: ${captures}`);
});

for(const mode of ['recover','form_present','fails_twice'])test('entry click timeout recovery is bounded and preserves visible forms: '+mode,async()=>{
  const f=creationForm(['原生名称']),byRole=f.tab.playwright.getByRole;let clicks=0,formPresent=false;
  f.tab.playwright.getByRole=(role,opt)=>{
    const base=byRole(role,opt);
    if(role==='row')return {...base,locator(){const open=base.getByText('追投');return {...open,async click(){
      clicks++;
      if(clicks===1||mode==='fails_twice'){
        if(mode==='form_present')formPresent=true;
        throw Error('Playwright selector deadline exceeded');
      }
      formPresent=true;return open.click();
    }};}};
    if(role==='textbox'&&opt.name==='请输入任务名称，1-50个字符')return {...base,async count(){return formPresent?1:0;}};
    return base;
  };
  const out=await f.run({execute:true,readback_next_round:true});
  if(mode==='recover'){
    assert.equal(out.effect_status,'submitted_pending_readback');assert.equal(clicks,2);assert.equal(f.state.submissions.length,1);
  }else{
    assert.equal(out.effect_status,'not_submitted');assert.equal(clicks,mode==='form_present'?1:2);assert.equal(f.state.submissions.length,0);
    assert.equal(f.state.budget,'');assert.equal(f.state.nameFills.length,0);
  }
});

test('ambiguous creation fields stop before filling or submitting',async()=>{
  const {tab,state,run}=creationForm(['原生名称']),byRole=tab.playwright.getByRole;
  tab.playwright.getByRole=(role,opt)=>{
    const value=byRole(role,opt);
    return role==='textbox'&&opt.name==='请输入'?{...value,async count(){return 3;}}:value;
  };
  const out=await run({execute:true});
  assert.equal(out.effect_status,'not_submitted');assert.match(out.error,/create_form_inputs_not_unique/);
  assert.equal(state.budget,'');assert.equal(state.duration,'');assert.equal(state.submissions.length,0);
});
for(const failure of ['incomplete','old','wrong_budget','disconnect'])test('single complete readback remains unknown without re-dispatch: '+failure,async()=>{
  const {state,run}=creationForm(['20261007_素材追投_10:00:00']);let reads=0;
  const out=await run({execute:true,read_created:async name=>{reads++;if(failure==='disconnect')throw Error('lost readback');return {complete:failure!=='incomplete',task:{task_id:'4',name,status:'调控中',budget:failure==='wrong_budget'?200:100,duration_hours:8,created_at:new Date(Date.now()-(failure==='old'?60000:0)).toISOString()}};}});
  assert.equal(out.effect_status,'unconfirmed');assert.equal(out.ad_writes,null);assert.equal(state.submissions.length,1);assert.equal(reads,1);
});
