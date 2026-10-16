'use strict';
const { sendJSON,readJsonBody,requireWriteAuth }=require('../lib/utils');
const { BrowserBoostService }=require('../lib/browserBoostService');
const service=new BrowserBoostService();
async function handleBrowserBoost(req,res) {
  if(req.method!=='POST')return sendJSON(res,{ok:false,code:'method_not_allowed'},405);
  if(!requireWriteAuth(req,res))return;
  const {data,error}=await readJsonBody(req);
  if(error)return sendJSON(res,{ok:false,code:'invalid_json',advertising_writes:0},400);
  if(Buffer.byteLength(JSON.stringify(data))>256*1024)return sendJSON(res,{ok:false,code:'browser_request_too_large',advertising_writes:0},413);
  try {
    const result=await service.run(data,req);
    return sendJSON(res,result); // structured failures keep their zero-write/unknown distinction
  }catch(error){return sendJSON(res,{ok:false,code:error.code||'browser_service_unavailable',error:'浏览器服务未能完成；写入请沿原请求编号查证',retry_write:false},503);}
}
handleBrowserBoost.service=service;
module.exports=handleBrowserBoost;
