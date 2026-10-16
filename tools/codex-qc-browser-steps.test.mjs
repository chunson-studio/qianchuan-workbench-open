import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQianchuanBrowserSteps, executeQianchuanTaskAction } from './codex-qc-browser-steps.cua.mjs';
import { createFakeTab, fakeTask, HEADERS, ALL } from './fixtures/codex-qc-fake-tab.mjs';

// All identities are invented. This suite imports the production UI orchestrator
// with a local, stateful tab double; it never imports a browser/advertising driver.
// Known regressions remain ordinary failing assertions until production is fixed.
const ID = '60000042', OTHER = '60000043';
for(const selected of [true,false])test('observed Tab 3 of 6 accessible name is located exactly and its selection is verified: '+selected,async t=>{
  const f=setup(t);f.model.tabName=selected?'调控':'素材';
  const snapshot=f.tab.playwright.domSnapshot,byRole=f.tab.playwright.getByRole;
  f.tab.playwright.domSnapshot=async()=>(await snapshot()).replace('- tab "调控"','- tab "Tab 3 of 6 调控"');
  f.tab.playwright.getByRole=(role,opt={})=>role==='tab'?byRole(role,{...opt,name:opt.name==='Tab 3 of 6 调控'?'调控':'not present'}):byRole(role,opt);
  await f.ui.openTab('调控');assert.equal(f.model.tabName,'调控');
  assert.equal(f.model.events.filter(e=>e.type==='click'&&e.name==='调控').length,selected?0:1);
  assertNoSubmit(f);
});
test('duplicate semantic tabs never fall back to a broad text match',async t=>{
  const f=setup(t),snapshot=f.tab.playwright.domSnapshot;
  f.tab.playwright.domSnapshot=async()=>await snapshot()+'\n- tab "Tab 3 of 6 调控"';
  await assert.rejects(f.ui.openTab('调控'),/plan_tab_not_unique/);assertNoSubmit(f);
});

test('partial page shell waits for the missing account then revalidates without reload or writes',async t=>{
  const f=setup(t),snapshot=f.tab.playwright.domSnapshot;let reads=0;
  f.tab.playwright.domSnapshot=async()=>{const dom=await snapshot();return ++reads===1?dom.replace(/^.*ID：60000000.*\n?/m,''):dom;};
  const result=await f.ui.view();assert.deepEqual(result.view.issues,[]);
  assert.ok(marks(f,'plan.identity.pending').some(x=>x.status==='observed'));
  assert.ok(f.model.events.some(e=>e.type==='wait'&&e.state==='visible'));
  assertNoSubmit(f);assert.equal(f.model.events.filter(e=>e.type==='click').length,0);
});

test('a different visible account or plan fails immediately instead of waiting for the intended account',async t=>{
  for(const field of ['advertiser_id','primary_ad_id']) {
    const f=setup(t),snapshot=f.tab.playwright.domSnapshot;
    f.tab.playwright.domSnapshot=async()=>(await snapshot()).replaceAll(f.binding[field],f.binding[field]+'9');
    await assert.rejects(f.ui.view(),/plan_identity_mismatch/);
    assert.equal(f.model.events.some(e=>e.type==='wait'),false);assertNoSubmit(f);
  }
});

test('missing account timeout is a readiness failure and never a successful identity check',async t=>{
  const f=setup(t),snapshot=f.tab.playwright.domSnapshot;
  f.tab.playwright.domSnapshot=async()=>(await snapshot()).replace(/^.*ID：60000000.*\n?/m,'');
  f.tab.playwright.getByText=()=>({async waitFor(){throw Error('identity timeout');}});
  await assert.rejects(f.ui.view(),/plan_identity_not_ready/);
  assert.ok(marks(f,'plan.identity.pending').some(x=>x.status==='read_failed'));assertNoSubmit(f);
});

test('detached snapshot is reobserved once; repeated detach fails without reload or ad retries',async t=>{
  const f=setup(t),snapshot=f.tab.playwright.domSnapshot;let attempts=0;
  f.tab.playwright.domSnapshot=async()=>{if(++attempts===1)throw Error('Detached while handling command');return snapshot();};
  assert.deepEqual((await f.ui.view()).view.issues,[]);assert.equal(attempts,2);
  assert.equal(marks(f,'plan.read.retry').length,1);assertNoSubmit(f);
  attempts=0;f.tab.playwright.domSnapshot=async()=>{attempts++;throw Error('Detached while handling command');};
  await assert.rejects(f.ui.view(),/Detached/);assert.equal(attempts,2);assertNoSubmit(f);
});

test('responsive hidden account header supplies separate DOM evidence through pool reduction without fabricating AX',async t=>{
  const f=setup(t),snapshot=f.tab.playwright.domSnapshot;
  f.tab.playwright.domSnapshot=async()=>(await snapshot()).replace(/^.*ID：60000000.*\n?/m,'');
  f.model.accountBoxes=[{textContent:'模拟账户\nID：'+f.binding.advertiser_id,display:'none'}];
  const result=await f.ui.view();assert.deepEqual(result.view.issues,[]);
  assert.ok(!result.raw.dom.includes('ID：'+f.binding.advertiser_id));
  assert.equal(result.raw.account_dom.text,f.model.accountBoxes[0].textContent);
  const pool=await f.ui.readPool('调控中');assert.equal(pool.pool.complete,true);
  assert.ok(pool.pages.every(p=>p.account_dom?.selector==='.account-info-box'));assertNoSubmit(f);
});

for(const mode of ['wrong_account','duplicate_headers','not_hidden','wrong_plan'])test('responsive account fallback rejects '+mode,async t=>{
  const f=setup(t),snapshot=f.tab.playwright.domSnapshot;
  f.tab.playwright.domSnapshot=async()=>{
    let dom=(await snapshot()).replace(/^.*ID：60000000.*\n?/m,'');
    if(mode==='wrong_plan')dom=dom.replace(f.binding.primary_ad_id,f.binding.primary_ad_id+'9');return dom;
  };
  f.model.accountBoxes=[{textContent:'ID：'+f.binding.advertiser_id+(mode==='wrong_account'?'9':''),display:mode==='not_hidden'?'block':'none'}];
  if(mode==='duplicate_headers')f.model.accountBoxes.push({...f.model.accountBoxes[0]});
  await assert.rejects(f.ui.view(),/plan_identity_(?:mismatch|not_ready)/);assertNoSubmit(f);
});
function setup(t, options = {}, extra = {}) {
  const f = createFakeTab(options);
  t.mock.method(Date, 'now', () => f.model.now);
  f.ui = createQianchuanBrowserSteps({ tab: f.tab, binding: f.binding, checkpoint: f.checkpoint, ...extra });
  f.run = cfg => executeQianchuanTaskAction(f.tab, {
    action: 'pause', target_id: ID, binding: f.binding, on_checkpoint: f.checkpoint,
    execute: true, readback_timeout_ms: 250, ...cfg,
  });
  return f;
}
const marks = (f, id) => f.model.checkpoints.filter(c => c.id === id);

