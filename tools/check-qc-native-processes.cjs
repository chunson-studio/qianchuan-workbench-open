'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {fork}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const {readQianchuanNativeConfig}=require('./start-qc-native-session.cjs');
const {createQianchuanNativeClient}=require('./qc-native-session-client.cjs');

async function runWorker(spec){
  const client=createQianchuanNativeClient({runtimeFile:spec.runtimeFile,timeoutMs:15000});
  await new Promise(resolve=>setTimeout(resolve,Math.max(0,spec.startAtMs-Date.now())));
  const reads=[];
  for(let round=1;round<=spec.rounds;round++){
    const started=Date.now();let response;
    try{response=await client.call({...spec.binding,request_id:'process_check_'+randomUUID(),operation:spec.operation,input:spec.input});}
    catch(error){response={ok:false,code:error.code||'native_process_read_failed'};}
    const passed=response.ok===true&&response.state==='completed'&&response.result?.ok===true&&(spec.operation!=='read_control'||response.result.complete===true);
    reads.push({round,started_at_ms:started,finished_at_ms:Date.now(),elapsed_ms:Date.now()-started,passed,response});
    if(!passed)break;
  }
  return {client_pid:process.pid,host_id:client.host_id,room:spec.binding.room,reads,ok:reads.length===spec.rounds&&reads.every(r=>r.passed)};
}

async function checkNativeProcesses({configFile,cases,operation='read_control',rounds=3}){
  if(!['read_control','snapshot'].includes(operation)||!Number.isInteger(rounds)||rounds<1||rounds>10||!Array.isArray(cases)||cases.length<1||cases.length>4||new Set(cases.map(c=>c.room)).size!==cases.length)throw new Error('native_process_options_invalid');
  const config=readQianchuanNativeConfig(configFile),startAtMs=Date.now()+1500;
  const workers=await Promise.all(cases.map(item=>new Promise((resolve,reject)=>{
    const binding=config.bindings.find(b=>b.room===item.room);
    if(!binding){reject(new Error('native_process_room_missing'));return;}
    const child=fork(__filename,['--worker'],{stdio:['ignore','ignore','pipe','ipc'],windowsHide:true});
    let settled=false;
    const timer=setTimeout(()=>{child.kill();reject(new Error('native_process_timeout'));},60000);
    child.once('message',result=>{settled=true;clearTimeout(timer);resolve(result);});
    child.once('exit',code=>{if(!settled){clearTimeout(timer);reject(new Error('native_process_exited_'+code));}});
    child.send({runtimeFile:config.runtimeFile,binding:{room:binding.room,account_id:binding.account_id,advertiser_id:binding.advertiser_id,primary_ad_id:binding.primary_ad_id},startAtMs,rounds,operation,input:item.input??{}});
  })));
  const intervals=workers.flatMap(w=>w.reads.map(r=>({start:r.started_at_ms,end:r.finished_at_ms,pid:w.client_pid})));
  const overlap=intervals.some((a,i)=>intervals.slice(i+1).some(b=>a.pid!==b.pid&&Math.max(a.start,b.start)<Math.min(a.end,b.end)));
  return {ok:workers.every(w=>w.ok),captured_at:new Date().toISOString(),scope:'independent_client_processes_one_native_owner; not independent Codex chats or live advertising acceptance',concurrency:cases.length,overlap_verified:cases.length===1?null:overlap,operation,workers,advertising_writes:0};
}

// Compare explicitly sampled fields by task ID and unchanged header names.
// Callers retain capture times; equality does not prove simultaneous freshness.
function compareNativeControlSample(native,sample){
  const failures=[];
  if(!native?.ok||native.complete!==true||sample?.complete!==true)return {ok:false,code:'comparison_incomplete'};
  const tasks=new Map(native.tasks.map(t=>[t.task_id,t]));
  if(tasks.size!==native.total||native.tasks.length!==native.total||sample.tasks.length!==sample.total||new Set(sample.tasks.map(t=>t.task_id)).size!==sample.total||native.total!==sample.total)return {ok:false,code:'comparison_coverage_mismatch'};
  const normalized=value=>String(value).replace(/\s+/g,'');
  for(const task of sample.tasks){
    const actual=tasks.get(task.task_id);
    if(!actual){failures.push({task_id:task.task_id,code:'task_missing'});continue;}
    for(const [header,expected]of Object.entries(task.fields)){
      const index=native.headers.indexOf(header);
      if(index<0||native.headers.lastIndexOf(header)!==index||normalized(actual.raw_cells[index])!==normalized(expected))failures.push({task_id:task.task_id,header,code:'field_mismatch'});
    }
  }
  return {ok:!failures.length,total:native.total,failures,native_captured_at:native.captured_at,sample_captured_at:sample.captured_at,scope:'same-ID sampled raw fields; capture times differ; no ROI conversion'};
}
if(require.main===module){
  if(process.argv[2]==='--worker')process.once('message',spec=>runWorker(spec).then(result=>{process.send(result,()=>process.exit());}).catch(error=>{process.send({ok:false,code:error.code||'native_process_failed',client_pid:process.pid,reads:[]},()=>process.exit(1));}));
  else{
    const [specFile,outputFile]=process.argv.slice(2);
    if(!path.isAbsolute(outputFile||''))throw new Error('native_process_output_required');
    checkNativeProcesses(JSON.parse(fs.readFileSync(specFile,'utf8'))).then(result=>{
      fs.writeFileSync(outputFile,JSON.stringify(result,null,2)+'\n');
      console.log(JSON.stringify({...result,workers:result.workers.map(w=>({...w,reads:w.reads.map(({response,...r})=>({...r,rows:response.result?.visible_rows,total:response.result?.total,code:response.code||response.operation_code||response.result?.code}))}))}));
      if(!result.ok)process.exitCode=1;
    }).catch(error=>{console.error(error.code||error.message);process.exitCode=1;});
  }
}
module.exports={checkNativeProcesses,runWorker,compareNativeControlSample};
