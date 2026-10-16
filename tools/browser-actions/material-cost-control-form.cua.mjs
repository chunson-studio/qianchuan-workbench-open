

export async function fillMaterialEditRoi(tab, spec) {
  const u=new URL(await tab.url());
  if(u.searchParams.get('aavid')!==spec.advertiser_id || u.searchParams.get('adId')!==spec.primary_ad_id)throw new Error('plan_binding_mismatch');
  if(!Number.isFinite(spec.old_roi_goal) || !Number.isFinite(spec.roi_goal) || spec.roi_goal<spec.min_roi || spec.roi_goal>spec.max_roi || Math.abs(spec.roi_goal/spec.old_roi_goal-1)>spec.max_change_fraction+1e-9)throw new Error('roi_range_mismatch');
  const name=tab.playwright.getByRole('textbox',{name:'请输入任务名称，1-50个字符',exact:true});
  if(await name.evaluate(e=>e.value)!==spec.task_name)throw new Error('task_name_mismatch');
  const form=(await tab.playwright.domSnapshot()).split('追投方式').pop();
  if(!spec.material_ids.every(id=>form.includes('素材ID: '+id)) || !form.includes('已添加：'+spec.material_ids.length+'/20') || !form.includes(spec.regions.join('、')) || !form.includes(spec.region_type))throw new Error('material_or_region_mismatch');
  const budget=tab.playwright.getByRole('textbox',{name:'请输入',exact:true});
  const roi=tab.playwright.getByRole('textbox',{name:'请输入期望的综合营销ROI目标',exact:true});
  if(await roi.count()!==1 || Number(await budget.evaluate(e=>e.value))!==spec.daily_budget_yuan || Number(await roi.evaluate(e=>e.value))!==spec.old_roi_goal)throw new Error('original_values_mismatch');
  await roi.fill(String(spec.roi_goal));await roi.press('Tab');await tab.playwright.domSnapshot();
  if(Number(await roi.evaluate(e=>e.value))!==spec.roi_goal || Number(await budget.evaluate(e=>e.value))!==spec.daily_budget_yuan)throw new Error('filled_values_mismatch');
  return {status:'read_verified',task_id:spec.task_id,old_roi_goal:spec.old_roi_goal,roi_goal:spec.roi_goal,advertising_writes:0};
}
export async function fillMaterialEditBudget(tab, spec) {
  if (!Number.isFinite(spec.new_budget_yuan) || spec.new_budget_yuan <= spec.daily_budget_yuan || !Number.isFinite(spec.available_budget_yuan) || spec.new_budget_yuan - spec.daily_budget_yuan > spec.available_budget_yuan) throw new Error('budget_range_mismatch');
  await fillMaterialEditRoi(tab, {...spec, roi_goal:spec.old_roi_goal});
  const budget=tab.playwright.getByRole('textbox',{name:'请输入',exact:true});
  await budget.fill(String(spec.new_budget_yuan));
  await budget.press('Tab');
  if (Number(await budget.evaluate(e=>e.value)) !== spec.new_budget_yuan) throw new Error('budget_readback_mismatch');
  return {status:'read_verified',task_id:spec.task_id,old_budget:spec.daily_budget_yuan,new_budget:spec.new_budget_yuan,advertising_writes:0};
}
export async function prepareMaterialCostControlForm(tab, spec, save) {
  if (typeof save !== 'function') throw new Error('checkpoint_callback_required');
  const u = new URL(await tab.url());
  if (u.hostname !== 'qianchuan.jinritemai.com' ||
      u.searchParams.get('aavid') !== spec.advertiser_id ||
      u.searchParams.get('adId') !== spec.primary_ad_id) throw new Error('plan_binding_mismatch');
  if (!spec.material_id || !Number.isFinite(spec.daily_budget_yuan) || spec.daily_budget_yuan <= 0 ||
      (spec.roi_mode !== 'deferred' && (!Number.isFinite(spec.roi_goal) || spec.roi_goal <= 0))) throw new Error('invalid_parameters');
  if(await tab.playwright.getByRole('button',{name:'提交',exact:true}).count() || await tab.playwright.getByRole('button',{name:'确定',exact:true}).count())throw new Error('existing_form_or_confirmation_must_be_preserved');
  if(!spec.material_tab_ready) {
    await tab.playwright.getByRole('tab', {name:'素材',exact:true}).click();
    await tab.playwright.domSnapshot();
  } else {
    const current=await tab.playwright.domSnapshot();
    if(!/- tab "素材"[^\n]*\[selected\]/.test(current))throw new Error('material_tab_not_ready');
  }
  await save('materials.open_tab', {status:'opened',material_id:spec.material_id});
  const row = tab.playwright.getByRole('row').filter({hasText:'素材ID: ' + spec.material_id});
  await row.waitFor({state:'visible',timeoutMs:10000});
  if (await row.count() !== 1) throw new Error('material_not_unique');
  await row.getByText('审核通过',{exact:true}).waitFor({state:'visible',timeoutMs:10000});
  const rowText = await row.innerText();
  if (!rowText.includes('审核通过') || !rowText.includes('自选投放视频')) throw new Error('material_not_approved');
  await row.getByText('追投', {exact:true}).click();
  await tab.playwright.domSnapshot();
  if(!/- button "提交"/.test(await tab.playwright.domSnapshot())) {
    const action=row.locator('.main-vmok-plugin-oc-promotion-operation-action-item').filter({hasText:/^追投$/});
    if(await action.count()!==1)throw new Error('material_action_not_unique');
    await action.click();
  }
  await save('boost.form.open', {status:'opened',material_id:spec.material_id,row:rowText});
  await tab.playwright.locator('div.main-vmok-plugin-radio-item').filter({hasText:/^控成本追投$/}).click();
  await tab.playwright.domSnapshot();
  await tab.playwright.getByText('调控日预算',{exact:true}).waitFor({state:'visible'});
  await tab.playwright.getByRole('textbox',{name:'请输入期望的综合营销ROI目标',exact:true}).waitFor({state:'visible',timeoutMs:10000});
  let dom = await tab.playwright.domSnapshot();
  const form = dom.slice(dom.lastIndexOf('- generic: 对指定素材付出额外预算追加投放'));
  if (!form.includes('综合营销ROI目标') || !form.includes('调控日预算') ||
      !form.includes(spec.material_id)) throw new Error('cost_control_form_binding_mismatch');
  await save('boost.cost_control_mode', {status:'read_verified',form});
  
  await explicitlySelectCostVideo(tab, spec.material_id, save);
  const nativeName = await tab.playwright.getByRole('textbox', {name:'请输入任务名称，1-50个字符',exact:true}).evaluate(e => e.value);
  const taskName = nativeName;
  if (typeof taskName !== 'string' || !taskName.trim() || taskName.length > 50 || /[\r\n\u0000]/.test(taskName)) throw new Error('invalid_native_name');
  await fillMaterialCostFields(tab, {...spec,task_name:taskName});
  await tab.playwright.domSnapshot();
  dom = await tab.playwright.domSnapshot();
  const values = await tab.playwright.locator('input').evaluateAll(es => es.filter(e => e.getBoundingClientRect().width > 0).map(e => ({placeholder:e.placeholder,value:e.value})));
  if (!values.some(v => v.placeholder === '请输入' && Number(v.value) === spec.daily_budget_yuan) ||
      !values.some(v => v.placeholder === '请输入期望的综合营销ROI目标' && (spec.roi_mode === 'deferred' ? v.value === '' : Number(v.value) === spec.roi_goal)) ||
      !values.some(v => v.placeholder === '请输入任务名称，1-50个字符' && v.value === taskName)) throw new Error('filled_values_mismatch');
  await save('boost.cost_control_fill', {status:'read_verified',task_name:taskName,material_id:spec.material_id,daily_budget_yuan:spec.daily_budget_yuan,roi_goal:spec.roi_goal,roi_basis:'chengfang_comprehensive',form:dom.slice(dom.lastIndexOf('- generic: 对指定素材付出额外预算追加投放'))});
  return {task_name:taskName,material_id:spec.material_id,daily_budget_yuan:spec.daily_budget_yuan,roi_goal:spec.roi_goal,advertising_writes:0};
}
import { setMaterialAgeBands } from './material-age-targeting.cua.mjs';

