'use strict';
// Private historical flow selection and classification are not distributed.
const SLOTS=[];
function computeFlowBaseline(){return {strategy_status:'not_included',data_valid:false,sessions_used:null,slots:{},computed_at:null};}
const getFlowBaseline=computeFlowBaseline;
function aggregateSlotRates(){return {};}
module.exports={computeFlowBaseline,getFlowBaseline,aggregateSlotRates,SLOTS};
