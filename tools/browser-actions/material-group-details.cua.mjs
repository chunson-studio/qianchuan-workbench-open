

export async function readMaterialGroupDetails(tab, spec) {
  const u=new URL(await tab.url());
  if(u.hostname!=='qianchuan.jinritemai.com' || u.searchParams.get('aavid')!==spec.advertiser_id || u.searchParams.get('adId')!==spec.primary_ad_id || !/^\d+$/.test(spec.task_id)) throw new Error('plan_or_task_binding_mismatch');
  if(await tab.playwright.getByRole('button',{name:'提交',exact:true}).isVisible()) throw new Error('protected_form_open');
  const row=tab.playwright.getByRole('row').filter({hasText:new RegExp('ID:\\s*'+spec.task_id+'(?:\\D|$)')});
  if(await row.count()!==1) throw new Error('task_row_not_unique');
  const rowText=await row.innerText();
  const expectedMembers=Number(rowText.match(/共\s*(\d+)\s*条视频/)?.[1]);
  if(!expectedMembers) throw new Error('not_a_group_task');
  const headers=await tab.playwright.getByRole('table').first().getByRole('row').first().getByRole('columnheader').allTextContents({});
  const orderIndex=headers.findIndex(h=>h.trim()==='调控成交订单数');
  const cells=await row.getByRole('cell').allTextContents({});
  if(orderIndex<0 || !/^\d+$/.test(cells[orderIndex]?.trim()||'')) throw new Error('task_orders_unknown');

  const report=tab.playwright.locator('div.main-vmok-plugin-modal').filter({hasText:'素材追投数据报告'});
  if(await report.isVisible()) {
    await report.locator('div.main-vmok-plugin-modal__close-icon').click();
    await tab.getAXState({emit:false});
    await report.waitFor({state:'hidden',timeoutMs:10000});
  }
  const button=row.locator('iconpark-icon[name="oc-chart-histogram"]');
  if(await button.count()!==1) throw new Error('report_button_not_unique');
  await button.click();
  await tab.getAXState({emit:false});
  await report.waitFor({state:'visible',timeoutMs:10000});
  const text=await report.innerText();
  if(!new RegExp('ID[：:]\\s*'+spec.task_id+'(?:\\D|$)').test(text)) throw new Error('report_task_id_mismatch');
  const dates=await report.getByRole('textbox',{name:/开始日期|结束日期/}).evaluateAll(es=>es.map(e=>e.value));
  if(dates.length!==2 || dates.some(d=>d!==spec.date)) throw new Error('report_date_mismatch');
  const table=report.getByRole('table');
  if(await table.count()!==1) throw new Error('member_table_not_unique');
  await table.getByRole('row').filter({hasText:/素材ID[：:]\s*\d+/}).first().waitFor({state:'visible',timeoutMs:10000});
  const rows=await table.getByRole('row').allTextContents({});
  const observedMembers=rows.filter(r=>/素材ID[：:]\s*\d+/.test(r)).length;
  return {task_id:spec.task_id,date:spec.date,captured_at:new Date().toISOString(),raw_report:text,raw_rows:rows,expected_members:expectedMembers,observed_members:observedMembers,all_members_present:observedMembers===expectedMembers,advertising_writes:0};
}

export async function readMaterialMembershipFromEditor(tab, spec) {
  const u = new URL(await tab.url());
  if (u.hostname !== 'qianchuan.jinritemai.com' || u.searchParams.get('aavid') !== spec.advertiser_id || u.searchParams.get('adId') !== spec.primary_ad_id || !/^\d+$/.test(spec.task_id)) throw new Error('binding_mismatch');
  if (await tab.playwright.getByRole('button', {name:'提交',exact:true}).count()) throw new Error('protected_form_open');
  const row = tab.playwright.getByRole('row').filter({hasText:'ID: '+spec.task_id});
  if (await row.count() !== 1) throw new Error('task_not_unique');
  const original = await row.innerText();
  await row.locator('iconpark-icon[name="oc-icon-light-edit"]').click();
  await tab.playwright.getByRole('button', {name:'提交',exact:true}).waitFor({state:'visible',timeoutMs:10000});
  const dom = await tab.playwright.domSnapshot();
  const form = dom.slice(dom.lastIndexOf('- generic: 编辑素材追投'));
  const material_ids = [...form.matchAll(/素材ID: (\d+)/g)].map(m=>m[1]);
  const count = Number(form.match(/已添加：(\d+)\/20/)?.[1]);
  await tab.playwright.getByRole('button', {name:'取消',exact:true}).click();
  await tab.playwright.getByRole('button', {name:'提交',exact:true}).waitFor({state:'hidden',timeoutMs:10000});
  if (!count || material_ids.length !== count || new Set(material_ids).size !== count) throw new Error('membership_incomplete');
  return {task_id:spec.task_id,material_ids,original_row:original,advertising_writes:0};
}
