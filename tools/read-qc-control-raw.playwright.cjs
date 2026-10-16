'use strict';

const DATE_INPUT_NAME=/^(?:请选择)?(?:开始日期|结束日期)$/;
const CONTROL_TABLE_CONTAINER='.main-vmok-plugin-oc-table-wrapper, .oc-table-wrapper';

async function controlTabIsSelected(page) {
  const tabs=await page.getByRole('tab').evaluateAll(elements=>elements.map(el=>{
    const label=el.cloneNode(true);
    // Aurora adds this zero-size live announcement to the accessible tab name.
    for(const live of label.querySelectorAll('div[aria-live="polite"]')){
      const style=live.style;
      if(style.width==='0px'&&style.height==='0px'&&style.position==='absolute'&&
        style.overflow==='hidden'&&style.opacity==='0'&&/^Tab \d+ of \d+$/.test(live.textContent.trim()))live.remove();
    }
    return {label:label.textContent.replace(/\s+/g,' ').trim(),selected:el.getAttribute('aria-selected')==='true'};
  }));
  const matches=tabs.filter(tab=>tab.label==='调控');
  if(matches.length)return matches.length===1&&matches[0].selected;
  const label=page.getByText('调控',{exact:true});
  if(await label.count()!==1)return false;
  return label.evaluate(el=>{
    const parent=el.parentElement;
    return parent?.matches('div.row.tab--active[data-e2e="oc_emptyKey_uni-prom/detail_uni_task_center"]')===true;
  });
}

