'use strict';
const {sendJSON}=require('../lib/utils');
module.exports=async(req,res)=>sendJSON(res,{ok:false,code:'private_strategy_not_included',advertising_writes:0},501);
