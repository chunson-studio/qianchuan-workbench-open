import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {readLiveSessions} from './qc-read-live-sessions.mjs';

async function temporaryDirectory(t) {
  const root=await fs.realpath(os.tmpdir()),dir=await fs.mkdtemp(path.join(root,'qc-sessions-'));
  t.after(async()=>{
    const resolved=await fs.realpath(dir);
    assert.equal(path.dirname(resolved),root);assert.ok(path.basename(resolved).startsWith('qc-sessions-'));
    await fs.rm(resolved,{recursive:true,force:true});
  });return dir;
}

test('complete account/day receipt is retained verbatim without status or room filtering',async t=>{
  const dir=await temporaryDirectory(t);
  const output_path=path.join(dir,'evidence.json');
  const result={ok:true,data_valid:true,partial:false,errors:[],component:'live_sessions',date:'2026-10-07',
    count:2,sessions:[{roomId:'123',status:'4'},{roomId:'456',status:'2'}],source_at:'2026-10-07T13:00:00Z'};
  const out=await readLiveSessions({account_id:'fixture',date:'2026-10-07',output_path,read_token:'test-only'},async(url,opts)=>{
    assert.equal(url.hostname,'127.0.0.1');assert.equal(url.pathname,'/api/live-sessions');
    assert.deepEqual([...url.searchParams],[['account','fixture'],['date','2026-10-07']]);
    assert.equal(opts.method,'GET');assert.equal(opts.redirect,'error');assert.equal(opts.headers.Authorization,'Bearer test-only');
    return new Response(JSON.stringify(result));
  });
  assert.equal(out.usable,true);const raw=await fs.readFile(output_path,'utf8');assert.equal(raw.includes('test-only'),false);
  assert.deepEqual(JSON.parse(raw).result,result);
  await assert.rejects(readLiveSessions({account_id:'fixture',date:'2026-10-07',output_path},()=>{throw Error('must_not_call');}),{code:'EEXIST'});
});
test('missing binding and invalid calendar dates fail before transport',async()=>{
  for(const args of [{date:'2026-10-07'},{account_id:'fixture',date:'2026-02-30'}]){
    await assert.rejects(readLiveSessions({...args,output_path:path.resolve('unused.json')},()=>{throw Error('must_not_call');}),/required/);
  }
});
test('partial and limit-full results are saved as evidence but never declared usable',async t=>{
  const dir=await temporaryDirectory(t);
  for(const partial of [true,false]){
    const result={ok:true,data_valid:true,partial,errors:[],component:'live_sessions',date:'2026-10-07',count:200,sessions:Array(200).fill({roomId:'123'})};
    const output_path=path.join(dir,String(partial)+'.json');
    const out=await readLiveSessions({account_id:'fixture',date:'2026-10-07',output_path},async()=>new Response(JSON.stringify(result)));
    assert.equal(out.usable,false);assert.deepEqual(JSON.parse(await fs.readFile(output_path,'utf8')).result,result);
  }
});
