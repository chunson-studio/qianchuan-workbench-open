'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {loadPlanContexts,validatePlanContexts}=require('../tools/lib/plan-contexts.cjs');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'public-plan-fixture-'));
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
const fixture=()=>({schema_version:1,contexts:[['1','quan_yu','payment_roi'],['2','cheng_fang','comprehensive_roi']].map(([id,plan_type,roi_metric])=>({
 context_id:`demo${id}|plan_${id}`,account_id:`demo${id}`,advertiser_id:id,account_name:`Synthetic ${id}`,plan_id:id,plan_type,product_name:`Example ${id}`,
 douyin_account_id:`demo${id}`,roi_metric,platform_target_roi:1,operating_target_roi:null,live_room_id:null,browser_profile_name:null,status:'verified',source_note:'synthetic fixture only'
}))});
test('two synthetic plan types load without browser bindings',()=>{
 const file=path.join(root,'contexts.json'),data=fixture();fs.writeFileSync(file,JSON.stringify(data));
 assert.deepEqual(loadPlanContexts(file),data);assert.ok(data.contexts.every(x=>x.live_room_id===null&&x.browser_profile_name===null));
});
test('duplicate plans, unknown keys and mismatched metrics are rejected',()=>{
 const data=fixture(),a=data.contexts[0],b=data.contexts[1];
 assert.throws(()=>validatePlanContexts({...data,contexts:[a,{...b,plan_id:a.plan_id,context_id:`${b.account_id}|plan_${a.plan_id}`}]}),{code:'plan_contexts_ambiguous'});
 assert.throws(()=>validatePlanContexts({...data,unexpected:true}),{code:'plan_contexts_invalid'});
 assert.throws(()=>validatePlanContexts({...data,contexts:[{...a,source_note:undefined}]}),{code:'plan_contexts_invalid'});
 assert.throws(()=>validatePlanContexts({...data,contexts:[{...b,roi_metric:'payment_roi'}]}),{code:'plan_contexts_invalid'});
});
test('explicit unknown plan metadata remains nullable',()=>{
 const c={...fixture().contexts[0],plan_type:'unknown',roi_metric:'unknown',platform_target_roi:null,operating_target_roi:null,status:'pending'};
 assert.equal(validatePlanContexts({schema_version:1,contexts:[c]}).contexts[0].status,'pending');
});
test('invalid JSON never rewrites source',()=>{
 const f=path.join(root,'invalid.json');fs.writeFileSync(f,'{ malformed');assert.throws(()=>loadPlanContexts(f),{code:'plan_contexts_invalid_json'});assert.equal(fs.readFileSync(f,'utf8'),'{ malformed');
});