test('no owned search performs no observation and preserves human input',async t=>{
  const f=setup(t,{search:'human-query'});
  const events=f.model.events.length;
  assert.deepEqual(await f.ui.releaseSearch(),{status:'not_needed'});
  assert.equal(f.model.events.length,events);assert.equal(f.model.search,'human-query');
});
test('single-page pool read reuses internal navigation observation but keeps capture checks',async t=>{
  const f=setup(t);await f.ui.readPool('调控中');
  assert.equal(f.model.events.filter(e=>e.type==='snapshot').length,4);
  // Public calls always obtain their own observation, ignoring supplied snapshots.
  f.model.binding.advertiser_id='999';
  await assert.rejects(f.ui.choosePool('调控中',{view:{actual_filter:'调控中'}}),/identity/);
});
test('controlled verified pause leaves result pool and next read navigates normally',async t=>{
  const f=setup(t),out=await f.run({restore_after_verified:false});
  assert.equal(out.effect_status,'write_verified');assert.equal(f.model.pool,'手动暂停');
  assert.equal(marks(f,'pool.restore').at(-1).reason,'controlled_verified_result_pool');
  assert.equal(f.model.submitted.length,1);
  await f.ui.readPool('调控中');assert.equal(f.model.pool,'调控中');
});

for(const neverApply of [false,true])test(`controller pause defers only readback and never claims success: ${neverApply}`,async t=>{
  const f=setup(t,{neverApply});
  const out=await f.run({defer_pause_readback:true,restore_after_verified:false});
  assert.equal(out.effect_status,'submitted_pending_readback');
  assert.equal(out.confirmed_writes,0);assert.equal(out.ad_writes,null);
  assert.deepEqual(out.pending_ids,[ID]);assert.equal(f.model.submitted.length,1);
  assert.equal(marks(f,'action.readback').length,0);
  assert.equal(marks(f,'pool.read').length,0);
  assert.equal(f.model.pool,'调控中');
  assert.equal((await f.ui.selectedIds()).length,0);
});
test('controlled unknown submit retains cleanup and never resends',async t=>{
  const f=setup(t,{neverApply:true});
  const out=await f.run({restore_after_verified:false,readback_timeout_ms:60});
  assertUnknown(out,f);assert.equal(f.model.pool,'调控中');
  assert.notEqual(marks(f,'pool.restore').at(-1).reason,'controlled_verified_result_pool');
});
test('failed durable readback checkpoint keeps controlled action unconfirmed and restores',async t=>{
  const f=setup(t);
  const out=await f.run({restore_after_verified:false,on_checkpoint:async item=>{
    if(item.id==='action.readback')throw Error('checkpoint unavailable');
    await f.checkpoint(item);
  }});
  assert.equal(out.effect_status,'unconfirmed');assert.equal(f.model.submitted.length,1);
  assert.equal(f.model.pool,'调控中');assert.equal(marks(f,'pool.restore').at(-1).status,'read_verified');
});

test('task reads never evaluate aggregate ROI or honor the legacy summary-only permission',async t=>{
  let summaryReads=0;
  const f=setup(t,{summaryCells:()=>[{get innerText(){summaryReads++;throw Error('aggregate read cancelled');},colSpan:7,rowSpan:1}]},
    {allowed_pools:['手动暂停','调控中'],reporting_allowed_pools:['调控中',ALL]});
  const result=await f.ui.readPool('调控中');
  assert.equal(result.pool.complete,true);assert.equal(result.pool.tasks.length,1);
  assert.equal(summaryReads,0);assert.equal(result.pool.native_summary,undefined);assert.equal(f.ui.readPoolSummary,undefined);
  await assert.rejects(f.ui.choosePool(ALL,{summary:true}),/pool_not_authorized/);
  assert.equal(marks(f,'pool.summary').length,0);assertNoSubmit(f);
});

test('batch creation readback scans active once for all 15 names, without opening manual pause or search',async t=>{
  const tasks=Array.from({length:15},(_,i)=>fakeTask(String(BigInt(ID)+BigInt(i)),{name:'示例用户原生'+i}));
  const f=setup(t,{tasks,pageSize:20});
  const out=await f.ui.readCreatedBatch(tasks.map(t=>t.name));
  assert.deepEqual(out.searched_pools,['调控中']);assert.equal(out.targets.length,15);
  assert.ok(out.targets.every(r=>r.match_count===1&&r.task));
  assert.equal(marks(f,'pool.refresh').length,1);
  assert.ok(!f.model.events.some(e=>e.type==='search'||e.name==='手动暂停'));assertNoSubmit(f);
});
test('missing or duplicate batch names stay unknown; only missing names require the paused fallback',async t=>{
  const f=setup(t,{tasks:[fakeTask(ID,{name:'one'}),fakeTask(OTHER,{name:'one'}),fakeTask(ID+'1',{name:'two',status:'已暂停\n手动暂停'})]});
  const out=await f.ui.readCreatedBatch(['one','two','missing']);
  assert.deepEqual(out.searched_pools,['调控中','手动暂停']);
  assert.equal(out.targets[0].task,null);assert.equal(out.targets[0].match_count,2);
  assert.equal(out.targets[1].task.name,'two');assert.equal(out.targets[2].task,null);assertNoSubmit(f);
});

test('complete visible pool skips page-one navigation; a partial last page still resets and covers all IDs',async t=>{
  for(const count of [0,1,6,10,11]) {
    const tasks=Array.from({length:count},(_,i)=>fakeTask(String(BigInt(ID)+BigInt(i))));
    const f=setup(t,{tasks,pageSize:10,page:count>10?2:1});
    const out=await f.ui.readPool('调控中');
    assert.equal(out.pool.complete,true);assert.equal(out.pool.tasks.length,count);
    assert.equal(marks(f,'pool.page.1').length,count>10?1:0);
    assert.equal(f.model.refreshes,1);
    assertNoSubmit(f);
  }
});

for(const activePageSelector of ['.main-vmok-plugin-page-turner__item--active','.ovui-page-turner__item--active'])test('verified paginator style covers both pages: '+activePageSelector,async t=>{
  const tasks=Array.from({length:3},(_,i)=>fakeTask(String(BigInt(ID)+BigInt(i))));
  const f=setup(t,{tasks,pageSize:2,page:2,activePageSelector});
  const out=await f.ui.readPool('调控中');
  assert.equal(out.pool.complete,true);
  assert.equal(out.pool.tasks.length,3);
  assert.equal(marks(f,'pool.page.1').length,1);
  assert.equal(marks(f,'pool.page.2').length,1);
  assertNoSubmit(f);
});

test('validation phases retain final confirmation checks and stop a changed condition there',async t=>{
  const phases=[],f=setup(t);
  const out=await f.run({validate_before:async({phase})=>{
    phases.push(phase);
    if(phase==='confirmation')throw Error('fresh_authorization_revoked');
  }});
  assert.deepEqual(phases,['preflight','selection','confirmation']);
  assert.equal(out.effect_status,'unconfirmed');assert.match(out.error,/authorization_revoked/);
  assertNoSubmit(f);
});

for(const blocked of [false,true])test('resume confirmation rechecks target and final hook before dispatch: '+blocked,async t=>{
  const f=setup(t,{tasks:[fakeTask(ID,{status:'已暂停\n手动暂停'})],confirmActions:['resume']}),phases=[];
  const out=await f.run({action:'resume',validate_before:async({phase})=>{
    phases.push(phase);if(blocked&&phase==='confirmation')throw Error('scene_ended');
  }});
  assert.deepEqual(phases,['preflight','selection','confirmation']);
  assert.equal(f.model.submitted.length,blocked?0:1);
  assert.equal(out.effect_status,blocked?'unconfirmed':'write_verified');
});
test('explicit uncheck transition failure is re-observed before bounded recovery, without a second submit',async t=>{
  let failed=false;
  const f=setup(t,{tasks:[fakeTask(ID)],readbackDelayRefreshes:1,onEvent(e){
    if(e.type==='uncheck'&&!failed){failed=true;throw Error('Click did not change checked state to false');}
  }});
  const out=await f.run({});
  assert.equal(out.effect_status,'write_verified');assert.equal(f.model.submitted.length,1);
  assert.equal(marks(f,'task.deselect.attempt').length,1);
  assert.equal(f.model.events.filter(e=>e.type==='uncheck').length,2);
});
function assertNoSubmit(f) { assert.deepEqual(f.model.submitted, [], 'No simulated advertising submission is allowed'); }