export async function fillMaterialCostFields(tab, spec) {
  const u=new URL(await tab.url());
  if(u.hostname!=='qianchuan.jinritemai.com' || u.searchParams.get('aavid')!==spec.advertiser_id || u.searchParams.get('adId')!==spec.primary_ad_id) throw new Error('plan_binding_mismatch');
  if(!Number.isFinite(spec.daily_budget_yuan) || spec.daily_budget_yuan<=0 || (spec.roi_mode!=='deferred' && (!Number.isFinite(spec.roi_goal)||spec.roi_goal<=0))) throw new Error('invalid_parameters');
  const dom=await tab.playwright.domSnapshot();
  const start=dom.lastIndexOf('- generic: 对指定素材付出额外预算追加投放');
  const form=start>=0?dom.slice(start):'';
  if(!form.includes('调控日预算') || !form.includes('已添加：1/20') || !form.includes('素材ID: '+spec.material_id)) throw new Error('cost_control_form_binding_mismatch');
  const fields=[['请输入',String(spec.daily_budget_yuan)],['请输入期望的综合营销ROI目标',spec.roi_mode==='deferred'?'':String(spec.roi_goal)]];
  for(const [name] of fields) if(await tab.playwright.getByRole('textbox',{name,exact:true}).count()!==1) throw new Error('form_field_not_unique:'+name);
  const nameInput=tab.playwright.getByRole('textbox',{name:'请输入任务名称，1-50个字符',exact:true});
  if(await nameInput.count()!==1)throw new Error('form_field_not_unique:task_name');
  const taskName=await nameInput.evaluate(e=>e.value);
  if(typeof taskName!=='string'||!taskName.trim()||taskName.length>50||/[\r\n\u0000]/.test(taskName))throw new Error('invalid_native_name');
  for(const [name,value] of fields) await tab.playwright.getByRole('textbox',{name,exact:true}).fill(value);
  await tab.playwright.getByRole('textbox',{name:'请输入期望的综合营销ROI目标',exact:true}).press('Tab');
  await tab.playwright.domSnapshot();
  for(const [name,value] of fields) if(await tab.playwright.getByRole('textbox',{name,exact:true}).evaluate(e=>e.value)!==value) throw new Error('filled_value_mismatch:'+name);
  if(await nameInput.evaluate(e=>e.value)!==taskName)throw new Error('native_name_changed');
  return {status:'read_verified',material_id:spec.material_id,task_name:taskName,daily_budget_yuan:spec.daily_budget_yuan,roi_goal:spec.roi_goal,advertising_writes:0};
}
export async function explicitlySelectCostVideo(tab, materialId, save) {
  if (typeof save !== 'function') throw new Error('checkpoint_callback_required');
  const before = await tab.playwright.domSnapshot();
  const currentForm = before.slice(before.lastIndexOf('- generic: 对指定素材付出额外预算追加投放'));
  if (currentForm.includes('已添加：1/20') && currentForm.includes('素材ID: ' + materialId)) {
    await save('boost.cost_video.existing', {status:'read_verified',material_id:materialId,form:currentForm});
    return {material_id:materialId,selected:1,already_present:true,advertising_writes:0};
  }
  await tab.playwright.getByRole('button', {name:'添加视频',exact:true}).click();
  await tab.playwright.domSnapshot();
  await save('boost.cost_video.open', {status:'opened',material_id:materialId});
  const search = tab.playwright.getByRole('textbox', {name:'输入视频名称/ID后回车搜索',exact:true});
  await search.fill(materialId);
  await search.press('Enter');
  await tab.playwright.domSnapshot();
  const row = tab.playwright.getByRole('row').filter({hasText:'素材ID: ' + materialId});
  await row.waitFor({state:'visible',timeoutMs:10000});
  if (await row.count() !== 1) throw new Error('selectable_material_not_unique');
  await save('boost.cost_video.search', {status:'read_verified',material_id:materialId,row:await row.innerText()});
  await row.getByRole('checkbox').check();
  await tab.playwright.domSnapshot();
  const selectedDom = await tab.playwright.domSnapshot();
  if (!selectedDom.includes('已选 1 / 20')) throw new Error('single_material_selection_not_verified');
  await save('boost.cost_video.select', {status:'read_verified',material_id:materialId,tail:selectedDom.slice(-500)});
  await tab.playwright.getByRole('button', {name:'确定',exact:true}).click();
  await tab.playwright.domSnapshot();
  const dom = await tab.playwright.domSnapshot();
  const form = dom.slice(dom.lastIndexOf('- generic: 对指定素材付出额外预算追加投放'));
  if (!form.includes('已添加：1/20') || !form.includes(materialId)) throw new Error('confirmed_material_not_in_form');
  await save('boost.cost_video.confirm', {status:'read_verified',material_id:materialId,form});
  return {material_id:materialId,selected:1,advertising_writes:0};
}


