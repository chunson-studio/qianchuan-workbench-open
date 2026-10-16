'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {createRequire}=require('node:module');
const {readQianchuanNativeConfig,bindQianchuanNativePages}=require('./start-qc-native-session.cjs');
const {connectQianchuanReadCDP}=require('./read-qc-target-cdp.cjs');
const {attachSelectedQianchuanPages}=require('./qc-cdp-selected-targets.cjs');
const {getChromePageTarget}=require('./attach-qc-chrome.playwright.cjs');
const {startQianchuanNativeHost}=require('./qc-native-session-host.cjs');
const {createQianchuanNativeOperations}=require('./qc-native-operations.cjs');

// Maintenance owner: exact selected targets, existing Chrome, bounded read/refresh
// operations only. No automatic reconnection, context creation or advertising UI.
async function startSelectedSession(configFile,{selectByUniquePlan=false}={}){
  const config=readQianchuanNativeConfig(configFile);
  const started=Date.now();
  const source=await connectQianchuanReadCDP({configFile,timeoutMs:10000});
  let attachment,host;
  try{
    const inventory=(await source.send('Target.getTargets')).targetInfos;
    const targets=config.bindings.map(binding=>{
      const matches=inventory.filter(t=>{
        if(t.type!=='page')return false;
        if(selectByUniquePlan){
          try{const u=new URL(t.url);return u.origin==='https://qianchuan.jinritemai.com'&&!u.username&&!u.password&&(!binding.browser_context_id||t.browserContextId===binding.browser_context_id)&&['/overall-prom/detail','/uni-prom/detail'].includes(u.pathname)&&u.searchParams.getAll('aavid').length===1&&u.searchParams.get('aavid')===binding.advertiser_id&&u.searchParams.getAll('adId').length===1&&u.searchParams.get('adId')===binding.primary_ad_id;}catch{return false;}
        }
        return binding.observed_url?t.url===binding.observed_url:t.targetId===binding.target_id&&t.browserContextId===binding.browser_context_id;
      });
      if(matches.length!==1)throw Object.assign(new Error('native_selected_target_not_unique'),{code:'native_selected_target_not_unique'});
      return matches[0];
    });
    const chromium=createRequire(path.resolve(__dirname,'../server-app/package.json'))('playwright-core').chromium;
    attachment=await attachSelectedQianchuanPages({source,targets,chromium,timeoutMs:15000});
    const exactBindings=config.bindings.map((binding,i)=>{const {observed_url,...rest}=binding;return {...rest,browser_context_id:targets[i].browserContextId,target_id:targets[i].targetId};});
    const bindings=await bindQianchuanNativePages(attachment.browser,exactBindings,getChromePageTarget,10000);
    const available=createQianchuanNativeOperations();
    const operations=Object.fromEntries(['snapshot','read_control','refresh'].map(name=>[name,available[name]]));
    host=await startQianchuanNativeHost({browser:attachment.browser,bindings,operations,runtimeFile:config.runtimeFile});
    let closing;
    const close=()=>closing||=(async()=>{try{await host.close();}finally{await attachment.browser.close().catch(()=>{});source.close();}})();
    return {host,close,elapsed_ms:Date.now()-started,bindings:bindings.map(({page,observed_url,...b})=>b)};
  }catch(error){await host?.close().catch(()=>{});await attachment?.browser.close().catch(()=>{});source.close();throw error;}
}
if(require.main===module){
  const configFile=process.argv[2],statusFile=process.argv[3];
  if(!path.isAbsolute(statusFile||''))throw new Error('native_selected_status_required');
  fs.writeFileSync(statusFile,JSON.stringify({status:'connecting',pid:process.pid,started_at:new Date().toISOString()})+'\n');
  startSelectedSession(configFile,{selectByUniquePlan:process.argv[4]==='--unique-plan'}).then(session=>{
    fs.writeFileSync(statusFile,JSON.stringify({status:'running',pid:process.pid,elapsed_ms:session.elapsed_ms,bindings:session.bindings,advertising_writes:0},null,2)+'\n');
    for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void session.close();});
  }).catch(error=>{
    fs.writeFileSync(statusFile,JSON.stringify({status:'failed',pid:process.pid,code:/^(?:native_|cdp_)[a-z_]+$/.test(error.code||'')?error.code:'native_selected_failed',method:error.method||null,advertising_writes:0})+'\n');process.exitCode=1;
  });
}
module.exports={startSelectedSession};