test('two-pool restriction applies to name queries, missing IDs and explicit all-pool attempts',async t=>{
  const f=setup(t,{tasks:[fakeTask(ID,{name:'native',status:'已暂停\n手动暂停'})]}, {allowed_pools:['手动暂停','调控中']});
  const found=await f.ui.readCreated('native');assert.equal(found.task.task_id,ID);
  assert.deepEqual(found.searched_pools,['手动暂停','调控中']);
  assert.equal((await f.ui.readCreated('missing')).task,null);
  assert.equal((await f.ui.readTargets([OTHER],{allow_all:true})).targets[0].task,null);
  await assert.rejects(f.ui.choosePool(ALL),/pool_not_authorized/);
  assert.ok(!f.model.events.some(e=>e.type==='click'&&e.name===ALL));assert.equal(f.model.pool,'调控中');assertNoSubmit(f);
  assert.equal(f.model.events.filter(e=>e.type==='search').length,0,'Exact create reconciliation must not use unreliable platform name search');
});
test('native prefixed name is queried exactly across normal pools; duplicate names cannot confirm creation',async t=>{
  const name='示例用户20261007_素材追投_09:41:40';
  const f=setup(t,{tasks:[fakeTask(ID,{name,status:'已暂停\n手动暂停'})]});
  const found=await f.ui.readCreated(name);assert.equal(found.task.task_id,ID);assert.equal(f.model.search,'');assertNoSubmit(f);
  const duplicate=setup(t,{tasks:[fakeTask(ID,{name}),fakeTask(OTHER,{name})]});
  await assert.rejects(duplicate.ui.readCreated(name),/exact_id_search_mismatch/);assertNoSubmit(duplicate);
});
test('platform fuzzy name results resolve only the unique full-name match',async t=>{
  const name='示例用户20261007_素材追投_10:07:02';
  const f=setup(t,{overbroadSearch:true,tasks:[fakeTask(ID,{name}),fakeTask(OTHER,{name:'示例用户20261007_素材追投_10:05:47'})]});
  const found=await f.ui.readCreated(name);assert.equal(found.task.task_id,ID);assert.equal(found.task.name,name);assert.equal(f.model.pool,'调控中');assertNoSubmit(f);
});
test('fuzzy name results with no exact name never confirm another task',async t=>{
  const f=setup(t,{overbroadSearch:true,tasks:[fakeTask(ID,{name:'示例用户20261007_素材追投_10:05:47'})]});
  assert.equal((await f.ui.readCreated('示例用户20261007_素材追投_10:07:02')).task,null);assertNoSubmit(f);
});
for(const selected of [true,false])test('legacy tab selection is verified in its actual tab container: '+selected,async t=>{
  const f=setup(t),original=f.tab.playwright.getByRole;
  f.tab.playwright.getByRole=(role,options)=>role==='tab'?{async count(){return 0;}}:original(role,options);
  f.tab.playwright.locator=selector=>{
    assert.equal(selector,'.ovui-tabs__tab-btn');
    return {getByText(name,options){assert.equal(name,'数据');assert.equal(options.exact,true);return {
      async count(){return 1;},async click(){},async evaluate(fn){return fn({closest(s){assert.equal(s,'.row.tab--active');return selected?{}:null;}});}
    }}};
  };
  if(selected)await f.ui.openTab('数据');else await assert.rejects(f.ui.openTab('数据'),/not_verified/);
  assert.equal(marks(f,'tab.数据').at(-1).status,selected?'read_verified':'read_failed');assertNoSubmit(f);
});
function assertUnknown(out, f, ids = [ID]) {
  assert.equal(out.ok, false);
  assert.equal(out.effect_status, 'unconfirmed');
  assert.equal(out.ad_writes, null, 'Ambiguous submission must not claim zero writes');
  assert.equal(out.retry_write, false);
  assert.deepEqual(out.pending_ids, ids);
  assert.equal(f.model.submitted.length, 1, 'Submission is dispatched exactly once');
}

for (const failures of [0, 1, 2]) {
  test(`pool menu succeeds after ${failures} failures, saves each failed attempt`, async t => {
    let attempts = 0;
    const f = setup(t, { onEvent(e) {
      if (e.type === 'click' && e.role === 'option' && e.name === ALL && ++attempts <= failures)
        throw Error('fake menu temporarily unavailable');
    } });
    await f.ui.choosePool(ALL);
    assert.equal(f.model.pool, ALL);
    assert.equal(attempts, failures + 1);
    assert.deepEqual(marks(f, 'pool.attempt').map(c => c.attempt), Array.from({ length: failures }, (_, i) => i));
    assert.equal(marks(f, 'pool.select').at(-1).status, 'read_verified');
    assertNoSubmit(f);
  });
}

test('pool menu permanently failing permits initial attempt plus two retries only', async t => {
  let attempts = 0;
  const f = setup(t, { onEvent(e) {
    if (e.type === 'click' && e.role === 'option' && e.name === ALL) {
      attempts++; throw Error('fake menu permanently unavailable');
    }
  } });
  await assert.rejects(f.ui.choosePool(ALL), /permanently unavailable/);
  assert.equal(attempts, 3);
  assert.deepEqual(marks(f, 'pool.attempt').map(c => c.attempt), [0, 1, 2]);
  assertNoSubmit(f);
});

test('manual paused submenu retry uses its still-open observed state', async t => {
  let failures = 0;
  const f = setup(t, { onEvent(e) {
    if (e.type === 'click' && e.name === '手动暂停' && failures++ === 0) throw Error('fake submenu lost focus');
  } });
  await f.ui.choosePool('手动暂停');
  assert.equal(f.model.pool, '手动暂停');
  assert.equal(failures, 2);
  assert.equal(f.model.events.filter(e => e.type === 'click' && e.name === '已暂停').length, 1);
  assert.equal(marks(f, 'pool.parent').length, 1);
});

test('identity failure stops menu retries and does not click any control', async t => {
  const f = setup(t);
  f.model.binding.advertiser_id = '60000002';
  await assert.rejects(f.ui.choosePool(ALL), /plan_identity_mismatch/);
  assert.equal(marks(f, 'pool.attempt').length, 1);
  assert.equal(f.model.events.filter(e => e.type === 'click').length, 0);
});