export async function setCostMaterialRegions(tab, regions, save) {
  if (typeof save !== 'function') throw new Error('checkpoint_callback_required');
  if (!Array.isArray(regions) || !regions.length || regions.some(r => typeof r !== 'string' || !r.trim()) || new Set(regions).size !== regions.length) throw new Error('invalid_regions');
  if (!await tab.playwright.getByRole('textbox',{name:'请输入关键字搜索',exact:true}).isVisible()) {
    await tab.playwright.getByRole('button', {name:'+ 设置定向',exact:true}).click();
    await tab.playwright.domSnapshot();
    await save('boost.audience.open', {status:'opened',dom:await tab.playwright.domSnapshot()});
    await tab.playwright.getByText('按省市', {exact:true}).click();
    await tab.playwright.domSnapshot();
  }
  await tab.playwright.getByText(regions[0],{exact:true}).waitFor({state:'visible',timeoutMs:10000});
  const items = await tab.playwright.locator('li.main-vmok-plugin-cascader-panel__selection-item').evaluateAll(els=>els.map(e=>({id:e.getAttribute('data-id'),name:e.textContent.trim()})));
  const ids = {};
  for (const region of regions) {
    const matches = items.filter(i=>i.name===region);
    if(matches.length!==1 || !/^\d+$/.test(matches[0].id)) throw new Error('region_taxonomy_not_unique');
    ids[region]=matches[0].id;
  }
  await save('boost.audience.provinces', {status:'opened',dom:await tab.playwright.domSnapshot()});
  for (const region of regions) {
    const item = tab.playwright.locator('li.main-vmok-plugin-cascader-panel__selection-item[data-id="'+ids[region]+'"]');
    if ((await item.innerText()).trim() !== region) throw new Error('region_taxonomy_mismatch');
    await item.getByRole('checkbox').check();
    await save('boost.audience.region', {status:'read_verified',region});
  }
  await tab.playwright.getByRole('button', {name:'确定',exact:true}).click();
  await tab.playwright.domSnapshot();
  await tab.playwright.getByText('已选定向信息', {exact:true}).waitFor({state:'visible',timeoutMs:10000});
  const dom = await tab.playwright.domSnapshot();
  const form = dom.slice(dom.lastIndexOf('- generic: 对指定素材付出额外预算追加投放'));
  if (regions.some(r => !form.includes(r)) || !form.includes('正在该地区的用户') || !form.includes('- generic: 性别\n- generic: 不限') ||
      !form.includes('- generic: 年龄\n- generic: 不限')) throw new Error('audience_form_mismatch');
  await save('boost.audience.confirm', {status:'read_verified',regions,sex:'unlimited',age:'unlimited',form});
  return {regions,sex:'unlimited',age:'unlimited',advertising_writes:0};
}


