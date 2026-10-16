'use strict';
// Portable business entry: delegates to the guarded local service, never clicks unchecked controls.
const fs=require('node:fs'),path=require('node:path');
const { normalizeRequest,READS }=require('../server-app/server/lib/browserBoostContract');
async function main(args=process.argv.slice(2), nativeFetch=fetch) {
  if(args.includes('--help')){console.log('node tools/browser-boost.cjs --request <local.json> [--execute] [--port <18991>]\nWrites default to preview; explicit --execute keeps request_id. No Cookie, endpoint, locator or JavaScript accepted.');return;}
  const allowed=new Set(['--request','--execute','--port']);
  const options={};
  for(let i=0;i<args.length;i++) { const key=args[i];if(!allowed.has(key))throw Error('unsupported_argument');if(key==='--execute')options.execute=true;else {if(!args[i+1]||args[i+1].startsWith('--'))throw Error('missing_argument');options[key.slice(2)]=args[++i];} }
  if(!options.request)throw Error('request_file_required');
  const file=path.resolve(options.request), stat=fs.statSync(file);if(!stat.isFile() || stat.size>256*1024)throw Error('invalid_request_file');
  let input;try{input=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));}catch{throw Error('invalid_request_json');}
  if(!READS.has(input.action))input.preview=!options.execute;
  const request=normalizeRequest(input), port=Number(options.port || process.env.QC_PORT || 18991);
  if(!Number.isSafeInteger(port)||port<1||port>65535)throw Error('invalid_port');
  await require('./monitor.cjs').verifyService({baseUrl:'http://127.0.0.1:'+port},{fetch:nativeFetch});
  const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),55000);timer.unref?.();
  try {
    const response=await nativeFetch('http://127.0.0.1:'+port+'/api/browser-boost',{method:'POST',signal:controller.signal,
      headers:{'Content-Type':'application/json',...(request.execution_owner?{'X-QC-Execution-Owner':request.execution_owner}:{}),...(request.session_key?{'X-QC-Session-Key':request.session_key}:{})},body:JSON.stringify(request)});
    const result=await response.json();console.log(JSON.stringify(result));if(!response.ok||result.ok===false)process.exitCode=1;return result;
  }catch(error){throw Object.assign(Error('local_service_result_unknown'),{request_id:request.request_id});}finally{clearTimeout(timer);}
}
if(require.main===module)main().catch(error=>{console.error(JSON.stringify({ok:false,code:error.code||error.message,request_id:error.request_id||null,
  ...(error.advertising_writes===0?{advertising_writes:0,effect_status:'rejected'}:{}),retry_write:false}));process.exitCode=1;});
module.exports={main};
