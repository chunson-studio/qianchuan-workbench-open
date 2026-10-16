
import {parseFinancialDom, planIdentity, bindingMatches} from './codex-qc-browser-data.mjs';
import {prepareMaterialCostControlForm, setCostMaterialRegions} from './browser-actions/material-cost-control-form.cua.mjs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {calculateCostControlBudget} from './codex-qc-cost-control-budget.mjs';

export const MATERIAL_CONTROL_VERSION = '20261010-1';
const num = x => /^[\d,]+(?:\.\d+)?$/.test(String(x).trim()) ? Number(String(x).replaceAll(',', '')) : null;
const text = s => { try { return JSON.parse(s); } catch { return s; } };
const fail = (ok, message) => { if (!ok) throw Object.assign(Error(message), {code:message}); };
const now = () => new Date().toISOString();
const tokens = dom => [...dom.matchAll(/^\s*- (?:generic|paragraph|text): (.+)$/gm)].map(m=>text(m[1]));
const metric = (dom, label) => { const a=tokens(dom), ix=a.flatMap((x,i)=>x===label?[i]:[]); return ix.length===1?num(a[ix[0]+1]):null; };
const materialIds = t => t.material_ids ?? (t.material_id ? [t.material_id] : []);
const sameIds = (a,b) => JSON.stringify([...a].sort())===JSON.stringify([...b].sort());
const formSection = dom => {const i=dom.lastIndexOf('- generic: 对指定素材付出额外预算追加投放');fail(i>=0,'material_form_missing');return dom.slice(i);};
const formIds = form => [...form.matchAll(/^- generic: "素材ID: (\d+)"$/gm)].map(m=>m[1]);

export async function loadMaterialPolicy(binding, policyFile) { if(!policyFile)throw Error('explicit_policy_file_required'); const p=JSON.parse(await fs.readFile(policyFile,'utf8')); if(p.advertiser_id!==binding.advertiser_id||p.primary_ad_id!==binding.primary_ad_id)throw Error('policy_binding_mismatch'); return p; }

export function validateMaterialParameterChange({expected_roi,new_roi,expected_budget,new_budget},policy) {
  fail((new_roi!=null)!==(new_budget!=null),'change_one_parameter_at_a_time');
  if(new_roi!=null){
    fail(Number.isFinite(new_roi)&&new_roi>0&&Number.isFinite(expected_roi)&&expected_roi>0,'invalid_roi');
    fail(Math.abs(new_roi-expected_roi)/expected_roi<=policy.max_bid_change_ratio+1e-10,'roi_change_exceeds_limit');
    fail((policy.roi_min==null||new_roi>=policy.roi_min)&&(policy.roi_max==null||new_roi<=policy.roi_max),'roi_outside_authorized_range');
  }
  if(new_budget!=null){
    fail(Number.isFinite(expected_budget)&&expected_budget>0&&Number.isFinite(new_budget)&&new_budget>expected_budget,'invalid_budget');
    if(policy.budget_increase_ratio!=null)fail(new_budget===Math.round(expected_budget*(1+policy.budget_increase_ratio)*100)/100,'budget_increase_outside_authorized_steps');
    else fail(policy.budget_options?.includes(new_budget),'budget_increase_outside_authorized_steps');
  }
  return true;
}

export function verifyMaterialRegionForm(form,policy) {
  const audience=form.slice(form.indexOf('- generic: 定向人群'));
  fail(form.includes('- generic: 定向人群'),'audience_missing');
  if(policy.region_mode==='unlimited') {
    fail(!audience.includes('已选定向信息')||/- generic: 地域\n- generic: 不限(?:\n|$)/.test(audience),'unlimited_region_unverified');
  } else {
    fail(policy.region_mode==='fixed'&&Array.isArray(policy.regions)&&policy.regions.length>0,'region_policy_missing');
    const values=[...audience.matchAll(/^- generic: (.+)$/gm)].map(m=>text(m[1]));
    fail(values.some(v=>sameIds(String(v).split('、'),policy.regions))&&audience.includes(policy.geography),'fixed_region_mismatch');
  }
  return true;
}

export async function adoptMaterialRoiSuggestion(tab) {
  const form=formSection(await tab.playwright.domSnapshot());
  const suggested=Number(form.match(/建议目标值不超过\s*(\d+(?:\.\d+)?)/)?.[1]);
  fail(Number.isFinite(suggested)&&suggested>0,'roi_suggestion_missing');
  await tab.playwright.getByText('采纳建议',{exact:true}).click();await tab.getAXState({emit:false});
  const value=Number(await tab.playwright.getByRole('textbox',{name:'请输入期望的综合营销ROI目标',exact:true}).evaluate(e=>e.value));
  fail(value===suggested,'roi_suggestion_fill_mismatch');
  return value;
}

