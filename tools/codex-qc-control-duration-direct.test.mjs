import {test} from 'node:test';
import assert from 'node:assert/strict';
import {verifyInlineDuration} from './codex-qc-control-duration-direct.cua.mjs';

function fixture({updated=true,budget=100,status='调控中',disappear=false}={}) {
 let waited=false;
 const calls=[];
 const cells=()=>['','fixture','material',status,String(budget),'-','-','-',waited&&updated?'8.0预计 明天结束':'6.0预计 明天结束'];
 const row={count:async()=>waited&&disappear?0:1,getByRole:()=>({allTextContents:async()=>cells(),nth:index=>({getByText:(text,opt)=>({waitFor:async request=>{
  calls.push({index,text,opt,request});waited=true;if(!updated)throw Error('selector deadline exceeded');
 }})})})};
 const tab={getAXState:async()=>{},playwright:{getByRole:()=>({filter:()=>row})}};
 return {tab,calls};
}

test('duration readback waits for delayed page update within the same call without a submit',async()=>{
 const f=fixture(),events=[];
 const r=await verifyInlineDuration(f.tab,{task_id:'123',hours:8,budget:100,on_checkpoint:async e=>events.push(e)});
 assert.equal(r.status,'write_verified');assert.equal(events.length,1);
 assert.deepEqual(f.calls,[{index:8,text:'8.0',opt:{exact:true},request:{state:'visible',timeoutMs:5000}}]);
});

test('duration timeout or disappearance remains unconfirmed and cannot resend an edit',async()=>{
 for(const config of [{updated:false},{disappear:true}]) {
  const f=fixture(config),r=await verifyInlineDuration(f.tab,{task_id:'123',hours:8,budget:100});
  assert.equal(r.status,'unconfirmed');assert.equal(f.calls.length,1);
 }
});

test('changed budget or inactive status cannot be accepted as successful duration readback',async()=>{
 const changed=fixture({budget:200});
 assert.equal((await verifyInlineDuration(changed.tab,{task_id:'123',hours:8,budget:100})).status,'unconfirmed');
 assert.equal(changed.calls.length,0);
 const inactive=fixture({status:'已暂停'});
 assert.equal((await verifyInlineDuration(inactive.tab,{task_id:'123',hours:8,budget:100})).status,'unconfirmed');
});
