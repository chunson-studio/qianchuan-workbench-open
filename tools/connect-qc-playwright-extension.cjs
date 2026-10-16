'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {createRequire}=require('node:module');
const fail=code=>{throw Object.assign(new Error(code),{code});};
function redactExtensionResult(value,token){
  return JSON.parse(JSON.stringify(value).replaceAll(token,'[redacted]')
    .replace(/([?&](?:token|msToken|a_bogus|verifyFp|fp)=)[^&\s)"<>\\]+/gi,'$1[redacted]'));
}
function decodeExtensionJson(result){
  if(result?.isError){
    const message=result.content?.filter(x=>x.type==='text').map(x=>x.text).join('\n')||'';
    fail(/Target page, context or browser has been closed|Tab \d+ not found|No tabs open|extension_test_attach_timeout/.test(message)?'extension_target_lost':'extension_tool_returned_error');
  }
  const block=result?.content?.find(item=>item.type==='text'&&item.text.startsWith('### Result\n'));
  if(!block)fail('extension_result_missing');
  const body=block.text.slice('### Result\n'.length).split('\n### ')[0].trim();
  try{return JSON.parse(body);}catch{fail('extension_result_invalid');}
}
function buildExtensionControlCode(spec,{sortQuery=false}={}){
  if(!spec||Object.keys(spec).some(k=>!['advertiser_id','primary_ad_id','date','pool'].includes(k))||
    typeof spec.advertiser_id!=='string'||typeof spec.primary_ad_id!=='string'||typeof spec.date!=='string'||!/^\d+$/.test(spec.advertiser_id)||!/^\d+$/.test(spec.primary_ad_id)||
    !/^\d{4}-\d{2}-\d{2}$/.test(spec.date||'')||!['手动暂停','调控中'].includes(spec.pool)||typeof sortQuery!=='boolean')fail('extension_read_spec_invalid');
  // Reuse the verified dependency-free reader without a second parser. The MCP
  // code tool's VM does not support dynamic import; source is fixed locally.
  const reader=fs.readFileSync(path.join(__dirname,'read-qc-control-raw.playwright.cjs'),'utf8');
  return `async (anchor) => {
    const spec=${JSON.stringify(spec)},start=Date.now();
    if(!anchor.url().startsWith('chrome-extension://mmlmfjhmonkocbjadbfplnigmagldckm/connect.html?'))throw Error('extension_anchor_required');
    const candidates=anchor.context().pages().filter(p=>{try{const u=new URL(p.url());return u.origin==='https://qianchuan.jinritemai.com'&&u.searchParams.get('aavid')===spec.advertiser_id&&u.searchParams.get('adId')===spec.primary_ad_id;}catch{return false;}});
    if(candidates.length!==1)throw Error('extension_test_attach_timeout');
    const page=candidates[0];
    const module={exports:{}};\n${reader}\n
    const text=await page.locator('body').innerText();
    const header=text.slice(0,text.indexOf('计划ID'));
    const accounts=[...new Set([...header.matchAll(/(?:^|\\n)ID[：:]\\s*(\\d+)/g)].map(m=>m[1]))];
    if(accounts.length!==1||accounts[0]!==spec.advertiser_id)throw Error('visible_account_mismatch');
    const before=await module.exports.readQianchuanControlRaw(page,spec);
    if(!before.complete)throw Error('extension_pool_incomplete');
    const document_info=await page.evaluate(()=>({time_origin:performance.timeOrigin,ready_state:document.readyState,visibility:document.visibilityState,focused:document.hasFocus()}));
    if(!${sortQuery})return {...before,channel:'playwright-extension',operation:'read_control',document_info,operation_ms:Date.now()-start};
    if(await page.getByRole('dialog').evaluateAll(es=>es.some(e=>e.getClientRects().length)))throw Error('existing_form_protected');
    const target=page.getByRole('columnheader',{name:'调控消耗',exact:true});
    if(await target.count()!==1)throw Error('sort_column_not_unique');
    const responsePending=page.waitForResponse(r=>{const u=new URL(r.url());return u.origin==='https://qianchuan.jinritemai.com'&&u.pathname==='/ad/api/pmc/v1/uni-promotion/ad/list-required';},{timeout:10000});
    void responsePending.catch(()=>{});
    const label=target.getByText('调控消耗',{exact:true});
    if(await label.count()!==1)throw Error('sort_label_not_unique');
    // Dispatch only the verified query label; no foreground or ad-control event.
    await label.dispatchEvent('click',undefined,{timeout:5000});
    const response=await responsePending;await response.finished();
    if(response.status()!==200)throw Error('sort_query_response_failed');
    const after=await module.exports.readQianchuanControlRaw(page,spec);
    if(!after.complete)throw Error('extension_pool_incomplete');
    return {...after,channel:'playwright-extension',operation:'sort_query',document_info,operation_ms:Date.now()-start,query_response:{status:response.status(),path:new URL(response.url()).pathname}};
  }`;
}
async function readExtensionControl(client,spec,options={}){
  const start=Date.now();
  const selected=await client.callTool('browser_tabs',{action:'select',index:0},10000);
  if(selected?.isError)fail('extension_anchor_unavailable');
  const result=await client.callTool('browser_run_code_unsafe',{code:buildExtensionControlCode(spec,options)},25000);
  return {...decodeExtensionJson(result),client_elapsed_ms:Date.now()-start};
}
async function bindExtensionTestTab(client,{tab_id,expected_group_id,spec,allow_orphan=false}){
  if(!Number.isSafeInteger(tab_id)||tab_id<=0||!Number.isSafeInteger(expected_group_id)||expected_group_id<0||typeof allow_orphan!=='boolean')fail('extension_test_binding_invalid');
  buildExtensionControlCode(spec);
  const args={tab_id,expected_group_id,advertiser_id:spec.advertiser_id,primary_ad_id:spec.primary_ad_id,allow_orphan};
  const code=`async () => {
    if(location.origin!=='chrome-extension://mmlmfjhmonkocbjadbfplnigmagldckm'||location.pathname!=='/connect.html')throw Error('extension_anchor_required');
    const a=${JSON.stringify(args)},anchor=await chrome.tabs.getCurrent(),tab=await chrome.tabs.get(a.tab_id);
    const status=await chrome.runtime.sendMessage({type:'getConnectionStatus'});
    if(anchor.groupId<0||!status.connections.some(c=>c.connectedTabIds.includes(anchor.id)))throw Error('extension_anchor_unbound');
    const orphan=a.allow_orphan&&tab.groupId===-1&&!status.connections.some(c=>c.connectedTabIds.includes(tab.id));
    if(tab.groupId!==a.expected_group_id&&!orphan)throw Error('extension_test_group_changed');
    if(!orphan){const oldGroup=await chrome.tabGroups.get(tab.groupId);if(!oldGroup.title?.startsWith('Playwright · '))throw Error('extension_test_group_unverified');}
    const u=new URL(tab.url);
    if(u.origin!=='https://qianchuan.jinritemai.com'||!['/overall-prom/detail','/uni-prom/detail'].includes(u.pathname)||u.searchParams.get('aavid')!==a.advertiser_id||u.searchParams.get('adId')!==a.primary_ad_id)throw Error('extension_test_identity_mismatch');
    await chrome.tabs.ungroup([tab.id]);
    await chrome.tabs.group({tabIds:[tab.id],groupId:anchor.groupId});
    return {tab_id:tab.id,group_id:anchor.groupId,action:'bound_existing_test_tab',advertising_writes:0};
  }`;
  const binding=decodeExtensionJson(await client.callTool('browser_evaluate',{function:code},10000));
  return {...binding,...await waitExtensionTestPage(client,spec)};
}
async function waitExtensionTestPage(client,spec){
  buildExtensionControlCode(spec);
  const anchor=await client.callTool('browser_tabs',{action:'select',index:0},10000);
  if(anchor?.isError)fail('extension_anchor_unavailable');
  const readyCode=`async (page) => {
    const a=${JSON.stringify(spec)},context=page.context();
    const matches=p=>{try{const u=new URL(p.url());return u.origin==='https://qianchuan.jinritemai.com'&&u.searchParams.get('aavid')===a.advertiser_id&&u.searchParams.get('adId')===a.primary_ad_id;}catch{return false;}};
    if(!context.pages().some(matches))try{await context.waitForEvent('page',{predicate:matches,timeout:5000});}catch{throw Error('extension_test_attach_timeout');}
    const pages=context.pages().filter(matches);
    if(pages.length!==1)throw Error('extension_test_page_ambiguous');
    return {ready:true,index:context.pages().indexOf(pages[0])};
  }`;
  return decodeExtensionJson(await client.callTool('browser_run_code_unsafe',{code:readyCode},10000));
}
async function evaluateExtensionAnchor(client,fn,timeoutMs=10000){
  const code=`async(current)=>{const anchors=current.context().pages().filter(p=>p.url().startsWith('chrome-extension://mmlmfjhmonkocbjadbfplnigmagldckm/connect.html?'));if(anchors.length!==1)throw Error('extension_anchor_unavailable');return await anchors[0].evaluate(${fn});}`;
  return decodeExtensionJson(await client.callTool('browser_run_code_unsafe',{code},timeoutMs));
}
async function waitExtensionDetachQuiet(client,{tab_id,expected_group_id}){
  const code=`async()=>{
    if(location.origin!=='chrome-extension://mmlmfjhmonkocbjadbfplnigmagldckm'||location.pathname!=='/connect.html')throw Error('extension_anchor_required');
    const a=${JSON.stringify({tab_id,expected_group_id})},tab=await chrome.tabs.get(a.tab_id);
    if(tab.groupId!==a.expected_group_id)throw Error('extension_test_group_changed');
    if(window.__qcDetachWait?.tab_id===a.tab_id&&window.__qcDetachWait.listener)return {started:true};
    if(window.__qcDetachWait?.listener)chrome.debugger.onDetach.removeListener(window.__qcDetachWait.listener);
    const state={tab_id:a.tab_id,events:[]};
    state.listener=(source,reason)=>{if(source.tabId===a.tab_id&&reason==='target_closed')state.events.push({reason,at:Date.now()});};
    window.__qcDetachWait=state;chrome.debugger.onDetach.addListener(state.listener);
    return {started:true};
  }`;
  const start=Date.now();let quietStart=start,count=0,events=[],transient_errors=0,initialized=false;
  const evaluateQuiet=async fn=>{
    try{return await evaluateExtensionAnchor(client,fn,5000);}
    catch(error){
      // Chrome can emit a delayed detach while MCP is evaluating the anchor.
      // Retry only this bounded diagnostic, and reset the observed quiet time.
      if(error.code!=='extension_target_lost'||++transient_errors>3)throw error;
      quietStart=Date.now();return null;
    }
  };
  try{
    while(Date.now()-start<15000){
      if(!initialized){initialized=!!await evaluateQuiet(code);if(!initialized){await new Promise(resolve=>setTimeout(resolve,400));continue;}}
      await new Promise(resolve=>setTimeout(resolve,400));
      const state=await evaluateQuiet(`async()=>{const tab=await chrome.tabs.get(${tab_id});if(tab.groupId!==${expected_group_id})throw Error('extension_test_group_changed');if(window.__qcDetachWait?.tab_id!==${tab_id}||!window.__qcDetachWait.listener)throw Error('extension_detach_observer_missing');return {events:window.__qcDetachWait.events};}`);
      if(!state)continue;
      events=state.events;
      if(events.length!==count){count=events.length;quietStart=Date.now();}
      if(Date.now()-quietStart>=5000)return {events,quiet_ms:Date.now()-quietStart,elapsed_ms:Date.now()-start,transient_errors};
    }
    fail('extension_detach_unstable');
  }finally{
    await evaluateExtensionAnchor(client,'()=>{if(window.__qcDetachWait?.listener)chrome.debugger.onDetach.removeListener(window.__qcDetachWait.listener);delete window.__qcDetachWait;return {stopped:true};}',5000).catch(()=>{});
  }
}
async function inspectExtensionTestBinding(client,binding){
  const {tab_id,expected_group_id,spec}=binding;
  if(!Number.isSafeInteger(tab_id)||tab_id<=0||!Number.isSafeInteger(expected_group_id)||expected_group_id<0)fail('extension_test_binding_invalid');
  buildExtensionControlCode(spec);
  const anchorSelected=await client.callTool('browser_tabs',{action:'select',index:0},10000);
  if(anchorSelected.isError)fail('extension_anchor_unavailable');
  const args={tab_id,expected_group_id,advertiser_id:spec.advertiser_id,primary_ad_id:spec.primary_ad_id};
  const code=`async(page)=>{
    const a=${JSON.stringify(args)},context=page.context(),pages=context.pages();
    const anchors=pages.filter(p=>p.url().startsWith('chrome-extension://mmlmfjhmonkocbjadbfplnigmagldckm/connect.html?'));
    if(anchors.length!==1)throw Error('extension_anchor_unavailable');
    await anchors[0].evaluate(async a=>{const tab=await chrome.tabs.get(a.tab_id),anchor=await chrome.tabs.getCurrent(),u=new URL(tab.url);if(anchor.groupId!==a.expected_group_id||tab.groupId!==a.expected_group_id||u.origin!=='https://qianchuan.jinritemai.com'||u.searchParams.get('aavid')!==a.advertiser_id||u.searchParams.get('adId')!==a.primary_ad_id)throw Error('extension_test_identity_mismatch');},a);
    const matches=pages.filter(p=>{try{const u=new URL(p.url());return u.origin==='https://qianchuan.jinritemai.com'&&u.searchParams.get('aavid')===a.advertiser_id&&u.searchParams.get('adId')===a.primary_ad_id;}catch{return false;}});
    if(matches.length>1)throw Error('extension_test_page_ambiguous');
    return {index:matches.length?pages.indexOf(matches[0]):-1,anchor_index:pages.indexOf(anchors[0])};
  }`;
  return decodeExtensionJson(await client.callTool('browser_run_code_unsafe',{code},10000));
}
async function ensureExtensionTestPage(client,binding){
  const state=await inspectExtensionTestBinding(client,binding);
  if(state.index>=0)return {index:state.index,recovered:false};
  const selected=await client.callTool('browser_tabs',{action:'select',index:state.anchor_index},10000);
  if(selected.isError)fail('extension_anchor_unavailable');
  const quiet=await waitExtensionDetachQuiet(client,binding);
  const ready=await bindExtensionTestTab(client,binding);
  return {...ready,recovered:true,quiet};
}
async function refreshExtensionControl(client,{tab_id,expected_group_id,spec}){
  const start=Date.now();
  if(!Number.isSafeInteger(tab_id)||tab_id<=0||!Number.isSafeInteger(expected_group_id)||expected_group_id<0)fail('extension_test_binding_invalid');
  let phase='preflight';
  try{
  const preflight=await ensureExtensionTestPage(client,{tab_id,expected_group_id,spec});
  const before=await readExtensionControl(client,spec);
  const anchorResult=await client.callTool('browser_tabs',{action:'select',index:0},10000);
  if(anchorResult.isError)fail('extension_anchor_unavailable');
  const args={tab_id,expected_group_id,url:before.url};
  const code=`async () => {
    if(location.origin!=='chrome-extension://mmlmfjhmonkocbjadbfplnigmagldckm'||location.pathname!=='/connect.html')throw Error('extension_anchor_required');
    const a=${JSON.stringify(args)},anchor=await chrome.tabs.getCurrent(),tab=await chrome.tabs.get(a.tab_id);
    const status=await chrome.runtime.sendMessage({type:'getConnectionStatus'});
    if(anchor.groupId!==a.expected_group_id||tab.groupId!==a.expected_group_id||tab.url!==a.url||!status.connections.some(c=>c.connectedTabIds.includes(anchor.id)&&c.connectedTabIds.includes(tab.id)))throw Error('extension_refresh_binding_mismatch');
    const events=[],deadline=Date.now()+20000;
    const loaded=new Promise((resolve,reject)=>{
      const listener=(id,change)=>{if(id!==a.tab_id||!change.status)return;events.push({status:change.status,at:Date.now()});if(change.status==='complete'&&events.some(e=>e.status==='loading')){clearTimeout(timer);chrome.tabs.onUpdated.removeListener(listener);resolve();}};
      const timer=setTimeout(()=>{chrome.tabs.onUpdated.removeListener(listener);reject(Error('extension_reload_not_complete'));},15000);
      chrome.tabs.onUpdated.addListener(listener);
    });void loaded.catch(()=>{});
    let error;
    try{await chrome.tabs.reload(tab.id);await loaded;}catch(e){error=e.message;}
    if(Date.now()>deadline)throw Error('extension_refresh_deadline');
    const current=await chrome.tabs.get(tab.id),u=new URL(current.url),old=new URL(a.url);
    if(current.groupId!==anchor.groupId||u.origin!==old.origin||u.pathname!==old.pathname||['aavid','adId','dateRange'].some(k=>u.searchParams.get(k)!==old.searchParams.get(k)))throw Error('extension_refresh_identity_changed');
    return {tab_id:tab.id,group_id:anchor.groupId,events,reload_complete:!error,error:error||null,advertising_writes:0};
  }`;
  phase='reload_once';
  const reload=await evaluateExtensionAnchor(client,code,25000);
  if(!reload.reload_complete)fail('extension_reload_not_complete');
  const readAfter=async()=>{
    await waitExtensionTestPage(client,spec);
    const readyCode=`async(anchor)=>{const a=${JSON.stringify(spec)},pages=anchor.context().pages().filter(p=>{try{const u=new URL(p.url());return u.origin==='https://qianchuan.jinritemai.com'&&u.searchParams.get('aavid')===a.advertiser_id&&u.searchParams.get('adId')===a.primary_ad_id;}catch{return false;}});if(pages.length!==1)throw Error('extension_test_attach_timeout');await pages[0].getByRole('columnheader',{name:'任务名称',exact:true}).waitFor({state:'visible',timeout:10000});return {ready:true};}`;
    decodeExtensionJson(await client.callTool('browser_run_code_unsafe',{code:readyCode},15000));
    return await readExtensionControl(client,spec);
  };
  let after,recovered=false,quiet;
  phase='read_new_document';
  try{after=await readAfter();}
  catch(error){
    error.refresh_diagnostic={reload,elapsed_ms:Date.now()-start};
    if(error.code!=='extension_target_lost')throw error;
    const selected=await client.callTool('browser_tabs',{action:'select',index:0},10000);
    if(selected.isError)fail('extension_anchor_unavailable');
    phase='wait_detach_quiet';
    quiet=await waitExtensionDetachQuiet(client,{tab_id,expected_group_id});
    phase='rebind_original_tab';
    try{await bindExtensionTestTab(client,{tab_id,expected_group_id,spec});recovered=true;after=await readAfter();}
    catch(secondError){secondError.refresh_diagnostic={reload,quiet,elapsed_ms:Date.now()-start};throw secondError;}
  }
  phase='verify_new_document';
  if(!Number.isFinite(before.document_info?.time_origin)||!Number.isFinite(after.document_info?.time_origin)||before.document_info.time_origin===after.document_info.time_origin)fail('extension_new_document_unverified');
  return {ok:true,channel:'playwright-extension',operation:'refresh_control',advertising_writes:0,new_document:true,preflight_recovered:preflight.recovered,recovered,quiet,reload,before_document:before.document_info,after,elapsed_ms:Date.now()-start};
  }catch(error){error.refresh_phase=phase;throw error;}
}

// Official Playwright MCP extension client. Profile credentials stay in a
// git-ignored local file and the child process environment, never source/logs.
async function connectPlaywrightExtension({configFile,depsRoot,clientName='Qianchuan maintenance'}){
  if(!path.isAbsolute(configFile||'')||!path.isAbsolute(depsRoot||''))fail('extension_config_path_invalid');
  const stat=fs.lstatSync(configFile);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16384)fail('extension_config_invalid');
  const config=JSON.parse(fs.readFileSync(configFile,'utf8'));
  if(!/^(?:Default|Profile \d+)$/.test(config.profile_dir_name||'')||
    !/^[A-Za-z0-9_-]{32,256}$/.test(config.extension_token||'')||
    config.extension_id!=='mmlmfjhmonkocbjadbfplnigmagldckm')fail('extension_config_invalid');
  const requireSdk=createRequire(path.resolve(__dirname,'../server-app/package.json'));
  const {Client}=requireSdk('@modelcontextprotocol/sdk/client/index.js');
  const {StdioClientTransport}=requireSdk('@modelcontextprotocol/sdk/client/stdio.js');
  const cli=path.join(depsRoot,'node_modules/@playwright/mcp/cli.js');
  if(!fs.existsSync(cli))fail('extension_mcp_dependency_missing');
  if(config.chrome_executable_path!==undefined&&(!path.isAbsolute(config.chrome_executable_path)||!fs.existsSync(config.chrome_executable_path)))fail('extension_chrome_path_invalid');
  const env={};
  for(const key of ['PATH','Path','SystemRoot','WINDIR','LOCALAPPDATA','APPDATA','USERPROFILE','TEMP','TMP','PROGRAMFILES','PROGRAMFILES(X86)'])if(process.env[key])env[key]=process.env[key];
  env.PLAYWRIGHT_MCP_EXTENSION_TOKEN=config.extension_token;
  const transport=new StdioClientTransport({command:process.execPath,cwd:path.resolve(__dirname,'..'),
    args:['--dns-result-order=ipv4first',cli,'--extension','--profile-dir-name',config.profile_dir_name,...(config.chrome_executable_path?['--executable-path',config.chrome_executable_path]:[]),'--codegen','none','--snapshot-mode','none','--image-responses','omit','--no-webmcp','--output-dir',path.join(path.dirname(configFile),'outputs'),'--timeout-action','5000','--timeout-navigation','15000','--timeout-settle','0'],env,stderr:'pipe'});
  let stderr='',lastToolError=null;transport.stderr?.on('data',chunk=>{stderr=(stderr+String(chunk).replaceAll(config.extension_token,'[redacted]')).slice(-4000);});
  const client=new Client({name:clientName,version:'1.0.0'});
  let transportConnected=false;client.onclose=()=>{transportConnected=false;};
  try{await client.connect(transport);}
  catch(error){await transport.close().catch(()=>{});fail('extension_mcp_start_failed');}
  transportConnected=true;
  return {profile_dir_name:config.profile_dir_name,server_pid:transport.pid,
    isTransportConnected:()=>transportConnected,
    listTools:async()=>redactExtensionResult(await client.listTools(),config.extension_token),
    callTool:async(name,args={},timeoutMs=25000)=>{
      try{const result=redactExtensionResult(await client.callTool({name,arguments:args},undefined,{timeout:timeoutMs}),config.extension_token);if(result.isError)lastToolError={tool:name,at:new Date().toISOString(),text:result.content?.filter(c=>c.type==='text').map(c=>c.text).join('\n').slice(0,1600)};return result;}
      catch(error){throw Object.assign(new Error('extension_tool_failed'),{code:'extension_tool_failed',tool:name});}
    },
    diagnostics:()=>({profile_dir_name:config.profile_dir_name,server_pid:transport.pid,stderr,last_tool_error:lastToolError}),
    close:()=>client.close(),
  };
}
module.exports={connectPlaywrightExtension,redactExtensionResult,decodeExtensionJson,buildExtensionControlCode,readExtensionControl,bindExtensionTestTab,inspectExtensionTestBinding,ensureExtensionTestPage,refreshExtensionControl};
