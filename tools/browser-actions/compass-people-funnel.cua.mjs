
export async function readCompassPeopleFunnel(tab,binding){
  const url=await tab.url(),parsed=new URL(url);
  if(parsed.hostname!=='compass.jinritemai.com'||parsed.pathname!=='/shop/live-detail'||parsed.searchParams.get('live_room_id')!==String(binding.room_id))throw new Error('funnel_room_mismatch');
  const dom=await tab.playwright.domSnapshot();
  if(!dom.includes(binding.live_name)||!dom.includes(binding.live_start_display))throw new Error('funnel_header_mismatch');
  const section=dom.split('- generic: 成交转化漏斗\n')[1]?.split('- generic: 互动转化漏斗')[0];
  if(!section)throw new Error('funnel_section_missing');
  const tokens=[...section.matchAll(/^- generic: (.+)$/gm)].map(m=>m[1].replace(/^"|"$/g,''));
  const prior=label=>{const i=tokens.indexOf(label);return i>0?tokens[i-1]:null;};
  const count=label=>{const v=prior(label);return v&&/^\d[\d,]*$/.test(v)?Number(v.replaceAll(',','')):null;};
  const rate=label=>{const v=prior(label);return v&&/^\d+(?:\.\d+)?%$/.test(v)?v:null;};
  return {binding,url,observed_at:new Date().toISOString(),window:'current_session_cumulative',source_time:'page_not_explicitly_displayed',source:'compass_live_detail_people_funnel',counts:{shows:count('直播间曝光人数'),views:count('直播间观看人数'),product_shows:count('商品曝光人数'),product_clicks:count('商品点击人数'),pay_people:count('成交人数')},rates:{enter:rate('曝光-观看率(人数)'),product_show:rate('观看-商品曝光率(人数)'),product_click:rate('商品曝光-点击率(人数)'),click_pay:rate('商品点击-成交转化率(人数)')},raw_section:section,advertising_writes:0};
}