test('loading after choosing a pool waits before taking any rows', async t => {
  const f = setup(t, { loadingDelayMs: 40, afterEvent(e, m) {
    if (e.type === 'click' && e.role === 'option') m.loading = true;
  } });
  f.model.pool='手动暂停';
  const out = await f.ui.readPool('调控中');
  assert.equal(out.pool.complete, true);
  assert.equal(out.pool.tasks[0].cost, 12.9);
  const wait = f.model.events.findIndex(e => e.type === 'wait');
  const rows = f.model.events.findIndex(e => e.type === 'evaluate');
  assert.ok(wait >= 0 && rows > wait);
  assert.equal(marks(f, 'plan.loading').length, 1);
  assert.equal(f.model.events[wait].timeoutMs, 5000);
  assertNoSubmit(f);
});
test('transient loading is reread before a hidden locator wait and never reused as empty data',async t=>{
  const f=setup(t,{loading:true,afterEvent(e,m){if(e.type==='snapshot')m.loading=false;}});
  const out=await f.ui.readPool('调控中');
  assert.equal(out.pool.complete,true);assert.equal(out.pool.tasks[0].cost,12.9);
  assert.equal(f.model.events.some(e=>e.type==='wait'&&e.state==='hidden'),false);
  assert.equal(marks(f,'plan.loading.recovered')[0].basis,'fresh_snapshot_before_wait');assertNoSubmit(f);
});
test('hidden wait CDP timeout can recover only from a new ready bound snapshot',async t=>{
  const f=setup(t,{loading:true});let waits=0;
  f.tab.playwright.getByText=()=>({async waitFor(){waits++;f.model.loading=false;throw Error('Runtime.evaluate timeout; no_matches');}});
  const out=await f.ui.readPool('调控中');
  assert.equal(waits,1);assert.equal(out.pool.complete,true);assert.equal(out.pool.tasks[0].cost,12.9);
  assert.equal(marks(f,'plan.loading.wait').length,1);
  assert.equal(marks(f,'plan.loading.recovered')[0].basis,'fresh_snapshot_after_wait_failure');assertNoSubmit(f);
});
test('no_matches diagnostics cannot override a fresh snapshot that is still loading',async t=>{
  const f=setup(t,{loading:true});let waits=0;
  f.tab.playwright.getByText=()=>({async waitFor(){waits++;throw Error('Runtime.evaluate timeout; no_matches');}});
  await assert.rejects(f.ui.readPool('调控中'),/Runtime.evaluate timeout/);
  assert.equal(waits,1);assert.equal(marks(f,'plan.loading.recovered').length,0);
  assert.equal(f.model.events.some(e=>e.type==='evaluate'),false);assertNoSubmit(f);
});
for(const kind of ['disconnected','wrong_account','expired_deadline'])test('loading recovery does not bypass '+kind,async t=>{
  const f=setup(t,{loading:true}),snapshot=f.tab.playwright.domSnapshot;let failed=false;
  f.tab.playwright.getByText=()=>({async waitFor(){failed=true;f.model.loading=false;if(kind==='expired_deadline')f.model.now+=100;throw Error('Runtime.evaluate timeout');}});
  f.tab.playwright.domSnapshot=async()=>{
    if(failed&&kind==='disconnected')throw Error('browser disconnected');
    const dom=await snapshot();return failed&&kind==='wrong_account'?dom.replaceAll(f.binding.advertiser_id,'999999'):dom;
  };
  if(kind==='expired_deadline')f.ui.setDeadline(f.model.now+50);
  await assert.rejects(f.ui.readPool('调控中'),/browser disconnected|plan_identity_mismatch|readback_deadline/);
  assert.equal(f.model.events.some(e=>e.type==='evaluate'),false);assertNoSubmit(f);
});
test('accepted submit with disappearing loader is verified once after wait failure, never resubmitted',async t=>{
  const f=setup(t,{afterEvent(e,m){if(e.type==='submit')m.loading=true;}}),getByText=f.tab.playwright.getByText;
  f.tab.playwright.getByText=(name,...args)=>name==='加载中...'?{async waitFor(){f.model.loading=false;throw Error('Runtime.evaluate timeout; no_matches');}}:getByText(name,...args);
  const out=await f.run({readback_timeout_ms:200});
  assert.equal(out.effect_status,'write_verified');assert.equal(f.model.submitted.length,1);
  assert.equal(out.confirmed_writes,1);assert.equal(marks(f,'plan.loading.wait').length,1);
});

test('already selected tab and pool do not generate redundant navigation clicks',async t=>{
  const f=setup(t);await f.ui.readPool('调控中');
  assert.equal(f.model.events.filter(e=>e.type==='click'&&(e.role==='tab'||e.role==='option'||e.role==='textbox')).length,0);
  assert.equal(f.model.events.filter(e=>e.type==='click'&&e.role==='columnheader').length,1);
  const lookup=setup(t);await lookup.ui.readTask(ID);
  assert.equal(lookup.model.events.filter(e=>e.type==='click'&&e.role==='tab').length,0);
  assert.ok(!lookup.model.events.some(e=>e.type==='click'&&e.name===ALL));
  assert.equal(lookup.model.pool,'调控中');
});
test('strict zero-order comparison is honored by the real browser action orchestrator',async t=>{
  for(const cost of ['5.00','5.01']){
    const f=setup(t,{tasks:[fakeTask(ID,{cost})]});const out=await f.run({zero_order_threshold:5,zero_order_comparator:'gt'});
    assert.equal(out.effect_status,cost==='5.00'?'not_submitted':'write_verified');assert.equal(f.model.submitted.length,cost==='5.00'?0:1);
  }
});

test('permanent loading timeout returns a gap, never rows or verified empty pool', async t => {
  const f = setup(t, { loading: true, loadingNeverEnds: true });
  await assert.rejects(f.ui.readPool('调控中'), /loading timeout/);
  assert.equal(f.model.events.filter(e => e.type === 'evaluate').length, 0);
  assert.equal(marks(f, 'pool.coverage').length, 0);
  assertNoSubmit(f);
});

test('loading wait is bounded by remaining readback deadline', async t => {
  const f = setup(t, { loading: true, loadingDelayMs: 100 });
  f.ui.setDeadline(f.model.now + 15);
  await assert.rejects(f.ui.view(), /loading timeout|readback_deadline/);
  const wait = f.model.events.find(e => e.type === 'wait');
  assert.ok(wait.timeoutMs > 0 && wait.timeoutMs <= 15);
  assert.equal(f.model.events.filter(e => e.type === 'evaluate').length, 0);
});

for (const pathname of ['overall-prom/detail', 'uni-prom/detail']) {
  test(`${pathname}: all pages with reordered headers preserve exact long IDs and values`, async t => {
    const tasks = [fakeTask(ID), fakeTask(OTHER, { cost: '23.45', orders: '2', budget: '220', hours: '8' }),
      fakeTask('60000044', { cost: '9', orders: '1' })];
    const f = setup(t, { tasks, pageSize: 1, page: 3,
      headers: [HEADERS[3], HEADERS[6], HEADERS[0], HEADERS[5], HEADERS[1], HEADERS[4], HEADERS[2]],
      url: `https://qianchuan.jinritemai.com/${pathname}?aavid=60000000&adId=60000028`,
    });
    const out = await f.ui.readPool('调控中');
    assert.equal(out.pool.complete, true);
    assert.deepEqual(out.pages.map(p => p.page), [1, 2, 3]);
    assert.deepEqual(out.pool.tasks.map(r => r.task_id), tasks.map(r => r.id));
    assert.deepEqual(out.pool.tasks.map(r => r.cost), [12.9, 23.45, 9]);
    assert.equal(out.pool.tasks[1].payment_orders, 2);
    assert.equal(out.pool.tasks[1].budget, 220);
    assert.equal(out.pool.tasks[1].duration_hours, 8);
    assert.equal(marks(f, 'pool.rows').length, 3);
    assertNoSubmit(f);
  });
}

