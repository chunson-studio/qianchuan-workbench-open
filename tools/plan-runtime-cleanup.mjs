// Read-only selection of disposable output from proven closed scenes.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const pendingStatuses=new Set(['dispatch_pending','submitted_pending_readback','unconfirmed']);
const normalize=p=>path.resolve(p).replaceAll('\\','/').toLowerCase();
const overlaps=(a,b)=>a===b||a.startsWith(b+'/')||b.startsWith(a+'/');
const read=p=>JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,''));
const strings=(v,out=[])=>{if(typeof v==='string')out.push(v);else if(v&&typeof v==='object')for(const x of Object.values(v))strings(x,out);return out;};
function newest(root){
  let latest=0;
  for(const entry of fs.readdirSync(root,{withFileTypes:true})){
    const p=path.join(root,entry.name),s=fs.lstatSync(p);
    if(s.isSymbolicLink())throw Error('linked_artifact');
    latest=Math.max(latest,s.mtimeMs,entry.isDirectory()?newest(p):0);
  }
  return latest;
}
export function planRuntimeCleanup({root,before}){
  root=fs.realpathSync(root);const cutoff=Date.parse(before);
  if(!Number.isFinite(cutoff))throw Error('explicit_before_timestamp_required');
  const selected=[],skipped=[],seen=new Set();
  const relative=p=>path.relative(root,p).replaceAll('\\','/');
  function inspect(sceneRoot){
    const configs=fs.readdirSync(sceneRoot).filter(n=>/(config|配置).*\.json$/i.test(n));
    const candidates=configs.flatMap(n=>{try{const c=read(path.join(sceneRoot,n));return c.binding&&c.run_root&&normalize(c.run_root)===normalize(sceneRoot)?[{c,file:path.join(sceneRoot,n)}]:[];}catch{return [];}});
    if(!candidates.length){skipped.push({path:relative(sceneRoot),reason:'binding_config_missing'});return;}
    const identities=new Set(candidates.map(({c})=>JSON.stringify([c.binding.advertiser_id,c.binding.primary_ad_id,c.binding.room_id])));
    if(identities.size!==1){skipped.push({path:relative(sceneRoot),reason:'config_binding_conflict'});return;}
    const cfg=candidates[0].c,b=cfg.binding;
    if(!/^\d{4}-\d{2}-\d{2}/.test(b.session_started_at??'')||b.session_started_at.slice(0,10)>=before.slice(0,10))return;
    const runtime=path.resolve(cfg.runtime_root??'');
    if(!normalize(runtime).startsWith(normalize(root)+'/')){skipped.push({path:relative(sceneRoot),reason:'runtime_outside_project'});return;}
    const stateRoot=path.join(runtime,'codex-control');if(!fs.existsSync(stateRoot))return;
    const matches=[];
    for(const e of fs.readdirSync(stateRoot,{withFileTypes:true})){
      if(!e.isDirectory()||e.isSymbolicLink())continue;
      const f=path.join(stateRoot,e.name,'state.json');if(!fs.existsSync(f))continue;
      const state=read(f);
      for(const [key,scene] of Object.entries(state.scenes??{})){
        const sb=scene.binding??JSON.parse(key).reduce((o,v,i)=>({...o, [['advertiser_id','primary_ad_id','room_id','session_started_at'][i]]:v}),{});
        if(['advertiser_id','primary_ad_id','room_id'].every(k=>String(sb[k])===String(b[k])))matches.push({state,scene,key,file:f});
      }
    }
    if(matches.length!==1){skipped.push({path:relative(sceneRoot),reason:'unique_scene_state_missing'});return;}
    const {state,scene,key,file}=matches[0];
    if(!state.operations||typeof state.operations!=='object'||Array.isArray(state.operations)||!Array.isArray(scene.memory?.unresolved_submissions)){
      skipped.push({path:relative(sceneRoot),reason:'pending_state_incomplete'});return;
    }
    if(scene.status!=='ended'||!scene.host_actions?.some(h=>['verified_paused','verified_absent'].includes(h.status))||state.owner?.session===key&&state.owner.status==='active'){
      skipped.push({path:relative(sceneRoot),reason:'scene_or_host_not_closed'});return;
    }
    const pending=Object.values(state.operations??{}).filter(o=>o.session===key&&pendingStatuses.has(o.status));
    const memoryPending=scene.memory?.unresolved_submissions??[];
    const refs=strings([pending,memoryPending]).filter(path.isAbsolute).map(normalize);
    const configRefs=strings(candidates.map(x=>x.c)).filter(path.isAbsolute).map(normalize).filter(p=>p.includes('/control-modules'));
    const record=(p,kind)=>{
      if(!fs.existsSync(p)||seen.has(normalize(p)))return;
      if(fs.lstatSync(p).isSymbolicLink()||refs.some(ref=>overlaps(normalize(p),ref))){skipped.push({path:relative(p),reason:'pending_or_linked'});return;}
      if(newest(p)>=cutoff){skipped.push({path:relative(p),reason:'recently_modified'});return;}
      selected.push({path:relative(p),kind,config:relative(candidates[0].file),state:relative(file),session:key,pending_operations:pending.length});seen.add(normalize(p));
    };
    record(path.join(sceneRoot,'clean-reader'),'closed_scene_read_diagnostics');
    if(pending.length===0&&memoryPending.length===0)record(path.join(sceneRoot,'control-actions'),'closed_scene_action_diagnostics');
    const modules=path.join(sceneRoot,'control-modules');
    if(fs.existsSync(modules)&&pending.length===0&&memoryPending.length===0){
      const dirs=fs.readdirSync(modules,{withFileTypes:true}).filter(e=>e.isDirectory()&&!e.isSymbolicLink()).map(e=>path.join(modules,e.name));
      dirs.sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs);
      for(const p of dirs.slice(1))if(!configRefs.some(ref=>overlaps(normalize(p),ref)))record(p,'obsolete_module_bundle');
    }
  }
  function walk(dir){
    if(!fs.existsSync(dir))return;
    const es=fs.readdirSync(dir,{withFileTypes:true});
    if(es.some(e=>e.isDirectory()&&['clean-reader','control-actions','control-modules'].includes(e.name))){inspect(dir);return;}
    for(const e of es)if(e.isDirectory()&&!e.isSymbolicLink()&&!e.name.startsWith('.'))walk(path.join(dir,e.name));
  }
  for(const base of ['work/browser-actions/runs','work/live-control'])walk(path.join(root,base));
  return {schema_version:1,purpose:'Authorized cleanup of historical scene diagnostics; not execution state, current scenes or pending evidence',root,before,selected,paths:selected.map(x=>x.path),skipped};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),options={root:process.cwd()};
  for(let i=0;i<args.length;i+=2){if(!['--root','--before','--output'].includes(args[i])||!args[i+1])throw Error('usage: --root DIR --before ISO_TIMESTAMP [--output JSON]');options[args[i].slice(2)]=args[i+1];}
  const plan=planRuntimeCleanup(options);if(options.output)fs.writeFileSync(options.output,JSON.stringify(plan,null,2)+'\n');
  console.log(JSON.stringify(options.output?{selected:plan.selected.length,skipped:plan.skipped,output:options.output}:plan));
}
