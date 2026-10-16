'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {checkNativeProcesses}=require('../tools/check-qc-native-processes.cjs');
const {compareNativeControlSample}=require('../tools/check-qc-native-processes.cjs');
test('independent clients overlap, retain errors and stop failed client without writes',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qc-process-check-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const hostId=crypto.randomUUID(),token=crypto.randomBytes(32).toString('hex'),calls=[];
  const server=http.createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;const r=JSON.parse(body);assert.equal(req.headers.authorization,'Bearer '+token);calls.push(r);await new Promise(resolve=>setTimeout(resolve,35));res.setHeader('Content-Type','application/json');res.end(JSON.stringify({host_id:hostId,ok:true,state:'completed',result:{ok:true,complete:r.room!=='b',total:1,visible_rows:1}}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const runtimeFile=path.join(dir,'runtime.json'),configFile=path.join(dir,'config.json');
  fs.writeFileSync(runtimeFile,JSON.stringify({schema:'qianchuan-native-session/v1',status:'running',host_id:hostId,token,endpoint:'http://127.0.0.1:'+server.address().port}));
  const bindings=['a','b'].map(room=>({room,account_id:'test',advertiser_id:'123',primary_ad_id:room==='a'?'456':'789',browser_context_id:'profile',target_id:room}));
  fs.writeFileSync(configFile,JSON.stringify({markerPath:path.join(dir,'DevToolsActivePort'),expectedPort:9222,runtimeFile,bindings}));
  const result=await checkNativeProcesses({configFile,cases:bindings.map(b=>({room:b.room,input:{date:'2026-10-15',pool:'手动暂停'}})),rounds:3});
  assert.equal(result.ok,false);assert.equal(result.overlap_verified,true);
  assert.equal(new Set(result.workers.map(w=>w.client_pid)).size,2);
  assert.equal(result.workers.find(w=>w.room==='a').reads.length,3);
  assert.equal(result.workers.find(w=>w.room==='b').reads.length,1);
  assert.equal(calls.length,4);assert.ok(calls.every(c=>c.operation==='read_control'));
  assert.equal(result.advertising_writes,0);
});
test('benchmark cannot dispatch advertising or refresh operations',async()=>{
  await assert.rejects(checkNativeProcesses({configFile:'unused',cases:[{room:'a'}],operation:'ui'}),/options_invalid/);
  await assert.rejects(checkNativeProcesses({configFile:'unused',cases:[{room:'a'}],operation:'refresh'}),/options_invalid/);
});
test('cross-channel samples require full unique coverage and the original ROI header',()=>{
  const native={ok:true,complete:true,total:1,headers:['调控消耗','调控支付ROI'],tasks:[{task_id:'1',raw_cells:['7.02','8.28']}]};
  const sample={complete:true,total:1,tasks:[{task_id:'1',fields:{'调控消耗':'7.02','调控支付ROI':'8.28'}}]};
  assert.equal(compareNativeControlSample(native,sample).ok,true);
  assert.equal(compareNativeControlSample(native,{...sample,tasks:[{task_id:'1',fields:{'调控综合营销ROI':'8.28'}}]}).ok,false);
  assert.equal(compareNativeControlSample(native,{...sample,total:2}).code,'comparison_coverage_mismatch');
  assert.equal(compareNativeControlSample({...native,complete:false},sample).code,'comparison_incomplete');
});
