'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {loadConfig}=require('./start-qc-extension-session.cjs');
const {createQianchuanNativeClient}=require('./qc-native-session-client.cjs');

// Maintenance against an already-running owner. No browser connection,
// advertising submission or automatic retry is created by this client.
async function checkExtensionSession({configFile,outputFile,operation='read_control',rounds=3}){
  if(!['read_control','sort_query','refresh_control'].includes(operation)||!Number.isSafeInteger(rounds)||rounds<1||rounds>10||!path.isAbsolute(outputFile||''))throw Error('extension_check_options_invalid');
  const config=loadConfig(configFile),client=createQianchuanNativeClient({runtimeFile:config.runtimeFile,timeoutMs:60000});
  if([configFile,config.runtimeFile,config.statusFile,...config.bindings.map(b=>b.profileConfigFile)].some(p=>path.resolve(p).toLowerCase()===path.resolve(outputFile).toLowerCase()))throw Error('extension_check_output_conflict');
  const evidence={captured_at:new Date().toISOString(),operation,client_pid:process.pid,host_id:client.host_id,advertising_writes:0,rounds:[],ok:false};
  for(let round=1;round<=rounds;round++){
    const start=Date.now();
    const rooms=await Promise.all(config.bindings.map(async b=>{
      const started=Date.now(),identity={room:b.room,account_id:b.account_id,advertiser_id:b.advertiser_id,primary_ad_id:b.primary_ad_id};
      const request_id='extension_check_'+crypto.randomUUID();
      let response;
      try{response=await client.call({...identity,request_id,operation,input:{advertiser_id:b.advertiser_id,primary_ad_id:b.primary_ad_id,date:b.date,pool:b.pool}});}
      catch(e){response={ok:false,state:'unknown',code:e.code||'extension_check_failed',retry_write:false};}
      const pool=operation==='refresh_control'?response.result?.after:response.result;
      const passed=response.ok===true&&response.state==='completed'&&pool?.complete===true&&(operation!=='refresh_control'||response.result?.new_document===true);
      return {room:b.room,request_id,elapsed_ms:Date.now()-started,passed,response};
    }));
    evidence.rounds.push({round,elapsed_ms:Date.now()-start,rooms});
    fs.writeFileSync(outputFile,JSON.stringify(evidence,null,2)+'\n');
    process.stdout.write(JSON.stringify({round,operation,rooms:rooms.map(x=>({room:x.room,passed:x.passed,elapsed_ms:x.elapsed_ms,code:x.response.operation_code||x.response.code||null,rows:(x.response.result?.after||x.response.result)?.visible_rows,complete:(x.response.result?.after||x.response.result)?.complete}))})+'\n');
    if(rooms.some(x=>!x.passed))break;
  }
  evidence.ok=evidence.rounds.length===rounds&&evidence.rounds.every(r=>r.rooms.every(x=>x.passed));
  fs.writeFileSync(outputFile,JSON.stringify(evidence,null,2)+'\n');
  return evidence;
}
if(require.main===module){const [configFile,outputFile,operation='read_control',rounds='3']=process.argv.slice(2);checkExtensionSession({configFile,outputFile,operation,rounds:Number(rounds)}).then(r=>{if(!r.ok)process.exitCode=1;}).catch(e=>{process.stderr.write((e.code||e.message)+'\n');process.exitCode=1;});}
module.exports={checkExtensionSession};
