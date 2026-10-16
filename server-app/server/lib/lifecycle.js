'use strict';
const PHASES={unknown:{key:'unknown',name:'未作策略判定',cls:'phase-unknown'}};
function computeLifecycle(){return {phase:PHASES.unknown,strategy_status:'not_included'};}
function classifySeeding(){return null;}
function attachLifecycle(rows){return (rows||[]).map(row=>({...row,_lifecycle:'unknown',_lifecycleName:'未作策略判定',_lifecycleClass:'phase-unknown',_action:null,strategy_status:'not_included'}));}
function reconcileActionByLifecycle(row){if(row)row._action=null;}
module.exports={PHASES,computeLifecycle,classifySeeding,attachLifecycle,reconcileActionByLifecycle};