// Read the currently selected control pool. No navigation, filtering or ad writes.
// The caller verifies the logged-in account and current live scene separately.
async function readQianchuanControlRaw(page, spec) {
  const start=Date.now();
  const fail=(code,message)=>{throw Object.assign(new Error(message),{code,advertising_writes:0});};
  if(!spec || typeof spec.advertiser_id!=='string' || typeof spec.primary_ad_id!=='string' || !/^\d+$/.test(spec.advertiser_id||'') || !/^\d+$/.test(spec.primary_ad_id||'') ||
    !/^\d{4}-\d{2}-\d{2}$/.test(spec.date||'') || typeof spec.pool!=='string' || !spec.pool.trim()) fail('binding_required','Explicit advertiser, plan, date and pool are required');
  if(!Number.isFinite(Date.parse(spec.date))||new Date(spec.date).toISOString().slice(0,10)!==spec.date)fail('date_invalid','Request date is not a valid calendar date');
  const checkUrl=()=>{
    const u=new URL(page.url());
    if(u.origin!=='https://qianchuan.jinritemai.com'||u.username||u.password)fail('identity_mismatch','Not a Qianchuan page');
    const params=new URLSearchParams(u.search);
    const hashQuery=u.hash.indexOf('?');
    if(hashQuery>=0)for(const [k,v]of new URLSearchParams(u.hash.slice(hashQuery+1)))params.append(k,v);
    for(const [keys,value]of [[['aavid','advertiser_id','advertiserId'],spec.advertiser_id],[['adId','primary_ad_id','primaryAdId'],spec.primary_ad_id]]){
      const values=keys.flatMap(key=>params.getAll(key));
      if(!values.length||values.some(v=>v!==value))fail('identity_mismatch','URL binding mismatch');
    }
    for(const value of ['dateRange','date_range','date','dr'].flatMap(key=>params.getAll(key))){
      let dates;try{dates=JSON.parse(value);}catch{dates=value.includes(',')?value.split(','):[value,value];}
      if(!Array.isArray(dates)||dates.length!==2||dates.some(v=>v!==spec.date))fail('date_mismatch','URL date differs from visible/requested date');
    }
    return u.href;
  };
  const beforeUrl=checkUrl();
  await page.getByText('计划ID：'+spec.primary_ad_id,{exact:true}).waitFor({state:'visible',timeout:5000});
  if(!await controlTabIsSelected(page))fail('wrong_tab','Control tab must already be selected');
  const dates=await page.getByRole('textbox',{name:DATE_INPUT_NAME}).evaluateAll(es=>es.map(e=>e.value));
  if(dates.length!==2||dates.some(v=>v!==spec.date))fail('date_mismatch','Visible date range differs from request');
  const filters=await page.getByRole('textbox',{name:'请选择',exact:true}).evaluateAll(es=>es.map(e=>e.value));
  if(filters.length!==3||filters[2]!==spec.pool)fail('pool_mismatch','Visible pool differs from request');
  await page.getByText('加载中...',{exact:true}).waitFor({state:'hidden',timeout:5000});
  const tableHeader=page.getByRole('row').filter({has:page.getByRole('columnheader',{name:'任务名称',exact:true})});
  if(await tableHeader.count()!==1)fail('table_ambiguous','No unique control table header');
  // One DOM observation for header, rows, total and filters. Do not combine
  // an old row read with a newer total, or include rows from another table.
  const capture=await tableHeader.evaluate((header,selectors)=>{
    const table=header.closest(selectors.table);
    if(!header.isConnected||!table)return null;
    const inputs=Array.from(document.querySelectorAll('input'));
    const visible=el=>el.getClientRects().length>0&&getComputedStyle(el).visibility!=='hidden';
    return {url:location.href,headers:Array.from(header.querySelectorAll('th')).map(c=>c.innerText.trim()),
      busy:[table,...table.querySelectorAll('[aria-busy="true"],[role="progressbar"]')].some(el=>el.matches('[aria-busy="true"],[role="progressbar"]')&&visible(el)),
      rows:Array.from(table.querySelectorAll('tbody tr')).map(e=>Array.from(e.querySelectorAll('td')).map(c=>c.innerText.trim())).filter(c=>c.length),
      table_text:table.innerText,text:document.body.innerText,
      dates:inputs.filter(e=>new RegExp(selectors.date).test(e.placeholder)).map(e=>e.value),
      filters:inputs.filter(e=>e.placeholder==='请选择').map(e=>e.value),
      searches:inputs.filter(e=>e.placeholder==='输入任务名称或ID搜索').map(e=>e.value),
      captured_at:new Date().toISOString()};
  },{table:CONTROL_TABLE_CONTAINER,date:DATE_INPUT_NAME.source});
  if(!capture)fail('table_structure_changed','Verified table container is missing');
  const {headers,rows,text}=capture;
  if(capture.url!==beforeUrl||JSON.stringify(capture.dates)!==JSON.stringify(dates)||JSON.stringify(capture.filters)!==JSON.stringify(filters))fail('view_changed','View changed before the table observation');
  if(!['任务名称','素材','调控状态','调控预算(元)','追投方式','创建时间','调控消耗','调控成交订单数'].every(h=>headers.includes(h)) ||
    !headers.some(h=>['调控综合营销ROI','调控支付ROI'].includes(h)) ||
    new Set(headers.filter(Boolean)).size!==headers.filter(Boolean).length)fail('table_structure_changed','Required raw headers are missing or duplicated');
  if(filters[0]!==''||filters[1]!==''||capture.searches.length!==1||capture.searches[0]!=='')fail('extra_filter_active','Additional filters or search restrict the requested pool');
  if(capture.busy||/加载中|加载失败|请求失败/.test(text))fail('data_unavailable','Control data is not ready');
  const totals=[...capture.table_text.matchAll(/共\s*(\d+)\s*条(?:任务|记录)/g)].map(m=>Number(m[1]));
  if(!totals.length||totals.some(n=>n!==totals[0]))fail('coverage_unknown','Visible total is missing or contradictory');
  const total=totals[0], ids=new Set();
  const tasks=rows.map(cells=>{
    const idMatches=[...(cells[headers.indexOf('任务名称')]||'').matchAll(/(?:^|\n)ID:\s*(\d+)/g)];
    const task_id=idMatches[0]?.[1];
    if(idMatches.length!==1||!task_id||ids.has(task_id)||cells.length!==headers.length)fail('table_structure_changed','Task IDs or columns are ambiguous');
    const status=cells[headers.indexOf('调控状态')];
    if((spec.pool==='调控中'&&status!=='调控中')||(spec.pool==='手动暂停'&&!status.includes('手动暂停')))fail('pool_mismatch','Task row status differs from selected pool');
    ids.add(task_id);return {task_id,raw_cells:cells};
  });
  const empty=total===0 && rows.length===0 && /暂无数据/.test(capture.table_text);
  if(total===0&&!empty)fail('empty_not_verified','Empty table was not verified');
  const afterUrl=checkUrl();
  if(beforeUrl!==afterUrl)fail('page_changed','Page changed while reading');
  const afterDates=await page.getByRole('textbox',{name:DATE_INPUT_NAME}).evaluateAll(es=>es.map(e=>e.value));
  const afterPool=await page.getByRole('textbox',{name:'请选择',exact:true}).nth(2).inputValue();
  if(JSON.stringify(dates)!==JSON.stringify(afterDates)||afterPool!==spec.pool)fail('view_changed','Date or pool changed while reading');
  const planStart=text.indexOf('抖音号：'), planEnd=text.indexOf('一键调速');
  const budget=text.split('\n').find(line=>line.includes('共用调控总预算'))||null;
  return {ok:true,channel:'playwright-native',advertising_writes:0,binding:{advertiser_id:spec.advertiser_id,primary_ad_id:spec.primary_ad_id,date:spec.date},
    url:afterUrl,pool:spec.pool,filters,headers,tasks,total,visible_rows:rows.length,complete:rows.length===total,empty_verified:empty,
    plan_raw:planStart>=0&&planEnd>planStart?text.slice(planStart,planEnd):null,shared_budget_raw:budget,
    page_update_raw:text.match(/\d{2}-\d{2} \d{2}:\d{2}更新/)?.[0]||null,
    captured_at:capture.captured_at,elapsed_ms:Date.now()-start,
    limits:['Current page only; incomplete pagination is reported, not silently accepted.','Logged-in account and live-scene verification remain with the caller.']};
}
module.exports={readQianchuanControlRaw};