test('header order changes between pages are rejected even when each row fits its own headers', async t => {
  const f = setup(t, { tasks: [fakeTask(ID), fakeTask(OTHER)], pageSize: 1,
    headersByPage: { 2: [...HEADERS].reverse() } });
  await assert.rejects(f.ui.readPool('调控中'), /pool_changed_between_pages/);
  assert.equal(marks(f, 'pool.coverage').at(-1).status, 'read_failed');
  assertNoSubmit(f);
});

test('header order changes while evaluateAll reads a page cannot create a trusted capture', async t => {
  const f = setup(t, { afterEvent(e, m) { if (e.type === 'evaluate') m.headers.reverse(); } });
  await assert.rejects(f.ui.readPool('调控中'), /pool_changed_during_capture/);
  assert.equal(marks(f, 'pool.rows').length, 0);
});

test('missing next page with remaining records is a coverage failure', async t => {
  const f = setup(t, { tasks: [fakeTask(ID), fakeTask(OTHER)], pageSize: 1, missingPages: [2] });
  await assert.rejects(f.ui.readPool('调控中'), /pool_next_page_unverified/);
  assert.equal(marks(f, 'pool.rows').length, 1);
  assertNoSubmit(f);
});

test('max_pages cannot label a partial pool complete', async t => {
  const f = setup(t, { tasks: [fakeTask(ID), fakeTask(OTHER)], pageSize: 1 }, { max_pages: 1 });
  await assert.rejects(f.ui.readPool('调控中'), /pool_count_mismatch/);
  assert.equal(marks(f, 'pool.coverage').at(-1).complete, false);
});

test('duplicate ID across pages is rejected rather than silently deduplicated', async t => {
  const f = setup(t, { tasks: [fakeTask(ID), fakeTask(ID)], pageSize: 1 });
  await assert.rejects(f.ui.readPool('调控中'), /duplicate_task/);
  assert.equal(marks(f,'pool.rescan').length,1);assert.equal(marks(f,'pool.coverage').length,2);assertNoSubmit(f);
});

test('an 18-row pool with a moving page boundary restarts once and recovers the missing unique ID',async t=>{
  const tasks=Array.from({length:18},(_,i)=>fakeTask(String(BigInt(ID)+BigInt(i)),{status:'已暂停\n手动暂停'}));
  let moved=false;
  const f=setup(t,{tasks,pageSize:10,onEvent(e,m){
    if(!moved&&e.type==='click'&&e.role==='listitem'&&e.name==='2'){moved=true;m.tasks.unshift(m.tasks.pop());}
  }});
  const result=await f.ui.readPool('手动暂停');
  assert.equal(result.pool.complete,true);assert.equal(result.pool.tasks.length,18);
  assert.equal(new Set(result.pool.tasks.map(x=>x.task_id)).size,18);
  assert.equal(result.pool.tasks[0].task_id,tasks[17].id);
  assert.deepEqual(marks(f,'pool.coverage').map(x=>x.status),['read_failed','read_verified']);
  assert.equal(marks(f,'pool.rescan').length,1);assert.equal(f.model.refreshes,2);
  assertNoSubmit(f);assert.equal(f.model.events.some(e=>e.type==='search'),false);
});

test('perpetually moving page boundaries remain incomplete after the single whole-pool retry',async t=>{
  const tasks=Array.from({length:18},(_,i)=>fakeTask(String(BigInt(ID)+BigInt(i))));
  const f=setup(t,{tasks,pageSize:10,onEvent(e,m){
    if(e.type==='click'&&e.role==='listitem'&&e.name==='2')m.tasks.unshift(m.tasks.pop());
  }});
  await assert.rejects(f.ui.readPool('调控中'),/duplicate_task/);
  assert.equal(marks(f,'pool.rescan').length,1);assert.equal(marks(f,'pool.coverage').length,2);
  assert.ok(marks(f,'pool.coverage').every(x=>!x.complete));assertNoSubmit(f);
});

test('selector deadline in a missing paused-menu item allows only the existing two read-state retries',async t=>{
  let attempts=0;
  const f=setup(t,{onEvent(e){
    if(e.type==='click'&&e.name==='已暂停'&&++attempts<=2)throw Error('Playwright selector deadline exceeded: no_matches');
  }});
  await f.ui.choosePool('手动暂停');
  assert.equal(f.model.pool,'手动暂停');assert.equal(attempts,3);
  assert.equal(marks(f,'pool.attempt').length,2);assertNoSubmit(f);
});

test('a visible but incomplete status menu is reopened before retrying the paused pool',async t=>{
 let opens=0;
 const f=setup(t,{onEvent(e,m){if(e.type==='click'&&e.role==='textbox'&&e.name==='请选择')m.missingPausedParent=++opens===1;}});
 await f.ui.choosePool('手动暂停');
 assert.equal(f.model.pool,'手动暂停');assert.equal(marks(f,'pool.reopen').length,1);
 assert.ok(opens<=3);assertNoSubmit(f);
});

test('empty pool needs explicit count and empty message from a ready page', async t => {
  const f = setup(t, { tasks: [] });
  const out = await f.ui.readPool('手动暂停');
  assert.equal(out.pool.complete, true);
  assert.equal(out.pool.empty_verified, true);
  assert.deepEqual(out.pool.tasks, []);
});

test('exact ID read finds a manually paused task after it leaves the active pool', async t => {
  const f = setup(t, { tasks: [fakeTask(ID, { status: '已暂停\n手动暂停' }), fakeTask(OTHER)] });
  const read = await f.ui.readTask(ID);
  assert.equal(read.task.task_id, ID);
  assert.equal(read.task.status, '已暂停\n手动暂停');
  assert.equal(f.model.pool, '调控中');
  assert.deepEqual(f.model.events.filter(e => e.type === 'search').map(e => e.query), [ID, '']);
  assert.equal(f.model.search, '');
  assertNoSubmit(f);
});

test('non-exact search results cannot verify a neighboring ID', async t => {
  const f = setup(t, { tasks: [fakeTask(ID), fakeTask(ID + '0')], overbroadSearch: true });
  await assert.rejects(f.ui.readTask(ID), /exact_id_search_mismatch/);
  assert.equal(f.model.search, '');
  assertNoSubmit(f);
});

test('substring ID search returning the exact ID plus a longer prefix match is rejected safely', async t => {
  const f = setup(t, { tasks: [fakeTask(ID), fakeTask(ID + '0')] });
  await assert.rejects(f.ui.readTask(ID), /exact_id_search_mismatch/);
  assert.equal(f.model.search, '');
  assertNoSubmit(f);
});

test('main plan ID cannot be used as a task target', async t => {
  const f = setup(t);
  await assert.rejects(f.ui.readTask(f.binding.primary_ad_id), /invalid_boost_target/);
  assert.equal(f.model.events.length, 0);
  assertNoSubmit(f);
});

test('manual selection already present is preserved and blocks advertising dispatch', async t => {
  const f = setup(t, { tasks: [fakeTask(ID), fakeTask(OTHER)], selected: [OTHER] });
  const out = await f.run();
  assert.equal(out.effect_status, 'not_submitted');
  assert.equal(out.ad_writes, 0);
  assert.match(out.error, /human_draft_or_selection/);
  assert.deepEqual([...f.model.selected], [OTHER]);
  assertNoSubmit(f);
});

test('checkbox click that does not select the target blocks dispatch', async t => {
  const f = setup(t, { checkboxNoop: true });
  const out = await f.run();
  assert.equal(out.effect_status, 'not_submitted');
  assert.match(out.error, /selection_mismatch/);
  assert.equal(marks(f, 'task.select').length, 0);
  assertNoSubmit(f);
});

