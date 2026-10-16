'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const canonical=value=>JSON.stringify(value,function(_key,item){return item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item;});
async function checkQianchuanPageSize({binding,date,page_sizes=[50,100,50],timeout_ms=45000},options={}) {
  if(!binding||!/^[A-Za-z0-9_-]+$/.test(binding.account_id||'')||!/^\d+$/.test(binding.advertiser_id||'')||!/^\d+$/.test(binding.primary_ad_id||'')
      ||!/^\d{4}-\d{2}-\d{2}$/.test(date||'')||!Array.isArray(page_sizes)||!page_sizes.length||page_sizes.length>5
      ||page_sizes.some(n=>!Number.isInteger(n)||n<1||n>100)||!Number.isInteger(timeout_ms)||timeout_ms<1||timeout_ms>60000)throw Error('invalid_page_size_benchmark');
  const read=options.read||((size,signal)=>{
    const {validateAccount}=require('../server-app/server/lib/api-helpers');
    validateAccount(binding.account_id);
    if(require('../server-app/server/lib/cookie').resolveAavid(binding.account_id)!==binding.advertiser_id)throw Error('binding_mismatch');
    return require('../server-app/server/lib/qianchuanTabs').fetchBoostList(binding.primary_ad_id,date,date,binding.account_id,{includeAllStatus:true,pageSize:size,signal});
  });
  const report={captured_at:new Date().toISOString(),binding,date,advertising_writes:0,ok:true,samples:[]};
  let baseline;
  for(const size of page_sizes){
    const controller=new AbortController();const began=Date.now();let timer,lastRead;
    try{
      const r=lastRead=await Promise.race([Promise.resolve().then(()=>read(size,controller.signal)),new Promise((_resolve,reject)=>{timer=setTimeout(()=>{const e=Error('read_deadline');controller.abort(e);reject(e);},timeout_ms);})]);
      const rows=r?.data?.adInfos,total=r?.data?.pagination?.totalNum;
      if((r?.status_code??r?.code)!==0||r.truncated!==false||!Array.isArray(rows)||total==null||Number(total)!==rows.length||new Set(rows.map(t=>t.id)).size!==rows.length
          ||rows.some(t=>t.advId!==binding.advertiser_id))throw Error('incomplete_or_mismatched_read');
      const values=rows.map(t=>({id:t.id,advId:t.advId,name:t.name,budget:t.budget,smartBidType:t.smartBidType,adOptType:t.adOptType,
        startTime:t.startTime,endTime:t.endTime,audience:t.audience,ecpRoi2Goal:t.ecpRoi2Goal,
        metric_fields:Object.keys(r.data.adStatsMap?.[t.id]?.metrics||{}).sort()})).sort((a,b)=>a.id.localeCompare(b.id));
      const signature=crypto.createHash('sha256').update(canonical(values)).digest('hex');
      baseline??=signature;
      report.samples.push({page_size:size,elapsed_ms:Date.now()-began,task_count:rows.length,signature,same_objects_and_parameters:signature===baseline,read_timings:r.read_timings,result:r});
      if(signature!==baseline){report.ok=false;break;}
    }catch(error){report.ok=false;report.samples.push({page_size:size,elapsed_ms:Date.now()-began,state:'unknown',code:/^[a-z_]{1,80}$/.test(error.message)?error.message:'read_failed',result:lastRead??null});break;}
    finally{clearTimeout(timer);}
  }
  return report;
}
if(require.main===module)(async()=>{
  const [input,output]=process.argv.slice(2);if(!path.isAbsolute(input||'')||!path.isAbsolute(output||''))throw Error('absolute_paths_required');
  Object.assign(process.env,require('./setup.cjs').serviceEnvironment());
  const r=await checkQianchuanPageSize(JSON.parse(fs.readFileSync(input,'utf8')));fs.writeFileSync(output,JSON.stringify(r,null,2));
  console.log(JSON.stringify({ok:r.ok,samples:r.samples.map(({result,...sample})=>sample)}));if(!r.ok)process.exitCode=2;
})().catch(()=>{console.error('page_size_benchmark_failed');process.exitCode=1;});
module.exports={checkQianchuanPageSize};
