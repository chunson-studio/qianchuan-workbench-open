'use strict';
const store=require('../lib/pendingOps');
const {sendJSON}=require('../lib/utils');
async function handlePendingOps(req,res,url){
 if(req.method==='GET'&&url.pathname==='/api/pending-ops')return sendJSON(res,{ok:true,items:store.list({account:url.searchParams.get('account')||null,status:url.searchParams.get('status')||null}),strategy_status:'not_included'});
 return sendJSON(res,{ok:false,code:'private_strategy_not_included',advertising_writes:0,message:'旧策略队列执行未公开；明确指定动作使用通用执行接口。'},501);
}
handlePendingOps.startAutoSweep=()=>{};
handlePendingOps.sweepOnce=async()=>({ok:false,code:'private_strategy_not_included',advertising_writes:0});
module.exports=handlePendingOps;
