'use strict';
require('./setup-runtime.cjs');
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const {createRequire}=require('node:module');
const pw=createRequire(path.resolve(__dirname,'../server-app/package.json'))('playwright-core');
const {fixtureHtml}=require('./fixtures/browser-boost-page.cjs');
const {BrowserBoostService}=require('../server-app/server/lib/browserBoostService');
const {withTargetWriteLock}=require('../server-app/server/lib/targetWriteLock');
async function localPort(){const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
test('真实本机 CDP 连接复用；页面为隔离夹具，冷启动与重复调用分别留证',async()=>{
 const root=process.env.QC_RUNTIME_DATA_ROOT,port=await localPort();
 const context=await pw.chromium.launchPersistentContext(path.join(root,'cdp-profile'),{executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--disable-gpu','--remote-debugging-port='+port]});
 const file=path.join(root,'isolated-bindings.json');
 fs.writeFileSync(file,JSON.stringify({schema_version:1,bindings:[{account_id:'cdp_fixture',browser_type:'playwright-cdp',profile_name:'isolated-profile',cdp_endpoint:'http://127.0.0.1:'+port,status:'active',advertisers:[{advertiser_id:'10001',primary_ad_ids:['20001']}]}]}));
 const service=new BrowserBoostService({config:{qianchuan_accounts:[{id:'cdp_fixture',aavid:'10001'}]},dataRoot:path.join(root,'browser-boost'),bindingsFile:file,evidenceOrigin:'isolated_fixture'});
 try{await context.route('**/*',route=>route.fulfill({contentType:'text/html',body:fixtureHtml()}));const page=await context.newPage();
  await page.goto('https://qianchuan.jinritemai.com/uni-prom/detail?aavid=10001&adId=20001&dr='+encodeURIComponent('["2026-10-01","2026-10-01"]'),{waitUntil:'domcontentloaded'});
  const req={account_id:'cdp_fixture',primary_ad_id:'20001',action:'list',start:'2026-10-01',end:'2026-10-01'};
  const cold=await service.run(req),repeat=await service.run(req);
  assert.equal(cold.ok,true,JSON.stringify(cold));assert.equal(repeat.ok,true,JSON.stringify(repeat));
  assert.equal(cold.timings.connection_reused,false);assert.equal(repeat.timings.connection_reused,true);assert.equal(service.pool.size,1);
  fs.writeFileSync(path.join(root,'browser-cdp-fixture-timings.json'),JSON.stringify({evidence_origin:'isolated_fixture',connection:'real_local_cdp',cold:cold.timings,repeat:repeat.timings}));
  await service.close();assert.equal(service.pool.size,0);assert.equal(page.isClosed(),false,'closing service transport leaves the owned test browser open');
 }finally{await service.close();await context.close();}
});
test('排队超期只返回零写入；后续获得锁也不会提交',async()=>{
 let release,entered;const ready=new Promise(resolve=>{entered=resolve;});
 const lock=withTargetWriteLock('queue_fixture','boost-scope:20001',()=>{entered();return new Promise(resolve=>{release=resolve;});});
 await ready;let connects=0;
 const service=new BrowserBoostService({config:{qianchuan_accounts:[{id:'queue_fixture',aavid:'10001'}]},totalMs:30,dataRoot:path.join(process.env.QC_RUNTIME_DATA_ROOT,'queue'),sessionFactory:async()=>{connects++;throw Error('must not connect');}});
 try{const result=await service.run({account_id:'queue_fixture',primary_ad_id:'20001',action:'list'});
  assert.equal(result.code,'browser_queue_timeout');assert.equal(result.advertising_writes,0);assert.equal(connects,0);
 }finally{release();await lock;await service.close();}
 assert.equal(connects,0);
});