test('selection evaluation uses a DOM snapshot captured after the checkbox click',async t=>{
  let stale=false;
  const f=setup(t,{afterEvent(e){if(e.type==='click'&&e.role==='checkbox')stale=true;if(e.type==='snapshot')stale=false;}});
  const byRole=f.tab.playwright.getByRole;
  f.tab.playwright.getByRole=(...args)=>{
    const locator=byRole(...args);
    if(args[0]==='row') {
      const filter=locator.filter.bind(locator);
      locator.filter=(options)=>{
        const rows=filter(options),evaluate=rows.evaluateAll.bind(rows);
        rows.evaluateAll=callback=>{
          if(callback.toString().includes('aria-checked')&&stale)throw Error('selection_evaluation_before_fresh_snapshot');
          return evaluate(callback);
        };
        return rows;
      };
    }
    return locator;
  };
  const out=await f.run();assert.equal(out.effect_status,'write_verified');
  assert.equal(f.model.events.filter(e=>e.type==='click'&&e.role==='checkbox').length,1);
});

test('checkbox unexpectedly also selecting another visible row blocks dispatch and preserves external selection', async t => {
  const f = setup(t, { tasks: [fakeTask(ID), fakeTask(OTHER)], afterEvent(e, m) {
    if (e.type === 'click' && e.role === 'checkbox') { m.selected.add(OTHER); m.appliedSearch = ''; }
  } });
  const out = await f.run();
  assert.equal(out.ad_writes, 0);
  assert.match(out.error, /selection_mismatch/);
  assert.ok(f.model.selected.has(OTHER));
  assertNoSubmit(f);
});

test('checkbox selecting an extra off-search row must not dispatch direct stop against the hidden ID', async t => {
  const f = setup(t, { tasks: [fakeTask(ID), fakeTask(OTHER)], afterEvent(e, m) {
    if (e.type === 'click' && e.role === 'checkbox') m.selected.add(OTHER);
  } });
  const out = await f.run({ action: 'stop' });
  assertNoSubmit(f);
  assert.equal(out.effect_status, 'not_submitted');
  assert.ok(f.model.selected.has(OTHER));
});

test('clearSelection never clears an ID outside the explicitly owned selection', async t => {
  const f = setup(t, { tasks: [fakeTask(ID), fakeTask(OTHER)], selected: [ID, OTHER] });
  await assert.rejects(f.ui.clearSelection([ID]), /external_selection_changed/);
  assert.deepEqual([...f.model.selected], [ID, OTHER]);
  assert.equal(f.model.events.filter(e => e.type === 'click').length, 0);
});

test('single pause submits once from the visible row and verifies the manual-paused pool without search', async t => {
  const f = setup(t);
  const out = await f.run();
  assert.equal(out.ok, true);
  assert.equal(out.effect_status, 'write_verified');
  assert.equal(out.ad_writes, 1);
  assert.deepEqual(out.verified, [ID]);
  assert.deepEqual(f.model.submitted, [{ action: 'pause', ids: [ID] }]);
  assert.equal(out.before[0].status, '调控中');
  assert.equal(out.after[0].status, '已暂停\n手动暂停');
  assert.equal(marks(f, 'action.readback').length, 1);
  assert.equal(f.model.search, '');
  assert.equal(f.model.pool,'调控中');assert.equal(marks(f,'pool.restore').at(-1).status,'read_verified');
  assert.equal(f.model.events.filter(e=>e.type==='search'||e.type==='fill'||e.type==='click'&&e.name===ALL).length,0);
  assert.deepEqual(marks(f,'pool.rows').map(c=>c.pool),['手动暂停']);
});

test('lookup failure restores the active pool but never clears a human selection',async t=>{
  const f=setup(t,{tasks:[fakeTask(ID),fakeTask(ID+'0')]});
  await assert.rejects(f.ui.readTask(ID),/exact_id_search_mismatch/);assert.equal(f.model.pool,'调控中');assertNoSubmit(f);
  const other=setup(t);await other.ui.choosePool(ALL);other.model.selected.add(ID);
  assert.equal((await other.ui.restoreDefaultPool()).status,'unknown');assert.ok(other.model.selected.has(ID));assert.equal(other.model.pool,ALL);assertNoSubmit(other);
});
test('finishing a lookup preserves a human pool change and failed restoration never resubmits',async t=>{
  const f=setup(t);await f.ui.choosePool(ALL);f.model.pool='手动暂停';
  assert.equal((await f.ui.restoreDefaultPool()).status,'external_filter_preserved');assert.equal(f.model.pool,'手动暂停');assertNoSubmit(f);
  const broken=setup(t,{onEvent(e,m){if(m.submitted.length&&e.type==='click'&&e.name==='调控中')throw Error('restore menu unavailable');}});
  const out=await broken.run();assert.equal(out.ok,true);assert.equal(broken.model.submitted.length,1);
  assert.equal(marks(broken,'pool.restore').at(-1).status,'attempt_failed');
});

test('batch pause verifies every exact ID after all targets leave the original active pool', async t => {
  const f = setup(t, { tasks: [fakeTask(ID), fakeTask(OTHER), fakeTask('60000044')] });
  const out = await f.run({ target_ids: [ID, OTHER] });
  assert.equal(out.ok, true);
  assert.equal(out.confirmed_writes, 2);
  assert.deepEqual(out.verified, [ID, OTHER]);
  assert.deepEqual(f.model.submitted, [{ action: 'pause', ids: [ID, OTHER] }]);
  assert.equal(f.model.tasks.find(r => r.id === '60000044').status, '调控中');
  assert.equal(marks(f, 'action.readback').length, 2);
  assert.equal(f.model.events.filter(e=>e.type==='search'||e.type==='click'&&e.name===ALL).length,0);
  assert.deepEqual(marks(f,'pool.rows').map(c=>c.pool),['手动暂停']);
});

test('normal target reads scan the two pools once for several IDs without any search',async t=>{
  const f=setup(t,{tasks:[fakeTask(ID),fakeTask(OTHER,{status:'已暂停\n手动暂停'})]});
  const out=await f.ui.readTargets([ID,OTHER,ID]);
  assert.deepEqual(out.targets.map(r=>r.task.task_id),[ID,OTHER]);assert.ok(out.targets.every(r=>r.complete));
  assert.deepEqual(marks(f,'pool.rows').map(c=>c.pool),['手动暂停','调控中']);
  assert.equal(f.model.events.filter(e=>e.type==='search'||e.type==='click'&&e.name===ALL).length,0);assertNoSubmit(f);
});

test('recovery expands to all states only for missing IDs, including a system-paused task',async t=>{
  const system='60000044';
  const f=setup(t,{tasks:[fakeTask(ID),fakeTask(OTHER,{status:'已暂停\n手动暂停'}),fakeTask(system,{status:'已暂停\n关联直播间未开播'})]});
  const normal=await f.ui.readTargets([system]);assert.equal(normal.targets[0].task,null);
  assert.equal(f.model.events.filter(e=>e.type==='search').length,0);
  const recovery=await f.ui.readTargets([ID,OTHER,system],{allow_all:true});
  assert.equal(recovery.targets[2].task.task_id,system);assert.equal(f.model.pool,'调控中');
  assert.deepEqual(f.model.events.filter(e=>e.type==='search').map(e=>e.query),[system,'']);
  assert.deepEqual(marks(f,'target.fallback').map(c=>c.target_id),[system]);assertNoSubmit(f);
});

