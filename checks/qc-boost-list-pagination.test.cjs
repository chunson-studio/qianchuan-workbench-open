'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
function fixture({total=200,cap=200,mutate}={}) {
  const calls=[],module={exports:{}};
  const qc={enqueue:async(fn,_account,opts)=>fn(opts.signal),requestAPI:async(_method,_url,body)=>{
    const {Page:page,PageSize:size}=body.Params.PageParams;
    calls.push({page,size,filter:structuredClone(body.Params.AdFilter),search:body.Params.SearchFilter&&structuredClone(body.Params.SearchFilter)});
    const count=Math.min(size,cap),start=(page-1)*count;
    const rows=Array.from({length:Math.max(0,Math.min(count,total-start))},(_,i)=>({id:String(start+i+1),advId:'900'}));
    const r={status_code:0,request_timings:{upstream_ms:0},data:{adInfos:rows,
      adStatsMap:Object.fromEntries(rows.map(t=>[t.id,{metrics:{cost:{value:1}}}])),
      pagination:{page,pageSize:count,totalNum:String(total)}}};
    if(mutate)mutate(r,page);return r;
  }};
  const filename=path.resolve('server-app/server/lib/qianchuanTabs.js');
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module,exports:module.exports,Date,URLSearchParams,
    console:{log(){},warn(){},error(){}},require(name){
      if(name==='fs')return{existsSync:()=>true,promises:{}};
      if(name==='path')return path;
      if(name==='./qianchuan')return qc;
      if(name==='./config')return{CACHE_DIR:'fixture-cache'};
      if(name==='./cookie')return{resolveAavid:()=> '900'};
      if(['./utils','./db','./creativeVideoLibrary'].includes(name))return{};
      throw Error('unexpected_dependency_'+name);
    }},{filename});
  return{calls,read:opts=>module.exports.fetchBoostList('999','2026-10-15','2026-10-15','fixture',opts)};
}
test('known total ends a full last page without an extra empty request',async()=>{
  const f=fixture({total:100}),r=await f.read({pageSize:100});
  assert.equal(r.truncated,false);assert.equal(f.calls.length,1);assert.equal(r.data.adInfos.length,100);
  assert.equal(r.read_timings.page_count,1);
});
test('large pages retain every unique task and its metrics',async()=>{
  const f=fixture({total:250}),r=await f.read({pageSize:100});
  assert.equal(r.truncated,false);assert.equal(f.calls.length,3);
  assert.equal(new Set(r.data.adInfos.map(t=>t.id)).size,250);assert.equal(Object.keys(r.data.adStatsMap).length,250);
});
test('server page-size clamp cannot cause a partial pool to be complete',async()=>{
  const f=fixture({total:100,cap:50}),r=await f.read({pageSize:100});
  assert.equal(r.truncated,false);assert.equal(f.calls.length,2);assert.equal(r.data.adInfos.length,100);
});
for(const defect of ['duplicate','total_changed','missing_total','page_mismatch','module_error'])test(defect+' is incomplete',async()=>{
  const f=fixture({total:100,cap:50,mutate(r,page){
    if(page!==2)return;
    if(defect==='duplicate')r.data.adInfos[0].id='1';
    if(defect==='total_changed')r.data.pagination.totalNum='101';
    if(defect==='missing_total')delete r.data.pagination.totalNum;
    if(defect==='page_mismatch')r.data.pagination.page=1;
    if(defect==='module_error')r.data.moduleErrors={metrics:{code:1}};
  }}),r=await f.read({pageSize:100});
  assert.equal(r.truncated,true);assert.equal(f.calls.length,2);assert.equal(r.data.adInfos.length,50);
});
test('page count remains bounded and invalid size makes no upstream request',async()=>{
  const f=fixture({total:2000,cap:50}),r=await f.read({pageSize:100});
  assert.equal(r.truncated,true);assert.equal(f.calls.length,20);
  for(const pageSize of [0,101,1.5,'100'])await assert.rejects(f.read({pageSize}),{code:'invalid_boost_page_size'});
  assert.equal(f.calls.length,20);
});
test('observed manual-pause and exact-ID search stay bound to the requested main plan',async()=>{
  const f=fixture({total:1}),r=await f.read({pool:'manual_paused',taskId:'1'});
  assert.equal(r.truncated,false);assert.equal(r.task_pool,'manual_paused');
  assert.equal(f.calls[0].filter.AdStatusFilterType,4);assert.equal(f.calls[0].filter.AssistTaskFilter.PrimaryAID,'999');
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0].search)),{Type:1,Keyword:'1'});
  await assert.rejects(f.read({pool:'ended'}),{code:'invalid_boost_query_scope'});
  await assert.rejects(f.read({taskId:'1,2'}),{code:'invalid_boost_query_scope'});
});
