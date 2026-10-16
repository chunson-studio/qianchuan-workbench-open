// 在 Codex cua_repl 会话中定义并调用；不是独立 Node/Playwright CLI。
// tab 必须来自已连接浏览器的 CUA API。仅刷新、导航、筛选、读取，无广告写操作。
// cfg: advertiser_id, primary_ad_id, task_id, task_name, material_id, date。
// 已实测入口：旧版 /uni-prom/detail 的「调控 → 素材追投」页。
var runQianchuanReadOnce = async function(tab,cfg) {
  const started=Date.now(),trace=[];
  const stamp=step=>trace.push({step,elapsed_ms:Date.now()-started});
  const retryRead=async fn=>{let error;for(let i=0;i<4;i++){try{return await fn();}catch(e){error=e;}}throw error;};
  const ready=async locator=>retryRead(()=>locator.waitFor({state:'visible',timeoutMs:3000}));
  const checkUrl=async()=>{const u=new URL(await tab.url());if(u.hostname!=='qianchuan.jinritemai.com'||u.pathname!=='/uni-prom/detail'||u.searchParams.get('aavid')!==cfg.advertiser_id||u.searchParams.get('adId')!==cfg.primary_ad_id)throw new Error('账户或主计划URL不匹配');};
  const identity=async()=>{
    await checkUrl();
    await ready(tab.playwright.getByText('计划ID：'+cfg.primary_ad_id,{exact:true}));
    await ready(tab.playwright.getByText('ID：'+cfg.advertiser_id,{exact:true}));
    const dates=await tab.playwright.getByRole('textbox',{name:/请选择开始日期|请选择结束日期/}).evaluateAll(es=>es.map(e=>e.value));
    if(dates.length!==2||dates.some(x=>x!==cfg.date))throw new Error('日期范围不匹配');
    return tab.playwright.domSnapshot();
  };
  try{
    if(['advertiser_id','primary_ad_id','task_id','task_name','material_id','date'].some(k=>!cfg[k]))throw new Error('缺少对象绑定参数');
    await identity();stamp('identity_verified');
    const refresh_started_at=new Date().toISOString();
    try{await tab.reload();}catch(e){if(!/Detached/i.test(String(e.message)))throw e;stamp('refresh_context_changed');}
    await retryRead(()=>tab.getAXState({emit:false}));
    let dom=await retryRead(identity);
    const refresh_completed_at=new Date().toISOString();stamp('refreshed');
    if(!dom.includes('columnheader "调控预算(元)"')){
      await tab.playwright.getByText('调控',{exact:true}).click();await tab.playwright.domSnapshot();
      await tab.playwright.getByText('素材追投',{exact:true}).click();
      await ready(tab.playwright.getByRole('columnheader',{name:'调控预算(元)',exact:true}));
      dom=await tab.playwright.domSnapshot();
    }
    stamp('boost_list_ready');
    const filters=tab.playwright.getByRole('textbox',{name:'请选择',exact:true});
    if(await filters.count()!==3)throw new Error('追投筛选结构变化');
    const values=await filters.evaluateAll(es=>es.map(e=>e.value));
    if(values[2]!=='全部（包括已删除）'){
      await filters.nth(2).click();await tab.playwright.domSnapshot();
      await tab.playwright.getByText('全部（包括已删除）',{exact:true}).click();
      await tab.getAXState({emit:false});
    }
    const search=tab.playwright.getByRole('textbox',{name:'输入任务名称或ID搜索'});
    await search.fill(cfg.task_name);await search.press('Enter');await tab.getAXState({emit:false});stamp('searched');
    const row=tab.playwright.getByRole('row').filter({hasText:cfg.task_id});
    await ready(row);
    if(await row.count()!==1)throw new Error('目标任务匹配不唯一');
    const raw=await row.getByRole('cell').allTextContents({});
    const headers=await tab.playwright.getByRole('columnheader').evaluateAll(es=>es.filter(e=>e.parentElement===es[0].parentElement).map(e=>e.innerText));
    if(headers.length!==raw.length)throw new Error('表头与单元格数量不一致');
    const fields=Object.fromEntries(headers.map((h,i)=>[h.trim(),raw[i].trim()]));
    if(!fields['任务名称']?.includes(cfg.task_name)||!fields['素材']?.includes(cfg.material_id))throw new Error('任务名称或素材绑定不匹配');
    const finalDom=await identity();
    const filterAfter=await filters.evaluateAll(es=>es.map(e=>e.value));
    if(filterAfter[2]!=='全部（包括已删除）')throw new Error('最终筛选范围不匹配');
    stamp('target_read');
    return {ok:true,mode:'read_only',ad_writes:0,binding:cfg,timing:{started_at:new Date(started).toISOString(),refresh_started_at,refresh_completed_at,captured_at:new Date().toISOString(),elapsed_ms:Date.now()-started},page_updated_at_label:finalDom.match(/\d{2}-\d{2} \d{2}:\d{2}更新/)?.[0]??null,plan_net_roi_target:finalDom.match(/净成交ROI目标：\n- generic: "?([\d.]+)/)?.[1]??null,headers,cells:raw,fields,coverage:'one_matched_task',trace};
  }catch(error){return {ok:false,mode:'read_only',ad_writes:0,error:String(error.message),elapsed_ms:Date.now()-started,trace};}
};

// schema_version 1.0 capture entry point for the complete visible task table.
// Supports only evidenced detail routes: /uni-prom/detail (全域) and /overall-prom/detail (乘方).
// It never changes filters or pagination. The legacy runQianchuanReadOnce entry point above remains compatible.
var runQianchuanCapturePage = async function(tab,cfg) {
  const started=Date.now(),trace=[];
  const stamp=step=>trace.push({step,elapsed_ms:Date.now()-started});
  const retryRead=async fn=>{let error;for(let i=0;i<4;i++){try{return await fn();}catch(e){error=e;}}throw error;};
  const ready=async locator=>retryRead(()=>locator.waitFor({state:'visible',timeoutMs:3000}));
  const planTypeByPath={'/uni-prom/detail':'quan_yu','/overall-prom/detail':'cheng_fang'};
  const isDate=value=>{
    if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
    const parsed=new Date(value+'T00:00:00.000Z');
    return Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===value;
  };
  const urlDateRange=value=>{
    let parsed;
    try{parsed=JSON.parse(value);}catch{parsed=value.split(/[~,]/);}
    if(!Array.isArray(parsed)||parsed.length!==2||!parsed.every(isDate))throw new Error('URL日期范围无法识别');
    return parsed;
  };
  const uniqueParam=(url,key)=>{
    const values=url.searchParams.getAll(key);
    if(values.length!==1||!values[0])throw new Error('URL参数缺失或重复：'+key);
    return values[0];
  };
  const requestedRange=()=>{
    if(Array.isArray(cfg.date_range)&&cfg.date_range.length===2&&cfg.date_range.every(isDate))return cfg.date_range;
    if(isDate(cfg.date))return [cfg.date,cfg.date];
    throw new Error('缺少date或date_range绑定参数');
  };
  const inspectIdentity=async()=>{
    const url=new URL(await tab.url());
    if(url.protocol!=='https:'||url.hostname!=='qianchuan.jinritemai.com'||!planTypeByPath[url.pathname])throw new Error('页面URL不是已验证的全域或乘方追投详情页');
    const planType=planTypeByPath[url.pathname];
    if(cfg.plan_type&&cfg.plan_type!==planType)throw new Error('配置计划类型与页面URL不一致');
    const dateKey=url.pathname==='/uni-prom/detail'?'dr':'dateRange';
    const otherDateKey=dateKey==='dr'?'dateRange':'dr';
    if(url.searchParams.getAll(otherDateKey).length)throw new Error('页面版本与URL日期参数不匹配');
    const range=urlDateRange(uniqueParam(url,dateKey));
    if(uniqueParam(url,'aavid')!==cfg.advertiser_id||uniqueParam(url,'adId')!==cfg.primary_ad_id)throw new Error('账户或主计划URL不匹配');
    const expected=requestedRange();
    if(range[0]!==expected[0]||range[1]!==expected[1])throw new Error('URL日期范围与请求绑定不匹配');
    const planText=tab.playwright.getByText('计划ID：'+cfg.primary_ad_id,{exact:true});
    const advertiserText=tab.playwright.getByText('ID：'+cfg.advertiser_id,{exact:true});
    await ready(planText);await ready(advertiserText);
    if(await planText.count()!==1||await advertiserText.count()!==1)throw new Error('页面实际账户或主计划身份不唯一');
    const textboxes=await tab.playwright.getByRole('textbox').evaluateAll(es=>es.map(e=>String(e.value||'')).filter(v=>/^\d{4}-\d{2}-\d{2}$/.test(v)));
    if(textboxes.length!==2||textboxes[0]!==range[0]||textboxes[1]!==range[1])throw new Error('页面实际日期范围与URL不匹配或无法唯一核验');
    return {url:url.href,plan_type:planType,date_range:range};
  };
  const idFromTaskCell=value=>{
    const matches=[...String(value||'').matchAll(/(?:任务|追投)\s*(?:ID|编号)\s*[:：#]?\s*([A-Za-z0-9_-]+)|\bID\s*[:：#]\s*([A-Za-z0-9_-]+)/gi)];
    if(matches.length>1)throw new Error('任务单元格包含多个任务ID');
    return matches[0]?(matches[0][1]||matches[0][2]):null;
  };
  const readTable=async(planType)=>{
    const headerGroups=await tab.playwright.getByRole('columnheader').evaluateAll(es=>{
      const groups=new Map();
      for(const e of es){const parent=e.parentElement;if(!parent)continue;if(!groups.has(parent))groups.set(parent,[]);groups.get(parent).push(String(e.innerText||''));}
      return Array.from(groups.values());
    });
    const headerMatches=headerGroups.filter(group=>group.some(h=>['任务名称','调控任务','追投任务'].includes(h.trim()))
      &&group.some(h=>['调控预算(元)','调控预算（元）','调控预算','预算'].includes(h.trim())));
    if(headerMatches.length!==1)throw new Error('追投表头缺失或匹配不唯一');
    const headers=headerMatches[0];
    const taskIndex=headers.findIndex(h=>['任务名称','调控任务','追投任务'].includes(h.trim()));
    const rowLocator=planType==='cheng_fang'?tab.playwright.locator('table tr'):tab.playwright.getByRole('row');
    const rawRows=await rowLocator.evaluateAll(es=>es.map(e=>Array.from(e.cells||[]).map(c=>String(c.innerText||''))));
    // The evidenced 乘方 table has a separate cross-column "共N条任务" aggregate row;
    // retain it as raw summary data, while every task row must match header width exactly.
    const rows=[],summaryRows=[],ids=new Set();let totalCount=null;
    for(const raw of rawRows){
      if(raw.every(value=>!String(value).trim()))continue;
      const text=raw.join('\n');
      if(raw.length===headers.length&&raw.every((value,i)=>String(value).trim()===String(headers[i]).trim()))continue;
      const summary=text.match(/共\s*(\d+)\s*条任务/);
      if(summary&&!idFromTaskCell(raw[taskIndex]||'')){
        const count=Number(summary[1]);
        if(totalCount!==null&&totalCount!==count)throw new Error('页面合计行数量不一致');
        totalCount=count;summaryRows.push(raw);continue;
      }
      const taskCell=String(raw[taskIndex]||'');
      const id=idFromTaskCell(taskCell);
      if(!id){if(/(?:任务|追投)\s*(?:ID|编号)|\bID\s*[:：#]/i.test(taskCell))throw new Error('任务单元格中的ID格式无法识别');continue;}
      if(raw.length!==headers.length)throw new Error('追投任务行宽与表头不一致');
      if(ids.has(id))throw new Error('任务ID重复：'+id);
      ids.add(id);rows.push(raw);
    }
    if(rows.length>100||headers.length>128||rows.some(row=>row.some(cell=>cell.length>4096)))throw new Error('追投表超过安全采集限制');
    if(rows.length===0&&totalCount!==0)throw new Error('页面没有已核验的任务行或明确空表计数');
    if(totalCount!==null&&totalCount<rows.length)throw new Error('页面合计数小于当前任务行数');
    return {headers,rows,summary_rows:summaryRows,total_count:totalCount};
  };
  const waitForTableSettled=async()=>{
    let dom=await tab.playwright.domSnapshot();
    if(/加载中|正在加载|Loading/i.test(dom)){
      try{await tab.playwright.getByText('加载中...',{exact:true}).waitFor({state:'hidden',timeoutMs:3000});}
      catch{throw new Error('追投表仍在加载');}
      dom=await tab.playwright.domSnapshot();
    }
    if(/加载中|正在加载|Loading/i.test(dom))throw new Error('追投表仍在加载');
    return dom;
  };
  const readPageControls=async(planType)=>{
    // Only the old 全域 placeholders and search control have exact locator evidence.
    // The 乘方 filter structure is not yet verified, so preserve it as unknown.
    if(planType!=='quan_yu')return {filters:null,keyword:null};
    const filters=tab.playwright.getByRole('textbox',{name:'请选择',exact:true});
    if(await filters.count()!==3)throw new Error('全域追投筛选结构无法唯一核验');
    const values=await filters.evaluateAll(es=>es.map(e=>String(e.value??'')));
    if(values.length!==3||values.some(value=>typeof value!=='string'))throw new Error('全域追投筛选值无法完整读取');
    const search=tab.playwright.getByRole('textbox',{name:'输入任务名称或ID搜索',exact:true});
    if(await search.count()!==1)throw new Error('全域追投搜索框无法唯一核验');
    const keyword=await search.evaluate(e=>String(e.value??''));
    return {filters:values,keyword};
  };
  try{
    if(['account_id','advertiser_id','primary_ad_id'].some(k=>!cfg[k]))throw new Error('缺少本机账户、平台账户或主计划绑定参数');
    const before=await inspectIdentity();stamp('identity_before_refresh');
    if(cfg.on_verified)await cfg.on_verified('common.identity.verify',{...before});
    const refresh_started_at=new Date().toISOString();
    try{await tab.reload();}catch(e){if(!/Detached/i.test(String(e.message)))throw e;stamp('refresh_context_changed');}
    await retryRead(()=>tab.getAXState({emit:false}));
    const afterRefresh=await inspectIdentity();
    if(JSON.stringify(before)!==JSON.stringify(afterRefresh))throw new Error('刷新后页面URL或身份发生变化');
    const taskHeader=tab.playwright.getByRole('columnheader',{name:'任务名称',exact:true});
    await ready(taskHeader);
    const domBefore=await waitForTableSettled();
    const controlsBefore=await readPageControls(afterRefresh.plan_type);
    const refresh_completed_at=new Date().toISOString();stamp('refreshed_and_table_ready');
    if(cfg.on_verified)await cfg.on_verified('common.page.reload',{refresh_started_at,refresh_completed_at});
    const first=await readTable(afterRefresh.plan_type);stamp('table_read');
    const afterRead=await inspectIdentity();
    const domAfter=await waitForTableSettled();
    const second=await readTable(afterRefresh.plan_type);
    if(JSON.stringify(first)!==JSON.stringify(second))throw new Error('读取期间追投表状态发生变化');
    const controlsAfter=await readPageControls(afterRefresh.plan_type);
    if(JSON.stringify(controlsBefore)!==JSON.stringify(controlsAfter))throw new Error('读取期间筛选或搜索状态发生变化');
    const finalIdentity=await inspectIdentity();
    if(JSON.stringify(afterRefresh)!==JSON.stringify(afterRead)||JSON.stringify(afterRead)!==JSON.stringify(finalIdentity))throw new Error('读取前后页面身份、日期或计划类型发生变化');
    const captured_at=new Date().toISOString();
    const updated=domAfter.match(/\d{2}-\d{2}\s+\d{2}:\d{2}\s*更新/)?.[0]??null;
    const rawStatusFilter=controlsAfter.filters?.[2];
    const statusFilter=afterRefresh.plan_type==='quan_yu'&&rawStatusFilter?.trim()?
      rawStatusFilter:null;
    const capture={
      schema_version:'1.0',source:'browser_dom',
      binding:{account_id:cfg.account_id,advertiser_id:cfg.advertiser_id,primary_ad_id:cfg.primary_ad_id,...(Array.isArray(cfg.target_ids)?{target_ids:cfg.target_ids}: {})},
      page:{url:finalIdentity.url,plan_type:finalIdentity.plan_type,metric_applicability:{comprehensive_roi:finalIdentity.plan_type==='cheng_fang'?'applicable':'not_applicable'},
        advertiser_id:cfg.advertiser_id,primary_ad_id:cfg.primary_ad_id,date_range:finalIdentity.date_range,
        updated_at_label:updated,status_filter:statusFilter,filters:controlsAfter.filters,keyword:controlsAfter.keyword,
        headers:first.headers,rows:first.rows,summary_rows:first.summary_rows,
        total_count:first.total_count,coverage:{scope:'current_page_only',page_number:null,page_size:null}},
      timing:{refresh_started_at,refresh_completed_at,captured_at},
    };
    stamp('capture_verified');
    if(cfg.on_verified)await cfg.on_verified('common.table.read_headers_and_row',{captured_at,row_count:first.rows.length,column_count:first.headers.length});
    return {ok:true,mode:'read_only',ad_writes:0,capture,coverage:'current_page_only',trace};
  }catch(error){return {ok:false,mode:'read_only',ad_writes:0,error:String(error.message),trace};}
};

// 允许在支持本地模块加载的 CUA 宿主导入函数；加载模块本身不访问浏览器。
if (typeof module !== 'undefined') module.exports = { runQianchuanReadOnce, runQianchuanCapturePage };
