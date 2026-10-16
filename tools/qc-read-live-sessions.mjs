import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/** Read the complete, unfiltered account/day response. No ledger or advertising writes. */
export async function readLiveSessions({account_id,date,output_path,port=18991,read_token=''}, fetchImpl=fetch) {
  if(!/^[A-Za-z0-9_-]{1,50}$/.test(account_id||''))throw Error('explicit_account_id_required');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date||'') || !Number.isFinite(Date.parse(date+'T00:00:00Z'))
    || new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date)throw Error('valid_explicit_date_required');
  if(!Number.isInteger(port)||port<1024||port>65535)throw Error('invalid_local_port');
  if(typeof output_path!=='string'||!path.isAbsolute(output_path))throw Error('absolute_output_path_required');
  // Exclusive creation preserves previous evidence even when the caller repeats an output path.
  const file=await fs.open(output_path,'wx',0o600);
  try {
    const url=new URL('/api/live-sessions','http://127.0.0.1:'+port);
    url.searchParams.set('account',account_id);url.searchParams.set('date',date);
    const response=await fetchImpl(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(45000),
      headers:read_token?{Authorization:'Bearer '+read_token}:{}});
    const raw=await response.text();
    let result;try{result=JSON.parse(raw);}catch{throw Error('sessions_response_not_json');}
    const receipt={observed_at:new Date().toISOString(),source:'/api/live-sessions',account_id,date,
      http_status:response.status,result};
    await file.writeFile(JSON.stringify(receipt,null,2)+'\n');
    // This is only transport/shape quality, not scene-end verification; recordEnded owns that check.
    const usable=response.ok&&result?.ok===true&&result.data_valid===true&&result.partial===false
      &&Array.isArray(result.errors)&&result.errors.length===0&&result.component==='live_sessions'
      &&result.date===date&&Array.isArray(result.sessions)&&result.count===result.sessions.length
      &&result.sessions.length<200&&result.truncated!==true&&result.has_more!==true;
    return {saved:true,usable,path:output_path,observed_at:receipt.observed_at,http_status:response.status,
      count:result.count??null,source_at:result.source_at??null,code:result.code??null};
  } finally {await file.close();}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const args={};for(let i=2;i<process.argv.length;i+=2){
      const key=process.argv[i];if(!['--account','--date','--out','--port'].includes(key)||!process.argv[i+1]||args[key])throw Error('invalid_arguments');
      args[key]=process.argv[i+1];
    }
    const config=createRequire(import.meta.url)('../server-app/server/lib/config.js');
    const result=await readLiveSessions({account_id:args['--account'],date:args['--date'],output_path:args['--out'],
      port:args['--port']?Number(args['--port']):config.PORT,read_token:config.READ_API_TOKEN||''});
    console.log(JSON.stringify(result));if(!result.usable)process.exitCode=2;
  }catch(error){console.error(JSON.stringify({ok:false,code:error.name==='TimeoutError'?'sessions_read_timeout':error.message}));process.exitCode=1;}
}
