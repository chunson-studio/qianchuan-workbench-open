'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {redactExtensionResult,decodeExtensionJson,buildExtensionControlCode,bindExtensionTestTab}=require('../tools/connect-qc-playwright-extension.cjs');
const spec={advertiser_id:'123',primary_ad_id:'456',date:'2026-10-15',pool:'手动暂停'};
test('extension output removes connection and signed request credentials',()=>{
  const result=redactExtensionResult({content:[{type:'text',text:'secret123 https://local/?token=secret123&msToken=abc&fp=def&verifyFp=ghi&a_bogus=jkl)'}]},'secret123');
  const text=JSON.stringify(result);
  for(const s of ['secret123','abc','def','ghi','jkl'])assert.equal(text.includes(s),false);
  assert.match(text,/redacted/);
});
test('MCP result parser rejects tool errors and missing JSON',()=>{
  assert.deepEqual(decodeExtensionJson({content:[{type:'text',text:'### Result\n{"complete":true}\n### Page\nignored'}]}),{complete:true});
  assert.throws(()=>decodeExtensionJson({isError:true,content:[]}),/extension_tool_returned_error/);
  assert.throws(()=>decodeExtensionJson({content:[{type:'text',text:'### Result\nnot JSON'}]}),/extension_result_invalid/);
});
test('generated control code only accepts bound reads and the observed sort query',()=>{
  for(const options of [{},{sortQuery:true}])assert.equal(typeof vm.runInNewContext('('+buildExtensionControlCode(spec,options)+')'),'function');
  assert.throws(()=>buildExtensionControlCode({...spec,advertiser_id:'123;bad()'}),/extension_read_spec_invalid/);
  assert.throws(()=>buildExtensionControlCode({...spec,action:'pause'}),/extension_read_spec_invalid/);
  assert.throws(()=>buildExtensionControlCode(spec,{sortQuery:'true'}),/extension_read_spec_invalid/);
});
test('test binding refuses a production group before changing tabs',async()=>{
  const actions=[];
  const client={callTool:async(name,args)=>{
    const fn=vm.runInNewContext('('+args.function+')',{
      location:{origin:'chrome-extension://mmlmfjhmonkocbjadbfplnigmagldckm',pathname:'/connect.html'},URL,
      chrome:{tabs:{getCurrent:async()=>({id:1,groupId:9}),get:async()=>({id:2,groupId:7,url:'https://qianchuan.jinritemai.com/overall-prom/detail?aavid=123&adId=456'}),ungroup:async()=>actions.push('ungroup'),group:async()=>actions.push('group')},
        runtime:{sendMessage:async()=>({connections:[{connectedTabIds:[1]}]})},tabGroups:{get:async()=>({title:'示例乙生产页'})}}
    });
    await fn();
  }};
  await assert.rejects(bindExtensionTestTab(client,{tab_id:2,expected_group_id:7,spec}),/extension_test_group_unverified/);
  assert.deepEqual(actions,[]);
});
test('binding waits for the asynchronous page attachment before returning its index',async()=>{
  const actions=[],pages=[{url:()=> 'chrome-extension://mmlmfjhmonkocbjadbfplnigmagldckm/connect.html'}];
  const target={url:()=> 'https://qianchuan.jinritemai.com/overall-prom/detail?aavid=123&adId=456'};
  const context={pages:()=>pages,waitForEvent:async(name,options)=>{actions.push('wait_page');assert.equal(name,'page');assert.equal(options.predicate(target),true);pages.push(target);return target;}};
  const client={callTool:async(name,args)=>{
    if(name==='browser_tabs')return {content:[{type:'text',text:'selected'}]};
    const fn=vm.runInNewContext('('+(args.function||args.code)+')',{
      location:{origin:'chrome-extension://mmlmfjhmonkocbjadbfplnigmagldckm',pathname:'/connect.html'},URL,
      chrome:{tabs:{getCurrent:async()=>({id:1,groupId:9}),get:async()=>({id:2,groupId:7,url:target.url()}),ungroup:async()=>actions.push('ungroup'),group:async()=>actions.push('group')},
        runtime:{sendMessage:async()=>({connections:[{connectedTabIds:[1]}]})},tabGroups:{get:async()=>({title:'Playwright · test'})}}
    });
    const result=await fn({context:()=>context});return {content:[{type:'text',text:'### Result\n'+JSON.stringify(result)}]};
  }};
  const result=await bindExtensionTestTab(client,{tab_id:2,expected_group_id:7,spec});
  assert.equal(result.ready,true);assert.equal(result.index,1);assert.deepEqual(actions,['ungroup','group','wait_page']);
});

test('transport recovery only reclaims its exact ungrouped, unclaimed test tab',async()=>{
  for(const scenario of [
    {groupId:-1,claimed:false,allow:false,rejected:true},
    {groupId:-1,claimed:true,allow:true,rejected:true},
    {groupId:8,claimed:false,allow:true,rejected:true},
    {groupId:-1,claimed:false,allow:true,wrongIdentity:true,rejected:true},
    {groupId:-1,claimed:false,allow:true,rejected:false}
  ]){
    const actions=[];
    const target={url:()=>`https://qianchuan.jinritemai.com/overall-prom/detail?aavid=${scenario.wrongIdentity?'999':'123'}&adId=456`};
    const context={pages:()=>[{},target]};
    const client={callTool:async(name,args)=>{
      if(name==='browser_tabs')return {content:[]};
      const fn=vm.runInNewContext('('+(args.function||args.code)+')',{
        location:{origin:'chrome-extension://mmlmfjhmonkocbjadbfplnigmagldckm',pathname:'/connect.html'},URL,
        chrome:{tabs:{getCurrent:async()=>({id:1,groupId:9}),get:async()=>({id:2,groupId:scenario.groupId,url:target.url()}),
          ungroup:async()=>actions.push('ungroup'),group:async()=>actions.push('group')},
          runtime:{sendMessage:async()=>({connections:[{connectedTabIds:scenario.claimed?[1,2]:[1]}]})}}
      });
      const result=await fn({context:()=>context});return {content:[{type:'text',text:'### Result\n'+JSON.stringify(result)}]};
    }};
    const invoke=()=>bindExtensionTestTab(client,{tab_id:2,expected_group_id:7,spec,allow_orphan:scenario.allow});
    if(scenario.rejected){await assert.rejects(invoke);assert.deepEqual(actions,[]);}
    else{assert.equal((await invoke()).ready,true);assert.deepEqual(actions,['ungroup','group']);}
  }
});