export async function prepareMaterialCostWithAudience(tab, spec, save) {
  const prepared=await prepareMaterialCostControlForm(tab,spec,save);
  await setCostMaterialRegions(tab,spec.regions,save);
  if(spec.age_bands?.length)await setMaterialAgeBands(tab,spec);
  return {...prepared,regions:spec.regions,age_bands:spec.age_bands,status:'prepared_not_submitted',advertising_writes:0};
}


export async function createRegionCostMaterialTask(tab, spec, save) {
  if (spec.roi_mode === 'deferred') throw new Error('explicit_roi_required_for_direct_create');
  const prepared = await prepareMaterialCostWithAudience(tab, spec, save);
  await save('boost.cost_submit.intent', {status:'prepared',...prepared,regions:spec.regions,age_bands:spec.age_bands});
  await tab.playwright.getByRole('button',{name:'提交',exact:true}).click();
  await tab.playwright.domSnapshot();
  await save('boost.cost_submit.response',{status:'submitted_unverified',task_name:prepared.task_name,dom:await tab.playwright.domSnapshot()});
  await tab.playwright.getByRole('button',{name:'提交',exact:true}).waitFor({state:'hidden',timeoutMs:10000});
  await tab.playwright.domSnapshot();
  await tab.playwright.getByRole('tab',{name:'调控',exact:true}).click();
  await tab.playwright.domSnapshot();
  const row=tab.playwright.getByRole('row').filter({hasText:prepared.task_name});
  await row.waitFor({state:'visible',timeoutMs:10000});
  const cells=await row.getByRole('cell').allTextContents({timeoutMs:10000});
  const id=cells[1]?.match(/ID:\s*(\d+)/)?.[1];
  if(!id || !cells[2]?.includes(spec.material_id) || !cells[3]?.includes('调控中') ||
     Number(cells[4])!==spec.daily_budget_yuan || Number(cells[5])!==spec.roi_goal ||
     !cells[9]?.includes('控成本追投')) throw new Error('submitted_task_readback_unknown:'+prepared.task_name);
  await save('boost.cost_create.list_verified',{status:'read_verified',target_id:id,cells});
  await row.locator('iconpark-icon[name="oc-icon-light-edit"]').click();
  await tab.playwright.domSnapshot();
  await tab.playwright.getByRole('textbox',{name:'请输入期望的综合营销ROI目标',exact:true}).waitFor({state:'visible',timeoutMs:10000});
  const dom=await tab.playwright.domSnapshot();
  const form=dom.slice(dom.lastIndexOf('- generic: 对指定素材付出额外预算追加投放'));
  if(!form.includes('已添加：1/20') || !form.includes('素材ID: '+spec.material_id) ||
     spec.regions.some(r=>!form.includes(r)) || !form.includes('- generic: 性别\n- generic: 不限')) throw new Error('submitted_task_settings_unknown:'+id);
  if(spec.age_bands?.length) {
    const expected=['18-23','24-30','31-40','41-49','50+'].filter(x=>spec.age_bands.includes(x)).join(', ');
    if(!form.includes('- generic: 年龄\n- generic: '+expected+'\n'))throw new Error('submitted_task_age_unknown:'+id);
  }
  await save('boost.cost_create.confirmed',{status:'write_verified',target_id:id,...prepared,advertising_writes:1,regions:spec.regions,form});
  await tab.playwright.getByRole('button',{name:'取消',exact:true}).click();
  await tab.playwright.domSnapshot();
  await tab.playwright.getByRole('button',{name:'取消',exact:true}).waitFor({state:'hidden',timeoutMs:10000});
  await save('boost.cost_create.editor_closed',{status:'closed',target_id:id});
  return {target_id:id,...prepared,regions:spec.regions,status:'confirmed',advertising_writes:1};
}
