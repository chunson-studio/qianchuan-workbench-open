'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { serviceEnvironment, run, selectPort } = require('../tools/setup.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-bootstrap-'));
  t.after(() => fs.rmSync(root, {recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'server-app'));
  return root;
}
test('service environment keeps legacy local account directory and background disabled', t => {
  const root=fixture(t); fs.writeFileSync(path.join(root,'server-app/config.json'),'{}');
  const env=serviceEnvironment(root,{});
  assert.equal(env.QC_RUNTIME_CONFIG_ROOT,path.join(root,'server-app'));
  assert.equal(env.QC_DISABLE_BACKGROUND,'1');
  assert.equal(serviceEnvironment(root,{QC_RUNTIME_CONFIG_ROOT:'custom',QC_DISABLE_BACKGROUND:'0'}).QC_RUNTIME_CONFIG_ROOT,'custom');
});
test('check does not rewrite unrelated host settings or launch service', async t => {
  const root=fixture(t), file=path.join(root,'.mcp.json'), original='{"mcpServers":{"other":{"command":"existing"}}}';
  fs.writeFileSync(file,original);
  const launcher={checkEnvironment:()=>({ok:true,nodeOk:true,sqlite:true,missingDependencies:[],failures:[]}),settings:()=>({url:'http://127.0.0.1:18991'}),checkReport:()=>({ok:true}),launch:()=>{throw Error('unexpected launch');}};
  const result=await run({root,env:{},args:['--check'],launcher});
  assert.equal(result.exitCode,0); assert.equal(result.result.mcp,undefined);
  assert.equal(fs.readFileSync(file,'utf8'),original);
});
test('launch uses local service without registering tools', async t=>{
  const root=fixture(t);let captured;
  const launcher={checkEnvironment:()=>({ok:true,nodeOk:true,sqlite:true,missingDependencies:[],failures:[]}),settings:()=>({url:'http://127.0.0.1:18991'}),checkReport:()=>({ok:true}),launch:async(config,options)=>{captured=options;return {url:config.url+'/v4',pid:123,reused:true};}};
  const result=await run({root,env:{},args:[],launcher});
  assert.equal(result.result.service.pid,123);assert.equal(captured.env.QC_DISABLE_BACKGROUND,'1');
  assert.equal(fs.existsSync(path.join(root,'.mcp.json')),false);
});
test('occupied fixed port is not replaced', async()=>{
  await assert.rejects(selectPort(18991,{fixed:true,inspect:async()=> 'occupied'}),/已有其他/);
});
