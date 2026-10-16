const test=require('node:test');
const assert=require('node:assert/strict');
const load=()=>import('../tools/codex-qc-browser-steps.cua.mjs');
function tab(dom,count=1,error=null){const calls=[];return {calls,playwright:{domSnapshot:async()=>dom,getByRole:()=>({count:async()=>count,click:async opts=>{calls.push(opts);if(error)throw error;}})}};}
test('missing or unrelated confirmation never clicks',async()=>{const {confirmQianchuanAction:f}=await load();for(const dom of ['', '确定要结束调控吗？']){const t=tab(dom);assert.equal((await f(t,{expected_text:'确定暂停所选的1条任务吗？'})).status,'confirmation_missing');assert.equal(t.calls.length,0);}});
test('exact confirmation clicks once with bounded wait',async()=>{const {confirmQianchuanAction:f}=await load();const t=tab('确定暂停所选的1条任务吗？');assert.equal((await f(t,{expected_text:'确定暂停所选的1条任务吗？'})).status,'submitted_pending_readback');assert.deepEqual(t.calls,[{timeoutMs:800}]);});
test('disappearing confirmation remains unknown and never retries',async()=>{const {confirmQianchuanAction:f}=await load();const t=tab('确定暂停所选的1条任务吗？',1,Error('no_matches'));const r=await f(t,{expected_text:'确定暂停所选的1条任务吗？'});assert.equal(r.status,'submission_unknown');assert.equal(r.retry_write,false);assert.equal(t.calls.length,1);});
test('ambiguous buttons never click',async()=>{const {confirmQianchuanAction:f}=await load();const t=tab('expected',2);assert.equal((await f(t,{expected_text:'expected'})).status,'confirmation_not_unique');assert.equal(t.calls.length,0);});
