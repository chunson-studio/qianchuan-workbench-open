export async function submitBoundLiveVolume(target,spec,record) {
  const u=new URL(await target.url());
  if(u.searchParams.get('aavid')!==spec.advertiser_id||u.searchParams.get('adId')!==spec.primary_ad_id)throw Error('binding_mismatch');
  const operation_id=spec.operation_id||spec.task_name;
  if(!operation_id||typeof record!=='function')throw Error('durable_intent_required');
  if(await target.playwright.getByRole('button',{name:'提交',exact:true}).count()===0) {
    await target.playwright.getByRole('row').filter({hasText:'ID: '+spec.material_id}).getByText('追投',{exact:true}).click();
    await target.playwright.getByRole('button',{name:'提交',exact:true}).waitFor({state:'visible'});
  }
  const d=await target.playwright.domSnapshot(),f=d.slice(d.lastIndexOf('- generic: 快速激活素材'));
  if(!f.includes('追投直播间画面')||!f.includes('ID: '+spec.material_id)||!f.includes('调控总预算'))throw Error('live_form_identity_mismatch');
  const fields=target.playwright.getByRole('textbox',{name:'请输入',exact:true});
  if(await fields.count()!==2)throw Error('field_layout_changed');
  const n=target.playwright.getByRole('textbox',{name:'请输入任务名称，1-50个字符',exact:true});
  if(await n.count()!==1)throw Error('name_field_not_unique');
  const task_name=await n.evaluate(e=>e.value);
  if(typeof task_name!=='string'||!task_name.trim()||task_name.length>50||/[\r\n\u0000]/.test(task_name))throw Error('invalid_native_name');
  await fields.nth(0).fill(String(spec.budget));await fields.nth(1).fill(String(spec.duration_hours));
  await fields.nth(1).press('Tab');await target.getAXState({emit:false});
  const values=await fields.evaluateAll(es=>es.map(e=>Number(e.value)));
  if(values[0]!==spec.budget||values[1]!==spec.duration_hours||await n.evaluate(e=>e.value)!==task_name)throw Error('values_changed');
  await record({operation_id,status:'intent',prepared:{...spec,task_name}});
  try {
    await target.playwright.getByRole('button',{name:'提交',exact:true}).click();await target.getAXState({emit:false});
    await target.playwright.getByRole('button',{name:'提交',exact:true}).waitFor({state:'hidden',timeoutMs:7000});
    await record({operation_id,status:'submitted_pending_readback'});
  } catch(e) {await record({operation_id,status:'unknown',error:String(e)});throw e;}
}
