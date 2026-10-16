export async function prepareSingleMaterialVolume({tab,binding,material_id,budget_yuan,duration_hours,api}) {
  if(!Number.isFinite(budget_yuan)||budget_yuan<=0||duration_hours<0.5||duration_hours>24)throw Error('invalid_volume_parameters');
  const current=await tab.playwright.domSnapshot();
  const pageUrl=new URL(await tab.url());
  if(pageUrl.searchParams.get('aavid')!==binding.advertiser_id||pageUrl.searchParams.get('adId')!==binding.primary_ad_id)throw Error('binding_mismatch');
  if(current.includes('- button "提交"'))throw Error('existing_form_preserved');
  if(!current.includes('- tab "素材" [selected]')||!current.includes('投放状态：投放中')||!current.includes('视频类型：自选投放视频'))await api.openMaterialCandidates(tab,binding);
  const search=tab.playwright.getByRole('textbox',{name:'输入视频名称/ID后回车搜索',exact:true});
  if(await search.evaluate(e=>e.value)!==material_id){await search.fill(material_id);await search.press('Enter');await tab.getAXState({emit:false});}
  const row=tab.playwright.getByRole('row').filter({hasText:'素材ID: '+material_id});
  await row.waitFor({state:'visible'});
  await row.getByText('审核通过',{exact:true}).waitFor({state:'visible'});
  if(await row.count()!==1||!(await row.innerText()).includes('自选投放视频'))throw Error('candidate_mismatch');
  await row.getByText('追投',{exact:true}).click();await tab.getAXState({emit:false});
  await tab.playwright.getByRole('button',{name:'提交',exact:true}).waitFor({state:'visible'});
  if(await tab.playwright.getByText('调控日预算',{exact:true}).count()) {
    await tab.playwright.getByText('放量追投',{exact:true}).click();await tab.getAXState({emit:false});
  }
  await tab.playwright.getByText('调控总预算',{exact:true}).waitFor({state:'visible'});
  const dom=await tab.playwright.domSnapshot();
  const form=dom.slice(dom.lastIndexOf('- generic: 快速激活素材'));
  const ids=[...form.matchAll(/素材ID: (\d+)/g)].map(m=>m[1]);
  if(ids.length!==1||ids[0]!==material_id||!form.includes('已添加：1/20'))throw Error('volume_material_mismatch');
  const inputs=tab.playwright.getByRole('textbox',{name:'请输入',exact:true});
  if(await inputs.count()!==2)throw Error('volume_input_layout_changed');
  await inputs.nth(0).fill(String(budget_yuan));await inputs.nth(1).fill(String(duration_hours));
  const nameInput=tab.playwright.getByRole('textbox',{name:'请输入任务名称，1-50个字符',exact:true});
  if(await nameInput.count()!==1)throw Error('name_field_not_unique');
  const task_name=await nameInput.evaluate(e=>e.value);
  if(typeof task_name!=='string'||!task_name.trim()||task_name.length>50||/[\r\n\u0000]/.test(task_name))throw Error('invalid_native_name');
  await tab.getAXState({emit:false});
  if(await nameInput.evaluate(e=>e.value)!==task_name)throw Error('native_name_changed');
  return {status:'prepared_not_submitted',type:'放量追投',material_id,material_ids:[material_id],task_name,budget:budget_yuan,duration_hours};
}

export async function submitSingleMaterialVolume({tab,binding,prepared,operation_id,record}) {
  const url=new URL(await tab.url());
  if(url.searchParams.get('aavid')!==binding.advertiser_id||url.searchParams.get('adId')!==binding.primary_ad_id)throw Error('binding_mismatch');
  const dom=await tab.playwright.domSnapshot();
  const form=dom.slice(dom.lastIndexOf('- generic: 快速激活素材'));
  if(!form.includes('调控总预算')||!form.includes('已添加：1/20')||!form.includes('素材ID: '+prepared.material_id))throw Error('form_changed');
  const values=await tab.playwright.getByRole('textbox',{name:'请输入',exact:true}).evaluateAll(es=>es.map(e=>Number(e.value)));
  const name=await tab.playwright.getByRole('textbox',{name:'请输入任务名称，1-50个字符',exact:true}).evaluate(e=>e.value);
  if(values.length!==2||values[0]!==prepared.budget||values[1]!==prepared.duration_hours||name!==prepared.task_name)throw Error('values_changed');
  await record({operation_id,status:'intent',prepared});
  try {
    await tab.playwright.getByRole('button',{name:'提交',exact:true}).click();await tab.getAXState({emit:false});
    try {await tab.playwright.getByRole('button',{name:'提交',exact:true}).waitFor({state:'hidden'});}
    catch(error) {if(await tab.playwright.getByRole('button',{name:'提交',exact:true}).count())throw error;}
    await record({operation_id,status:'submitted_pending_readback'});
    return {operation_id,status:'submitted_pending_readback'};
  } catch(error) {await record({operation_id,status:'unknown',error:String(error)});throw error;}
}