export function parseMaterialBoard(dom, binding, captured_at=now()) {
  const parsed=parseFinancialDom({dom,captured_at},'qianchuan_board',binding);
  const top=dom.split('- button "整体趋势"')[0];
  return {captured_at,source:'qianchuan_board',room_id:binding.room_id,
    live: /- text: 直播中(?:\n|$)/.test(top) && !/直播已结束|已下播/.test(top),
    cost:parsed.board.cost,roi:parsed.board.net_roi,net_gmv:parsed.board.net_gmv,
    online:metric(top,'实时在线人数'),refund_rate_1h:metric(top,'1小时内退款率'),
    gmv:parsed.board.gmv,refund:parsed.board.refund,issues:parsed.issues,
    basis:parsed.board.metric_basis,window:parsed.board.data_window};
}

export function parseMaterialTasks({dom,matrix,binding,captured_at=now()}) {
  const identity=planIdentity(dom,binding), issues=[];
  if(!identity.verified)issues.push('plan_identity_mismatch');
  if(/加载中|加载失败|请求失败/.test(dom))issues.push('page_not_ready');
  const dates=[...dom.matchAll(/- textbox "(?:开始|结束)日期": ([^\n]+)/g)].map(m=>text(m[1]));
  if(dates.length!==2)issues.push('date_window_unknown');
  else if(dates.some(d=>d!==binding.date))issues.push('today_window_required');
  const header=matrix.find(row=>row.some(c=>c.tag==='TH'&&c.text==='任务名称'));
  const headers=header?.map(c=>c.text.replace(/\s/g,''))??[];
  const required=['任务名称','素材','调控状态','调控预算(元)','综合营销ROI目标','追投方式','创建时间','调控成交订单数','调控消耗'];
  for(const h of required)if(headers.filter(x=>x===h).length!==1)issues.push('missing_or_duplicate_column:'+h);
  const metric_issues=[];
  for(const h of ['调控综合成本','调控综合营销ROI','调控净成交金额']) {
    if(!headers.includes(h))metric_issues.push('missing_column:'+h);
    if(headers.filter(x=>x===h).length>1)issues.push('duplicate_column:'+h);
  }
  const tasks=[];
  for(const row of matrix.filter(r=>r.every(c=>c.tag==='TD')&&r.some(c=>/(?:^|\n)ID:\s*\d+/.test(c.text)))) {
    if(row.length!==headers.length){issues.push('row_width_mismatch');continue;}
    const cells=Object.fromEntries(headers.map((h,i)=>[h,row[i].text.trim()]));
    const task_id=cells['任务名称']?.match(/(?:^|\n)ID:\s*(\d+)/)?.[1];
    const material_ids=[...new Set([...cells['素材'].matchAll(/素材ID[：:]\s*(\d+)/g)].map(m=>m[1]))];
    const declared=Number(cells['素材'].match(/(?:共|等)\s*(\d+)\s*(?:个|条)/)?.[1]??material_ids.length);
    if(!task_id){issues.push('task_id_missing');continue;}
    tasks.push({task_id,material_id:material_ids[0]??null,material_ids,material_count:declared||null,
      material_membership_complete:material_ids.length>0&&material_ids.length===declared,
      name:cells['任务名称'].split('\nID:')[0],material_name:cells['素材'].split('\n素材ID')[0],
      status:cells['调控状态'].replace(/\s*保$/,''),type:cells['追投方式'],created_at:cells['创建时间'].replace(/\s+/g,' '),
      budget:num(cells['调控预算(元)']),roi_goal:num(cells['综合营销ROI目标']),
      duration_hours:num(cells['调控时长(小时)']?.match(/^\d+(?:\.\d+)?/)?.[0]),
      cost:num(cells['调控消耗']),comprehensive_cost:num(cells['调控综合成本']),roi:num(cells['调控综合营销ROI']),
      net_gmv:num(cells['调控净成交金额']),orders:num(cells['调控成交订单数']),window:{start:dates[0]??null,end:dates[1]??null}});
  }
  const totals=[...dom.matchAll(/共\s*(\d+)\s*条(?:记录|任务)/g)].map(m=>Number(m[1]));
  const total=totals.length&&totals.every(x=>x===totals[0])?totals[0]:null;
  const filters=[...dom.matchAll(/- textbox "请选择"(?:: ([^\n]+))?/g)].map(m=>text(m[1]??''));
  const pool=filters.length===3?filters[2]:null;
  if(!pool)issues.push('pool_unknown');
  if(filters.slice(0,2).some(x=>x&&x!=='全部'))issues.push('extra_task_filter');
  if(/- textbox "输入任务名称或ID搜索": \S/.test(dom))issues.push('task_search_active');
  if(new Set(tasks.map(t=>t.task_id)).size!==tasks.length)issues.push('duplicate_task_id');
  const daily_budget=metric(dom,'素材追投-控成本追投、搜索抢首屏共用调控总预算，今日总预算');
  const remaining_budget=metric(dom,'元，今日可用预算');
  const updated_at=dom.match(/- generic: (\d{2}-\d{2} \d{2}:\d{2})(?:\n|更新)/)?.[1]??null;
  return {captured_at,updated_at,tasks,total,pool,daily_budget,remaining_budget,window:{start:dates[0]??null,end:dates[1]??null},
    human_editor: /- button "提交"/.test(dom),selected:/- checkbox[^\n]*\[checked\]/.test(dom),
    complete:issues.length===0&&tasks.length===total,issues,metric_issues};
}

