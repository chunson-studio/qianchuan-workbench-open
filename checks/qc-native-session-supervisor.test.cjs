'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events'),path=require('node:path');
const {superviseQianchuanNativeSession}=require('../tools/qc-native-session-supervisor.cjs');
function fixture(){
  const children=[],states=[];
  const owner=superviseQianchuanNativeSession({configFile:path.resolve('fixture/config.json'),runtimeFile:path.resolve('fixture/runtime.json'),restartDelayMs:1},{
    save:s=>states.push(s),emit:()=>{},spawn(_file,args,options){
      assert.ok(args.includes('--config'));assert.equal(options.windowsHide,true);
      const c=new EventEmitter();c.pid=100+children.length;c.stdout=new EventEmitter();c.stderr=new EventEmitter();
      c.kill=()=>{c.killed=true;c.exitCode=1;c.emit('exit',1,null);};children.push(c);return c;
    }
  });
  const ready=()=>{const c=children.at(-1);c.stdout.emit('data',JSON.stringify({status:'running',pid:c.pid,host_id:'host-'+c.pid})+'\n');};
  return{children,states,owner,ready};
}
test('initial permission/connection failure does not retry',async()=>{
  const f=fixture();f.children[0].stderr.emit('data','{"status":"start_failed","code":"chrome_attach_failed"}\n');
  f.children[0].emit('exit',1,null);const r=await f.owner.done;
  assert.equal(r.status,'failed');assert.equal(f.children.length,1);assert.equal(r.last_code,'chrome_attach_failed');
});

test('separate output streams retain only public connection diagnostics',async()=>{
  const f=fixture(),c=f.children[0];
  c.stdout.emit('data','{"unrelated":');
  c.stderr.emit('data',JSON.stringify({status:'start_failed',code:'chrome_attach_failed',message:'private',
    diagnostic:{stage:'websocket_handshake',failure_type:'handshake_rejected',transport_connected:false,
      http_status:403,elapsed_ms:5500,endpoint:'private',token:'private'}})+'\n');
  c.stdout.emit('data','true}\n');c.emit('exit',1,null);
  const r=await f.owner.done;
  assert.deepEqual(r.last_failure,{code:'chrome_attach_failed',diagnostic:{stage:'websocket_handshake',
    failure_type:'handshake_rejected',transport_connected:false,http_status:403,elapsed_ms:5500}});
  assert.equal(JSON.stringify(f.states).includes('private'),false);assert.equal(f.children.length,1);
});
test('one previously running worker can recover; no business request is dispatched or replayed',async()=>{
  const f=fixture();f.ready();f.children[0].emit('exit',1,null);
  await new Promise(r=>setTimeout(r,5));assert.equal(f.children.length,2);f.ready();
  assert.equal(f.owner.snapshot().status,'running');assert.equal(f.owner.snapshot().restart_count,1);
  f.children[1].emit('exit',1,null);assert.equal((await f.owner.done).status,'failed');assert.equal(f.children.length,2);
});
test('a failed reconnection stops and deliberate stop never reconnects',async()=>{
  const f=fixture();f.ready();f.children[0].emit('exit',1,null);await new Promise(r=>setTimeout(r,5));
  f.children[1].emit('exit',1,null);assert.equal((await f.owner.done).status,'failed');
  const g=fixture();g.ready();assert.equal((await g.owner.stop()).status,'stopped');assert.equal(g.children.length,1);
});
