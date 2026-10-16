'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {connectClient}=require('../tools/connect-client.cjs');
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'qc-client-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const projectRoot=path.join(root,'project'),packageRoot=path.join(root,'package');
 fs.mkdirSync(projectRoot);fs.mkdirSync(path.join(packageRoot,'skills/qianchuan-ops'),{recursive:true});
 fs.writeFileSync(path.join(packageRoot,'skills/qianchuan-ops/SKILL.md'),'test');
 return {projectRoot,packageRoot,client:'codex'};
}
test('skill install is idempotent and preserves host config byte-for-byte',t=>{
 const f=fixture(t),dir=path.join(f.projectRoot,'.codex');fs.mkdirSync(dir);
 const file=path.join(dir,'config.toml'),original='[mcp_servers.other]\ncommand = "existing"\n';fs.writeFileSync(file,original);
 const a=connectClient(f),b=connectClient(f);
 assert.equal(a.ok,true);assert.equal(b.ok,true);assert.equal(a.mcp,undefined);
 assert.equal(fs.readFileSync(file,'utf8'),original);assert.equal(fs.existsSync(path.join(f.projectRoot,'.mcp.json')),false);
 assert.equal(fs.realpathSync(path.dirname(a.skill.entry)),path.join(f.packageRoot,'skills/qianchuan-ops'));
});
test('manual returns skill path without configuration writes',t=>{
 const f=fixture(t),result=connectClient({...f,client:'manual'});
 assert.equal(result.skill.status,'read_by_path');assert.deepEqual(fs.readdirSync(f.projectRoot),[]);
});
test('existing unrelated skill is not overwritten',t=>{
 const f=fixture(t),target=path.join(f.projectRoot,'.agents/skills/qianchuan-ops');fs.mkdirSync(target,{recursive:true});
 assert.throws(()=>connectClient(f),/已有同名/);
});
