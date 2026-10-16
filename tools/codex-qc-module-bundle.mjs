// Freeze the actual dependency graph so CUA cannot mix old and new modules.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';

const core=['codex-qc-browser-data.mjs','codex-qc-decision-brief.mjs','codex-qc-feedback.mjs','codex-qc-browser-steps.cua.mjs','codex-qc-compass-top.cua.mjs'];
const exportsFor={
  'codex-qc-boost-replay.cua.js':'replayQianchuanBoostCreate, replayQianchuanBoostAction, replayQianchuanBoostPauseBatch, replayQianchuanBoost',
  'codex-qc-control-pools.cua.js':'readQianchuanControlPool, replayQianchuanControlPause, replayQianchuanControlResume, replayQianchuanControlDuration, runQianchuanBrowserRound',
};
export async function loadQianchuanModule({run_root,entry}) {
  if(!path.isAbsolute(run_root??''))throw Error('Absolute scene run_root required');
  const entries={
    'codex-qc-boost-replay.cua.js':[...core,'codex-qc-boost-replay.cua.js'],
    'codex-qc-control-pools.cua.js':['codex-qc-control-pools.cua.js'],
  };
  if(!entries[entry])throw Error('Unsupported entry');
  const sources=await Promise.all(entries[entry].map(async name=>({name,source:fileURLToPath(new URL(name,import.meta.url)),text:await fs.readFile(new URL(name,import.meta.url),'utf8')})));
  const contract=fileURLToPath(new URL('../server-app/server/lib/dataContract.js',import.meta.url));
  const contractHash=createHash('sha256').update(await fs.readFile(contract)).digest('hex');
  const sha256=createHash('sha256').update(JSON.stringify(sources.map(s=>[s.name,s.text]))+contractHash).digest('hex');
  const directory=path.join(run_root,'control-modules',sha256);await fs.mkdir(directory,{recursive:true});
  const write=async(name,text)=>{const file=path.join(directory,name);try{await fs.writeFile(file,text,{flag:'wx'});}catch(e){if(e.code!=='EEXIST'||await fs.readFile(file,'utf8')!==text)throw e;}};
  for(const s of sources) {
    let code=s.name==='codex-qc-decision-brief.mjs'?s.text.replace("'../server-app/server/lib/dataContract.js'",JSON.stringify(contract)):s.text;
    if(exportsFor[s.name])code+='\nexport { '+exportsFor[s.name]+' };\n';
    await write(s.name,code);
  }
  await write('package.json','{"type":"module"}\n');
  await write('source.json',JSON.stringify({sha256,entry,channel:'codex-cua',advertising_writes:0,arithmetic_contract:{source:contract,sha256:contractHash},sources:sources.map(s=>({name:s.name,source:s.source,sha256:createHash('sha256').update(s.text).digest('hex')}))},null,2)+'\n');
  return {...await import(pathToFileURL(path.join(directory,entry)).href),loaded_source:{directory,sha256}};
}
