
export async function selectBrandHeatingAccount(tab,douyinId,save){
  if(typeof save!=='function')throw Error('checkpoint_required');
  const row=tab.playwright.locator('div.oc-group-row').filter({hasText:'ID:'+douyinId});
  if(await row.count()!==1)throw Error('account_dropdown_must_be_open_and_unique');
  await row.click(); await tab.getAXState({emit:false});
  await save('brand.account_selected',{status:'opened',douyin_id:douyinId,dom:await tab.playwright.domSnapshot()});
  if(await tab.playwright.getByRole('button',{name:'确认',exact:true}).isVisible()){
    await tab.playwright.getByRole('button',{name:'确认',exact:true}).click();
    await tab.getAXState({emit:false});
  }
  return {douyin_id:douyinId,published:false,dom:await tab.playwright.domSnapshot()};
}
export async function setBrandDraftRegions(tab,regions,save){
  if(typeof save!=='function')throw Error('checkpoint_required');
  
  const items=await tab.playwright.locator('li.ovui-cascader-panel__selection-item').evaluateAll(els=>els.map(e=>({id:e.getAttribute('data-id'),name:e.textContent.trim()})));
  const ids={};
  for(const name of regions){const match=items.filter(i=>i.name===name);if(match.length!==1 || !/^\d+$/.test(match[0].id))throw Error('region_not_unique');ids[name]=match[0].id;}
  for(const name of regions){
    const item=tab.playwright.locator('li.ovui-cascader-panel__selection-item[data-id="'+ids[name]+'"]');
    await item.getByRole('checkbox').check();await tab.getAXState({emit:false});
    await save('brand.region_selected',{status:'read_verified',region:name,published:false,dom:await tab.playwright.domSnapshot()});
  }
  return {regions,published:false};
}
