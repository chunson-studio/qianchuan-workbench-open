const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const vm=require('node:vm');
const {prepare}=require('../tools/prepare-cua-inline.cjs');
test('direct CUA payload preserves existing script and loads with string code generation disabled',()=>{
  const output=path.join(os.tmpdir(),'qc-inline-'+process.pid+'.json');
  try {
    const info=prepare({entry:'codex-qc-boost-replay.cua.js',output});
    const payload=JSON.parse(fs.readFileSync(output,'utf8'));
    assert.equal(payload.code,fs.readFileSync(info.source,'utf8'));
    const context=vm.createContext({}, {codeGeneration:{strings:false,wasm:false}});
    vm.runInContext(payload.code,context);
    assert.equal(typeof context.replayQianchuanBoostCreate,'function');
    assert.throws(()=>vm.runInContext('new Function("return 1")',context),/Code generation/);
    assert.equal(context.replayQianchuanBoostCreate.constructor.name,'AsyncFunction');
  } finally {fs.rmSync(output,{force:true});}
});
test('direct CUA payload rejects unregistered source paths',()=>{
  assert.throws(()=>prepare({entry:'../private.json',output:'ignored.json'}),/Unsupported/);
});
