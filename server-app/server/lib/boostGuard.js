'use strict';
const unavailable=()=>({available:false,verdict:'not_evaluated',code:'private_strategy_not_included'});
module.exports={checkBoostStopLoss:async()=>unavailable(),checkMaterialBleeding:async()=>unavailable(),judgeTask:unavailable,judgeResumeTask:unavailable,judgePostLiveTask:unavailable,judgeRefund:unavailable,judgeBleeding:unavailable,protectionFor:()=>({protected:null,source:'private_strategy_not_included',until:null}),loadRunningStore:()=>({}),PROTECT_MS:null,REFUND_ALERT_LINE:null};
