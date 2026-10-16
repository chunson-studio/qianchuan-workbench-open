'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {BrowserBoostRequests,assertNoUnknownBrowserRequest,assertBrowserRequestIdUnused}=require('../server-app/server/lib/browserBoostRequests');
const request={account_id:'isolated',primary_ad_id:'20001',target_id:'30001',action:'pause',request_id:'journal-test-123'};
test('request journal persists before dispatch and rejects changed payloads',()=>{
 const db=new DatabaseSync(':memory:');try{const journal=new BrowserBoostRequests(db);
  assert.equal(journal.reserve(request),null);
  assert.equal(journal.reserve(request).effect_status,'unconfirmed');
  assert.equal(journal.reserve({...request,action:'resume'}).code,'request_id_conflict');
  journal.dispatched(request);
  assert.throws(()=>assertNoUnknownBrowserRequest('isolated','20001',null,db),{code:'browser_write_pending'});
  journal.finish(request,{ok:true,effect_status:'confirmed',operation_id:1});
  assert.equal(journal.reserve(request).replayed,true);
  assert.doesNotThrow(()=>assertNoUnknownBrowserRequest('isolated','20001',null,db));
  assert.throws(()=>assertBrowserRequestIdUnused('isolated',request.request_id,db),{code:'request_id_channel_conflict'});
  const next={...request,request_id:'journal-midnight-123'};
  assert.equal(journal.reserve({...next,start:'2026-10-01',end:'2026-10-01'},next),null);
  journal.finish(next,{ok:true,effect_status:'confirmed',operation_id:2});
  assert.equal(journal.lookup({...next,start:'2026-10-02',end:'2026-10-02'},next).operation_id,2);
 }finally{db.close();}
});
test('an API creation request ID cannot be submitted through the browser',()=>{
 const db=new DatabaseSync(':memory:');try{db.exec('CREATE TABLE boost_create_requests(account_id TEXT, request_id TEXT)');
  db.prepare('INSERT INTO boost_create_requests VALUES(?,?)').run(request.account_id,request.request_id);
  const journal=new BrowserBoostRequests(db);
  assert.equal(journal.reserve(request).code,'request_id_channel_conflict');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM browser_boost_requests').get().n,0);
 }finally{db.close();}
});
test('failed final receipt persistence leaves the submitted request blocking new writes',()=>{
 const db=new DatabaseSync(':memory:');try{const journal=new BrowserBoostRequests(db);journal.reserve(request);journal.dispatched(request);
  db.exec("CREATE TRIGGER isolated_failure BEFORE UPDATE OF response ON browser_boost_requests BEGIN SELECT RAISE(ABORT,'fixture persistence failure'); END");
  assert.throws(()=>journal.finish(request,{ok:true,effect_status:'confirmed'}));
  assert.equal(journal.reserve(request).effect_status,'unconfirmed');
  assert.throws(()=>assertNoUnknownBrowserRequest('isolated','20001',null,db),{code:'browser_write_pending'});
 }finally{db.close();}
});
