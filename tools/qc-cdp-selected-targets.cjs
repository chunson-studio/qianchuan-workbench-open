'use strict';

const {createQianchuanCDPTransport}=require('./qc-cdp-transport.cjs');
const fail=()=>{throw Object.assign(new Error('cdp_selected_target_denied'),{code:'cdp_selected_target_denied'});};

// Restrict the independent Playwright connection to explicitly selected pages.
// Browser-root auto-attachment excludes every target; pages attach individually.
// Related iframe/worker sessions remain managed by Playwright on selected pages.
function createSelectedTargetSource(source,targetIds){
  if(!Array.isArray(targetIds)||!targetIds.length||targetIds.some(x=>typeof x!=='string'||!x)||new Set(targetIds).size!==targetIds.length)fail();
  const allowed=new Set(targetIds);
  return {
    isConnected:()=>source.isConnected(),
    subscribe:(onEvent,onClose)=>source.subscribe(onEvent,onClose),
    async send(method,params={},sessionId){
      if(['Browser.close','Target.createTarget','Target.createBrowserContext','Target.disposeBrowserContext','Target.autoAttachRelated'].includes(method))fail();
      if(method==='Target.attachToTarget'&&!allowed.has(params.targetId))fail();
      if(method==='Target.closeTarget'&&!allowed.has(params.targetId))fail();
      if(method==='Target.setAutoAttach'&&!sessionId){
        return source.send(method,{...params,autoAttach:true,waitForDebuggerOnStart:false,flatten:true,filter:[{exclude:true}]});
      }
      if(method==='Target.setAutoAttach'&&sessionId){
        return source.send(method,{...params,filter:[{type:'page',exclude:true},{}]},sessionId);
      }
      return source.send(method,params,sessionId);
    },
  };
}

async function attachSelectedQianchuanPages({source,targets,chromium,timeoutMs=15000}){
  const scoped=createSelectedTargetSource(source,targets.map(t=>t.targetId));
  const transport=createQianchuanCDPTransport(scoped);
  let browser;
  try{
    browser=await chromium.connectOverCDP(transport,{timeout:timeoutMs,noDefaults:true});
    if(browser.contexts().some(context=>context.pages().length))fail();
    const pages=[];
    for(const target of targets){
      const context=browser.contexts()[0];
      const waiting=context.waitForEvent('page',{timeout:timeoutMs});
      const [page]=await Promise.all([waiting,scoped.send('Target.attachToTarget',{targetId:target.targetId,flatten:true})]);
      if(page.url()!==target.url)fail();
      pages.push({target,page});
    }
    return {browser,pages,transport};
  }catch(error){
    if(browser)await browser.close().catch(()=>{});
    transport.close('Selected target attachment ended');
    throw error;
  }
}

module.exports={createSelectedTargetSource,attachSelectedQianchuanPages};
