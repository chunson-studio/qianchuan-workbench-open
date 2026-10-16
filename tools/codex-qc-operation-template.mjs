// Pure parameter compilation. No browser, state, credentials or authorization IO.
import {digest} from './codex-qc-control-state.mjs';

export const TEMPLATE_VERSION='1';
const numericId=x=>typeof x==='string'&&/^\d+$/.test(x);
const positive=x=>typeof x==='number'&&Number.isFinite(x)&&x>0;
const money=x=>positive(x)&&Number.isSafeInteger(Math.round(x*100))&&Math.abs(x*100-Math.round(x*100))<1e-6;
const hours=x=>positive(x)&&x>=5&&x<=24;
const fields={create:['count','material_id','material_type','budget_per_task_yuan','duration_hours'],
  pause:['task_ids'],resume:['task_ids','new_zero_order_limit_yuan'],
  stop:['task_ids'],delete:['task_ids'],update:['task_ids','budget_per_task_yuan','duration_hours']};

export function prepareOperationTemplate(input) {
  if(!input||typeof input!=='object'||Array.isArray(input))throw Error('template_object_required');
  const {batch_id,operation,reason}=input;
  if(typeof batch_id!=='string'||!batch_id.trim()||batch_id.length>100||/[\r\n\u0000]/.test(batch_id))throw Error('stable_batch_id_required');
  if(!Object.hasOwn(fields,operation))throw Error('unsupported_template_operation');
  const allowed=new Set(['batch_id','operation','reason',...fields[operation]]);
  const unknown=Object.keys(input).filter(k=>!allowed.has(k));
  if(unknown.length)throw Error('unknown_template_fields:'+unknown.join(','));
  if(reason!==undefined&&(typeof reason!=='string'||!reason.trim()))throw Error('invalid_template_reason');
  const count=operation==='create'?input.count:input.task_ids?.length;
  // A per-call memory bound, not a target pool size or account spending limit.
  if(!Number.isSafeInteger(count)||count<1||count>1000)throw Error('template_count_must_be_1_to_1000');
  if(operation==='create') {
    if(!numericId(input.material_id))throw Error('template_material_id_required');
    if(input.material_type!==undefined&&!['live_screen','video'].includes(input.material_type))throw Error('unsupported_material_type');
  } else if(!Array.isArray(input.task_ids)||input.task_ids.some(x=>!numericId(x))||new Set(input.task_ids).size!==count)throw Error('unique_template_task_ids_required');
  if(['create','update'].includes(operation)&&!money(input.budget_per_task_yuan))throw Error('explicit_budget_per_task_yuan_required');
  if((operation==='create'||input.duration_hours!==undefined)&&!hours(input.duration_hours))throw Error('explicit_duration_hours_must_be_5_to_24');
  if(input.new_zero_order_limit_yuan!==undefined&&!money(input.new_zero_order_limit_yuan))throw Error('invalid_new_zero_order_limit_yuan');
  const parameters={batch_id,operation};
  for(const key of fields[operation])if(input[key]!==undefined)parameters[key]=Array.isArray(input[key])?[...input[key]]:input[key];
  if(reason!==undefined)parameters.reason=reason;
  const totalCents=input.budget_per_task_yuan===undefined?null:Math.round(input.budget_per_task_yuan*100)*count;
  if(totalCents!==null&&!Number.isSafeInteger(totalCents))throw Error('template_total_budget_out_of_range');
  const actions=Array.from({length:count},(_,i)=>({request_id:'template-'+digest(batch_id).slice(0,24)+'-'+(i+1),action:operation,
    ...(operation==='create'?{material_id:input.material_id}:{task_id:input.task_ids[i]}),
    ...(operation==='create'&&input.material_type!==undefined?{material_type:input.material_type}:{}),
    ...(input.budget_per_task_yuan!==undefined?{budget:input.budget_per_task_yuan}:{}),
    ...(input.duration_hours!==undefined?{duration_hours:input.duration_hours}:{}),
    ...(input.new_zero_order_limit_yuan!==undefined?{new_zero_order_limit_yuan:input.new_zero_order_limit_yuan}:{}),
    ...(reason!==undefined?{reason}:{})}));
  return {template_version:TEMPLATE_VERSION,batch_id,fingerprint:digest(parameters),parameters,operation,count,
    budget_per_task_yuan:input.budget_per_task_yuan??null,total_configured_budget_yuan:totalCents===null?null:totalCents/100,
    actions};
}
