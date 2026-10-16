
export async function addMaterialMetricColumns(tab,labels=['调控综合成本','调控综合营销ROI']) {
  await tab.playwright.locator('button').filter({has:tab.playwright.locator('iconpark-icon[name="oc-icon-metrics"]')}).click();
  const dom=await tab.playwright.domSnapshot();
  if(!dom.includes('- generic: 自定义列'))throw Error('column_menu_missing');
  for(const label of labels) {
    await tab.playwright.getByRole('checkbox',{name:label,exact:true}).check();
    const current=await tab.playwright.domSnapshot();
    if(!current.includes(`checkbox "${label}" [checked]`))throw Error('column_not_checked:'+label);
  }
  await tab.playwright.getByRole('button',{name:'确定',exact:true}).click();
  await tab.getAXState({emit:false});
  const headers=await tab.playwright.getByRole('columnheader').allTextContents({});
  for(const label of labels)if(!headers.includes(label))throw Error('column_save_unconfirmed:'+label);
  return {verified_columns:labels,ad_writes:0};
}
