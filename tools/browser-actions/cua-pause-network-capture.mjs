
import fs from 'node:fs/promises';
export async function beginPauseCapture(tab,outputRoot) {
  const cdp=await tab.capabilities.get('cdp');
  const enabled=await cdp.send('Network.enable');
  const cursor=(await cdp.readEvents({limit:1000})).cursor;
  await fs.writeFile(outputRoot+'/capture-ready.json',JSON.stringify({at:new Date().toISOString(),enabled,cursor},null,2));
  return {cdp,cursor,outputRoot,events:[]};
}
export async function collectPauseCapture(capture,expectedIds) {
  let page;
  do {
    page=await capture.cdp.readEvents({afterSequence:capture.cursor,limit:1000});
    capture.events.push(...page.events);capture.cursor=page.cursor;
  } while(page.hasMore);
  
  await fs.writeFile(capture.outputRoot+'/pause-network-raw.json',JSON.stringify(capture.events,null,2));
  const requests=capture.events.filter(e=>e.method==='Network.requestWillBeSent'&&e.params.request.method==='POST'&&new URL(e.params.request.url).pathname==='/ad/api/pmc/v1/batch_update_operation');
  const matching=requests.filter(e=>{try{const body=JSON.parse(e.params.request.postData);const ids=body.Objects.map(o=>o.objectID);return body.OptType===2&&ids.length===expectedIds.length&&ids.every(id=>expectedIds.includes(id));}catch{return false;}});
  if(matching.length!==1)throw Error('exact_pause_request_not_unique');
  const request=matching[0],response=capture.events.find(e=>e.method==='Network.responseReceived'&&e.params.requestId===request.params.requestId);
  if(!response)throw Error('pause_response_pending');
  const body=await capture.cdp.send('Network.getResponseBody',{requestId:request.params.requestId});
  await fs.writeFile(capture.outputRoot+'/pause-response-raw.json',JSON.stringify({response,body},null,2));
  const parsed=JSON.parse(body.base64Encoded?Buffer.from(body.body,'base64').toString('utf8'):body.body);
  const receipt={path:'/ad/api/pmc/v1/batch_update_operation',method:'POST',request:JSON.parse(request.params.request.postData),http_status:response.params.response.status,response:parsed,manual_readback_required:true,api_replay_verified:false};
  await fs.writeFile(capture.outputRoot+'/pause-interface.json',JSON.stringify(receipt,null,2));
  return receipt;
}
export async function stopPauseCapture(capture) {
  const result=await capture.cdp.send('Network.disable');
  await fs.writeFile(capture.outputRoot+'/capture-stopped.json',JSON.stringify({at:new Date().toISOString(),result},null,2));
}
