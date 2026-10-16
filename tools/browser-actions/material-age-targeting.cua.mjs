
const ageLabels=['18-23','24-30','31-40','41-49','50+'];
const ageGroup='div[data-e2e="oc_emptyKey_overall-prom/detail__createAudienceAge_checkbox_group"]';
const exact=(tab,label)=>tab.playwright.getByText(label,{exact:true});
const button=(tab,label)=>tab.playwright.getByRole('button',{name:label,exact:true});
const input=(tab,label)=>tab.playwright.getByRole('textbox',{name:label,exact:true});
async function readForm(tab) {
  const dom=await tab.playwright.domSnapshot();
  const marker='- generic: 对指定素材付出额外预算追加投放';
  const start=dom.lastIndexOf(marker);
  if(start<0)throw Error('material_form_missing');
  const form=dom.slice(start);
  return {form,name:await input(tab,'请输入任务名称，1-50个字符').evaluate(e=>e.value),
    budget:Number(await input(tab,'请输入').evaluate(e=>e.value)),
    roi:Number(await input(tab,'请输入期望的综合营销ROI目标').evaluate(e=>e.value)),
    region:form.match(/- generic: 地域\n- generic: ([^\n]+)/)?.[1],
    region_type:form.match(/- generic: 用户地域类型\n- generic: ([^\n]+)/)?.[1],
    ages:form.match(/- generic: 年龄\n- generic: ([^\n]+)/)?.[1]};
}
function sameSettings(before,after) {
  if(before.name!==after.name||before.budget!==after.budget||before.roi!==after.roi||
     before.region!==after.region||before.region_type!==after.region_type)throw Error('unrequested_parameter_change');
}
export async function setMaterialAgeBands(tab,{age_bands,regions,region_type='正在该地区的用户'}) {
  if(!Array.isArray(age_bands)||!age_bands.length||new Set(age_bands).size!==age_bands.length||age_bands.some(x=>!ageLabels.includes(x)))throw Error('invalid_age_bands');
  const before=await readForm(tab);
  if(before.region!==regions.join('、')||before.region_type!==region_type)throw Error('region_binding_mismatch');
  await exact(tab,'修改定向').click();await tab.playwright.domSnapshot();
  const group=tab.playwright.locator(ageGroup);
  if(await group.count()!==1)throw Error('age_group_not_unique');
  
  for(const [i,label] of ['不限',...ageLabels].entries()) {
    const item=group.locator('[data-e2e$="component_'+i+'"]');
    if(await item.count()!==1 || (await item.innerText()).trim()!==label)throw Error('age_item_binding_mismatch');
    const selected=(await item.getAttribute('class')||'').includes('--checked');
    const wanted=age_bands.includes(label);
    if(selected!==wanted)await item.click();
  }
  const checked=await group.evaluate(e=>Array.from(e.children).filter(x=>x.className.includes('--checked')).map(x=>x.innerText.trim()));
  if(checked.length!==age_bands.length||checked.some(x=>!age_bands.includes(x)))throw Error('age_selection_mismatch');
  await button(tab,'确定').click();await tab.playwright.domSnapshot();
  const after=await readForm(tab);sameSettings(before,after);
  const expected=ageLabels.filter(x=>age_bands.includes(x)).join(', ');
  if(after.ages!==expected)throw Error('age_form_readback_mismatch');
  return {age_bands,regions,budget:after.budget,roi_goal:after.roi,advertising_writes:0};
}
export async function editMaterialTaskAgeBands(tab,spec,save) {
  if(typeof save!=='function')throw Error('checkpoint_callback_required');
  const u=new URL(await tab.url());
  if(u.hostname!=='qianchuan.jinritemai.com'||u.searchParams.get('aavid')!==spec.advertiser_id||u.searchParams.get('adId')!==spec.primary_ad_id)throw Error('plan_binding_mismatch');
  const row=tab.playwright.getByRole('row').filter({hasText:spec.task_id});
  if(await row.count()!==1)throw Error('task_row_not_unique');
  const cells=await row.getByRole('cell').allTextContents({});
  if(cells[1]?.match(/ID:\s*(\d+)/)?.[1]!==spec.task_id||!cells[2]?.includes(spec.material_id)||!cells[3]?.includes('调控中'))throw Error('task_binding_mismatch');
  if(await button(tab,'提交').count())throw Error('existing_form_must_be_preserved');
  await row.locator('iconpark-icon[name="oc-icon-light-edit"]').click();await tab.playwright.domSnapshot();
  const before=await readForm(tab);
  if(before.name!==spec.task_name||!before.form.includes('素材ID: '+spec.material_id)||!before.form.includes('已添加：1/20'))throw Error('form_identity_mismatch');
  const expected=ageLabels.filter(x=>spec.age_bands.includes(x)).join(', ');
  if(before.ages===expected) {
    await button(tab,'取消').click();await tab.playwright.domSnapshot();
    return {task_id:spec.task_id,status:'already_set',age_bands:spec.age_bands,advertising_writes:0};
  }
  await setMaterialAgeBands(tab,spec);
  await save('age.submit.intent',{task_id:spec.task_id,task_name:spec.task_name,age_bands:spec.age_bands,budget:before.budget,roi_goal:before.roi});
  await button(tab,'提交').click();
  try {await button(tab,'提交').waitFor({state:'hidden',timeoutMs:15000});} catch {}
  await tab.playwright.domSnapshot();
  if(await button(tab,'提交').isVisible())throw Error('age_submit_unconfirmed_do_not_repeat');
  const savedRow=tab.playwright.getByRole('row').filter({hasText:spec.task_id});
  if(await savedRow.count()!==1)throw Error('saved_task_row_not_unique');
  await savedRow.locator('iconpark-icon[name="oc-icon-light-edit"]').click();await tab.playwright.domSnapshot();
  let after;
  try {after=await readForm(tab);} catch(error) {
    if(error.message!=='material_form_missing'||await button(tab,'提交').count())throw error;
    
    await tab.playwright.getByRole('row').filter({hasText:spec.task_id}).locator('iconpark-icon[name="oc-icon-light-edit"]').click();await tab.playwright.domSnapshot();
    after=await readForm(tab);
  }
  sameSettings(before,after);
  if(after.ages!==expected||!after.form.includes('素材ID: '+spec.material_id))throw Error('saved_age_readback_mismatch');
  const result={task_id:spec.task_id,age_bands:spec.age_bands,regions:spec.regions,budget:after.budget,roi_goal:after.roi,status:'write_verified',advertising_writes:1};
  await save('age.confirmed',result);
  await button(tab,'取消').click();await tab.playwright.domSnapshot();
  return result;
}
