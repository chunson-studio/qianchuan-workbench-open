
export async function editMaterialRoiGoal(tab, spec, save) {
  if (typeof save !== 'function') throw Error('checkpoint_callback_required');
  const url = new URL(await tab.url());
  if (url.hostname !== 'qianchuan.jinritemai.com' ||
      url.searchParams.get('aavid') !== spec.advertiser_id ||
      url.searchParams.get('adId') !== spec.primary_ad_id) throw Error('plan_binding_mismatch');
  if (!(Number.isFinite(spec.from_roi_goal) && Number.isFinite(spec.to_roi_goal)) ||
      spec.to_roi_goal <= spec.from_roi_goal ||
      spec.to_roi_goal > spec.max_roi_goal ||
      spec.to_roi_goal > spec.from_roi_goal * (1 + spec.max_step_ratio)) throw Error('roi_change_out_of_bounds');
  const row = tab.playwright.getByRole('row').filter({hasText: `ID: ${spec.task_id}`});
  if (await row.count() !== 1) throw Error('task_row_not_unique');
  const cells = await row.getByRole('cell').allTextContents({});
  if (cells[1]?.match(/ID:\s*(\d+)/)?.[1] !== spec.task_id ||
      !(spec.material_ids ? cells[2]?.includes('共'+spec.material_ids.length+'条视频') : cells[2]?.includes(spec.material_id)) ||
      !cells[3]?.includes('调控中') ||
      !cells[9]?.includes('控成本追投') ||
      Number(cells[5]) !== spec.from_roi_goal) throw Error('task_binding_mismatch');
  if (await tab.playwright.getByRole('button',{name:'提交',exact:true}).count()) throw Error('existing_form_must_be_preserved');
  await row.locator('iconpark-icon[name="oc-icon-light-edit"]').click();
  await tab.playwright.getByText('已选定向信息',{exact:true}).waitFor({state:'visible',timeoutMs:8000});
  const form = await tab.playwright.domSnapshot();
  const tail = form.slice(form.lastIndexOf('- generic: 编辑素材追投'));
  if (!(spec.material_ids || [spec.material_id]).every(id=>tail.includes(`素材ID: ${id}`)) ||
      !tail.includes(spec.regions.join('、')) ||
      !tail.includes(spec.region_type) ||
      !tail.includes(spec.age_bands.join(', '))) throw Error('form_targeting_mismatch');
  const budget = Number(await tab.playwright.getByRole('textbox',{name:'请输入',exact:true}).evaluate(e=>e.value));
  const goalBox = tab.playwright.getByRole('textbox',{name:'请输入期望的综合营销ROI目标'});
  if (budget !== spec.daily_budget_yuan || Number(await goalBox.evaluate(e=>e.value)) !== spec.from_roi_goal ||
      !tail.includes(spec.task_name)) throw Error('form_parameter_mismatch');
  await goalBox.fill(String(spec.to_roi_goal));
  await goalBox.press('Tab');
  const ready = await tab.playwright.domSnapshot();
  if (!ready.includes(`textbox "请输入期望的综合营销ROI目标": "${spec.to_roi_goal.toFixed(2)}"`)) throw Error('form_roi_readback_mismatch');
  await save('roi.submit.intent',{task_id:spec.task_id,from:spec.from_roi_goal,to:spec.to_roi_goal});
  await tab.playwright.getByRole('button',{name:'提交',exact:true}).click();
  const updated = tab.playwright.getByRole('row').filter({hasText:`ID: ${spec.task_id}`});
  const after = await updated.getByRole('cell').allTextContents({});
  if (after[1]?.match(/ID:\s*(\d+)/)?.[1] !== spec.task_id || Number(after[5]) !== spec.to_roi_goal ||
      Number(after[4]) !== budget || !(spec.material_ids ? after[2]?.includes('共'+spec.material_ids.length+'条视频') : after[2]?.includes(spec.material_id))) throw Error('roi_submit_unconfirmed_check_original_id_only');
  const result = {task_id:spec.task_id,roi_goal:spec.to_roi_goal,budget,status:'write_verified'};
  await save('roi.confirmed',result);
  return result;
}
