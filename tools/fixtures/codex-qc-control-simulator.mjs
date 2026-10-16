// Local deterministic adapter for controller tests. No browser, network or ads.
import {buildDecisionBrief} from '../codex-qc-decision-brief.mjs';
export const fixtureBinding={advertiser_id:'60000000',primary_ad_id:'60000001',room_id:'60000030',date:'2026-10-06',session_started_at:'2026-10-06T10:00:00+08:00',live_start_display:'2026/10/06 10:00',live_name:'模拟'};
export const fixtureTask=(task_id,patch={})=>({task_id,name:'模拟任务',status:'调控中',cost:5,payment_orders:0,payment_roi:0,payment_gmv:0,budget:100,duration_hours:5,...patch});
export function createControlSimulator({binding=fixtureBinding,tasks=[],net_roi=5}={}) {
  const world={binding,tasks:structuredClone(tasks),live_state:'live',net_roi,cost:100,clock:Date.parse('2026-10-06T04:00:00Z'),calls:[],writes:[],fail:'',changeBeforeSubmit:null,financialMissing:false};
  const now=()=>new Date(world.clock).toISOString();
  const readScene=async()=>({binding:world.binding,live_state:world.live_state,captured_at:now(),issues:[]});
  const pool=filter=>({filter,actual_filter:filter,complete:true,empty_verified:true,captured_at:now(),tasks:structuredClone(world.tasks.filter(t=>filter==='调控中'?t.status==='调控中':/手动暂停/.test(t.status))),total:world.tasks.filter(t=>filter==='调控中'?t.status==='调控中':/手动暂停/.test(t.status)).length});
  const io={now,capabilities:{channel:'isolated-simulator',budget_duration_edit:true},readScene,
    async readAll(){return {binding:world.binding,pool:{complete:true,captured_at:now(),tasks:structuredClone(world.tasks)}};},
    async readProtection(){world.calls.push('protection');return {binding:world.binding,scene:await readScene(),active_pool:pool('调控中'),observed_at:now()};},
    async readTargets(ids){world.calls.push('targets');return {binding:world.binding,observed_at:now(),evidence:'sim:exact-ids',targets:ids.map(task_id=>({task_id,task:structuredClone(world.tasks.find(t=>t.task_id===task_id)??null),complete:true,captured_at:now()}))};},
    async readCreated(name){return {binding:world.binding,complete:true,task:structuredClone(world.tasks.find(t=>t.name===name)??null),captured_at:now(),evidence:'sim:name'};},
    async read(context){world.calls.push('full');world.clock+=1;const current={binding:world.binding,captured_at:now(),...context.memory,
      compass:{room_id:binding.room_id,live_start_display:binding.live_start_display,live_state:world.live_state,in_live:world.live_state==='live',source_id:'sim',cost:world.financialMissing?null:world.cost,gmv:world.financialMissing?null:world.gmv??null,refund:world.financialMissing?null:world.refund??null,net_gmv:world.financialMissing?null:world.cost*world.net_roi,net_roi:world.financialMissing?null:world.net_roi,five_minutes:{updated_at:now(),enter:200,leave:150}},
      active_pool:pool('调控中'),paused_pool:pool('手动暂停')};
      const out=buildDecisionBrief(world.previous??null,current,{max_age_seconds:120,policy:{target_net_roi:10},check_interval_seconds:60,...context});world.previous=current;return out;},
    async execute(action,hooks){world.calls.push('execute');
      if(world.changeBeforeSubmit){world.changeBeforeSubmit(world,action);world.changeBeforeSubmit=null;}
      const target=world.tasks.find(t=>t.task_id===action.task_id);
      const before=structuredClone(target??null);
      await hooks.validate(target?[structuredClone(target)]:[]);
      await hooks.beforeSubmit({before:target?[structuredClone(target)]:[]});
      if(world.fail==='before_dispatch')throw Error('disconnect_before_dispatch');
      let after=target;
      if(action.action==='create'){after=fixtureTask(String(60000027+world.tasks.length),{name:action.task_name,budget:action.budget,duration_hours:action.duration_hours,cost:0});world.tasks.push(after);}
      else if(action.action==='update'){Object.assign(after,{budget:action.budget,duration_hours:action.duration_hours??after.duration_hours});}
      else after.status={pause:'已暂停\n手动暂停',resume:'调控中',delete:'已删除',stop:'调控结束'}[action.action];
      world.writes.push({action:action.action,task_id:after.task_id,request_id:action.request_id,before});
      await hooks.onSubmitted({evidence:'sim:submit'});
      if(world.fail==='after_dispatch')throw Error('disconnect_after_dispatch');
      return {effect_status:'write_verified',after:[structuredClone(after)],elapsed_ms:2300,evidence:'sim:exact-readback'};
    }};
  return {world,io};
}
