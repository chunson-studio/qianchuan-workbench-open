'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {startQianchuanNativeHost}=require('./qc-native-session-host.cjs');
const {connectPlaywrightExtension,bindExtensionTestTab,inspectExtensionTestBinding,ensureExtensionTestPage,readExtensionControl,refreshExtensionControl,buildExtensionControlCode}=require('./connect-qc-playwright-extension.cjs');
const fail=code=>{throw Object.assign(new Error(code),{code});};
function loadConfig(file){
  if(!path.isAbsolute(file||''))fail('extension_host_config_invalid');
  const stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>131072)fail('extension_host_config_invalid');
  const config=JSON.parse(fs.readFileSync(file,'utf8'));
  if(!path.isAbsolute(config.runtimeFile||'')||!path.isAbsolute(config.statusFile||'')||!path.isAbsolute(config.depsRoot||'')||
    !Array.isArray(config.bindings)||!config.bindings.length||config.bindings.length>4)fail('extension_host_config_invalid');
  const outputPaths=[config.runtimeFile,config.statusFile].map(p=>path.resolve(p).toLowerCase());
  if(new Set(outputPaths).size!==2||outputPaths.includes(path.resolve(file).toLowerCase()))fail('extension_host_output_path_conflict');
  const rooms=new Set(),targets=new Set();
  for(const b of config.bindings){
    if(typeof b.room!=='string'||!b.room.trim()||rooms.has(b.room)||typeof b.account_id!=='string'||!/^\d+$/.test(b.account_id)||!path.isAbsolute(b.profileConfigFile||'')||
      !Number.isSafeInteger(b.tab_id)||b.tab_id<=0||targets.has(b.tab_id)||!Number.isSafeInteger(b.expected_group_id)||b.expected_group_id<0)fail('extension_host_binding_invalid');
    if(outputPaths.includes(path.resolve(b.profileConfigFile).toLowerCase()))fail('extension_host_output_path_conflict');
    buildExtensionControlCode({advertiser_id:b.advertiser_id,primary_ad_id:b.primary_ad_id,date:b.date,pool:b.pool});
    rooms.add(b.room);targets.add(b.tab_id);
  }
  return config;
}
async function startExtensionSession(config,dependencies={}){
  const defaults={connectPlaywrightExtension,bindExtensionTestTab,inspectExtensionTestBinding,ensureExtensionTestPage,readExtensionControl,refreshExtensionControl,startQianchuanNativeHost};
  if(Object.keys(dependencies).some(k=>!Object.hasOwn(defaults,k)||typeof dependencies[k]!=='function'))fail('extension_host_dependencies_invalid');
  const deps={...defaults,...dependencies},assigned=[],bindingFailures=[];let host,status;
  const publicFailure=(item,error)=>({room:item.room,account_id:item.account_id,advertiser_id:item.advertiser_id,primary_ad_id:item.primary_ad_id,code:/^[a-z0-9_]+$/.test(error.code||'')?error.code:'extension_binding_start_failed'});
  const release=async page=>{
    if(page.expected_group_id!==page.original_group_id){
      await page.client.callTool('browser_tabs',{action:'select',index:0},5000).catch(()=>{});
      const code=`async()=>{const t=await chrome.tabs.get(${page.tab_id});if(t.groupId!==${page.expected_group_id})throw Error('rollback_group_changed');await chrome.tabGroups.get(${page.original_group_id});await chrome.tabs.group({tabIds:[t.id],groupId:${page.original_group_id}});return {restored:true};}`;
      await page.client.callTool('browser_evaluate',{function:code},5000).catch(()=>{});
    }
    await page.client.close().catch(()=>{});
  };
  const writeStatus=()=>{if(status){status.degraded=bindingFailures.length>0;status.binding_failures=[...bindingFailures];status.bindings=assigned.map(({item,page})=>({room:item.room,account_id:item.account_id,advertiser_id:item.advertiser_id,primary_ad_id:item.primary_ad_id,profile:page.client.profile_dir_name,tab_id:page.tab_id,group_id:page.expected_group_id,mcp_pid:page.client.server_pid,transport_connected:page.client.isTransportConnected(),transport_restarts:page.transport_restarts||0,transport_recovery_blocked:page.transport_recovery_blocked===true}));fs.writeFileSync(config.statusFile,JSON.stringify(status,null,2));}};
  if(fs.existsSync(config.runtimeFile)){
    const prior=JSON.parse(fs.readFileSync(config.runtimeFile,'utf8'));
    if(prior.status==='running'&&Number.isSafeInteger(prior.pid)){
      let alive=false;try{process.kill(prior.pid,0);alive=true;}catch{}
      if(alive)fail('extension_host_already_running');
    }
  }
  try{
    const prepared=await Promise.all(config.bindings.map(async item=>{
      let page;
      try{
      const client=await deps.connectPlaywrightExtension({configFile:item.profileConfigFile,depsRoot:config.depsRoot,clientName:'千川后台 '+item.room});
      const spec={advertiser_id:item.advertiser_id,primary_ad_id:item.primary_ad_id,date:item.date,pool:item.pool};
      page={client,spec,tab_id:item.tab_id,expected_group_id:item.expected_group_id,original_group_id:item.expected_group_id,tab_closed:null,transport_restarts:0};
      const initialized=await client.callTool('browser_tabs',{action:'list'},35000);
      if(initialized.isError)fail('extension_host_connect_failed');
      const bound=await deps.bindExtensionTestTab(client,{tab_id:page.tab_id,expected_group_id:page.expected_group_id,spec});
      page.expected_group_id=bound.group_id;
      await deps.ensureExtensionTestPage(client,page);
      const read=await deps.readExtensionControl(client,spec);
      if(!read.complete)fail('extension_host_initial_pool_incomplete');
      page.tab_closed=false;
      return {item,page};
      }catch(error){bindingFailures.push(publicFailure(item,error));if(page)await release(page);return null;}
    }));
    assigned.push(...prepared.filter(Boolean));
    if(!assigned.length)fail('extension_host_no_healthy_bindings');
    const bindings=assigned.map(({item,page})=>({room:item.room,account_id:item.account_id,advertiser_id:item.advertiser_id,primary_ad_id:item.primary_ad_id,
      browser_context_id:page.client.profile_dir_name,target_id:String(page.tab_id),page}));
    const recoverTransport=async page=>{
      if(page.client.isTransportConnected())return;
      if(page.transport_recovery_blocked)fail('extension_transport_recovery_exhausted');
      // One attempt per actual child loss. A failed recovery stays blocked;
      // a verified recovery permits a later, independent child-loss incident.
      page.transport_recovery_blocked=true;
      page.transport_restarts++;
      const item=assigned.find(x=>x.page===page).item;
      let replacement;
      try{
        replacement=await deps.connectPlaywrightExtension({configFile:item.profileConfigFile,depsRoot:config.depsRoot,clientName:'千川后台恢复 '+item.room});
        const initialized=await replacement.callTool('browser_tabs',{action:'list'},35000);
        if(initialized.isError)fail('extension_host_connect_failed');
        const bound=await deps.bindExtensionTestTab(replacement,{tab_id:page.tab_id,expected_group_id:page.expected_group_id,spec:page.spec,allow_orphan:true});
        const candidate={...page,client:replacement,expected_group_id:bound.group_id};
        await deps.ensureExtensionTestPage(replacement,candidate);
        const read=await deps.readExtensionControl(replacement,page.spec);
        if(!read.complete)fail('extension_host_initial_pool_incomplete');
        page.client=replacement;page.expected_group_id=bound.group_id;page.tab_closed=false;page.transport_recovery_blocked=false;writeStatus();
      }catch(e){writeStatus();if(replacement)await replacement.close().catch(()=>{});throw e;}
    };
    const pageAdapter={channel:'playwright-extension',accepts:p=>!!p?.client&&typeof p.client.callTool==='function'&&!!p.spec,
      verify:async binding=>{try{await recoverTransport(binding.page);await deps.inspectExtensionTestBinding(binding.page.client,binding.page);binding.page.tab_closed=false;}catch(e){binding.page.tab_closed=null;throw e;}},
      onInitialFailure:async(binding,error)=>{const index=assigned.findIndex(x=>x.page===binding.page);if(index<0)throw error;const entry=assigned.splice(index,1)[0];bindingFailures.push(publicFailure(entry.item,error));await release(entry.page);},
      isClosed:binding=>binding.page.tab_closed};
    const requestSpec=(page,input)=>{buildExtensionControlCode(input);if(input.advertiser_id!==page.spec.advertiser_id||input.primary_ad_id!==page.spec.primary_ad_id)fail('extension_host_input_identity_mismatch');return input;};
    const readRun=sortQuery=>async({page,input})=>{const spec=requestSpec(page,input);await deps.ensureExtensionTestPage(page.client,{...page,spec});return deps.readExtensionControl(page.client,spec,{sortQuery});};
    host=await deps.startQianchuanNativeHost({browser:{isConnected:()=>assigned.some(x=>x.page.client.isTransportConnected())},bindings,pageAdapter,runtimeFile:config.runtimeFile,
      operations:{read_control:{kind:'read',serialize:true,run:readRun(false)},sort_query:{kind:'read',serialize:true,run:readRun(true)},
        channel_diagnostics:{kind:'read',serialize:true,run:({page})=>({ok:true,advertising_writes:0,...page.client.diagnostics(),last_refresh_failure:page.last_refresh_failure||null})},
        refresh_control:{kind:'read',serialize:true,run:async({page,input})=>{
          try{return await deps.refreshExtensionControl(page.client,{...page,spec:requestSpec(page,input)});}
          catch(e){page.last_refresh_failure={code:e.code||'extension_refresh_failed',phase:e.refresh_phase||'unknown',diagnostic:e.refresh_diagnostic||null};throw e;}
        }}
      }
    });
    status={status:'running',channel:'playwright-extension',pid:process.pid,host_id:host.host_id,runtime_file:config.runtimeFile,
      bindings:assigned.map(({item,page})=>({room:item.room,account_id:item.account_id,advertiser_id:item.advertiser_id,primary_ad_id:item.primary_ad_id,
        profile:page.client.profile_dir_name,tab_id:page.tab_id,group_id:page.expected_group_id,mcp_pid:page.client.server_pid})),advertising_writes:0};
    writeStatus();
    const close=async()=>{await host.close();for(const {page}of assigned)await page.client.close();fs.writeFileSync(config.statusFile,JSON.stringify({...status,status:'stopped'},null,2));};
    return {host,status,close};
  }catch(error){
    if(host)await host.close().catch(()=>{});
    for(const {page}of assigned)await release(page);
    error.binding_failures=[...bindingFailures];
    throw error;
  }
}
if(require.main===module){
  let config;
  try{config=loadConfig(process.argv[2]);}
  catch(e){process.stderr.write((e.code||'extension_host_config_failed')+'\n');process.exitCode=1;}
  if(config)startExtensionSession(config).then(session=>{
    process.stdout.write(JSON.stringify(session.status)+'\n');
    let stopping=false;const stop=()=>{if(stopping)return;stopping=true;session.close().then(()=>process.exit(0),()=>process.exit(1));};
    process.once('SIGINT',stop);process.once('SIGTERM',stop);
  }).catch(e=>{const code=/^[a-z0-9_]+$/.test(e.code||'')?e.code:'extension_host_start_failed';fs.writeFileSync(config.statusFile,JSON.stringify({status:'failed',code,pid:process.pid,binding_failures:e.binding_failures||[]}));process.stderr.write(code+'\n');process.exitCode=1;});
}
module.exports={loadConfig,startExtensionSession};