export function summarizeMaterialTests({board,pool}) { return {board,budget:calculateCostControlBudget({pool}),pool_complete:pool.complete,pool_issues:pool.issues,human_editor:pool.human_editor,tasks:pool.tasks,strategy_status:'not_included'}; }

export function materialObservationKey(pool,task) {
  return JSON.stringify([pool.window, pool.updated_at??null,task.task_id,task.cost,task.orders,task.roi]);
}


export function evaluateMaterialActions({roi_watches={}}) { return {actions:[],roi_watches:{...roi_watches},strategy_status:'not_included'}; }

async function bindPlan(tab,binding) {
  const u=new URL(await tab.url());
  fail(u.hostname==='qianchuan.jinritemai.com'&&u.pathname==='/overall-prom/detail'&&u.searchParams.get('aavid')===binding.advertiser_id&&u.searchParams.get('adId')===binding.primary_ad_id,'plan_url_mismatch');
  const dom=await tab.playwright.domSnapshot();
  fail(planIdentity(dom,binding).verified,'plan_identity_mismatch');
  return dom;
}
async function clearForNavigation(tab,binding) {
  const dom=await bindPlan(tab,binding);
  fail(!/- button "(?:提交|确定)"/.test(dom)&&!/- checkbox[^\n]*\[checked\]/.test(dom),'human_draft_or_selection_preserved');
  return dom;
}
export async function readMaterialBoard(tab,binding,{refresh=false}={}) {
  const u=new URL(await tab.url());
  fail(u.hostname==='qianchuan.jinritemai.com'&&u.pathname==='/board-next'&&u.searchParams.get('aavid')===binding.advertiser_id&&u.searchParams.get('live_room_id')===binding.room_id,'board_url_mismatch');
  if(refresh){await tab.playwright.getByText('刷新数据',{exact:true}).click();await tab.getAXState({emit:false});}
  return parseMaterialBoard(await tab.playwright.domSnapshot(),binding);
}
export async function readMaterialTasks(tab,binding) {
  const dom=await bindPlan(tab,binding);
  const matrix=await tab.playwright.getByRole('row').evaluateAll(es=>es.map(e=>Array.from(e.querySelectorAll('th,td')).map(c=>({tag:c.tagName,text:c.innerText,span:c.colSpan}))));
  return parseMaterialTasks({dom,matrix,binding});
}


export async function openMaterialTaskPool(tab,binding,pool='调控中') {
  fail(['调控中','手动暂停'].includes(pool),'unsupported_pool');
  await clearForNavigation(tab,binding);
  await tab.playwright.getByRole('tab',{name:'调控',exact:true}).click();await tab.getAXState({emit:false});
  let snapshot=await readMaterialTasks(tab,binding);
  if(snapshot.pool!==pool){
    await tab.playwright.getByRole('textbox',{name:'请选择',exact:true}).nth(2).click();await tab.getAXState({emit:false});
    await tab.playwright.getByText(pool,{exact:true}).click();await tab.getAXState({emit:false});
    snapshot=await readMaterialTasks(tab,binding);
  }
  fail(snapshot.pool===pool,'pool_selection_unverified');
  return snapshot;
}

export async function setMaterialToday(tab,binding) {
  await clearForNavigation(tab,binding);
  for(const name of ['开始日期','结束日期']) {
    const input=tab.playwright.getByRole('textbox',{name,exact:true});
    if(await input.evaluate(e=>e.value)!==binding.date){await input.fill(binding.date);await input.press('Enter');await tab.getAXState({emit:false});}
  }
  const dom=await bindPlan(tab,binding);
  const values=[...dom.matchAll(/- textbox "(?:开始|结束)日期": ([^\n]+)/g)].map(m=>text(m[1]));
  fail(values.length===2&&values.every(d=>d===binding.date),'today_filter_unverified');
  return {date:binding.date,ad_writes:0};
}

export async function refreshMaterialTaskPage(tab,binding) {
  await clearForNavigation(tab,binding);
  await tab.reload();await tab.getAXState({emit:false});
  await tab.playwright.getByRole('tab',{name:'调控',exact:true}).waitFor({state:'visible'});
  return setMaterialToday(tab,binding);
}

