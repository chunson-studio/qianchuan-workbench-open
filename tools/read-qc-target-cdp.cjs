'use strict';
const fs = require('node:fs');
const { readQianchuanNativeConfig } = require('./start-qc-native-session.cjs');
const fail = code => {throw Object.assign(new Error(code),{code});};

// Fixed read-only target diagnostic. No auto-attach, tab creation, page mutation or API requests.
async function readQianchuanTargetCDP({configFile,date,pool,targetId,timeoutMs=8000,connection,scope='control'}) {
  const config=readQianchuanNativeConfig(configFile);
  if(config.bindings.length!==1||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!['control','page'].includes(scope)||scope==='control'&&(typeof pool!=='string'||!pool.trim()))fail('cdp_read_binding_invalid');
  const binding=config.bindings[0];
  if (connection && (typeof connection.send!=='function'||typeof connection.isConnected!=='function'||!connection.isConnected())) fail('cdp_read_connection_invalid');
  const owned = !connection;
  connection = connection || await connectQianchuanReadCDP({configFile,timeoutMs});
  const timings=[];
  const send=async(method,params,session)=>{const started=Date.now();try{return await connection.send(method,params,session);}finally{timings.push({method,elapsed_ms:Date.now()-started});}};
  let sessionId;
  const matches=value=>{
    try{const url=new URL(value);if(url.origin!=='https://qianchuan.jinritemai.com'||url.username||url.password)return false;
      const params=new URLSearchParams(url.search), index=url.hash.indexOf('?');if(index>=0)for(const [key,value]of new URLSearchParams(url.hash.slice(index+1)))params.append(key,value);
      return [[['aavid','advertiser_id','advertiserId'],binding.advertiser_id],[['adId','primary_ad_id','primaryAdId'],binding.primary_ad_id]].every(([names,expected])=>{const values=names.flatMap(name=>params.getAll(name));return values.length&&values.every(value=>value===expected);});
    }catch{return false;}
  };
  try{
    const version=await send('Browser.getVersion');
    const inventory=await send('Target.getTargets');
    const pages=inventory.targetInfos.filter(target=>target.type==='page');
    const candidates=pages.filter(target=>matches(target.url)&&(!targetId||target.targetId===targetId));
    if(candidates.length!==1)return {ok:false,code:candidates.length?'cdp_read_target_not_unique':'cdp_read_target_missing',page_count:pages.length,
      candidates:candidates.map(target=>({target_id:target.targetId,browser_context_id:target.browserContextId})),advertising_writes:0};
    const target=candidates[0];
    // A valid account URL in another profile is not sufficient to reuse a binding.
    if(target.browserContextId!==binding.browser_context_id||target.targetId!==binding.target_id)fail('cdp_read_binding_changed');
    sessionId=(await send('Target.attachToTarget',{targetId:target.targetId,flatten:true})).sessionId;
    const capture=scope==='control'?captureControlDOM:capturePageDOM;
    const captured=await send('Runtime.evaluate',{expression:`(${capture.toString()})()`,returnByValue:true,awaitPromise:false},sessionId);
    if(captured.exceptionDetails||!captured.result?.value)fail('cdp_read_dom_unavailable');
    const raw=captured.result.value;
    const after=(await send('Target.getTargetInfo',{targetId:target.targetId})).targetInfo;
    if(!matches(raw.url)||!matches(after.url)||after.browserContextId!==target.browserContextId||after.targetId!==target.targetId)fail('cdp_read_identity_changed');
    if(!new RegExp('ID[：:]\\s*'+binding.advertiser_id+'(?:\\D|$)').test(raw.header_text)||!new RegExp('计划ID[：:]\\s*'+binding.primary_ad_id+'(?:\\D|$)').test(raw.header_text))fail('cdp_read_visible_identity_mismatch');
    if(raw.dates.length!==2||raw.dates.some(value=>value!==date)||scope==='control'&&(raw.filters.length!==3||raw.filters[2]!==pool))fail('cdp_read_view_mismatch');
    if(raw.url!==after.url||raw.url!==target.url)fail('cdp_read_view_changed');
    if(scope==='control'&&raw.table_count!==1)fail('cdp_read_table_not_unique');
    return {ok:true,channel:'native_cdp_target_readonly',scope,pool_verified:false,binding:{room:binding.room,advertiser_id:binding.advertiser_id,primary_ad_id:binding.primary_ad_id,target_id:target.targetId,browser_context_id:target.browserContextId},browser_version:version.product,raw,timings_ms:timings,advertising_writes:0};
  }finally{
    if(sessionId&&connection.isConnected())await send('Target.detachFromTarget',{sessionId}).catch(()=>{});
    if(owned)await connection.close();
  }
}

