'use strict';
require('./setup-runtime.cjs');
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),net=require('node:net'),path=require('node:path'),fs=require('node:fs');
const {spawn}=require('node:child_process');
function request(port,pathname,body){return new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port,path:pathname,method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{}},res=>{let text='';res.setEncoding('utf8');res.on('data',data=>{text+=data;});res.on('end',()=>{try{resolve({status:res.statusCode,data:JSON.parse(text)});}catch(error){reject(error);}});});req.setTimeout(3000,()=>req.destroy(Error('fixture HTTP timeout')));req.on('error',reject);req.end(body?JSON.stringify(body):undefined);});}
test('独立空账户服务注册浏览器路由，错误保持零写入并优雅退出',async()=>{
 const listener=net.createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
 const child=spawn(process.execPath,['-e',"process.on('message',()=>process.emit('SIGTERM'));require('./server-app/server.js');"],{cwd:path.resolve(__dirname,'..'),env:{...process.env,QC_PORT:String(port),QC_HOST:'127.0.0.1'},stdio:['ignore','pipe','pipe','ipc']});
 let output='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stderr.on('data',text=>{output+=text;});
 const exit=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
 try{
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('fixture service startup timeout')),10000);child.stdout.on('data',text=>{output+=text;if(output.includes('千川数据服务启动:')){clearTimeout(timer);resolve();}});child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',()=>{clearTimeout(timer);reject(Error('fixture service exited before ready'));});});
  const health=await request(port,'/health/live');assert.equal(health.data.ok,true);
  const unknown=await request(port,'/api/browser-boost',{account_id:'not_configured',primary_ad_id:'20001',action:'list'});
  assert.equal(unknown.data.code,'account_required');assert.equal(unknown.data.advertising_writes,0);
  const bad=await request(port,'/api/browser-boost',{account_id:'not_configured',primary_ad_id:'20001',action:'list',endpoint:'http://127.0.0.1:1'});
  assert.equal(bad.data.advertising_writes,0);assert.equal(bad.data.effect_status,'rejected');
  child.send('close');const stopped=await Promise.race([exit,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('fixture shutdown timeout')),8000);timer.unref();})]);assert.equal(stopped.code,0);
  fs.writeFileSync(path.join(process.env.QC_RUNTIME_DATA_ROOT,'browser-http-smoke.json'),JSON.stringify({evidence_origin:'isolated_empty_account',route:true,unknown_account:unknown.data.code,shutdown:stopped}));
 }finally{if(child.exitCode===null&&!child.killed)child.kill();await exit;}
});
