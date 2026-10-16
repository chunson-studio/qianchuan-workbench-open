// Synthetic call-count comparison only. No live browser or advertising IO.
import fs from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createFakeTab} from './fixtures/codex-qc-fake-tab.mjs';
const sourceUrl=new URL('./codex-qc-browser-steps.cua.mjs',import.meta.url);
const current=await fs.readFile(sourceUrl,'utf8');
const baselineRef=process.argv[2]??'HEAD';
if(!/^[A-Za-z0-9_/.~-]+$/.test(baselineRef)||baselineRef.startsWith('-'))throw Error('invalid_baseline_ref');
const baseline=execFileSync('git',['show',baselineRef+':tools/codex-qc-browser-steps.cua.mjs'],{cwd:new URL('../',import.meta.url),encoding:'utf8',windowsHide:true});
async function measure(source,controlled,deferInRound=true){
  const text=source.replace("'./codex-qc-browser-data.mjs'",JSON.stringify(new URL('./codex-qc-browser-data.mjs',import.meta.url).href));
  const module=await import('data:text/javascript;base64,'+Buffer.from(text).toString('base64'));
  const results={};
  for(const operation of ['read','pause','pause_and_normal_pools']){
    const f=createFakeTab(),counts={};
    const builders=new Set(['getByRole','getByText','locator','filter','nth','first','last']);
    const wrap=obj=>new Proxy(obj,{get(target,key){const value=target[key];
      if(key==='playwright')return wrap(value);
      if(typeof value!=='function')return value;
      return (...args)=>{if(!builders.has(key))counts[key]=(counts[key]??0)+1;const out=value.apply(target,args);return builders.has(key)?wrap(out):out;};
    }});
    const tab=wrap(f.tab);
    if(operation==='read')await module.createQianchuanBrowserSteps({tab,binding:f.binding,checkpoint:f.checkpoint}).readPool('调控中');
    else {const defer=controlled&&deferInRound&&operation==='pause_and_normal_pools';
      const out=await module.executeQianchuanTaskAction(tab,{binding:f.binding,on_checkpoint:f.checkpoint,action:'pause',target_id:f.model.tasks[0].id,execute:true,restore_after_verified:!controlled,defer_pause_readback:defer});
      if(out.effect_status!==(defer?'submitted_pending_readback':'write_verified')||f.model.submitted.length!==1)throw Error('synthetic_pause_unverified');
      if(operation==='pause_and_normal_pools'){
        const ui=module.createQianchuanBrowserSteps({tab,binding:f.binding,checkpoint:f.checkpoint});
        await ui.readPool('调控中');const {pool}=await ui.readPool('手动暂停');
        if(!pool.complete||!pool.tasks.some(t=>t.task_id===f.model.tasks[0].id&&/^已暂停/.test(t.status)))throw Error('synthetic_normal_read_unverified');
      }}
    results[operation]={counts,total:Object.values(counts).reduce((a,b)=>a+b,0)};
  }return results;
}
console.log(JSON.stringify({baseline_ref:baselineRef,scope:'synthetic single page, one task; counts only, not live timing',baseline:await measure(baseline,false),current_immediate_readback:await measure(current,true,false),current:await measure(current,true)},null,2));
