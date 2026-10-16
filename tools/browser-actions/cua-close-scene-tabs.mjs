import fs from 'node:fs/promises';

export async function closeVerifiedSceneTabs({cua,browserId,tabs,outputRoot}) {
  const before=await cua.listTabs({browser:browserId,emit:false});
  await fs.writeFile(outputRoot+'/close-tabs-before.json',JSON.stringify(before,null,2));
  const receipts=[];
  for(const tab of tabs) {
    if(!before.some(t=>t.id===tab.id))throw Error('verified_tab_missing');
    await tab.close();
    const after=await cua.listTabs({browser:browserId,emit:false});
    const receipt={at:new Date().toISOString(),tab_id:tab.id,status:after.some(t=>t.id===tab.id)?'unconfirmed':'write_verified',readback:after};
    await fs.writeFile(outputRoot+`/close-tab-${tab.id}.json`,JSON.stringify(receipt,null,2));
    receipts.push(receipt);
    if(receipt.status!=='write_verified')throw Error('tab_close_unconfirmed');
  }
  return receipts;
}
