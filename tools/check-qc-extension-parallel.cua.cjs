'use strict';

// Run with already-bound Codex extension tabs. No navigation, refresh or ad writes.
async function readQianchuanExtensionProbe(binding) {
  const started = Date.now(), phases = [];
  const result = {room:binding.room,browser_id:binding.browser_id,tab_id:binding.tab.id,
    started_at:new Date(started).toISOString(),scope:'visible_task_pool',advertising_writes:0,phases};
  const phase = async (name, action) => {
    const t=Date.now();
    try {return await action();}
    finally {phases.push({name,started_offset_ms:t-started,elapsed_ms:Date.now()-t});}
  };
  try {
    const url = new URL(await phase('url',()=>binding.tab.url()));
    if(url.protocol!=='https:'||url.hostname!=='qianchuan.jinritemai.com'||!['/overall-prom/detail','/uni-prom/detail'].includes(url.pathname)
      ||url.searchParams.get('aavid')!==binding.advertiser_id||url.searchParams.get('adId')!==binding.primary_ad_id) throw Error('binding_url_mismatch');
    const dom=await phase('dom_snapshot',()=>binding.tab.playwright.domSnapshot());
    result.dom=dom;
    const header=dom.split(/^\s*- table[\s:]/m)[0];
    const adv=[...new Set([...header.matchAll(/^\s*- (?:generic(?: "[^"]*")?|text|paragraph): "?ID[：:]\s*(\d+)"?\s*$/gm)].map(m=>m[1]))];
    const plans=[...new Set([...header.matchAll(/^\s*- (?:generic|text|paragraph): "?计划ID[：:]\s*(\d+)"?\s*$/gm)].map(m=>m[1]))];
    if(!adv.length&&plans.length===1&&plans[0]===binding.primary_ad_id) {
      const boxes=await phase('responsive_account',()=>binding.tab.playwright.locator('.account-info-box').evaluateAll(
        es=>es.map(e=>({text:e.textContent,display:getComputedStyle(e).display}))));
      result.account_dom=boxes;
      if(boxes.length===1&&boxes[0].display==='none') {
        const matches=[...boxes[0].text.matchAll(/(?:^|\s)ID[：:]\s*(\d+)(?=\s|$)/g)];
        if(matches.length===1)adv.push(matches[0][1]);
      }
    }
    if(adv.length!==1||adv[0]!==binding.advertiser_id||plans.length!==1||plans[0]!==binding.primary_ad_id)throw Error('visible_identity_unverified');
    if(/- (?:generic|text): (?:加载中|正在加载)\.{0,3}\s*(?:\n|$)/.test(dom))throw Error('page_loading');
    const filters=[...dom.matchAll(/^\s*- textbox "请选择"(?: \[[^\]]+\])?(?:: (.*))?\s*$/gm)].map(m=>m[1]||'');
    result.filters=filters;
    if(filters.length!==3||filters.slice(0,2).some(v=>v&&v!=='全部')||filters[2]!==binding.pool)throw Error('pool_filter_unverified');
    if(/- textbox "输入任务名称或ID搜索"(?: \[[^\]]+\])?:\s*\S/.test(dom))throw Error('search_filter_present');
    const dateLabels=url.pathname==='/uni-prom/detail'?['请选择开始日期','请选择结束日期']:['开始日期','结束日期'];
    if(dateLabels.some(label=>!dom.includes('textbox "'+label+'": '+binding.date)))throw Error('date_unverified');
    if(url.pathname==='/uni-prom/detail') {
      const detail=new URLSearchParams(url.hash.slice(1)).get('uniDetail');
      if(!detail||JSON.parse(detail).tb!=='uni_task_center'||!dom.includes('- generic: 调控'))throw Error('control_tab_unverified');
    } else if(!/- tab "(?:Tab \d+ of \d+ )?调控"[^\n]*\[selected\]/.test(dom))throw Error('control_tab_unverified');
    const totals=[...dom.matchAll(/- generic: 共\s*(\d+)\s*条记录/g)].map(m=>Number(m[1]));
    const summaries=[...dom.matchAll(/- columnheader "共(\d+)条任务"/g)].map(m=>Number(m[1]));
    if(totals.length>1||summaries.length!==1||totals.length===1&&totals[0]!==summaries[0]
      ||!totals.length&&(summaries[0]!==0||!dom.includes('暂无数据')))throw Error('total_unverified');
    result.total=summaries[0];
    const raw=await phase('table_rows',()=>binding.tab.playwright.getByRole('row').evaluateAll(es=>es.map(e=>({
      headers:Array.from(e.querySelectorAll('th')).map(x=>x.textContent.trim()),
      cells:Array.from(e.querySelectorAll('td')).map(x=>x.textContent.trim())
    })),undefined,{timeoutMs:8000}));
    const hs=raw.filter(r=>r.headers.includes('任务名称'));
    if(hs.length!==1)throw Error('header_unverified');
    result.headers=hs[0].headers;
    result.rows=raw.filter(r=>r.cells.length).map(r=>r.cells);
    const taskColumn=result.headers.indexOf('任务名称');
    result.task_ids=result.rows.map(row=>row[taskColumn]?.match(/ID[：:]\s*(\d+)/)?.[1]??null);
    const roiColumn=binding.roi_column||'调控支付ROI';
    if(!['调控支付ROI','调控综合营销ROI'].includes(roiColumn))throw Error('roi_column_unsupported');
    const required=['调控状态','调控预算(元)','调控时长(小时)','调控消耗',roiColumn,'调控成交订单数'];
    if(required.some(h=>result.headers.filter(v=>v===h).length!==1))throw Error('required_columns_missing');
    if(result.rows.some(r=>r.length!==result.headers.length)||result.task_ids.some(v=>!v)
      ||new Set(result.task_ids).size!==result.total||result.rows.length!==result.total)throw Error('partial_or_duplicate_rows');
    const statusAt=result.headers.indexOf('调控状态');
    if(!['调控中','手动暂停'].includes(binding.pool)||result.rows.some(row=>binding.pool==='调控中'
      ?row[statusAt]!=='调控中':!row[statusAt].includes('手动暂停')))throw Error('stale_or_wrong_pool_rows');
    result.complete=true;
    result.status='read_verified';
  } catch(error) {
    result.complete=false;
    result.status='unknown';
    result.error=String(error.message||error);
  }
  result.finished_at=new Date().toISOString();
  result.elapsed_ms=Date.now()-started;
  return result;
}

async function checkQianchuanExtensionWave(bindings,label) {
  if(!Array.isArray(bindings)||bindings.length<1||bindings.length>4)throw Error('one_to_four_bound_pages_required');
  const t=Date.now();
  const reads=await Promise.all(bindings.map(readQianchuanExtensionProbe));
  return {label,started_at:new Date(t).toISOString(),elapsed_ms:Date.now()-t,complete:reads.every(r=>r.complete),reads};
}

async function readQianchuanExtensionAxSnapshot(binding) {
  const t=Date.now();
  const url=new URL(await binding.tab.url());
  if(url.protocol!=='https:'||url.hostname!=='qianchuan.jinritemai.com'
    ||!['/overall-prom/detail','/uni-prom/detail'].includes(url.pathname)
    ||url.searchParams.get('aavid')!==binding.advertiser_id||url.searchParams.get('adId')!==binding.primary_ad_id)throw Error('binding_url_mismatch');
  const ax=await binding.tab.getAXState({emit:false});
  return {scope:'ax_snapshot',complete:null,room:binding.room,tab_id:binding.tab.id,
    started_at:new Date(t).toISOString(),elapsed_ms:Date.now()-t,advertising_writes:0,ax};
}

async function refreshQianchuanExtensionTable(binding) {
  const t=Date.now();
  let stage='precheck';
  try {
    const before=await readQianchuanExtensionProbe(binding);
    if(!before.complete)return {...before,elapsed_ms:Date.now()-t,failed_stage:stage};
    if(/- (?:dialog|button "(?:提交|确认提交)")/.test(before.dom))throw Error('existing_form_protected');
    stage='sort_query';
    await binding.tab.playwright.getByRole('columnheader',{name:'调控消耗',exact:true}).click();
    stage='query_ready';
    const dom=await binding.tab.playwright.domSnapshot();
    if(/- (?:generic|text): (?:加载中|正在加载)\.{0,3}\s*(?:\n|$)/.test(dom)) {
      await binding.tab.playwright.getByText(/^(?:加载中|正在加载)\.{0,3}$/).waitFor({state:'hidden',timeoutMs:8000});
    }
    stage='readback';
    const after=await readQianchuanExtensionProbe(binding);
    return {...after,started_at:new Date(t).toISOString(),elapsed_ms:Date.now()-t,read_ms:after.elapsed_ms,
      refresh_method:'observed_cost_column_sort',failed_stage:after.complete?null:stage};
  } catch(error) {
    return {room:binding.room,started_at:new Date(t).toISOString(),elapsed_ms:Date.now()-t,complete:false,
      error:String(error.message||error),failed_stage:stage,advertising_writes:0};
  }
}

if(typeof module!=='undefined')module.exports={readQianchuanExtensionProbe,checkQianchuanExtensionWave,readQianchuanExtensionAxSnapshot,refreshQianchuanExtensionTable};
