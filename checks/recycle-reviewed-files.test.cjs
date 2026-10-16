const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {testOutputRoot} = require('./test-output.cjs');

test('reviewed recycle rejects drift and links, then recycles only the stable selection', {skip:process.platform!=='win32'}, () => {
  const root=testOutputRoot(), target=path.join(root,'candidate');
  fs.mkdirSync(target);fs.writeFileSync(path.join(target,'a.txt'),'original');
  fs.writeFileSync(path.join(root,'keep.txt'),'keep');
  const manifest=path.join(root,'manifest.json'),receipt=path.join(root,'receipt.json');
  const env={...process.env};delete env.PSModulePath;
  const run=(...args)=>spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-File',path.resolve('tools/recycle-reviewed-files.ps1'),'-RootPath',root,'-ManifestPath',manifest,...args],{encoding:'utf8',windowsHide:true,env});
  const planned=run('-ReviewPaths','candidate','-Purpose','synthetic test');assert.equal(planned.status,0,planned.stderr);
  fs.writeFileSync(path.join(target,'a.txt'),'modified');
  assert.notEqual(run('-Apply','-ReceiptPath',receipt).status,0);
  assert.ok(fs.existsSync(target));assert.ok(!fs.existsSync(receipt));
  fs.writeFileSync(path.join(target,'a.txt'),'original');fs.writeFileSync(path.join(target,'new.txt'),'new');
  assert.notEqual(run('-Apply','-ReceiptPath',receipt).status,0);
  const outside=path.join(root,'keep-dir');fs.mkdirSync(outside);
  fs.symlinkSync(outside,path.join(target,'link'),'junction');
  assert.notEqual(run('-ReviewPaths','candidate','-Purpose','synthetic test').status,0);
  // Let the owner-checked runner recycle this linked fixture; use a separate stable target.
  const stable=path.join(root,'stable');fs.mkdirSync(stable);fs.writeFileSync(path.join(stable,'final.txt'),'final');
  assert.equal(run('-ReviewPaths','stable','-Purpose','synthetic test').status,0);
  const applied=run('-Apply','-ReceiptPath',receipt);
  assert.equal(applied.status,0,applied.stderr);assert.ok(!fs.existsSync(stable));
  assert.equal(fs.readFileSync(path.join(root,'keep.txt'),'utf8'),'keep');
  assert.equal(JSON.parse(fs.readFileSync(receipt,'utf8').replace(/^\uFEFF/,'' )).files[0].status,'recycled');
});
