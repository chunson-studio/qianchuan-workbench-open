
export async function setControlPageSize(tab,{advertiser_id,primary_ad_id,size=100}){
  const u=new URL(await tab.url());
  if(u.hostname!=='qianchuan.jinritemai.com'||u.searchParams.get('aavid')!==String(advertiser_id)||u.searchParams.get('adId')!==String(primary_ad_id))throw Error('page_binding_mismatch');
  if(![10,20,50,100].includes(size))throw Error('unsupported_page_size');
  const input=tab.playwright.getByRole('textbox').last();
  const value=await input.evaluate(e=>e.value);
  if(!/^(10|20|50|100)条\/页$/.test(value))throw Error('page_size_control_unverified');
  if(value!==size+'条/页'){
    await input.click();await tab.playwright.domSnapshot();
    await tab.playwright.getByText(size+'条/页',{exact:true}).click();
  }
  const dom=await tab.playwright.domSnapshot();
  if(!dom.includes('- textbox: '+size+'条/页'))throw Error('page_size_readback_failed');
  return {size,binding:{advertiser_id,primary_ad_id},observed_at:new Date().toISOString(),advertising_writes:0,dom};
}
