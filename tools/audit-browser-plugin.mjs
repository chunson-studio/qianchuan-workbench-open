// Static source audit. Optional verification runs reviewed function slices against
// fake objects in a VM; it never imports the plugin or connects to a browser.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const hash = text => crypto.createHash('sha256').update(text).digest('hex');
function anchor(source, label, needle) {
  const offset = source.indexOf(needle);
  return { label, found: offset >= 0, offset_utf16: offset >= 0 ? offset : null,
    line: offset >= 0 ? source.slice(0,offset).split('\n').length : null };
}
function requiredSlice(source, start, end) {
  const from = source.indexOf(start), to = source.indexOf(end,from+start.length);
  if(from < 0 || to < 0 || source.indexOf(start,from+start.length) !== -1) {
    throw Error('Source version differs: reviewed function boundaries are missing or ambiguous. Reinspect before verification.');
  }
  return source.slice(from,to);
}
async function verifyReviewedFunctions(extension) {
  const queue = requiredSlice(extension,'async function ni(e,t){','async function Us(e,t){');
  const claim = requiredSlice(extension,'async claimTab(t,r,n,i,a){','async setSessionRequestHeaderEnabled(t,r){');
  const timeout = requiredSlice(extension,'async function mg(e){','function pg(e){');
  const context = vm.createContext({setTimeout,clearTimeout}, {codeGeneration:{strings:false,wasm:false}});
  const api = new vm.Script(`const kr=new Map();const Hf=10000;const ai=e=>e.operation();
    ${queue}
    ${timeout}
    const lease={leases:new Map(),async ensureInit(){},async getInstanceId(){return 'fixture';},
      async mutate(fn){await fn();return null;},${claim}};
    ({queue:ni,timeout:mg,lease});`).runInContext(context,{timeout:1000});
  let release;
  const gate = new Promise(resolve=>{release=resolve;});
  const events=[];
  const first=api.queue(1,async()=>{events.push('first');await gate;events.push('first_done');});
  const second=api.queue(1,async()=>{events.push('second');});
  const other=api.queue(2,async()=>{events.push('other');});
  try {
    await other;
    assert(events.includes('first'));
    assert(!events.includes('second'));
  } finally {release();}
  await Promise.all([first,second]);
  assert(events.indexOf('second')>events.indexOf('first_done'));
  await api.lease.claimTab('room-a','turn-a',11,'user');
  await assert.rejects(api.lease.claimTab('room-b','turn-b',11,'user'),/already part of browser session/);
  await api.lease.claimTab('room-b','turn-b',12,'user');
  assert.equal(api.lease.leases.size,2);
  let finishOperation;
  let operationCompleted=false;
  const operation=new Promise(resolve=>{finishOperation=resolve;}).then(()=>{operationCompleted=true;});
  await assert.rejects(api.timeout({method:'fixture',timeoutMs:5,operation:()=>operation}),/Timed out/);
  assert.equal(operationCompleted,false);
  finishOperation();await operation;
  assert.equal(operationCompleted,true);
  return {same_tab_attach_queue_serial:true,different_tab_attach_queues_can_progress:true,
    different_session_same_tab_rejected:true,different_tabs_distinct_sessions_allowed:true,
    timeout_wrapper_does_not_cancel_underlying_promise:true,
    scope:'Reviewed installed functions with fake dependencies only. No real CDP, transport, browser or ad actions. Outer debugger-detach and supervisor cancellation behavior is not simulated.'};
}
export async function auditBrowserPlugin({extensionFile,serviceFile,kernelFile,bundledServiceFile,verify=false}) {
  const sources={extension:extensionFile,service:serviceFile,kernel:kernelFile};
  for(const [name,file] of Object.entries(sources))if(!path.isAbsolute(file??''))throw Error(`${name} must be an absolute source-file path`);
  const texts=Object.fromEntries(await Promise.all(Object.entries(sources).map(async([name,file])=>[name,await fs.readFile(file,'utf8')])));
  const specs={
    extension:[
      ['profile_lease_mutation_queue','mutationQueue=Promise.resolve()'],
      ['tab_owned_by_another_session','is already part of browser session'],
      ['per_session_lifecycle_queue','lifecycleQueue=Promise.resolve()'],
      ['per_tab_attach_queue','async function ni(e,t){'],
      ['cdp_timeout_race','Promise.race([ai(e),n])'],
      ['default_cdp_timeout_10s','Hf=1e4'],
      ['native_connection','chrome.runtime.connectNative(this.application)'],
      ['native_reconnect_5s','Pr=5e3'],
    ],
    service:[
      ['multiple_rpc_requests','pendingRequests=new Map'],
      ['closed_native_transport','native pipe is closed'],
      ['turn_cleanup_4s','timeoutMs:4e3,run:({session_id:'],
      ['parallel_backend_discovery','Promise.all(s.map(b=>Ate('],
      ['discovery_timeout_and_runtime_ids','_te=5e3,xte=1'],
      ['new_browser_runtime_id','id:String(xte++)'],
      ['cached_browser_disposal','this.browsers=this.browsers.filter(r=>r!==e)'],
    ],
    kernel:[['single_kernel_exec_queue','queue = queue.then(() => handleExec(message))']],
  };
  const report={schema_version:1,checked_at:new Date().toISOString(),files:{},verification:null,
    caveat:'Static anchors identify reviewed code paths, not a diagnosis of live failures or a proven multi-room capacity. Minifier names and paths can change with upgrades. Do not alter vendor files or replay operations from this report.'};
  for(const [name,source] of Object.entries(texts))report.files[name]={path:sources[name],sha256:hash(source),bytes:Buffer.byteLength(source),anchors:specs[name].map(([label,needle])=>anchor(source,label,needle))};
  if(bundledServiceFile){
    if(!path.isAbsolute(bundledServiceFile))throw Error('bundled service must be an absolute path');
    const bundled=await fs.readFile(bundledServiceFile,'utf8');
    report.bundled_service={path:bundledServiceFile,sha256:hash(bundled),same_as_runtime:hash(bundled)===hash(texts.service),
      note:'Different bundles can be intentional. The configured runtime source is authoritative; hash differences alone do not prove a version defect.'};
  }
  if(verify)report.verification=await verifyReviewedFunctions(texts.extension);
  return report;
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),opts={};
  const names={'--extension-file':'extensionFile','--service-file':'serviceFile','--kernel-file':'kernelFile','--bundled-service-file':'bundledServiceFile'};
  for(let i=0;i<args.length;i++){
    if(args[i]==='--verify'){opts.verify=true;continue;}
    const key=names[args[i]];
    if(!key||!args[i+1]||args[i+1].startsWith('--'))throw Error('Usage: node tools/audit-browser-plugin.mjs --extension-file <background.js> --service-file <configured browser-service.mjs> --kernel-file <current kernel.js> [--bundled-service-file <cached browser-service.mjs>] [--verify]');
    opts[key]=args[++i];
  }
  console.log(JSON.stringify(await auditBrowserPlugin(opts),null,2));
}
