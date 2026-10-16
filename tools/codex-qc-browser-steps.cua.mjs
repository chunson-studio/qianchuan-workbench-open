// Codex CUA only. All DOM access uses the caller's bound tab; evidence is local.
import { inspectPlanDom, normalizePoolPages, selectedTaskCount, planTabs, planIdentity } from './codex-qc-browser-data.mjs';

const iso = () => new Date().toISOString();
const validId = id => typeof id === 'string' && /^\d+$/.test(id);
const loadingText = dom => dom.match(/- (?:generic|text): (加载中\.{0,3}|正在加载\.{0,3})\s*(?:\n|$)/)?.[1];
const activePageSelector = '.main-vmok-plugin-page-turner__item--active, .ovui-page-turner__item--active';
export async function confirmQianchuanAction(tab, {expected_text, timeout_ms=800}) {
  const started=Date.now();
  if(typeof expected_text!=='string'||!expected_text)throw Error('expected_confirmation_required');
  const dom=await tab.playwright.domSnapshot();
  if(!dom.includes(expected_text))return {status:'confirmation_missing',retry_write:false,elapsed_ms:Date.now()-started};
  const button=tab.playwright.getByRole('button',{name:'确定',exact:true});
  if(await button.count()!==1)return {status:'confirmation_not_unique',retry_write:false,elapsed_ms:Date.now()-started};
  try {
    await button.click({timeoutMs:Math.max(1,Math.min(1000,timeout_ms))});
    return {status:'submitted_pending_readback',retry_write:false,elapsed_ms:Date.now()-started};
  } catch(error) {
    return {status:'submission_unknown',retry_write:false,error:String(error.message||error),elapsed_ms:Date.now()-started};
  }
}
export function createQianchuanBrowserSteps({tab, binding, checkpoint, max_pages = 100, allowed_pools = ['手动暂停','调控中','全部（包括已删除）'], allow_search = true}) {
  if (!tab || !binding?.date || !validId(binding.advertiser_id) || !validId(binding.primary_ad_id)
      || typeof checkpoint !== 'function') throw Error('Bound tab, account, main plan, date and checkpoint required');
  let ownSearch = null, ownPool = null, selectionContext = null, deadline = Infinity;
  const checkTime=()=>{if(Date.now()>=deadline)throw Error('readback_deadline');};
  const save = (id,status,data={}) => checkpoint({id,status,channel:'codex-cua',observed_at:iso(),binding,...data});
  async function boundUrl() {
    checkTime();
    const url = new URL(await tab.url());
    if (url.protocol !== 'https:' || url.hostname !== 'qianchuan.jinritemai.com'
        || !['/overall-prom/detail','/uni-prom/detail'].includes(url.pathname)
        || url.searchParams.get('aavid') !== binding.advertiser_id || url.searchParams.get('adId') !== binding.primary_ad_id) throw Error('plan_url_mismatch');
    return url;
  }
  async function snapshot() {
    for(let attempt=0;attempt<2;attempt++) {
      await boundUrl();
      try {return await tab.playwright.domSnapshot();}
      catch(error) {
        if(attempt||!/Detached while handling command/i.test(String(error.message)))throw error;
        await save('plan.read.retry','attempt_failed',{error:String(error.message),attempt});
        await tab.getAXState({emit:false}); // Reobserve only; never reload or retry an ad submit.
      }
    }
  }
  async function view({allow_selection=false}={}) {
    let dom=await snapshot();
    for(let loadingAttempt=0;loadingAttempt<3;loadingAttempt++) {
      const loading=loadingText(dom);
      if(!loading)break;
      await save('plan.loading','observed',{dom});
      // The loading node can disappear between the snapshot and locator wait.
      // Prefer a fresh bound snapshot; never treat no_matches diagnostics alone
      // as readiness or use the old loading/empty table as current data.
      dom=await snapshot();
      if(!loadingText(dom)) {
        await save('plan.loading.recovered','observed',{dom,basis:'fresh_snapshot_before_wait'});
        break;
      }
      try {
        checkTime();
        await tab.playwright.getByText(loadingText(dom),{exact:true}).waitFor({state:'hidden',timeoutMs:Math.max(1,Math.min(5000,deadline-Date.now()))});
      } catch(error) {
        await save('plan.loading.wait','attempt_failed',{dom,error:String(error.message)});
        checkTime();
        const recovered=await snapshot();
        if(loadingText(recovered))throw error;
        dom=recovered;
        await save('plan.loading.recovered','observed',{dom,basis:'fresh_snapshot_after_wait_failure'});
        break;
      }
      await tab.getAXState({emit:false});
      dom=await snapshot();
    }
    let identity=planIdentity(dom,binding),account_dom;
    if(identity.missing_account&&!identity.missing_plan&&!identity.conflict) {
      const boxes=await tab.playwright.locator('.account-info-box').evaluateAll(es=>es.map(e=>({text:e.textContent,display:getComputedStyle(e).display})));
      if(boxes.length===1&&boxes[0].display==='none') {
        account_dom={selector:'.account-info-box',...boxes[0],captured_at:iso()};
        identity=planIdentity(dom,binding,{account_dom});
        await save('plan.identity.responsive',identity.verified?'read_verified':'read_failed',{dom,account_dom,identity});
      }
    }
    if(!identity.conflict&&(identity.missing_account||identity.missing_plan)) {
      await save('plan.identity.pending','observed',{dom,identity});
      try {
        for(const label of [identity.missing_account?'ID：'+binding.advertiser_id:null,identity.missing_plan?'计划ID：'+binding.primary_ad_id:null].filter(Boolean)) {
          checkTime();
          await tab.playwright.getByText(label,{exact:true}).waitFor({state:'visible',timeoutMs:Math.max(1,Math.min(5000,deadline-Date.now()))});
        }
        dom=await snapshot();identity=planIdentity(dom,binding,{account_dom});
      } catch(error) {
        await save('plan.identity.pending','read_failed',{dom,error:String(error.message)});
        throw Error('plan_identity_not_ready:'+error.message);
      }
      if(!identity.verified&&!identity.conflict){await save('plan.identity.pending','read_failed',{dom,identity});throw Error('plan_identity_not_ready');}
    }
    const url=await boundUrl();
    const inspected=inspectPlanDom(dom,binding,{allow_selection,search:ownSearch,selection_context:selectionContext,account_dom});
    if(inspected.issues.length) {await save('plan.invalid','read_failed',{dom,issues:inspected.issues});throw Error(inspected.issues.join(','));}
    return {raw:{url:url.href,tab_id:tab.id,dom,captured_at:iso(),...(account_dom?{account_dom}:{})},view:inspected};
  }
  async function step(id,operation,verify,options) {
    checkTime();
    await save(id+'.start','started');
    await operation();
    const result=await view(options), ok=!verify || await verify(result.raw,result.view);
    await save(id,ok?'read_verified':'read_failed',result.raw);
    if(!ok)throw Error(id+'_not_verified');return result;
  }
  async function choosePoolFromObservation(pool, observation) {
    if(!['调控中','手动暂停','全部（包括已删除）'].includes(pool))throw Error('unsupported_pool');
    if(!allowed_pools.includes(pool))throw Error('pool_not_authorized');
    let error;
    // Initial attempt plus at most two observed-state retries; never retry a submit.
    for(let attempt=0;attempt<3;attempt++) {
      try {
        const before=attempt===0&&observation?observation:await view();
        if(before.view.filters.length!==3 || before.view.filters.slice(0,2).some(v=>v && v!=='全部'))throw Error('extra_pool_filter');
        if(before.view.actual_filter===pool){ownPool=pool;await save('pool.reuse','read_verified',{pool,...before.raw});return before;}
        const menu=tab.playwright.getByRole('list').filter({hasText:'全部（包括已删除）'}).filter({visible:true});
        if(attempt>0&&await menu.count()===1&&pool==='手动暂停'
          &&await menu.getByText('已暂停',{exact:true}).count()===0
          &&await tab.playwright.getByRole('list').filter({hasText:'关联直播间未开播'}).filter({visible:true}).getByText(pool,{exact:true}).count()===0) {
          await step('pool.reopen',()=>tab.playwright.getByRole('textbox',{name:'请选择',exact:true}).nth(2).click());
        }
        if(await menu.count()!==1)await step('pool.open',()=>tab.playwright.getByRole('textbox',{name:'请选择',exact:true}).nth(2).click());
        if(pool==='手动暂停') {
          const submenu=tab.playwright.getByRole('list').filter({hasText:'关联直播间未开播'}).filter({visible:true});
          if(await submenu.count()!==1)await step('pool.parent',()=>menu.getByText('已暂停',{exact:true}).click());
          await step('pool.select',()=>submenu.getByText(pool,{exact:true}).click(),(_,v)=>v.actual_filter===pool);
        } else await step('pool.select',()=>menu.getByText(pool,{exact:true}).click(),(_,v)=>v.actual_filter===pool);
        ownPool=pool;return;
      } catch(e) {
        error=e;await save('pool.attempt','attempt_failed',{pool,attempt,error:String(e.message)});
        if(/identity|mismatch|human_|extra_pool_filter|task_search|readback_deadline/.test(e.message))throw e;
      }
    }
    throw error;
  }
  // Observations are passed only within this call chain, never accepted from callers.
  const choosePool=pool=>choosePoolFromObservation(pool);
  async function openTab(name) {
    if(!['数据','素材','调控','详情','日志','效果诊断','保障历史'].includes(name))throw Error('unsupported_plan_tab');
    const before=await view();
    const observed=planTabs(before.raw.dom).filter(t=>t.name===name);
    if(observed.length>1)throw Error('plan_tab_not_unique');
    const role=tab.playwright.getByRole('tab',{name:observed[0]?.accessible_name??name,exact:true});
    const selected=raw=>{const tabs=planTabs(raw.dom).filter(t=>t.name===name);return tabs.length===1&&tabs[0].selected;};
    const roleCount=await role.count();
    if(roleCount>1)throw Error('plan_tab_not_unique');
    if(roleCount===1){
      if(selected(before.raw)){await save('tab.'+name,'read_verified',{...before.raw,reused:true});return before;}
      return step('tab.'+name,()=>role.click(),selected);
    }
    const text=tab.playwright.locator('.ovui-tabs__tab-btn').getByText(name,{exact:true});
    if(await text.count()!==1)throw Error('plan_tab_not_unique');
    if(await text.evaluate(e=>Boolean(e.closest('.row.tab--active')))){await save('tab.'+name,'read_verified',{...before.raw,reused:true});return before;}
    return step('tab.'+name,()=>text.click(),()=>text.evaluate(e=>Boolean(e.closest('.row.tab--active'))));
  }
  async function readPool(pool) {
    for(let attempt=0;attempt<2;attempt++) {
      try{return await readPoolOnce(pool);}
      catch(error) {
        if(attempt||error.pool_rescan_allowed!==true)throw error;
        await save('pool.rescan','attempt_failed',{pool,attempt,error:String(error.message),reason:'duplicate_across_pages'});
      }
    }
  }
  async function readPoolOnce(pool) {
    await save('pool.read','started',{pool});
    const opened=await openTab('调控');
    await choosePoolFromObservation(pool,opened);
    const refreshed=await step('pool.refresh',()=>tab.playwright.getByRole('columnheader',{name:'调控消耗',exact:true}).click(),(_,v)=>v.actual_filter===pool);
    const first=tab.playwright.getByRole('listitem').filter({hasText:/^1$/});
    // If every reported row is already visible, pagination cannot add coverage.
    // Otherwise keep the conservative reset; never guess the active page class.
    const visibleCount=await tab.playwright.getByRole('row').filter({hasText:'ID:'}).count();
    if(visibleCount!==refreshed.view.total && await first.count()===1)await step('pool.page.1',async()=>{
      await first.click();
      await tab.playwright.locator(activePageSelector).filter({hasText:/^1$/}).waitFor({state:'visible',timeoutMs:5000});
    });
    const pages=[];
    for(let page=1;page<=max_pages;page++) {
      const before=await view();
      if(before.view.actual_filter!==pool || before.view.total===null)throw Error('pool_filter_or_total_unverified');
      const rows=await tab.playwright.getByRole('row').filter({hasText:'ID:'})
        .evaluateAll(es=>es.map(e=>Array.from(e.querySelectorAll('td')).map(c=>c.innerText)));
      const after=await view();
      if(after.view.actual_filter!==pool || after.view.total!==before.view.total || JSON.stringify(after.view.headers)!==JSON.stringify(before.view.headers))throw Error('pool_changed_during_capture');
      pages.push({...before.raw,page,rows});
      await save('pool.rows','observed',{pool,...pages.at(-1)});
      if(pages.reduce((n,p)=>n+p.rows.length,0)>=before.view.total)break;
      if(!rows.length)throw Error('pool_page_empty_before_total');
      const next=tab.playwright.getByRole('listitem').filter({hasText:new RegExp('^'+(page+1)+'$')});
      if(await next.count()!==1)throw Error('pool_next_page_unverified');
      await step('pool.page.'+(page+1),async()=>{
        await next.click();
        await tab.playwright.locator(activePageSelector).filter({hasText:new RegExp('^'+(page+1)+'$')}).waitFor({state:'visible',timeoutMs:5000});
      });
    }
    const normalized=normalizePoolPages(pages,pool,binding,{search:ownSearch});
    await save('pool.coverage',normalized.complete?'read_verified':'read_failed',{pool,complete:normalized.complete,issues:normalized.issues,total:normalized.total});
    if(!normalized.complete) {
      const error=Error('pool_incomplete:'+JSON.stringify(normalized.issues));
      // Changing sort positions during pagination can move a boundary row.
      // Restart the whole read once; never deduplicate and claim full coverage.
      error.pool_rescan_allowed=pages.length>1&&pages.length<max_pages
        &&normalized.issues.some(i=>i.code==='duplicate_task')
        &&normalized.issues.every(i=>['duplicate_task','pool_count_mismatch'].includes(i.code));
      throw error;
    }
    return {pages,pool:normalized};
  }
  async function queryTask(query,byName=false,keep_search=false,restore=true,poolName='调控中') {
    if(!allow_search)throw Error('task_search_not_authorized');
    if(byName ? typeof query!=='string'||!query.trim()||query.length>50||/[\r\n\u0000]/.test(query) : !validId(query) || query===binding.primary_ad_id)throw Error('invalid_boost_target');
    const search=tab.playwright.getByRole('textbox',{name:'输入任务名称或ID搜索',exact:true});
    const opened=await openTab('调控');
    await choosePoolFromObservation(poolName,opened);
    ownSearch=query;
    try {
      await search.fill(query);await search.press('Enter');
      const {pool}=await readPool(poolName);
      const matches=pool.tasks.filter(t=>(byName?t.name:t.task_id)===query);
      // Platform name search can return several fuzzy matches. Match the full
      // name locally over the complete result; never select a neighboring row.
      if((!byName&&pool.tasks.some(t=>t.task_id!==query)) || matches.length>1)throw Error('exact_id_search_mismatch');
      return {task:matches[0]??null,captured_at:pool.captured_at,binding,complete:pool.complete};
    } finally {if(!keep_search){try{await releaseSearch();}finally{if(restore)await restoreDefaultPool();}}}
  }
  async function releaseSearch() {
      if(ownSearch===null)return {status:'not_needed'};
      // Only clear our own query; a concurrently changed search belongs to its author.
      const raw=await tab.playwright.domSnapshot();
      const actual=raw.match(/- textbox "输入任务名称或ID搜索": ([^\n]+)/)?.[1]?.replace(/^"|"$/g,'')??'';
      if(actual===ownSearch){const search=tab.playwright.getByRole('textbox',{name:'输入任务名称或ID搜索',exact:true});await search.fill('');await search.press('Enter');await save('search.clear','read_verified',{query:ownSearch});}
      ownSearch=null;
  }
  // Helper lookups are temporary. Never overwrite a person's intervening
  // search, selection or filter, and never mask an advertising receipt on cleanup.
  async function restoreDefaultPool() {
    if(!ownPool||ownPool==='调控中')return {status:'not_needed'};
    const savedDeadline=deadline;deadline=Date.now()+5000;
    try {
      await save('pool.restore.start','started',{pool:'调控中'});
      const current=await view();
      if(current.view.actual_filter!==ownPool)return {status:'external_filter_preserved'};
      await choosePoolFromObservation('调控中',current);await save('pool.restore','read_verified',{pool:'调控中'});
      return {status:'restored',pool:'调控中'};
    } catch(e) {
      try{await save('pool.restore','attempt_failed',{error:String(e.message)});}catch{/* retain original receipt */}
      return {status:'unknown',error:String(e.message)};
    } finally {deadline=savedDeadline;}
  }
  async function readTask(id,{keep_search=false,restore=true,pool}={}) {
    if(!allow_search){const result=await readTargets([id],{pools:pool?[pool]:['手动暂停','调控中'],restore});return {...result.targets[0],binding};}
    if(pool)return queryTask(id,false,keep_search,restore,pool);
    if(keep_search)throw Error('explicit_search_pool_required');
    let result;
    try {
      for(const name of ['手动暂停','调控中']) {
        result=await queryTask(id,false,false,false,name);
        if(result.task)return result;
      }
      return result;
    } finally {if(restore)await restoreDefaultPool();}
  }
  async function readCreated(name) {
    // Absence in these two pools is still unknown, never proof of no submission.
    if(typeof name!=='string'||!name.trim()||name.length>50||/[\r\n\u0000]/.test(name))throw Error('invalid_boost_target');
    // The platform can return zero search results for an exact visible name.
    // Scan both complete pools and perform exact matching locally instead.
    const matches=[];let captured_at;
    try {
      for(const poolName of ['手动暂停','调控中']) {
        const {pool}=await readPool(poolName);captured_at=pool.captured_at;
        matches.push(...pool.tasks.filter(t=>t.name===name));
      }
      if(matches.length>1)throw Error('exact_id_search_mismatch');
      return {binding,complete:true,captured_at,task:matches[0]??null,searched_pools:['手动暂停','调控中']};
    } finally {await restoreDefaultPool();}
  }
  async function readCreatedBatch(names) {
    if(!Array.isArray(names)||!names.length||new Set(names).size!==names.length||names.some(name=>typeof name!=='string'||!name.trim()||name.length>50||/[\r\n\u0000]/.test(name)))throw Error('invalid_create_batch_names');
    const matches=new Map(names.map(name=>[name,[]])),searched_pools=[];let captured_at;
    try {
      // Successful new creations belong to active. A normal batch needs one
      // complete active read; only missing names justify checking paused.
      for(const poolName of ['调控中','手动暂停']) {
        if(poolName==='手动暂停'&&names.every(name=>matches.get(name).length>0))break;
        const {pool}=await readPool(poolName);searched_pools.push(poolName);captured_at=pool.captured_at;
        for(const task of pool.tasks)if(matches.has(task.name))matches.get(task.name).push(task);
      }
      return {binding,complete:true,captured_at,searched_pools,targets:names.map(name=>({name,complete:true,captured_at,
        task:matches.get(name).length===1?matches.get(name)[0]:null,match_count:matches.get(name).length}))};
    } finally {await restoreDefaultPool();}
  }
  // Normal target checks share complete pool reads, not one search per ID.
  // All-state search is an explicit recovery/cleanup fallback for missing IDs.
  async function readTargets(ids,{pools=['手动暂停','调控中'],allow_all=false,restore=true}={}) {
    if(!Array.isArray(ids)||ids.some(id=>!validId(id)||id===binding.primary_ad_id))throw Error('invalid_boost_target');
    const wanted=[...new Set(ids)],found=new Map();let captured_at=iso();
    try {
      for(const name of pools) {
        if(found.size===wanted.length)break;
        const {pool}=await readPool(name);captured_at=pool.captured_at;
        for(const task of pool.tasks.filter(t=>wanted.includes(t.task_id))) {
          if(found.has(task.task_id))throw Error('target_changed_between_pools');
          found.set(task.task_id,{task,captured_at:pool.captured_at,binding,complete:true});
        }
      }
      if(allow_all&&allowed_pools.includes('全部（包括已删除）'))for(const id of wanted.filter(id=>!found.has(id))) {
        await save('target.fallback','observed',{target_id:id,reason:'missing_from_normal_pools'});
        found.set(id,await readTask(id,{restore:false,pool:'全部（包括已删除）'}));
      }
      return {binding,targets:wanted.map(task_id=>({task_id,...(found.get(task_id)??{task:null,captured_at,binding,complete:true})})),observed_at:iso()};
    } finally {if(restore)await restoreDefaultPool();}
  }
  async function locateTargets(ids,pool,{allow_partial=false}={}) {
    const opened=await openTab('调控');await choosePoolFromObservation(pool,opened);
    await step('pool.refresh',()=>tab.playwright.getByRole('columnheader',{name:'调控消耗',exact:true}).click(),(_,v)=>v.actual_filter===pool);
    const visible=(await visibleTasks()).filter(t=>ids.includes(t.task_id));
    if(visible.length===ids.length||allow_partial&&visible.length>0) {
      await save('target.visible','read_verified',{pool,target_ids:ids});return visible;
    }
    // Without search, page within the already verified source pool.
    if(ids.length===1&&!allow_search||allow_partial) {
      const first=tab.playwright.getByRole('listitem').filter({hasText:/^1$/});
      if(await first.count()===1)await step('target.page.1',()=>first.click());
      for(let page=1;page<=max_pages;page++) {
        const rows=await visibleTasks(),match=rows.filter(t=>ids.includes(t.task_id));
        if(match.length){await save('target.visible','read_verified',{pool,target_ids:ids,page});return match;}
        const next=tab.playwright.getByRole('listitem').filter({hasText:new RegExp('^'+(page+1)+'$')});
        if(await next.count()!==1)break;
        await step('target.page.'+(page+1),()=>next.click());
      }
      return [];
    }
    // Optional precise search is confined to the source pool.
    if(ids.length===1) {
      await save('target.search','observed',{pool,target_id:ids[0],reason:'not_on_visible_page'});
      const read=await queryTask(ids[0],false,true,false,pool);return read.task?[read.task]:[];
    }
    throw Error('batch_targets_not_on_same_visible_page');
  }
  async function visibleTasks({allow_selection=false}={}) {
    const {raw,view:v}=await view({allow_selection});
    const rows=await tab.playwright.getByRole('row').filter({hasText:'ID:'}).evaluateAll(es=>es.map(e=>Array.from(e.querySelectorAll('td')).map(c=>c.innerText)));
    const after=await view({allow_selection});
    if(after.view.actual_filter!==v.actual_filter||after.view.total!==v.total||JSON.stringify(after.view.headers)!==JSON.stringify(v.headers))throw Error('pool_changed_during_capture');
    // The full capture validator supplies the mandatory-header and width checks.
    // A write targets the visible page; validate its schema without claiming
    // that a single page covers the entire pool.
    const pageDom=raw.dom.replace(/共\s*[\d,]+\s*条(记录|任务)/g,(_,kind)=>`共 ${rows.length} 条${kind}`);
    const result=normalizePoolPages([{...raw,dom:pageDom,page:1,rows}],v.actual_filter,binding,{allow_selection,search:ownSearch,selection_context:selectionContext});
    if(!result.complete)throw Error('visible_rows_invalid');return result.tasks;
  }
  const selectedIds=()=>tab.playwright.getByRole('row').filter({hasText:'ID:'}).evaluateAll(es=>es.filter(e=>
    e.querySelector('input[type="checkbox"]:checked,[role="checkbox"][aria-checked="true"]')).map(e=>e.innerText.match(/ID\s*[:：]\s*(\d+)/)?.[1]??null));
  async function verifySelection(ids,{require_total=false,allow_confirmation=false}={}) {
    const {raw,view:v}=await view({allow_selection:true});
    if(!allow_confirmation&&/- button "确定"/.test(raw.dom))throw Error('human_confirmation_present');
    if(v.filters.length!==3||v.filters.slice(0,2).some(v=>v&&v!=='全部'))throw Error('extra_pool_filter');
    const selected=await selectedIds(),count=selectedTaskCount(raw.dom);
    if(selected.length!==ids.length||selected.some(v=>!ids.includes(v))||count!==null&&count!==ids.length)throw Error('selection_mismatch');
    if(require_total&&count===null)throw Error('selection_total_unverified');
    if(v.filter_source==='verified_before_own_selection')await save('selection.context','read_verified',{filter_source:v.filter_source,filters:v.filters,visible_filters:v.visible_filters,selected_ids:selected,selected_total:count});
    return selected;
  }
  async function selectTargets(ids) {
    const before=await view();
    if((await selectedIds()).length)throw Error('human_selection_present');
    if(before.view.filters.length!==3||before.view.filters.slice(0,2).some(v=>v&&v!=='全部'))throw Error('extra_pool_filter');
    selectionContext={filters:[...before.view.filters],ids:[...ids],captured_at:before.raw.captured_at};
    for(const id of ids) {
      if(!validId(id) || id===binding.primary_ad_id)throw Error('invalid_boost_target');
      // Normalized row text can join an ID to a digit-led video title.
      // Selection is still checked against the independently parsed exact ID.
      const row=tab.playwright.getByRole('row').filter({hasText:new RegExp('ID\\s*[:：]\\s*'+id)});
      if(await row.count()!==1)throw Error('target_not_unique');
      await row.getByRole('checkbox').click();await tab.getAXState({emit:false});
      await view({allow_selection:true});
      const selected=await selectedIds();
      if(!selected.includes(id) || selected.some(v=>!ids.includes(v)))throw Error('selection_mismatch');
      await save('task.select','read_verified',{target_id:id,selected_ids:selected});
    }
    await verifySelection(ids);
  }
  async function clearSelection(ids) {
    const completed=new Set();
    // Submission may leave a closing dialog or a loading table. Wait for those
    // observed states before touching selection; this never repeats a submit.
    const confirm=tab.playwright.getByRole('button',{name:'确定',exact:true});
    if(await confirm.count()===1&&await confirm.isVisible())
      await confirm.waitFor({state:'hidden',timeoutMs:Math.max(1,Math.min(5000,deadline-Date.now()))});
    for(let attempt=0;attempt<3;attempt++) {
      checkTime();
      const {raw}=await view({allow_selection:true});
      const remaining=await selectedIds(),count=selectedTaskCount(raw.dom);
      if(remaining.some(id=>!ids.includes(id))||count!==null&&count>ids.length)throw Error('external_selection_changed');
      if(!remaining.length&&(count===null||count===0)) {
        selectionContext=null;
        await save('task.deselect','read_verified',{ids,...raw});return;
      }
      for(const id of remaining) {
        if(completed.has(id))continue;
        const row=tab.playwright.getByRole('row').filter({hasText:new RegExp('ID\\s*[:：]\\s*'+id)});
        if(await row.count()!==1)throw Error('selected_target_not_unique');
        try {await row.getByRole('checkbox').uncheck();completed.add(id);}
        catch(error) {
          await save('task.deselect.attempt','attempt_failed',{target_id:id,attempt,error:String(error.message)});
          // Only a state-transition failure is eligible for a fresh observation
          // and another explicit uncheck. Disconnects/other errors remain unknown.
          if(!/did not change checked state to false/.test(error.message))throw error;
        }
        await tab.getAXState({emit:false});
        const afterIds=await selectedIds();
        if(afterIds.some(v=>!ids.includes(v)))throw Error('external_selection_changed');
        if(!afterIds.includes(id))await save('task.deselect.row','read_verified',{target_id:id,selected_ids:afterIds});
      }
      await tab.getAXState({emit:false});
    }
    const final=await view({allow_selection:true});
    const remaining=await selectedIds(),count=selectedTaskCount(final.raw.dom);
    if(remaining.some(id=>!ids.includes(id)))throw Error('external_selection_changed');
    if(remaining.length||count!==null&&count!==0)throw Error('selection_not_cleared');
    selectionContext=null;await save('task.deselect','read_verified',{ids,...final.raw});
  }
  return {view,step,openTab,choosePool,readPool,readTask,readTargets,readCreated,readCreatedBatch,locateTargets,releaseSearch,restoreDefaultPool,visibleTasks,selectTargets,selectedIds,verifySelection,clearSelection,save,hasOwnSelection:()=>selectionContext!==null,setDeadline:at=>{deadline=at;}};
}