// Keep one normally authorized browser connection across reads. No auto-reconnection.
async function connectQianchuanReadCDP({configFile,timeoutMs=8000},dependencies={}) {
  const config=readQianchuanNativeConfig(configFile);
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000)fail('cdp_read_timeout_invalid');
  const marker=fs.readFileSync(config.markerPath,'utf8').trim().split(/\r?\n/);
  if(marker.length!==2||Number(marker[0])!==config.expectedPort||!/^\/devtools\/browser(?:\/[\w-]+|\/)?$/.test(marker[1]))fail('cdp_read_marker_invalid');
  const Socket=dependencies.WebSocket??globalThis.WebSocket;
  if(typeof Socket!=='function')fail('cdp_read_websocket_unavailable');
  const socket=new Socket(`ws://127.0.0.1:${config.expectedPort}${marker[1]}`);
  let nextId=0;
  const requests=new Map();
  const subscribers=new Set();
  socket.addEventListener('message',event=>{
    let message; try{message=JSON.parse(event.data);}catch{return;}
    if(!Object.hasOwn(message,'id')&&typeof message.method==='string'){
      for(const listener of subscribers)listener.onEvent(message);
      return;
    }
    const request=requests.get(message.id);if(!request)return;
    requests.delete(message.id);clearTimeout(request.timer);
    if(message.error)request.reject(Object.assign(new Error('cdp_read_protocol_error'),{code:'cdp_read_protocol_error',method:request.method,protocol_code:message.error.code}));
    else request.resolve(message.result);
  });
  socket.addEventListener('close',()=>{for(const request of requests.values()){clearTimeout(request.timer);request.reject(Object.assign(new Error('cdp_read_disconnected'),{code:'cdp_read_disconnected'}));}requests.clear();for(const listener of subscribers)listener.onClose?.('cdp_read_disconnected');subscribers.clear();});
  const send=(method,params={},session)=>new Promise((resolve,reject)=>{
    if(socket.readyState!==1){reject(Object.assign(new Error('cdp_read_disconnected'),{code:'cdp_read_disconnected'}));return;}
    const id=++nextId;
    const timer=setTimeout(()=>{requests.delete(id);reject(Object.assign(new Error('cdp_read_command_timeout'),{code:'cdp_read_command_timeout',method}));},timeoutMs);
    requests.set(id,{resolve,reject,timer,method,started:Date.now()});
    try{socket.send(JSON.stringify({id,method,params,...(session?{sessionId:session}:{})}));}catch{clearTimeout(timer);requests.delete(id);reject(Object.assign(new Error('cdp_read_disconnected'),{code:'cdp_read_disconnected'}));}
  });
  try{
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Object.assign(new Error('cdp_read_connect_timeout'),{code:'cdp_read_connect_timeout'})),config.timeoutMs);
      socket.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});
      socket.addEventListener('error',()=>{clearTimeout(timer);reject(Object.assign(new Error('cdp_read_connect_failed'),{code:'cdp_read_connect_failed'}));},{once:true});
    });
    return {send,isConnected:()=>socket.readyState===1,close:()=>socket.close(),
      subscribe(onEvent,onClose){
        if(typeof onEvent!=='function'||onClose!==undefined&&typeof onClose!=='function')fail('cdp_read_subscription_invalid');
        const listener={onEvent,onClose};subscribers.add(listener);
        return ()=>subscribers.delete(listener);
      }};
  }catch(error){socket.close();throw error;}
}

function captureControlDOM(){
  const visible=node=>node.getClientRects().length>0&&getComputedStyle(node).visibility!=='hidden';
  const wrappers=[...document.querySelectorAll('.main-vmok-plugin-oc-table-wrapper, .oc-table-wrapper')].filter(node=>visible(node)&&[...node.querySelectorAll('th')].some(cell=>cell.innerText.trim()==='任务名称'));
  const inputs=[...document.querySelectorAll('input')].filter(visible);
  const text=document.body.innerText, start=text.indexOf('素材追投-控成本追投');
  return {url:location.href,captured_at:new Date().toISOString(),header_text:start>=0?text.slice(0,start):'',table_count:wrappers.length,
    dates:inputs.filter(node=>/^(?:请选择)?(?:开始日期|结束日期)$/.test(node.placeholder)).map(node=>node.value),
    filters:inputs.filter(node=>node.placeholder==='请选择').map(node=>node.value),
    searches:inputs.filter(node=>node.placeholder==='输入任务名称或ID搜索').map(node=>node.value),
    tables:wrappers.map(node=>({headers:[...node.querySelectorAll('thead tr:first-child th')].map(cell=>cell.innerText.trim()),rows:[...node.querySelectorAll('tbody tr')].map(row=>[...row.querySelectorAll('td')].map(cell=>cell.innerText.trim())).filter(row=>row.length),text:node.innerText}))};
}

function capturePageDOM(){
  const visible=node=>node.getClientRects().length>0&&getComputedStyle(node).visibility!=='hidden';
  const text=document.body.innerText;
  return {url:location.href,captured_at:new Date().toISOString(),header_text:text.slice(0,1500),text:text.slice(0,200000),truncated:text.length>200000,
    dates:[...document.querySelectorAll('input')].filter(node=>visible(node)&&/^(?:请选择)?(?:开始日期|结束日期)$/.test(node.placeholder)).map(node=>node.value)};
}

if(require.main===module)readQianchuanTargetCDP({configFile:process.argv[2],date:process.argv[3],pool:process.argv[4],targetId:process.argv[5]}).then(value=>process.stdout.write(JSON.stringify(value)+'\n')).catch(error=>{process.stdout.write(JSON.stringify({ok:false,code:/^cdp_read_[a-z_]+$/.test(error.code||'')?error.code:'cdp_read_failed',method:error.method??null,advertising_writes:0})+'\n');process.exitCode=1;});
module.exports={readQianchuanTargetCDP,connectQianchuanReadCDP,captureControlDOM,capturePageDOM};
