// Whitelist the reader result before it is printed into the model context.
export function filterCompassTop(snapshot) {
  const binding=snapshot?.binding??{},issues=[];
  const scene={room_id:binding.room_id??null,live_start_display:binding.live_start_display??null};
  const at=typeof snapshot?.captured_at==='string'&&Number.isFinite(Date.parse(snapshot.captured_at))?snapshot.captured_at:null;
  const sourceVerified=snapshot?.financial_basis==='compass_gmv_minus_refund_over_shop_bound_cost'
    &&snapshot?.cost_label==='投放消耗(店铺绑定)';
  const inputIssues=Array.isArray(snapshot?.issues)?snapshot.issues:null;
  if(!sourceVerified)issues.push('financial_source_unverified');
  if(!scene.room_id||!scene.live_start_display)issues.push('scene_binding_missing');
  if(!at)issues.push('capture_time_missing');
  if(!inputIssues||!['read_verified','read_unverified'].includes(snapshot?.status))issues.push('reader_result_unverified');
  // The diagnostic-only abnormal-sales card is not an input to this formula.
  for(const issue of inputIssues??[])if(typeof issue!=='string')issues.push('reader_issue_unknown');
    else if(!issue.startsWith('直播间成交金额（含异常交易）:'))issues.push(issue);
  const fields={gmv:'直播间成交金额',refund:'退款金额',cost:'投放消耗(店铺绑定)',online:'实时在线人数'};
  const fatal=issues.some(code=>!Object.values(fields).some(label=>code.startsWith(label+':')));
  const metrics={};
  for(const [field,label] of Object.entries(fields)) {
    const cards=(Array.isArray(snapshot?.cards)?snapshot.cards:[]).filter(card=>card?.label===label);
    const value=cards.length===1&&!cards[0].issue?cards[0].value:null;
    metrics[field]=!fatal&&Number.isFinite(value)&&value>=0&&(field!=='online'||Number.isInteger(value))?value:null;
  }
  metrics.net_roi=metrics.gmv!==null&&metrics.refund!==null&&metrics.cost>0?(metrics.gmv-metrics.refund)/metrics.cost:null;
  const missing=Object.keys(metrics).filter(key=>metrics[key]===null);
  if(metrics.cost===0)issues.push('zero_cost_roi_unknown');
  return {scene,at,source:'compass',cost_basis:'shop_bound',metrics,
    quality:{verified:issues.length===0&&missing.length===0,missing,issues:[...new Set(issues)]}};
}

export async function readCompassTopBrief(input) {
  return filterCompassTop(await readCompassTop(input));
}

// Read only: the bound, already-open Compass professional board. No navigation.
export async function readCompassTop({tab,binding}) {
  if(!tab?.playwright||!binding?.room_id||!binding.live_name||!binding.live_start_display)throw Error('bound_compass_scene_required');
  const started=Date.now(),url=await tab.url(),parsed=new URL(url);
  if(parsed.hostname!=='compass.jinritemai.com'||parsed.protocol!=='https:'
    ||!['/screen/live/shop','/screen/live/talent'].includes(parsed.pathname)
    ||parsed.searchParams.get('live_room_id')!==binding.room_id)throw Error('compass_scene_url_mismatch');
  const snapshot=await tab.playwright.evaluate(expected=>{
    const issues=[],labels=['直播间成交金额','直播间成交金额（含异常交易）','投放消耗(店铺绑定)','退款金额','实时在线人数'];
    const header=document.body.innerText.slice(0,1000).replace(/\s+/g,'');
    if(!header.includes(expected.live_name.replace(/\s+/g,''))
      ||!header.includes('开播时间'+expected.live_start_display.replaceAll('-','/').replace(/\s+/g,'')))issues.push('compass_scene_header_mismatch');
    const cards=labels.map(label=>{
      const matches=Array.from(document.querySelectorAll('span')).filter(e=>e.textContent.trim()===label&&e.getClientRects().length);
      if(matches.length!==1)return {label,value:null,issue:'label_not_unique'};
      const main=label==='直播间成交金额',card=matches[0].closest(main?'.gmv--FSUoo':'.main--EILLq');
      let raw=null;
      if(main) {
        const inside=card?.querySelector('.odometer-inside'),tokens=[];
        if(inside)for(const part of inside.children) {
          if(part.classList.contains('odometer-formatting-mark'))tokens.push(part.textContent.trim());
          else if(part.classList.contains('odometer-digit')) {
            const digits=part.querySelectorAll('.odometer-value');
            // Animation can expose multiple ribbon values. Do not guess one.
            if(digits.length!==1){tokens.length=0;break;}
            tokens.push(digits[0].textContent.trim());
          } else {tokens.length=0;break;}
        }
        if(tokens.length)raw=tokens.join('');
      } else raw=card?.querySelector('.value--d9uln')?.innerText.replace(/\s+/g,'')??null;
      const valid=typeof raw==='string'&&/^[¥￥]?\d+(?:,\d{3})*(?:\.\d+)?$/.test(raw);
      const value=valid?Number(raw.replace(/[¥￥,]/g,'')):(label==='退款金额'&&raw==='-'?0:null);
      return {label,raw,value,issue:value===null?'value_unknown':null};
    });
    for(const card of cards)if(card.issue)issues.push(card.label+':'+card.issue);
    return {captured_at:new Date().toISOString(),cards,issues};
  },{live_name:binding.live_name,live_start_display:binding.live_start_display});
  if(await tab.url()!==url)snapshot.issues.push('compass_url_changed');
  const get=label=>snapshot.cards.find(card=>card.label===label)?.value??null;
  const gmv=get('直播间成交金额'),refund=get('退款金额'),cost=get('投放消耗(店铺绑定)');
  const verified=snapshot.issues.length===0;
  return {...snapshot,url,binding:{...binding},status:verified?'read_verified':'read_unverified',
    gmv,refund,cost,online:get('实时在线人数'),gmv_including_abnormal:get('直播间成交金额（含异常交易）'),
    net_roi:verified&&cost>0?(gmv-refund)/cost:null,cost_label:'投放消耗(店铺绑定)',
    financial_basis:'compass_gmv_minus_refund_over_shop_bound_cost',elapsed_ms:Date.now()-started,advertising_writes:0};
}
