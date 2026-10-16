
export async function prepareSingleMaterialTest({tab,binding,material_id,api,authorized_daily_budget_yuan}) {
  const policy=await api.loadMaterialPolicy(binding);
  const budget=authorized_daily_budget_yuan??policy.initial_daily_budget_yuan;
  if(!Number.isFinite(budget)||budget<=0)throw Error('invalid_authorized_budget');
  if(policy.region_mode!=='unlimited'||policy.initial_roi_mode!=='suggested')throw Error('unsupported_policy');
  await api.readMaterialCandidatePage(tab,binding,{page:1});
  const search=tab.playwright.getByRole('textbox',{name:'输入视频名称/ID后回车搜索',exact:true});
  await search.fill(material_id);await search.press('Enter');await tab.getAXState({emit:false});
  const row=tab.playwright.getByRole('row').filter({hasText:'素材ID: '+material_id});
  const visible=await row.innerText();
  if(!visible.includes(material_id)||!visible.includes('自选投放视频'))throw Error('material_mismatch');
  await row.getByText('追投',{exact:true}).click();await tab.getAXState({emit:false});
  await tab.playwright.getByText('控成本追投',{exact:true}).click();await tab.getAXState({emit:false});
  await tab.playwright.getByRole('textbox',{name:'请输入期望的综合营销ROI目标',exact:true}).waitFor({state:'visible'});
  const dom=await tab.playwright.domSnapshot();
  const form=dom.slice(dom.lastIndexOf('- generic: 对指定素材'));
  const ids=[...form.matchAll(/素材ID: (\d+)/g)].map(m=>m[1]);
  if(ids.length!==1||ids[0]!==material_id)throw Error('form_material_mismatch');
  api.verifyMaterialRegionForm(form,policy);
  await tab.playwright.getByRole('textbox',{name:'请输入',exact:true}).fill(String(budget));
  const nameInput=tab.playwright.getByRole('textbox',{name:'请输入任务名称，1-50个字符',exact:true});
  if(await nameInput.count()!==1)throw Error('name_field_not_unique');
  const task_name=await nameInput.evaluate(e=>e.value);
  if(typeof task_name!=='string'||!task_name.trim()||task_name.length>50||/[\r\n\u0000]/.test(task_name))throw Error('invalid_native_name');
  const roi_goal=await api.adoptMaterialRoiSuggestion(tab);
  if(await nameInput.evaluate(e=>e.value)!==task_name)throw Error('native_name_changed');
  return {status:'prepared_not_submitted',material_id,material_ids:[material_id],task_name,daily_budget_yuan:budget,roi_goal,region_mode:policy.region_mode,regions:[]};
}