export async function readMaterialTaskPool(tab,binding,pool='调控中') {
  let snapshot=await openMaterialTaskPool(tab,binding,pool);
  if(snapshot.complete)return snapshot;
  fail(!snapshot.issues.length,'task_pool_unverified:'+snapshot.issues.join(','));
  const first=tab.playwright.getByRole('listitem').filter({hasText:/^1$/});
  fail(await first.count()===1,'first_page_not_visible');
  await first.click();await tab.getAXState({emit:false});snapshot=await readMaterialTasks(tab,binding);
  const rows=[...snapshot.tasks],seen=new Set(rows.map(t=>t.task_id));
  for(let page=2;rows.length<snapshot.total;page++) {
    const next=tab.playwright.getByRole('listitem').filter({hasText:new RegExp('^'+page+'$')});
    fail(await next.count()===1,'next_page_not_visible_use_ui');
    await next.click();await tab.getAXState({emit:false});
    const s=await readMaterialTasks(tab,binding);
    fail(!s.issues.length&&s.total===snapshot.total&&s.pool===pool&&JSON.stringify(s.window)===JSON.stringify(snapshot.window),'task_pool_changed');
    fail(s.tasks.length>0&&s.tasks.every(t=>!seen.has(t.task_id)),'task_page_repeated');
    s.tasks.forEach(t=>{seen.add(t.task_id);rows.push(t);});
  }
  return {...snapshot,tasks:rows,complete:rows.length===snapshot.total};
}

export async function openMaterialCandidates(tab,binding) {
  const initial=await clearForNavigation(tab,binding);
  if(!/- tab "素材"[^\n]*\[selected\]/.test(initial)){await tab.playwright.getByRole('tab',{name:'素材',exact:true}).click();await tab.getAXState({emit:false});}
  const video=tab.playwright.locator('div.main-vmok-plugin-radio-item').filter({hasText:/^视频$/});
  fail(await video.count()===1,'video_mode_not_unique');
  if(!(await video.getAttribute('class')).includes('--checked')){await video.click();await tab.getAXState({emit:false});}
  let dom=await bindPlan(tab,binding);
  fail(/投放状态：\s*投放中/.test(dom),'set_active_video_filter_in_ui');
  if(!/视频类型：\s*自选投放视频/.test(dom)) {
    await tab.playwright.getByRole('button',{name:/^更多筛选(?: \d+)?$/}).click();await tab.getAXState({emit:false});
    const inputs=tab.playwright.getByRole('textbox',{name:'请选择',exact:true});
    fail(await inputs.count()===5,'material_filter_layout_changed');
    await inputs.nth(1).click();
    const ax=await tab.getAXState({emit:false,disableDiffing:true});
    const menu=ax.slice(ax.lastIndexOf('text 视频类型'));
    const options=[...menu.matchAll(/^\s*(\d+) text 自选投放视频\s*$/gm)];
    fail(options.length===1,'video_type_option_not_unique');
    await tab.click(Number(options[0][1]));await tab.getAXState({emit:false});
    fail(await inputs.nth(1).evaluate(e=>e.value)==='自选投放视频','video_type_selection_unknown');
    await tab.playwright.getByRole('button',{name:'确定',exact:true}).click();await tab.getAXState({emit:false});
    dom=await bindPlan(tab,binding);
  }
  fail(/投放状态：\s*投放中/.test(dom)&&/视频类型：\s*自选投放视频/.test(dom),'video_filters_unverified');
  return dom;
}

