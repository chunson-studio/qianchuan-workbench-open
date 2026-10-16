
function verifyUrl(url,binding,kind){
  const parsed=new URL(url);
  if(kind==='compass'){
    if(parsed.hostname!=='compass.jinritemai.com'||parsed.searchParams.get('live_room_id')!==String(binding.room_id))throw new Error('room_mismatch');
  }else if(parsed.hostname!=='qianchuan.jinritemai.com'||parsed.pathname!=='/overall-prom/detail'||parsed.searchParams.get('aavid')!==String(binding.advertiser_id)||parsed.searchParams.get('adId')!==String(binding.primary_ad_id))throw new Error('plan_mismatch');
}
export async function readBoundLivePage(tab,binding,kind){
  const url=await tab.url();
  verifyUrl(url,binding,kind);
  const raw=await tab.playwright.evaluate(()=>({
    header:document.body.innerText.split('详细数据')[0],
    tables:[...document.querySelectorAll('table')].map(t=>[...t.querySelectorAll('tr')].slice(0,2).map(r=>r.innerText))
  }));
  if(!raw.header.includes(binding.live_name))throw new Error('live_name_mismatch');
  if(kind==='compass'&&!raw.header.includes(binding.live_start_display))throw new Error('start_mismatch');
  if(kind!=='compass'&&!raw.header.includes('计划ID：'+binding.primary_ad_id))throw new Error('rendered_plan_mismatch');
  return {observed_at:new Date().toISOString(),binding,url,raw,advertising_writes:0};
}
export async function readActiveBoostCount(tab,binding){
  const url=await tab.url();
  verifyUrl(url,binding,'plan');
  const dom=await tab.playwright.domSnapshot();
  if(!dom.includes('计划ID：'+binding.primary_ad_id)||!dom.includes(binding.live_name))throw new Error('rendered_binding_mismatch');
  if(!dom.includes('- textbox "请选择": 调控中'))throw new Error('active_filter_not_selected');
  if(dom.includes('加载中'))throw new Error('still_loading');
  const total=dom.match(/row "共(\d+)条任务/);
  if(!total)throw new Error('task_count_unknown');
  return {binding,url,observed_at:new Date().toISOString(),count:Number(total[1]),scope:'current_active_boosts',advertising_writes:0};
}
export async function openCurrentCompassDetail(overview,browser,binding){
  const rows=overview.playwright.getByRole('row').filter({hasText:binding.live_name}).filter({hasText:binding.list_start_display});
  if(await rows.count()!==1)throw new Error('current_scene_row_not_unique');
  await rows.getByText('详情',{exact:true}).click();
  await overview.getAXState({emit:false});
  const tabs=await browser.tabs.list();
  const matches=tabs.filter(t=>{try{const p=new URL(t.url);return p.hostname==='compass.jinritemai.com'&&p.pathname==='/shop/live-detail'&&p.searchParams.get('live_room_id')===String(binding.room_id);}catch{return false;}});
  if(matches.length!==1)throw new Error('detail_tab_not_unique_or_missing');
  return {tab_id:matches[0].id,url:matches[0].url,binding,observed_at:new Date().toISOString(),status:'opened',advertising_writes:0};
}