export async function executeQianchuanTaskAction(tab,cfg) {
  const start=Date.now(), action=cfg.action;
  let ids=cfg.target_ids??[cfg.target_id];
  const allowed=['pause','resume','stop','delete'];
  if(!allowed.includes(action) || !ids.length || new Set(ids).size!==ids.length)throw Error('Invalid action targets');
  const ui=createQianchuanBrowserSteps({tab,binding:cfg.binding,checkpoint:cfg.on_checkpoint,max_pages:cfg.max_pages,allowed_pools:cfg.allowed_pools,allow_search:cfg.allow_search});
  let dispatched=false, completedVerified=false, before=[], after=[], verified=[], pending=[...ids];
  const stamp=async(id,status,data={})=>ui.save(id,status,{action,target_ids:ids,elapsed_ms:Date.now()-start,...data});
  const condition=t=>{
    if(!t || t.task_id===cfg.binding.primary_ad_id)throw Error('target_missing');
    if(action==='pause' && t.status!=='调控中')throw Error('target_not_active');
    if(action==='resume' && !/已暂停[\s\S]*手动暂停/.test(t.status))throw Error('target_not_manual_paused');
    if(action==='delete' && !/已暂停|关联直播间未开播|调控结束|已结束/.test(t.status))throw Error('delete_requires_inactive_target');
    if(cfg.zero_order_threshold!=null && !(Number.isFinite(t.cost) && (cfg.zero_order_comparator==='gt'?t.cost>cfg.zero_order_threshold:t.cost>=cfg.zero_order_threshold) && t.payment_orders===0))throw Error('zero_order_condition_changed');
  };
  try {
    await stamp('action.start','started');
    if(action!=='pause'&&ids.length!==1)throw Error('single_target_action_required');
    before=await ui.locateTargets(ids,action==='resume'?'手动暂停':action==='delete'?'全部（包括已删除）':'调控中',
      {allow_partial:action==='pause'&&cfg.pause_visible_batch===true});
    if(action==='pause'&&cfg.pause_visible_batch===true&&before.length){ids=before.map(t=>t.task_id);pending=[...ids];}
    if(before.length!==ids.length)throw Error('target_missing');before.forEach(condition);
    await cfg.validate_before?.({action,tasks:before,binding:cfg.binding,phase:'preflight'});
    await stamp('action.preflight','read_verified',{before});
    if(cfg.execute!==true)return {ok:true,ad_writes:0,effect_status:'not_submitted',mode:'dry_run',before};
    await ui.selectTargets(ids);
    const current=(await ui.visibleTasks({allow_selection:true})).filter(t=>ids.includes(t.task_id));
    if(current.length!==ids.length)throw Error('target_missing');current.forEach(condition);
    await cfg.validate_before?.({action,tasks:current,binding:cfg.binding,phase:'selection'});
    // Save the intent before any click that may dispatch. A crash leaves an
    // ambiguous intent to reconcile, never an invitation to repeat the write.
    await cfg.before_submit?.({action,ids,before:current});
    await ui.verifySelection(ids,{require_total:action==='resume'||action==='stop'});
    await stamp('action.dispatch','started');
    dispatched=true;
    await tab.playwright.getByRole('button',{name:{pause:'暂停',resume:'开启',stop:'停止',delete:'删除'}[action],exact:true}).click();
    await tab.getAXState({emit:false});
    // Pause/delete have a observed confirmation. Resume/stop can submit directly.
    if(action==='pause' || action==='delete') {
      const confirmation=tab.playwright.getByText(action==='pause'?`确定暂停所选的${ids.length}条任务吗？`:/确定删除所选的\s*1\s*条任务吗？删除后不可恢复/,
        {exact:action==='pause'});
      if(!await confirmation.isVisible()) {
        try {await confirmation.waitFor({state:'visible',timeoutMs:5000});}
        catch(error) {
          await tab.getAXState({emit:false});
          const confirmDom=await tab.playwright.domSnapshot();
          const expectedText=action==='pause'?`确定暂停所选的${ids.length}条任务吗？`:'确定删除所选的';
          if(!confirmDom.includes(expectedText)||!/- button "确定"/.test(confirmDom))throw error;
          await stamp('action.confirm.wait','read_verified',{reobserved_after_wait_error:true});
        }
      }
      await stamp('action.confirm','opened');
      // Read current task values, then verify selection once after the final hook.
      const confirmedCurrent=(await ui.visibleTasks({allow_selection:true})).filter(t=>ids.includes(t.task_id));
      if(confirmedCurrent.length!==ids.length)throw Error('target_missing');confirmedCurrent.forEach(condition);
      await cfg.validate_before?.({action,tasks:confirmedCurrent,binding:cfg.binding,phase:'confirmation'});
      await ui.verifySelection(ids,{allow_confirmation:true});
      const confirmationResult=await confirmQianchuanAction(tab,{expected_text:action==='pause'?`确定暂停所选的${ids.length}条任务吗？`:'确定删除所选的'});
      if(confirmationResult.status!=='submitted_pending_readback')throw Error(confirmationResult.status);
    } else {
      const confirm=tab.playwright.getByRole('button',{name:'确定',exact:true});
      if(await confirm.count()===1 && await confirm.isVisible()) {
        const confirmedCurrent=(await ui.visibleTasks({allow_selection:true})).filter(t=>ids.includes(t.task_id));
        if(confirmedCurrent.length!==ids.length)throw Error('target_missing');confirmedCurrent.forEach(condition);
        await cfg.validate_before?.({action,tasks:confirmedCurrent,binding:cfg.binding,phase:'confirmation'});
        await ui.verifySelection(ids,{allow_confirmation:true,require_total:true});
        await confirm.click({timeoutMs:800});
      }
    }
    await stamp('action.submit','submitted_pending_readback');
    // A controller hard pause is followed by complete normal-pool reads in this
    // same round. Leave it pending for those reads instead of scanning twice.
    if(action==='pause'&&cfg.defer_pause_readback===true) {
      await ui.clearSelection(ids);
      return {ok:true,ad_writes:null,confirmed_writes:0,effect_status:'submitted_pending_readback',
        verified:[],pending_ids:[...ids],before,after:[],retry_write:false,elapsed_ms:Date.now()-start};
    }
    const deadline=Date.now()+Math.min(15000,cfg.readback_timeout_ms??15000);ui.setDeadline(deadline);
    const expect={pause:/^已暂停/,resume:/^调控中$/,stop:/调控结束|已停止/,delete:/已删除/}[action];
    const resultPool={pause:'手动暂停',resume:'调控中',stop:'全部（包括已删除）',delete:'全部（包括已删除）'}[action];
    do {
      await stamp('action.verify','started',{pending_ids:pending,verified});
      // Our own checked rows may survive a platform response; don't clear others.
      await ui.clearSelection(ids);
      await ui.releaseSearch();
      const reads=await ui.readTargets(pending,{pools:[resultPool],restore:false});
      for(const id of [...pending]) {
        if(Date.now()>=deadline)break;
        const read=reads.targets.find(t=>t.task_id===id);
        if(read.task && expect.test(read.task.status)) {verified.push(id);pending=pending.filter(v=>v!==id);after.push(read.task);
          await stamp('action.readback','write_verified',{target_id:id,after:read.task});}
      }
      if(pending.length && Date.now()<deadline)await tab.getAXState({emit:false});
    } while(pending.length && Date.now()<deadline);
    completedVerified=!pending.length;
    return {ok:!pending.length,ad_writes:pending.length?null:verified.length,confirmed_writes:verified.length,
      effect_status:pending.length?'unconfirmed':'write_verified',verified,pending_ids:pending,before,after,retry_write:false,elapsed_ms:Date.now()-start};
  } catch(e) {
    try{await stamp('action.failure','attempt_failed',{dispatched,error:String(e.message),verified});}catch{/* caller has a durable submission intent */}
    if(!dispatched&&ui.hasOwnSelection()) {try{await ui.clearSelection(ids);}catch{/* preserve external selection/draft */}}
    return {ok:false,ad_writes:dispatched?null:0,confirmed_writes:verified.length,effect_status:dispatched?'unconfirmed':'not_submitted',
      verified,pending_ids:dispatched?pending:[],retry_write:false,error:String(e.message),before,after,elapsed_ms:Date.now()-start};
  } finally {
    try{await ui.releaseSearch();}catch(e){try{await stamp('search.cleanup','attempt_failed',{error:String(e.message)});}catch{/* never mask a write receipt */}}
    // Only the controlled adapter opts out, and only after every ID was verified.
    if(cfg.restore_after_verified!==false||!completedVerified)await ui.restoreDefaultPool();
    else {try{await stamp('pool.restore','not_needed',{reason:'controlled_verified_result_pool'});}catch{/* retain verified advertising receipt */}}
  }
}
