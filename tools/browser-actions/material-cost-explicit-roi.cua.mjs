
export async function setExplicitMaterialRoi(tab, liveTab, spec, save) {
  if (!spec.explicit_user_instruction || !spec.pending_clear || typeof save !== 'function') throw Error('explicit_scope_required');
  const u = new URL(await tab.url()), l = new URL(await liveTab.url());
  if(u.hostname!=='qianchuan.jinritemai.com'||u.searchParams.get('aavid')!==spec.advertiser_id||u.searchParams.get('adId')!==spec.primary_ad_id||!u.searchParams.get('dateRange')?.includes(spec.date)||l.searchParams.get('live_room_id')!==spec.room_id) throw Error('binding_mismatch');
  const live = await liveTab.playwright.domSnapshot();
  if(!live.includes(spec.live_name)||!live.includes(spec.live_start_display)||!live.includes('已开播')) throw Error('live_unknown');
  const input=tab.playwright.getByRole('textbox',{name:'请输入期望的综合营销ROI目标',exact:true});
  if(await input.isVisible()) throw Error('existing_form');
  const row=tab.playwright.getByRole('row').filter({hasText:'ID: '+spec.target_id});
  if(await row.count()!==1) throw Error('target_not_unique');
  const before=await row.getByRole('cell').allTextContents({timeoutMs:10000});
  if(!before[2]?.includes(spec.material_id)||!before[3]?.includes('调控中')||!before[9]?.includes('控成本追投')||Number(before[5])!==spec.expected_roi||!(spec.new_roi>0)) throw Error('object_changed');
  await save('before',{target_id:spec.target_id,cells:before,instruction:spec.explicit_user_instruction});
  await row.locator('iconpark-icon[name="oc-icon-light-edit"]').click();
  await input.waitFor({state:'visible',timeoutMs:10000});
  await tab.playwright.getByText('上海市、江苏省、浙江省',{exact:true}).waitFor({state:'visible',timeoutMs:10000});
  const dom=await tab.playwright.domSnapshot();
  const form=dom.slice(dom.lastIndexOf('- generic: 编辑素材追投'));
  if(!form.includes('素材ID: '+spec.material_id)||!form.includes('已添加：1/20')||Number(await input.evaluate(e=>e.value))!==spec.expected_roi) throw Error('editor_mismatch');
  const values=await tab.playwright.getByRole('textbox').evaluateAll(es=>es.filter(e=>e.getClientRects().length).map(e=>({placeholder:e.getAttribute('placeholder'),value:e.value})));
  await save('editor_verified',{target_id:spec.target_id,form,values});
  await input.fill(String(spec.new_roi)); await input.press('Tab');
  if(Number(await input.evaluate(e=>e.value))!==spec.new_roi) throw Error('fill_mismatch');
  await save('submit_intent',{target_id:spec.target_id,before:spec.expected_roi,after:spec.new_roi,dom:(await tab.playwright.domSnapshot()).slice(-2600)});
  await tab.playwright.getByRole('button',{name:'提交',exact:true}).filter({visible:true}).click();
  await save('submitted',{target_id:spec.target_id,status:'submitted_unverified',dom:(await tab.playwright.domSnapshot()).slice(-1000)});
  await input.waitFor({state:'hidden',timeoutMs:15000});
  await row.getByRole('cell').nth(5).getByText(spec.new_roi.toFixed(2),{exact:true}).waitFor({state:'visible',timeoutMs:10000});
  const after=await row.getByRole('cell').allTextContents({timeoutMs:10000});
  if(Number(after[5])!==spec.new_roi||after[4]!==before[4]||after[8]!==before[8]||after[2]!==before[2]) throw Error('write_unknown');
  const result={target_id:spec.target_id,before_roi:spec.expected_roi,after_roi:spec.new_roi,status:'write_verified',confirmed_at:new Date().toISOString(),cells:after};
  await save('confirmed',result);return result;
}
