
export async function verifyMaterialGroupTasks(tab,spec){
 const u=new URL(await tab.url());if(u.searchParams.get('aavid')!==spec.advertiser_id||u.searchParams.get('adId')!==spec.primary_ad_id)throw Error('plan_binding_mismatch');
 if(await tab.playwright.getByRole('button',{name:'提交',exact:true}).count())throw Error('existing_form_protected');
 const results=[];
 for(const id of spec.task_ids){
 const row=tab.playwright.getByRole('row').filter({hasText:id});if(await row.count()!==1)throw Error('task_not_unique:'+id);
 await row.locator('iconpark-icon[name="oc-icon-light-edit"]').click();
 await tab.playwright.getByText('已选定向信息',{exact:true}).waitFor({state:'visible',timeoutMs:8000});
 const d=await tab.playwright.domSnapshot();const f=d.slice(d.lastIndexOf('- generic: 对指定素材付出额外预算追加投放'));
 const ids=[...f.matchAll(/素材ID: (\d+)/g)].map(m=>m[1]).sort();
 const budget=Number(await tab.playwright.getByRole('textbox',{name:'请输入',exact:true}).evaluate(e=>e.value));
 const roi=Number(await tab.playwright.getByRole('textbox',{name:'请输入期望的综合营销ROI目标',exact:true}).evaluate(e=>e.value));
 if(JSON.stringify(ids)!==JSON.stringify([...spec.material_ids].sort())||budget!==spec.daily_budget_yuan||roi!==spec.roi_goal||!f.includes(spec.regions.join('、'))||!f.includes(spec.region_type)||!f.includes(spec.age_bands.join(', ')))throw Error('group_readback_mismatch:'+id);
 results.push({task_id:id,status:'write_verified',material_ids:ids,budget,roi_goal:roi,regions:spec.regions,age_bands:spec.age_bands});
 await tab.playwright.getByRole('button',{name:'取消',exact:true}).click();await tab.playwright.domSnapshot();
 }return results;
}