test('a target on another page is searched only within its source pool',async t=>{
  const f=setup(t,{tasks:[fakeTask(OTHER),fakeTask(ID)],pageSize:1});
  const out=await f.run({readback_timeout_ms:1000});assert.equal(out.effect_status,'write_verified');
  assert.deepEqual(f.model.events.filter(e=>e.type==='search').map(e=>e.query),[ID,'']);
  assert.equal(f.model.events.filter(e=>e.type==='click'&&e.name===ALL).length,0);
  assert.equal(marks(f,'target.search')[0].pool,'调控中');assert.deepEqual(f.model.submitted,[{action:'pause',ids:[ID]}]);
});

test('search-disabled off-page pause navigates pagination and verifies without a search write',async t=>{
  const f=setup(t,{tasks:[fakeTask(OTHER),fakeTask(ID)],pageSize:1},{allow_search:false,allowed_pools:['手动暂停','调控中']});
  const read=await f.ui.readTask(ID);assert.equal(read.task.task_id,ID);
  const out=await f.run({readback_timeout_ms:1000,allow_search:false,allowed_pools:['手动暂停','调控中']});
  assert.equal(out.effect_status,'write_verified');assert.equal(f.model.events.filter(e=>e.type==='search').length,0);
  assert.ok(!f.model.events.some(e=>e.type==='click'&&e.name===ALL));assert.deepEqual(f.model.submitted,[{action:'pause',ids:[ID]}]);
});

test('cross-page batch never submits a partially visible selection',async t=>{
  const f=setup(t,{tasks:[fakeTask(ID),fakeTask(OTHER)],pageSize:1});
  const out=await f.run({target_ids:[ID,OTHER]});assert.equal(out.effect_status,'not_submitted');
  assert.match(out.error,/batch_targets_not_on_same_visible_page/);assertNoSubmit(f);
});

test('resume reads its source and result pools directly, without all-state search',async t=>{
  const f=setup(t,{tasks:[fakeTask(ID,{status:'已暂停\n手动暂停'}),fakeTask(OTHER)]});
  const out=await f.run({action:'resume'});assert.equal(out.effect_status,'write_verified');
  assert.equal(f.model.pool,'调控中');assert.equal(f.model.events.filter(e=>e.type==='search'||e.type==='click'&&e.name===ALL).length,0);
});

test('asynchronous deselection is observed to settle without clicking again',async t=>{
  let delayed=false,ax=0;
  const f=setup(t,{readbackDelayRefreshes:1,selectionReplacesFilters:true,afterEvent(e,m){
    if(e.type==='uncheck'&&m.submitted.length){m.selected.add(ID);delayed=true;}
    if(e.type==='ax'&&delayed&&++ax===2){m.selected.delete(ID);delayed=false;}
  }});
  const out=await f.run({readback_timeout_ms:1000});assert.equal(out.effect_status,'write_verified');
  assert.equal(f.model.events.filter(e=>e.type==='uncheck').length,1);
  assert.equal(f.model.events.filter(e=>e.type==='click'&&e.role==='checkbox').length,1);
  assert.equal(f.model.submitted.length,1);assert.equal(f.model.selected.size,0);
});

test('deselection that never settles remains unknown and is never toggled repeatedly',async t=>{
  const f=setup(t,{readbackDelayRefreshes:1,afterEvent(e,m){
    if(e.type==='uncheck'&&m.submitted.length)m.selected.add(ID);
  }});
  const out=await f.run({readback_timeout_ms:1000});assertUnknown(out,f);assert.match(out.error,/selection_not_cleared/);
  assert.equal(f.model.events.filter(e=>e.type==='uncheck').length,1);
  assert.equal(f.model.events.filter(e=>e.type==='click'&&e.role==='checkbox').length,1);
});

test('real residual checkbox shape uses explicit uncheck instead of a toggle that leaves it selected',async t=>{
  const f=setup(t,{readbackDelayRefreshes:1,selectionReplacesFilters:true,afterEvent(e,m){
    if(e.type==='click'&&e.role==='checkbox'&&m.submitted.length)m.selected.add(ID);
  }});
  const out=await f.run({readback_timeout_ms:1000});assert.equal(out.effect_status,'write_verified');
  assert.equal(f.model.events.filter(e=>e.type==='uncheck').length,1);assert.equal(f.model.selected.size,0);
  assert.deepEqual(f.model.submitted,[{action:'pause',ids:[ID]}]);
});

test('a human search blocks normal target scans without replacing their input',async t=>{
  const f=setup(t,{search:'human-search'});
  await assert.rejects(f.ui.readTargets([ID]),/task_search_not_empty/);
  assert.equal(f.model.search,'human-search');assert.equal(f.model.events.filter(e=>e.type==='fill').length,0);assertNoSubmit(f);
});

for (const [action, initial, expected] of [
  ['resume', '已暂停\n手动暂停', '调控中'], ['stop', '调控中', '调控结束'],
  ['delete', '已暂停\n手动暂停', '已删除'],
]) {
  test(`${action} verifies its explicit final status with a single dispatch`, async t => {
    const f = setup(t, { tasks: [fakeTask(ID, { status: initial })] });
    const out = await f.run({ action });
    assert.equal(out.ok, true);
    assert.equal(out.after[0].status, expected);
    assert.deepEqual(f.model.submitted, [{ action, ids: [ID] }]);
    assert.equal(f.model.events.filter(e => e.type === 'click' && e.name === '确定').length, action === 'delete' ? 1 : 0);
  });
}

// Regression shape observed in 示例甲 selection-filter-inspect.json: selecting
// a row replaces all three filters AND search with “已选1个 任务” and buttons.
for(const action of ['pause','resume','stop','delete'])test('real selection-toolbar shape preserves verified context for '+action,async t=>{
  const initial=['resume','delete'].includes(action)?'已暂停\n手动暂停':'调控中';
  const f=setup(t,{tasks:[fakeTask(ID,{status:initial})],selectionReplacesFilters:true});
  const out=await f.run({action});assert.equal(out.ok,true);assert.equal(f.model.submitted.length,1);
  assert.equal(f.model.pool,'调控中');assert.equal(f.model.selected.size,0);
  assert.ok(marks(f,'selection.context').length>0);
  for(const mark of marks(f,'selection.context')){assert.deepEqual(mark.visible_filters,[]);assert.deepEqual(mark.selected_ids,[ID]);assert.equal(mark.selected_total,1);}
});
test('hidden selection filters without a verified own selection context cannot authorize dispatch',async t=>{
  const f=setup(t,{selected:[ID],selectionReplacesFilters:true});
  await assert.rejects(f.ui.verifySelection([ID]),/extra_pool_filter/);assertNoSubmit(f);
});

test('dry run observes and validates without selecting or submitting', async t => {
  const f = setup(t);
  const out = await f.run({ execute: false });
  assert.equal(out.mode, 'dry_run');
  assert.equal(out.ad_writes, 0);
  assert.equal(f.model.events.filter(e => e.type === 'click' && e.role === 'checkbox').length, 0);
  assertNoSubmit(f);
  assert.equal(f.model.search, '');
});

