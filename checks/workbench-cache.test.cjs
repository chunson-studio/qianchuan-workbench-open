'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source=fs.readFileSync(path.resolve(__dirname,'../server-app/server/public/sw.js'),'utf8');

const currentCache=source.match(/const CACHE_PREFIX = '([^']+)'/)[1]+source.match(/const CACHE_NAME = CACHE_PREFIX \+ '([^']+)'/)[1];
function worker() {
  const events={},removed=[],writes=[],waits=[];
  const cache={addAll:async()=>{},put:async(request)=>writes.push(request.url),match:async()=>undefined};
  const self={location:{origin:'http://workbench.test'},addEventListener:(name,fn)=>events[name]=fn,skipWaiting(){},clients:{claim:async()=>{}}};
  vm.runInNewContext(source,{self,URL,Response,fetch:async()=>new Response('asset'),
    caches:{keys:async()=>['unrelated-app-cache','qianchuan-v4-v19',currentCache],delete:async key=>removed.push(key),open:async()=>cache}});
  return {events,removed,writes,waits,request(url){let response=null;events.fetch({request:{method:'GET',url},respondWith:value=>response=value,waitUntil:p=>waits.push(p)});return response;}};
}

test('静态资源缓存不接管 API、凭据链接或外站请求',async()=>{
  const w=worker();
  for(const url of ['http://workbench.test/api/status','http://workbench.test/compass_api/test',
    'https://another.test/v4/shared.js','http://workbench.test/v4?token=secret']) assert.equal(w.request(url),null);
  const response=await w.request('http://workbench.test/v4/demo-data.js?v=20');
  assert.equal(response.status,200);
  await Promise.all(w.waits);
  assert.deepEqual(w.writes,['http://workbench.test/v4/demo-data.js?v=20']);
});

test('版本升级只清理本产品旧静态缓存，保留其他应用缓存',async()=>{
  const w=worker();
  w.events.activate({waitUntil:p=>w.waits.push(p)});
  await Promise.all(w.waits);
  assert.deepEqual(w.removed,['qianchuan-v4-v19']);
});