export async function readMaterialCandidatePage(tab,binding,{page=1}={}) {
  let dom=await openMaterialCandidates(tab,binding);
  const pageButton=tab.playwright.getByRole('listitem').filter({hasText:new RegExp('^'+page+'$')});
  if(await pageButton.count()===1){await pageButton.click();await tab.getAXState({emit:false});dom=await bindPlan(tab,binding);}
  else fail(page===1&&!/- listitem: "?2/.test(dom),'candidate_page_not_visible');
  if(/加载中/.test(dom)){await tab.getAXState({emit:false});dom=await bindPlan(tab,binding);}
  fail(!/加载中|加载失败|请求失败/.test(dom),'candidate_page_not_ready');
  fail(!/- textbox "输入视频名称\/ID后回车搜索": \S/.test(dom),'material_search_must_be_cleared');
  const matrix=await tab.playwright.getByRole('row').evaluateAll(es=>es.map(e=>Array.from(e.querySelectorAll('th,td')).map(c=>c.innerText)));
  const candidates=matrix.flatMap(row=>{
    const s=row.join('\n'),id=s.match(/素材ID[：:]\s*(\d+)/)?.[1];
    return id&&s.includes('自选投放视频')?[{material_id:id,name:s.slice(0,s.indexOf('素材ID')).trim(),approved:s.includes('审核通过')}]:[];
  });
  return {captured_at:now(),page,total:Number(dom.match(/共\s*(\d+)\s*个视频/)?.[1]??NaN),candidates,
    scope:'视频 / 投放中 / 自选投放视频',ad_writes:0};
}

export async function releaseMaterialSearch(tab,binding,material_id) {
  await clearForNavigation(tab,binding);
  await tab.playwright.getByRole('tab',{name:'素材',exact:true}).click();await tab.getAXState({emit:false});
  const search=tab.playwright.getByRole('textbox',{name:'输入视频名称/ID后回车搜索',exact:true});
  const value=await search.evaluate(e=>e.value);
  fail(!value||value===material_id,'different_material_search_preserved');
  if(value){await search.fill('');await search.press('Enter');await tab.getAXState({emit:false});}
  return {ad_writes:0};
}

export function validateMaterialAllocation({pool,requests,policy,pending=[]}) {
  fail(pool.complete&&pool.pool==='调控中'&&!pool.issues.length,'complete_active_pool_required');
  fail(!pool.human_editor&&!pool.selected,'human_draft_or_selection_preserved');
  fail(Array.isArray(requests)&&requests.every(r=>materialIds(r).length>=1&&materialIds(r).length<=5&&new Set(materialIds(r)).size===materialIds(r).length&&materialIds(r).every(id=>/^\d+$/.test(id))&&Number.isSafeInteger(r.count)&&r.count>0),'invalid_allocation');
  const total=requests.reduce((n,r)=>n+r.count,0);
  fail(pool.tasks.length+pending.length+total<=policy.max_active_tasks,'active_capacity_exceeded');
  const counts=new Map();
  for(const t of [...pool.tasks,...pending])for(const id of materialIds(t))counts.set(id,(counts.get(id)||0)+1);
  for(const r of requests)for(const id of materialIds(r))counts.set(id,(counts.get(id)||0)+r.count);
  if(policy.max_tasks_per_material!=null)fail([...counts.values()].every(n=>n<=policy.max_tasks_per_material),'material_capacity_exceeded');
  return {count:total,remaining:policy.max_active_tasks-pool.tasks.length-pending.length-total};
}

export async function prepareMaterialTest(tab,binding,spec) {
  const policy=await loadMaterialPolicy(binding);
  fail(spec.daily_budget_yuan===policy.initial_daily_budget_yuan,'initial_budget_mismatch');
  const ids=materialIds(spec);fail(ids.length>=1&&ids.length<=5&&new Set(ids).size===ids.length,'invalid_material_group');
  fail([1,4,5].includes(ids.length),'material_group_size_must_be_1_4_or_5');
  spec={...spec,material_id:ids[0]};
  await openMaterialCandidates(tab,binding);
  const search=tab.playwright.getByRole('textbox',{name:'输入视频名称/ID后回车搜索',exact:true});
  const prior=await search.evaluate(e=>e.value);
  fail(!prior||prior===spec.material_id,'human_material_search_preserved');
  await search.fill(spec.material_id);await search.press('Enter');await tab.getAXState({emit:false});
  const sink=async()=>{}; 
  const prepared=await prepareMaterialCostControlForm(tab,{...spec,...binding,roi_mode:policy.initial_roi_mode==='suggested'?'deferred':'fixed',roi_goal:policy.initial_roi,material_tab_ready:true},sink);
  if(policy.region_mode==='fixed')await setCostMaterialRegions(tab,policy.regions,sink);
  if(ids.length>1)await addMaterialGroup(tab,binding,{existing_id:ids[0],additional_ids:ids.slice(1)});
  if(policy.initial_roi_mode==='suggested')prepared.roi_goal=await adoptMaterialRoiSuggestion(tab);
  const form=formSection(await tab.playwright.domSnapshot());
  verifyMaterialRegionForm(form,policy);
  const remaining=metric(form,'元，当前最多可再追加预算');
  fail(remaining!==null&&spec.daily_budget_yuan<=remaining,'shared_budget_insufficient_or_unknown');
  return {...prepared,material_ids:ids,regions:policy.regions??[],region_mode:policy.region_mode,geography:policy.geography??null,status:'prepared_not_submitted'};
}

export async function addMaterialGroup(tab,binding,{existing_id,additional_ids}) {
  await bindPlan(tab,binding);
  const expected=[existing_id,...additional_ids];
  fail(expected.length>=2&&expected.length<=5&&new Set(expected).size===expected.length,'invalid_material_group');
  fail(sameIds(formIds(formSection(await tab.playwright.domSnapshot())),[existing_id]),'initial_group_changed');
  await tab.playwright.getByRole('button',{name:'添加视频',exact:true}).last().click();await tab.getAXState({emit:false});
  await selectMaterialGroupInPicker(tab,additional_ids);
  fail(sameIds(formIds(formSection(await tab.playwright.domSnapshot())),expected),'group_members_changed');
  return {material_ids:expected,status:'prepared_not_submitted',ad_writes:0};
}

export async function selectMaterialGroupInPicker(tab,additional_ids) {
  fail((await tab.playwright.domSnapshot()).includes('视频列表仅包括允许追投的全域在投视频'),'video_picker_missing');
  const table=tab.playwright.getByRole('table').last();
  await table.getByRole('row').filter({hasText:'素材ID:'}).first().waitFor({state:'visible'});
  for(const id of additional_ids) {
    let row=table.getByRole('row').filter({hasText:'素材ID: '+id});
    if(await row.count()!==1){
      const search=tab.playwright.getByRole('textbox',{name:'输入视频名称/ID后回车搜索',exact:true}).last();
      await search.fill(id);await search.press('Enter');await tab.getAXState({emit:false});
      row=table.getByRole('row').filter({hasText:'素材ID: '+id});
      await row.waitFor({state:'visible'});
    }
    fail(await row.count()===1,'group_material_not_unique');
    const visible=await row.innerText();fail(visible.includes('自选投放视频')&&visible.includes('审核通过'),'group_material_ineligible');
    await row.getByRole('checkbox').check();await tab.getAXState({emit:false});
  }
  fail((await tab.playwright.domSnapshot()).includes('已选 '+additional_ids.length+' / 19'),'group_selection_count_changed');
  await tab.playwright.getByRole('button',{name:'确定',exact:true}).click();await tab.getAXState({emit:false});
  return {added:additional_ids,status:'prepared_not_submitted',ad_writes:0};
}



export async function submitPreparedMaterial(tab,binding,{prepared,operation_id,record,authorized_daily_budget_yuan}) {
  fail(typeof record==='function'&&operation_id&&prepared?.status==='prepared_not_submitted','durable_intent_required');
  await bindPlan(tab,binding);
  const form=formSection(await tab.playwright.domSnapshot());
  const policy=await loadMaterialPolicy(binding);
  verifyMaterialRegionForm(form,policy);
  fail(sameIds(formIds(form),materialIds(prepared)),'prepared_form_changed');
  const roi=Number(await tab.playwright.getByRole('textbox',{name:'请输入期望的综合营销ROI目标',exact:true}).evaluate(e=>e.value));
  const budget=Number(await tab.playwright.getByRole('textbox',{name:'请输入',exact:true}).evaluate(e=>e.value));
  fail(roi===(prepared.new_roi??prepared.roi_goal)&&budget===(prepared.budget??prepared.daily_budget_yuan),'prepared_values_changed');
  fail(Number.isFinite(roi)&&roi>0&&Number.isFinite(budget)&&budget>0,'prepared_values_invalid');
  if(prepared.task_id)validateMaterialParameterChange({expected_roi:prepared.old_roi,new_roi:roi!==prepared.old_roi?roi:null,expected_budget:prepared.old_budget,new_budget:budget!==prepared.old_budget?budget:null},policy);
  else {
    const authorizedBudget=authorized_daily_budget_yuan??policy.initial_daily_budget_yuan;
    fail(Number.isFinite(authorizedBudget)&&authorizedBudget>0&&budget===authorizedBudget,'initial_budget_mismatch');
    fail(policy.initial_roi_mode==='suggested'||roi===policy.initial_roi,'initial_roi_mismatch');
    const taskName=await tab.playwright.getByRole('textbox',{name:'请输入任务名称，1-50个字符',exact:true}).evaluate(e=>e.value);
    fail(taskName===prepared.task_name,'prepared_name_changed');
  }
  const remaining=metric(form,'元，当前最多可再追加预算');
  const required=prepared.task_id?Math.max(0,budget-prepared.old_budget):budget;
  fail(required===0||(remaining!==null&&required<=remaining),'shared_budget_insufficient_or_unknown');
  await record({operation_id,status:'intent',prepared});
  try {
    await tab.playwright.getByRole('button',{name:'提交',exact:true}).click();await tab.getAXState({emit:false});
    const current=await tab.playwright.domSnapshot();
    const status=/- button "提交"/.test(current)?'unknown':'submitted_pending_readback';
    const result={operation_id,status,task_id:prepared.task_id??null,task_name:prepared.task_name??null,material_id:prepared.material_id};
    await record(result);return result;
  } catch(error) {const result={operation_id,status:'unknown',error:String(error.message)};await record(result);return result;}
}

export async function applyMaterialTaskStatus(tab,binding,{task_id,material_id,action,operation_id,record}) {
  fail(['pause','resume'].includes(action)&&typeof record==='function'&&operation_id,'invalid_task_action');
  const pool=await readMaterialTaskPool(tab,binding,action==='pause'?'调控中':'手动暂停');
  const task=pool.tasks.find(t=>t.task_id===task_id);
  fail(pool.complete&&task&&task.material_id===material_id&&task.type==='控成本追投','task_action_scope_mismatch');
  
  const search=tab.playwright.getByRole('textbox',{name:'输入任务名称或ID搜索',exact:true});
  await search.fill(task_id);await search.press('Enter');await tab.getAXState({emit:false});
  const row=tab.playwright.getByRole('row').filter({hasText:'ID: '+task_id});
  fail(await row.count()===1,'task_not_unique');
  fail((await row.innerText()).includes(material_id),'task_material_changed');
  await row.getByRole('checkbox').check();await tab.getAXState({emit:false});
  fail(await tab.playwright.getByRole('checkbox').evaluateAll(es=>es.filter(e=>e.checked||e.getAttribute('aria-checked')==='true').length)<=2,'selection_ambiguous');
  await record({operation_id,status:'intent',action,task_id,material_id});
  try {
    await tab.playwright.getByRole('button',{name:action==='pause'?'暂停':'开启',exact:true}).click();await tab.getAXState({emit:false});
    if(action==='pause') {
      fail(await tab.playwright.getByText('确定暂停所选的1条任务吗？',{exact:true}).isVisible(),'pause_confirmation_unknown');
      await tab.playwright.getByRole('button',{name:'确定',exact:true}).click();await tab.getAXState({emit:false});
    } else if(await tab.playwright.getByRole('button',{name:'确定',exact:true}).count()===1) {
      
      fail(/开启所选的1条任务/.test(await tab.playwright.domSnapshot()),'resume_confirmation_unknown');
      await tab.playwright.getByRole('button',{name:'确定',exact:true}).click();await tab.getAXState({emit:false});
    }
    const result={operation_id,status:'submitted_pending_readback',action,task_id,material_id};await record(result);
    
    if(await row.count()===1&&await row.getByRole('checkbox').count()===1)await row.getByRole('checkbox').uncheck();
    await search.fill('');await search.press('Enter');await tab.getAXState({emit:false});
    return result;
  } catch(error){const result={operation_id,status:'unknown',action,task_id,material_id,error:String(error.message)};await record(result);return result;}
}



export async function prepareMaterialRoiEdit(tab,binding,{task_id,material_id,expected_roi,new_roi}) {
  return prepareMaterialParameterEdit(tab,binding,{task_id,material_id,expected_roi,new_roi});
}

export async function prepareMaterialParameterEdit(tab,binding,{task_id,material_id,material_ids,expected_roi,new_roi,expected_budget,new_budget}) {
  const dom=await clearForNavigation(tab,binding);
  const policy=await loadMaterialPolicy(binding);
  validateMaterialParameterChange({expected_roi,new_roi,expected_budget,new_budget},policy);
  const pool=await readMaterialTasks(tab,binding),task=pool.tasks.find(t=>t.task_id===task_id);
  fail(!pool.issues.length&&task&&task.type==='控成本追投'&&(expected_roi==null||task.roi_goal===expected_roi)&&(expected_budget==null||task.budget===expected_budget),'task_parameters_changed');
  const ids=material_ids??(material_id?[material_id]:materialIds(task));
  fail(ids.length>0,'material_membership_required');
  const row=tab.playwright.getByRole('row').filter({hasText:'ID: '+task_id});
  fail(await row.count()===1,'task_not_unique');
  await row.locator('iconpark-icon[name="oc-icon-light-edit"]').click();await tab.getAXState({emit:false});
  const editor=await tab.playwright.domSnapshot();
  const form=formSection(editor);
  const roi=tab.playwright.getByRole('textbox',{name:'请输入期望的综合营销ROI目标',exact:true});
  fail(sameIds(formIds(form),ids),'editor_material_mismatch');
  verifyMaterialRegionForm(form,policy);
  const budget=tab.playwright.getByRole('textbox',{name:'请输入',exact:true});
  fail(Number(await roi.evaluate(e=>e.value))===task.roi_goal&&Number(await budget.evaluate(e=>e.value))===task.budget,'editor_values_changed');
  if(new_roi!=null){await roi.fill(String(new_roi));await roi.press('Tab');}
  if(new_budget!=null){
    const remaining=metric(form,'元，当前最多可再追加预算');
    fail(remaining!==null&&new_budget-task.budget<=remaining,'shared_budget_insufficient_or_unknown');
    await budget.fill(String(new_budget));await budget.press('Tab');
  }
  await tab.getAXState({emit:false});
  fail(Number(await roi.evaluate(e=>e.value))===(new_roi??task.roi_goal)&&Number(await budget.evaluate(e=>e.value))===(new_budget??task.budget),'parameter_fill_mismatch');
  return {status:'prepared_not_submitted',task_id,material_id:ids[0],material_ids:ids,old_roi:task.roi_goal,new_roi:new_roi??task.roi_goal,old_budget:task.budget,budget:new_budget??task.budget,regions:policy.regions??[],region_mode:policy.region_mode};
}


export async function reconcileMaterialOperations(store,pools) {
  const tasks=pools.flatMap(p=>p.issues.length?[]:p.tasks),confirmed=[];
  for(const o of Object.values(store.current().operations)) {
    if(['confirmed','not_submitted'].includes(o.status))continue;
    const p=o.prepared;
    const matches=tasks.filter(t=>(o.task_id??p?.task_id)?t.task_id===(o.task_id??p.task_id):p?.task_name&&t.name===p.task_name);
    if(matches.length!==1)continue;
    const t=matches[0];let ok=false;
    if(o.action)ok=o.action==='pause'?/暂停/.test(t.status):o.action==='resume'?t.status==='调控中':o.action==='delete'?t.status==='已删除':false;
    else if(p)ok=t.type==='控成本追投'&&t.budget===(p.budget??p.daily_budget_yuan)&&t.roi_goal===(p.new_roi??p.roi_goal)&&
      (p.task_id||!t.material_membership_complete||sameIds(materialIds(t),materialIds(p)));
    if(ok){await store.record({operation_id:o.operation_id,status:'confirmed',task_id:t.task_id});confirmed.push(o.operation_id);}
  }
  return confirmed;
}

export function formatMaterialReport(brief,actions='本轮未执行广告操作',judgment='') { const n=x=>x==null?'未知':x,b=brief.board??{}; return `综合成本：¥${n(b.cost)}｜净成交金额：¥${n(b.net_gmv)}｜综合营销ROI：${n(b.roi)}｜在线：${n(b.online)}人\n追投（本轮读盘）：${brief.pool_complete?'完整':'仅已读'} ${Array.isArray(brief.tasks)?brief.tasks.length:'未知'} 条\n${actions}${judgment?'\n使用者判断：'+judgment:''}`; }


export async function createMaterialStateStore({file,binding,execution_owner,runtime_root}) {
  fail(path.isAbsolute(file)&&execution_owner,'absolute_state_file_and_owner_required');
  let state;
  try {state=JSON.parse(await fs.readFile(file,'utf8'));}
  catch(e){if(e.code!=='ENOENT')throw e;state={binding,execution_owner,operations:{},latest:null,candidate_page:1};}
  fail(['advertiser_id','primary_ad_id','room_id','session_started_at'].every(k=>state.binding[k]===binding[k]),'state_scene_conflict');
  state.execution_owner=execution_owner;
  const sharedModule=runtime_root?await import('./codex-qc-control-state.mjs'):null;
  const shared=sharedModule?.createControlState({runtime_root,binding,execution_owner})??null;
  if(shared)await shared.exclusive(async({state:common,persist,session})=>{
    let changed=false;
    for(const [key,old] of Object.entries(state.operations??{})){
      if(common.operations[key]){
        const existing=common.operations[key];
        fail(existing.session===session,'original_request_scene_conflict');
        fail(existing.channel==='browser'&&(existing.task_id??existing.prepared?.task_id)===(old.task_id??old.prepared?.task_id)
          &&existing.request_fingerprint===old.request_fingerprint
          &&sharedModule.digest(existing.prepared??null)===sharedModule.digest(old.prepared??null),'original_request_conflict');
        continue;
      }
      common.operations[key]={...old,binding,session,channel:'browser'};changed=true;
    }
    if(changed)await persist();
    state.operations=Object.fromEntries(Object.entries(common.operations).filter(([,o])=>o.session===session));
  });
  const save=async()=>{await fs.mkdir(path.dirname(file),{recursive:true});const tmp=file+'.tmp';const local=shared?{...state,operations:{}}:state;await fs.writeFile(tmp,JSON.stringify(local,null,2)+'\n');await fs.rename(tmp,file);};
  return {
    current:()=>structuredClone(state),
    saveLatest:async latest=>{state.latest=latest;await save();},
    setCandidatePage:async page=>{fail(Number.isSafeInteger(page)&&page>0,'invalid_page');state.candidate_page=page;await save();},
    record:async result=>{
      fail(result.operation_id&&['intent','unknown','submitted_pending_readback','confirmed','not_submitted'].includes(result.status),'invalid_operation_record');
      fail(!Object.hasOwn(Object.prototype,result.operation_id),'invalid_operation_record');
      if(shared){
        return shared.exclusive(async({state:common,persist,session})=>{
          const old=common.operations[result.operation_id];
          const task_id=result.task_id??result.prepared?.task_id;
          if(result.status==='intent'){
            fail(!old,'operation_already_recorded_do_not_resend');
            fail(['live','ended'].includes(common.scenes[session]?.status)&&bindingMatches(common.scenes[session].binding,binding),'scene_observation_required');
            if(!task_id)fail(common.scenes[session].status==='live','scene_not_live');
            if(result.action==='resume')fail(common.scenes[session].status==='live','scene_not_live');
            if(task_id)fail(task_id!==binding.primary_ad_id&&!Object.values(common.operations).some(o=>(o.task_ids??[o.task_id??o.prepared?.task_id]).includes(task_id)&&!['confirmed','not_submitted','rejected'].includes(o.status)),'original_target_unresolved');
          }else{
            fail(old&&old.session===session,'operation_intent_missing');
            if(['confirmed','not_submitted','rejected'].includes(old.status))return structuredClone(old);
          }
          common.operations[result.operation_id]={...old,...result,binding,session,channel:'browser',
            ...(result.status==='intent'?{fingerprint:result.request_fingerprint??sharedModule.digest({binding,...result})}:{}),updated_at:now()};
          await persist();state.operations=Object.fromEntries(Object.entries(common.operations).filter(([,o])=>o.session===session));
          return structuredClone(common.operations[result.operation_id]);
        });
      }
      const old=state.operations[result.operation_id];
      if(result.status==='intent') {
        fail(!old,'operation_already_recorded_do_not_resend');
        const id=result.task_id??result.prepared?.task_id;
        if(id)fail(!Object.values(state.operations).some(o=>(o.task_id??o.prepared?.task_id)===id&&!['confirmed','not_submitted'].includes(o.status)),'original_target_unresolved');
      } else fail(old,'operation_intent_missing');
      state.operations[result.operation_id]={...old,...result,updated_at:now()};
      const completed=Object.values(state.operations).filter(o=>['confirmed','not_submitted'].includes(o.status)).sort((a,b)=>a.updated_at.localeCompare(b.updated_at));
      for(const o of completed.slice(0,Math.max(0,completed.length-100)))delete state.operations[o.operation_id];
      await save();
    },
  };
}