test('readback delay repeats only reads and waits for actual applied status', async t => {
  const f = setup(t, { readbackDelayRefreshes: 3 });
  const out = await f.run({ readback_timeout_ms: 1000 });
  assert.equal(out.ok, true);
  assert.equal(out.after[0].status, '已暂停\n手动暂停');
  assert.equal(f.model.submitted.length, 1);
  assert.ok(f.model.refreshes >= 4, 'One preflight refresh and three readback refreshes');
  const submitted = f.model.events.findIndex(e => e.type === 'submit');
  const refreshed = f.model.events.slice(submitted).filter(e => e.type === 'click' && e.role === 'columnheader');
  assert.equal(refreshed.length, 3);
  assert.equal(marks(f, 'action.readback').length, 1);
});

test('unchanged status times out as unknown and never re-dispatches', async t => {
  const f = setup(t, { neverApply: true });
  const out = await f.run({ readback_timeout_ms: 60 });
  assertUnknown(out, f);
  assert.equal(out.confirmed_writes, 0);
  assert.equal(marks(f, 'action.readback').length, 0);
  assert.equal(f.model.tasks[0].status, '调控中');
});

test('disappearing task cannot prove deletion; unknown must not re-dispatch', async t => {
  const f = setup(t, { tasks: [fakeTask(ID, { status: '已暂停\n手动暂停' })], disappearAfterSubmit: true });
  const out = await f.run({ action: 'delete', readback_timeout_ms: 60 });
  assertUnknown(out, f);
  assert.equal(out.confirmed_writes, 0);
});

for (const stage of ['submit', 'ax', 'snapshot']) {
  test(`disconnect at ${stage} after dispatch preserves unknown receipt and never resends`, async t => {
    const f = setup(t, { neverApply: stage === 'ax', afterEvent(e, m) {
      if (m.submitted.length && e.type === stage) m.disconnected = true;
    } });
    let out, error;
    try { out = await f.run(); } catch (e) { error = e; }
    assert.equal(f.model.submitted.length, 1, 'Even on disconnect there must be exactly one dispatch');
    assert.equal(marks(f, 'action.failure').at(-1).dispatched, true);
    assert.equal(error, undefined, 'Browser cleanup failures must not mask the unconfirmed advertising receipt');
    assertUnknown(out, f);
    assert.equal(out.confirmed_writes, 0);
  });
}

test('readback loading timeout after accepted submission is unknown with one dispatch', async t => {
  const f = setup(t, { loadingNeverEnds: true, afterEvent(e, m) {
    if (e.type === 'submit') m.loading = true;
  } });
  const out = await f.run({ readback_timeout_ms: 40 });
  assertUnknown(out, f);
  assert.match(out.error, /loading timeout|readback_deadline/);
});

test('human changes status pool while rows are being captured: abort without submission', async t => {
  const f = setup(t, { afterEvent(e, m) { if (e.type === 'evaluate') m.pool = '手动暂停'; } });
  await assert.rejects(f.ui.readPool('调控中'), /pool_changed_during_capture/);
  assert.equal(f.model.pool, '手动暂停');
  assertNoSubmit(f);
});

test('human changes an extra filter: do not retry the menu or overwrite their choice', async t => {
  const f = setup(t, { filters: ['素材追投', '全部'] });
  await assert.rejects(f.ui.choosePool(ALL), /extra_pool_filter/);
  assert.equal(marks(f, 'pool.attempt').length, 1);
  assert.equal(f.model.events.filter(e => e.type === 'click').length, 0);
  assert.equal(f.model.filters[0], '素材追投');
});

test('human changes search during capture: preserve their input when abandoning our query', async t => {
  const f = setup(t, { afterEvent(e, m) {
    if (e.type === 'evaluate' && m.search === ID) { m.search = 'human-query'; m.appliedSearch = 'human-query'; }
  } });
  await assert.rejects(f.ui.readTask(ID), /task_search_not_empty/);
  assert.equal(f.model.search, 'human-query');
  assert.deepEqual(f.model.events.filter(e => e.type === 'fill').map(e => e.value), [ID]);
  assertNoSubmit(f);
});

test('human filter changes in before_submit must block the confirmation submission', async t => {
  const f = setup(t);
  const out = await f.run({ before_submit: () => { f.model.filters[0] = '素材追投'; } });
  assertNoSubmit(f);
  assert.equal(out.effect_status, 'not_submitted');
  assert.equal(f.model.filters[0], '素材追投');
});

test('human adds another selection while confirmation is open: never submit an unrequested ID', async t => {
  const f = setup(t, { tasks: [fakeTask(ID), fakeTask(OTHER)], onEvent(e, m) {
    if (e.type === 'checkpoint' && e.id === 'action.confirm') m.selected.add(OTHER);
  } });
  const out = await f.run();
  assertNoSubmit(f);
  assert.notEqual(out.effect_status, 'write_verified');
  assert.ok(f.model.selected.has(OTHER));
});

test('target crosses the zero-order threshold condition before submit: validate fresh values', async t => {
  const f = setup(t);
  let validated = 0;
  const out = await f.run({ zero_order_threshold: 5, validate_before: () => {
    if (++validated === 1) f.model.tasks[0].orders = '1';
  } });
  assert.equal(out.effect_status, 'not_submitted');
  assert.match(out.error, /zero_order_condition_changed/);
  assertNoSubmit(f);
});

test('each successful checkbox is checkpointed before the next checkbox and final submit', async t => {
  const f = setup(t, { tasks: [fakeTask(ID), fakeTask(OTHER)] });
  const out = await f.run({ target_ids: [ID, OTHER] });
  assert.equal(out.ok, true);
  const events = f.model.events;
  const clicks = events.flatMap((e, i) => e.type === 'click' && e.role === 'checkbox' ? [i] : []);
  const saved = events.flatMap((e, i) => e.type === 'checkpoint' && e.id === 'task.select' ? [i] : []);
  assert.ok(clicks[0] < saved[0] && saved[0] < clicks[1] && clicks[1] < saved[1]);
  assert.ok(saved[1] < events.findIndex(e => e.type === 'submit'));
  for (const c of f.model.checkpoints) {
    assert.equal(c.channel, 'codex-cua');
    assert.equal(c.evidence_origin, 'isolated_fixture');
    assert.deepEqual(c.binding, f.binding);
  }
});


for (const action of ['pause', 'resume']) {
  test('ready '+action+' confirmation adds no wait before confirm', async t => {
    const f = setup(t, { tasks: [fakeTask(ID, {status: action === 'resume' ? '已暂停\n手动暂停' : '调控中'})], confirmActions: ['resume'] });
    const out = await f.run({ action });
    assert.equal(out.effect_status, 'write_verified');
    const open = f.model.events.findIndex(e => e.type === 'click' && e.name === (action === 'pause' ? '暂停' : '开启'));
    const confirm = f.model.events.findIndex((e, i) => i > open && e.type === 'click' && e.name === '确定');
    assert.ok(open >= 0 && confirm > open);
    assert.equal(f.model.events.slice(open + 1, confirm).some(e => e.type === 'wait'), false);
    assert.equal(f.model.submitted.length, 1);
  });
  test(action+' final confirmation hook cannot change selection and still submit', async t => {
    const status = action === 'resume' ? '已暂停\n手动暂停' : '调控中';
    const f = setup(t, { tasks: [fakeTask(ID, {status}), fakeTask(OTHER, {status})], confirmActions: ['resume'] });
    const out = await f.run({ action, validate_before: async ({phase}) => {
      if (phase === 'confirmation') f.model.selected.add(OTHER);
    }});
    assertNoSubmit(f);
    assert.notEqual(out.effect_status, 'write_verified');
    assert.ok(f.model.selected.has(OTHER));
  });
}
