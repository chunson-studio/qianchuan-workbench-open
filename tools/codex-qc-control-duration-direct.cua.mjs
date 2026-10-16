// Direct CUA duration edit. Caller owns live binding, authorization and serialized execution.
export async function verifyInlineDuration(tab,{task_id,hours,budget,on_checkpoint,timeout_ms=5000}){
 await tab.getAXState({emit:false});
 const row=tab.playwright.getByRole('row').filter({hasText:'ID: '+task_id});
 if(await row.count()!==1)return {task_id,status:'unconfirmed',reason:'target_missing_or_duplicate'};
 let after=await row.getByRole('cell').allTextContents();
 let wait_error;
 if(Number(after[4])===budget&&parseFloat(after[8])!==hours&&Number.isFinite(timeout_ms)&&timeout_ms>0) {
  try {await row.getByRole('cell').nth(8).getByText(hours.toFixed(1),{exact:true}).waitFor({state:'visible',timeoutMs:Math.min(timeout_ms,10000)});}
  catch(error){wait_error=String(error.message||error);}
  if(await row.count()===1)after=await row.getByRole('cell').allTextContents();
  else after=[];
 }
 const result={task_id,status:Number(after[4])===budget&&parseFloat(after[8])===hours&&after[3]?.includes('调控中')?'write_verified':'unconfirmed',after,hours,at:new Date().toISOString(),...(wait_error?{wait_error}:{})};
 if(on_checkpoint)await on_checkpoint(result);return result;
}
export async function submitInlineDuration(tab,cfg){
 if(cfg.hours<5||cfg.hours>24||!cfg.reason||typeof cfg.on_checkpoint!=='function')throw Error('invalid_duration');
 const row=tab.playwright.getByRole('row').filter({hasText:'ID: '+cfg.task_id});
 if(await row.count()!==1)throw Error('task_not_unique');
 const before=await row.getByRole('cell').allTextContents();
 if(Number(before[4])!==cfg.budget||!before[3].includes('调控中')||!before[9].includes('放量追投'))throw Error('task_changed');
 const hours=parseFloat(before[8]),cost=Number(before[11].replace(/,/g,'')),roi=Number(before[12]),orders=Number(before[13]);
 if(hours===cfg.hours)return {task_id:cfg.task_id,status:'already_target',before};
 if(hours!==cfg.expected_hours||![cost,roi,orders].every(Number.isFinite))throw Error('metrics_or_duration_unknown');
 if((orders===0&&cost>cfg.zero_order_max_cost)||(orders>0&&roi<cfg.minimum_ordered_roi))return {task_id:cfg.task_id,status:'needs_pause',before};
 await cfg.on_checkpoint({task_id:cfg.task_id,status:'prepared',before,hours:cfg.hours,at:new Date().toISOString()});
 await tab.getAXState({emit:false});
 await row.getByRole('cell').nth(8).getByText(hours.toFixed(1),{exact:true}).click();await tab.getAXState({emit:false});
 await row.getByRole('cell').nth(8).locator('iconpark-icon[name="oc-icon-light-edit"]').click();await tab.getAXState({emit:false});
 const input=tab.playwright.getByRole('textbox',{name:'请输入',exact:true});
 if(await input.count()!==1||Number(await input.evaluate(e=>e.value))!==hours)throw Error('inline_form_mismatch');
 await input.fill(String(cfg.hours));await input.press('Tab');
 if(Number(await input.evaluate(e=>e.value))!==cfg.hours)throw Error('input_not_applied');
 await cfg.on_checkpoint({task_id:cfg.task_id,status:'submitting',hours:cfg.hours,at:new Date().toISOString()});
 await tab.playwright.getByRole('button',{name:'确定',exact:true}).click();await tab.getAXState({emit:false});
 return {task_id:cfg.task_id,status:'submitted_pending_readback',before,hours:cfg.hours};
}
export async function editControlDuration(tab,cfg){
 const stamp=async event=>cfg.on_checkpoint({...event,task_id:cfg.task_id,at:new Date().toISOString()});
 if(!cfg.reason||!cfg.task_id||typeof cfg.on_checkpoint!=='function'||cfg.hours<5||cfg.hours>24)throw Error('invalid_duration_request');
 let submitted=false;
 try{
  const row=tab.playwright.getByRole('row').filter({hasText:'ID: '+cfg.task_id});
  if(await row.count()!==1)throw Error('task_not_unique');
  const cells=await row.getByRole('cell').allTextContents();
  if(!cells[3]?.includes('调控中')||Number(cells[4])!==cfg.budget||!cells[9]?.includes('放量追投'))throw Error('task_binding_or_budget_changed');
  const previous=parseFloat(cells[8]);
  if(previous===cfg.hours)return {task_id:cfg.task_id,status:'already_target',before:cells};
  if(previous!==cfg.expected_hours)throw Error('duration_changed');
  const cost=Number(cells[11]?.replace(/,/g,'')),roi=Number(cells[12]),orders=Number(cells[13]);
  if(![cost,roi,orders].every(Number.isFinite))throw Error('metrics_unknown');
  if((orders===0&&cost>cfg.zero_order_max_cost)||(orders>0&&roi<cfg.minimum_ordered_roi))return {task_id:cfg.task_id,status:'needs_pause',before:cells};
  await stamp({step:'intent',status:'prepared',before:cells,hours:cfg.hours,reason:cfg.reason});
  await row.getByText('调控中',{exact:true}).click();await tab.playwright.domSnapshot();
  await row.locator('iconpark-icon[name="oc-icon-light-edit"]').click();await tab.playwright.domSnapshot();
  const inputs=tab.playwright.getByRole('textbox',{name:'请输入',exact:true});
  const vals=await inputs.evaluateAll(es=>es.map(e=>e.value));
  const name=await tab.playwright.getByRole('textbox',{name:'请输入任务名称，1-50个字符',exact:true}).evaluate(e=>e.value);
  if(vals.length!==2||Number(vals[0])!==cfg.budget||Number(vals[1])!==previous||!cells[1].includes(name))throw Error('form_mismatch');
  await inputs.nth(1).fill(String(cfg.hours));await inputs.nth(1).press('Tab');
  const edited=await inputs.evaluateAll(es=>es.map(e=>e.value));
  if(Number(edited[0])!==cfg.budget||Number(edited[1])!==cfg.hours)throw Error('input_not_applied');
  await stamp({step:'form',status:'read_verified',values:edited});
  await stamp({step:'submit',status:'submitting'});submitted=true;
  await tab.playwright.getByRole('button',{name:'提交',exact:true}).click();await tab.playwright.domSnapshot();
  if(cfg.submit_only)return {task_id:cfg.task_id,status:'submitted_pending_readback',before:cells,hours:cfg.hours};
  await tab.playwright.getByRole('button',{name:'提交',exact:true}).waitFor({state:'hidden',timeoutMs:10000});
  await tab.playwright.getByRole('columnheader',{name:'调控消耗',exact:true}).click();await tab.playwright.domSnapshot();
  let after=await row.getByRole('cell').allTextContents();
  if(parseFloat(after[8])!==cfg.hours){await tab.playwright.getByRole('columnheader',{name:'调控消耗',exact:true}).click();await tab.playwright.domSnapshot();after=await row.getByRole('cell').allTextContents();}
  if(Number(after[4])!==cfg.budget||parseFloat(after[8])!==cfg.hours||!after[3]?.includes('调控中'))throw Error('readback_not_confirmed');
  const result={task_id:cfg.task_id,status:'write_verified',before:cells,after,hours:cfg.hours};await stamp({step:'verified',...result});return result;
 }catch(error){const result={task_id:cfg.task_id,status:submitted?'unconfirmed':'not_submitted',error:String(error.message||error)};await stamp({step:'failure',...result});return result;}
}
