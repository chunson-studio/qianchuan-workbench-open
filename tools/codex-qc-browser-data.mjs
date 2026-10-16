// Pure DOM-data reduction. No browser, network, advertising decisions or writes.
import { cleanTaskPool, buildDecisionBrief } from './codex-qc-decision-brief.mjs';
import { reconcileFeedback } from './codex-qc-feedback.mjs';

export const READER_VERSION = '20261006-2';
const unquote = s => { try { return s.startsWith('"') ? JSON.parse(s) : s; } catch { return s; } };
const values = dom => String(dom).split('\n').map(s => s.match(/^\s*- (?:generic|paragraph|text): (.*)$/)?.[1])
  .filter(s => s !== undefined).map(unquote);
const numeric = s => {
  const m = String(s ?? '').trim().match(/^[¥￥]?(-?\d+(?:,\d{3})*(?:\.\d+)?)(?:\s+(?:[+-]?\d+(?:\.\d+)?%|--))?$/);
  return m ? Number(m[1].replaceAll(',', '')) : null;
};
const one = (items, label, skip = []) => {
  const indexes = items.flatMap((v, i) => v === label ? [i] : []);
  if (indexes.length !== 1) return null;
  let i = indexes[0] + 1;
  while (skip.includes(items[i])) i++;
  // Never join animated odometer digits or interpret the following card as a value.
  if (numeric(items[i + 1]) !== null) return null;
  return numeric(items[i]);
};
export const bindingMatches = (a, b) => ['advertiser_id','primary_ad_id','room_id','date','session_started_at']
  .every(k => a?.[k] != null && a[k] === b?.[k]);

// Accessibility may prepend an observed ordinal to a tab's actual title.
// Keep the full name for exact locating; never match arbitrary suffix text.
export function planTabs(dom) {
  return [...String(dom).matchAll(/^\s*- tab "([^"]+)"([^\n]*)/gm)].map(([,accessible_name,flags])=>{
    const prefix=accessible_name.match(/^Tab ([1-9]\d*) of ([1-9]\d*) (.+)$/);
    const name=prefix&&Number(prefix[1])<=Number(prefix[2])?prefix[3]:accessible_name;
    return {name,accessible_name,selected:flags.includes('[selected]')};
  });
}

export const selectedTaskCount=dom=>{
  const counts=[...String(dom).matchAll(/^\s*- (?:generic|text): 已选(?:择|中)?\s*(\d+)\s*(?:条(?:\s*任务)?|个\s*任务)\s*$/gm)].map(m=>Number(m[1]));
  return counts.length===1?counts[0]:null;
};
export function planIdentity(dom,binding,{account_dom}={}) {
  const header=String(dom).split(/^\s*- table[\s:]/m)[0];
  const advertisers=[...new Set([...header.matchAll(/^\s*- (?:generic(?: "[^"]*")?|text|paragraph): "?ID[：:]\s*(\d+)"?\s*$/gm)].map(m=>m[1]))];
  // Responsive layouts hide the observed account header from accessibility.
  // Preserve its separately captured DOM evidence, never synthesize AX text.
  if(account_dom?.selector==='.account-info-box'&&account_dom.display==='none'&&typeof account_dom.text==='string') {
    const matches=[...account_dom.text.matchAll(/(?:^|\s)ID[：:]\s*(\d+)(?=\s|$)/g)];
    if(matches.length===1&&!advertisers.includes(matches[0][1]))advertisers.push(matches[0][1]);
  }
  const plans=[...new Set([...header.matchAll(/^\s*- (?:generic|text|paragraph): "?计划ID[：:]\s*(\d+)"?\s*$/gm)].map(m=>m[1]))];
  return {advertisers,plans,missing_account:advertisers.length===0,missing_plan:plans.length===0,
    conflict:advertisers.some(id=>id!==binding.advertiser_id)||plans.some(id=>id!==binding.primary_ad_id),
    verified:advertisers.length===1&&advertisers[0]===binding.advertiser_id&&plans.length===1&&plans[0]===binding.primary_ad_id};
}

const productLayouts = {
  multiplication: { target:'综合营销ROI目标', metric_basis:'platform_综合成本_综合营销ROI', path:'/overall-prom/detail' },
  full_domain: { target:'净成交ROI目标', metric_basis:'platform_整体消耗_净成交ROI', path:'/uni-prom/detail' },
};
export function parsePlanProductBasis(snapshot, binding) {
  const dom=String(snapshot?.dom??''),issues=[];
  const identity=planIdentity(dom,binding,{account_dom:snapshot?.account_dom});
  // Navigation precedes the plan ID. Only the main card after that ID and
  // before plan tabs/content/table can identify a product, never column labels.
  const header=dom.split(/^\s*- (?:table|rowgroup|row|columnheader)(?:\s|:|$)/m)[0];
  const lines=header.split('\n');
  const planLines=lines.flatMap((line,index)=>/^\s*- (?:generic|text|paragraph): "?计划ID[：:]\s*\d+"?\s*$/.test(line)?[index]:[]);
  const card=planLines.length===1?lines.slice(planLines[0]+1):[];
  const boundary=card.findIndex(line=>/^\s*- (?:tab(?:list)?(?:\s|:|$)|heading\s)/.test(line)
    || /^\s*- (?:generic|text|paragraph): "?(?:数据|效果诊断|素材|调控|详情|日志|保障历史|重点数据概览|数据概览)"?\s*$/.test(line));
  const fields=values((boundary<0?card:card.slice(0,boundary)).join('\n')).filter(value=>typeof value==='string')
    .map(value=>value.replace(/[：:]$/,'')).filter(value=>Object.values(productLayouts).some(layout=>layout.target===value));
  if(fields.length&&!identity.verified)issues.push('plan_product_identity_unverified');
  if(fields.length>1)issues.push('plan_product_card_ambiguous');
  const type=identity.verified&&fields.length===1?Object.keys(productLayouts).find(type=>productLayouts[type].target===fields[0]):null;
  let urlPath=null;
  if(snapshot?.url!=null) {
    try {
      const url=new URL(snapshot.url);urlPath=url.pathname;
      if(url.protocol!=='https:'||url.hostname!=='qianchuan.jinritemai.com'||url.username||url.password
        ||!Object.values(productLayouts).some(layout=>layout.path===url.pathname)
        ||url.searchParams.get('aavid')!==binding.advertiser_id||url.searchParams.get('adId')!==binding.primary_ad_id)issues.push('plan_product_url_unverified');
      else if(type&&url.pathname!==productLayouts[type].path)issues.push('plan_product_url_conflict');
    } catch {issues.push('plan_product_url_unverified');}
  }
  return {type,roi_target_field:type?productLayouts[type].target:null,
    expected_metric_basis:type?productLayouts[type].metric_basis:null,url_path:urlPath,
    identity_verified:identity.verified,issues};
}

function crossCheckProductBasis(capture, board, financialIssues) {
  const samples=[...(capture.active??[]).map((snapshot,i)=>({snapshot,source:'active',page:i+1})),
    ...(capture.paused??[]).map((snapshot,i)=>({snapshot,source:'paused',page:i+1})),
    ...(capture.financial_source==='plan_data'?[{snapshot:capture.financial,source:'financial_plan',page:null}]:[])];
  const observations=samples.map(({snapshot,source,page})=>({source,page,...parsePlanProductBasis(snapshot,capture.binding)}));
  const issues=observations.flatMap(item=>item.issues.map(code=>({code,source:item.source,page:item.page})));
  const types=[...new Set(observations.map(item=>item.type).filter(Boolean))];
  if(types.length>1)issues.push({code:'plan_product_cross_page_conflict',types});
  const type=types.length===1?types[0]:null,expected=type?productLayouts[type].metric_basis:null;
  const sessionFormula=board.source_id==='compass_top'&&board.metric_basis==='compass_gmv_minus_refund_over_shop_bound_cost';
  if(!sessionFormula&&expected&&board.metric_basis&&expected!==board.metric_basis)issues.push({code:'product_financial_basis_conflict',
    product_type:type,expected_metric_basis:expected,actual_metric_basis:board.metric_basis});
  const financialVerified=financialIssues.length===0&&(sessionFormula||Object.values(productLayouts).some(layout=>layout.metric_basis===board.metric_basis));
  return {issues,metadata:{type,source:type?'plan_main_card_roi_target':null,expected_metric_basis:expected,
    financial_metric_basis:board.metric_basis,status:issues.length?'conflict':type&&financialVerified?'matched'
      :type?'financial_unverified':financialVerified?'financial_only':'unknown',observations}};
}

export function inspectPlanDom(dom, binding, {allow_selection = false, search = null, selection_context = null,account_dom} = {}) {
  const dates = [...dom.matchAll(/- textbox "(?:请选择)?(?:开始|结束)日期": ([^\n]+)/g)].map(m => unquote(m[1].trim()));
  const visibleFilters = [...dom.matchAll(/- textbox "请选择"(?:: ([^\n]+))?/g)].map(m => unquote(m[1]?.trim() ?? ''));
  const selectedCount=selectedTaskCount(dom);
  const inherited=allow_selection&&visibleFilters.length===0&&selectedCount>0&&selectedCount<=selection_context?.ids?.length
    &&selection_context?.filters?.length===3;
  const filters=inherited?[...selection_context.filters]:visibleFilters;
  const counts = [...dom.matchAll(/共\s*(\d+)\s*条(?:记录|任务)/g)].map(m => Number(m[1]));
  const issues = [];
  if (!planIdentity(dom,binding,{account_dom}).verified) issues.push('plan_identity_mismatch');
  if (dates.length !== 2 || dates.some(d => d !== binding.date)) issues.push('plan_date_mismatch');
  if (/加载中|正在加载|加载失败|请求失败|Loading/i.test(dom)) issues.push('page_loading_or_failed');
  if (!allow_selection && (/- checkbox[^\n]*\[checked\]/.test(dom)||selectedCount>0||/- button "确定"/.test(dom)) || /- button "提交"/.test(dom)) issues.push('human_draft_or_selection');
  const actualSearch = dom.match(/- textbox "输入任务名称或ID搜索": ([^\n]+)/)?.[1] ?? '';
  if (actualSearch && unquote(actualSearch) !== search) issues.push('task_search_not_empty');
  const headers = [];
  let started = false;
  for (const line of dom.split('\n')) {
    if (/\s*- columnheader(?: |:|$)/.test(line)) {
      started = true;
      headers.push(line.match(/- columnheader "([^"]*)"/)?.[1] ?? '');
    } else if (started && /\s*- row(?: |:|$)/.test(line)) break;
  }
  return { issues, filters, visible_filters:visibleFilters, filter_source:inherited?'verified_before_own_selection':'visible', actual_filter: filters.length === 3 ? filters[2] : null, headers,
    total: counts.length && counts.every(n => n === counts[0]) ? counts[0] : null,
    empty_verified: counts.length > 0 && counts.every(n => n === 0) && /暂无数据/.test(dom) && !issues.length };
}

// Read the page's native aggregate using the real header cell spans. AX totals
// omit colspan and cannot safely be indexed or reconstructed from row ROIs.
export function normalizePoolPages(pages, expected, binding, inspection = {}) {
  const issues = [], rows = [];
  let headers = [], total = null;
  if (!Array.isArray(pages) || !pages.length) return { pool: expected, complete: false, tasks: [], total: null, issues: [{ code: 'pool_pages_missing' }] };
  for (const [index, page] of pages.entries()) {
    const view = inspectPlanDom(page.dom ?? '', binding, {...inspection,account_dom:page.account_dom});
    issues.push(...view.issues.map(code => ({ code, page: index + 1 })));
    if (view.filters.slice(0, 2).some(v => v && v !== '全部')) issues.push({ code: 'extra_pool_filter', page: index + 1 });
    if (view.actual_filter !== expected) issues.push({ code: 'filter_not_verified', page: index + 1 });
    if (index === 0) { headers = view.headers; total = view.total; }
    if (JSON.stringify(headers) !== JSON.stringify(view.headers) || total === null || total !== view.total) issues.push({ code: 'pool_changed_between_pages', page: index + 1 });
    if (page.page !== index + 1) issues.push({ code: 'page_sequence_unverified', page: index + 1 });
    if (!Array.isArray(page.rows) || page.rows.some(r => !Array.isArray(r) || r.length !== headers.length)) issues.push({ code: 'row_width_mismatch', page: index + 1 });
    rows.push(...(page.rows ?? []));
  }
  const keys = headers.map(s => s.replace(/\s|[()（）元]/g, ''));
  for (const name of ['任务名称','调控状态','调控消耗','调控成交订单数','调控支付ROI','调控预算','调控时长小时']) {
    if (keys.filter(h => h === name).length !== 1) issues.push({ code: 'required_header_missing_or_duplicate', header: name });
  }
  const result = cleanTaskPool({ actual_filter: expected, headers, rows, total, complete: true,
    empty_verified: pages.length === 1 && inspectPlanDom(pages[0].dom, binding, {...inspection,account_dom:pages[0].account_dom}).empty_verified,
    captured_at: pages[0].captured_at }, expected);
  result.issues.push(...issues);
  result.complete = result.complete && issues.length === 0;
  result.empty_verified = total === 0 && pages.length === 1 && inspectPlanDom(pages[0].dom, binding, {...inspection,account_dom:pages[0].account_dom}).empty_verified;
  result.source_finished_at = pages.at(-1).captured_at;
  // Preserve completeness failures when the shared brief normalizes this object again.
  if (result.issues.length) result.error = result.issues;
  return result;
}

// The observed plan Data overview has fixed decimal fragments, not an odometer:
// generic integer -> generic '.' -> text two decimal places -> comparison.
// Bound it before trends/tables; never concatenate arbitrary digit candidates.
function planOverviewMetrics(dom) {
  const lines=String(dom).split('\n'),unique=pattern=>{
    const ids=lines.flatMap((line,i)=>pattern.test(line)?[i]:[]);return ids.length===1?ids[0]:-1;
  };
  const start=unique(/^\s*- heading "数据概览" \[level=3\]\s*$/),end=unique(/^\s*- generic: 趋势对比\s*$/);
  if(start<0||end<=start)return null;
  const section=lines.slice(start+1,end);
  if(section.some(line=>/^\s*- (?:heading|table|row|columnheader|tabpanel|tab)\b/.test(line)))return null;
  const tokens=section.flatMap(line=>{
    const m=line.match(/^\s*- (generic|text): (.*)$/);return m?[{role:m[1],value:unquote(m[2])}]:[];
  });
  const positions=label=>tokens.flatMap((t,i)=>t.value===label?[i]:[]);
  const returns=positions('成交与回报'),costs=positions('支出与成本');
  if(returns.length!==1||costs.length!==1||returns[0]>=costs[0])return null;
  const costLabels=new Set(['综合成本(元)','整体消耗(元)']);
  const read=label=>{
    const ids=positions(label);if(ids.length!==1)return null;
    let i=ids[0]+1;
    if(costLabels.has(label)?ids[0]<=costs[0]:ids[0]<=returns[0]||ids[0]>=costs[0])return null;
    if(tokens[i]?.value==='重要')i++;
    const first=tokens[i++];if(first?.role!=='generic')return null;
    let raw=String(first.value);
    if(tokens[i]?.value==='.') {
      if(tokens[i]?.role!=='generic'||tokens[i+1]?.role!=='text'
        ||!/^\d{1,3}(?:,\d{3})*$|^\d+$/.test(raw)||!/^\d{2}$/.test(String(tokens[i+1].value)))return null;
      raw+='.'+tokens[i+1].value;i+=2;
    }
    if(!/^\d+(?:,\d{3})*(?:\.\d+)?$/.test(raw))return null;
    if(tokens[i]?.role!=='generic'||!/^(?:--|[+-]?\d+(?:\.\d+)?%)$/.test(String(tokens[i].value)))return null;
    const next=tokens[i+1]?.value;
    if(next!=null&&(numeric(next)!==null||['.','%','--'].includes(next)))return null;
    const value=numeric(raw);return Number.isFinite(value)?value:null;
  };
  const labels=['综合成本(元)','综合营销ROI','净成交金额(元)','整体成交金额(元)','整体消耗(元)','整体ROI','净成交ROI','退款金额(元)'];
  const metrics=Object.fromEntries(labels.map(label=>[label,read(label)]));
  return ['综合成本(元)','综合营销ROI','净成交金额(元)'].every(label=>metrics[label]!==null)?metrics:null;
}

// Consume the original formal MCP response; partial unrelated components do
// not invalidate a fresh, explicitly bound current-session financial component.
// This does not grant API advertising permissions or calculate an ROI.
export function parseMcpRoomFinancial(raw,binding,{runtime_account_id,exact_live_started_at,observed_at,max_age_seconds}={}) {
  const r=raw?.structuredContent??raw,issues=[],check=(ok,code)=>{if(!ok)issues.push(code);};
  const finite=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0;
  const start=exact_live_started_at,account=runtime_account_id,at=r?.components?.financial?.source_at;
  check(typeof account==='string'&&account.length>0&&r?.meta?.account_id===account,'financial_account_unverified');
  check(typeof start==='string'&&/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(start)
    &&start.slice(0,16)===String(binding.session_started_at).replace('T',' ').slice(0,16)&&r?.live?.start_time===start
    &&r?.live?.room_id===binding.room_id&&r?.meta?.session_key===`${account}|${binding.room_id}|${start}`,'financial_scene_unverified');
  check(r?.ok===true&&r?.meta?.data_valid===true&&r?.meta?.stale===false&&r?.live?.is_live===true,'financial_live_or_quality_unverified');
  const component=r?.components?.financial,net=r?.financial_checks?.net_roi;
  check(r?.metrics_scope==='current_session'&&component?.window==='current_session'&&component?.data_valid===true
    &&component?.freshness==='fresh'&&net?.window==='current_session'&&net?.data_valid===true
    &&net?.roi_basis==='platform_net_1h'&&net?.amount_basis==='platform_net_1h'&&net?.value_source==='upstream'
    &&r?.financial_basis?.spend==='ad_spend'&&r?.financial_basis?.net_roi==='platform_net_1h'
    &&r?.financial_basis?.net_gmv==='platform_net_1h','financial_basis_unverified');
  const age=(Date.parse(observed_at)-Date.parse(at))/1000;
  check(max_age_seconds>0&&Number.isFinite(age)&&age>=0&&age<=max_age_seconds,'financial_source_age_invalid');
  const m=r?.metrics;
  check(finite(m?.spend)&&finite(m?.net_gmv)&&finite(m?.net_roi)&&net?.raw_value===m?.net_roi,'financial_values_unverified');
  const valid=issues.length===0;
  const board={cost:valid?m.spend:null,net_roi:valid?m.net_roi:null,net_gmv:valid?m.net_gmv:null,
    overall_cost:valid?m.spend:null,net_transaction_roi:valid?m.net_roi:null,
    gmv:null,refund:null,overall_roi:null,coupon_amount:null,source_id:'mcp_room',
    metric_basis:'platform_整体消耗_净成交ROI',captured_at:at??null,top_metric_source_time:at??null,
    data_window:{kind:'live_net_transaction',room_id:binding.room_id,start_time:start??null},
    source_fields:{cost:'metrics.spend',net_roi:'metrics.net_roi',net_gmv:'metrics.net_gmv',
      gmv:'not_returned_payment_gmv_is_not_gross_sales',snapshot_id:r?.snapshot_id??null}};
  return {board,issues};
}

export function parseCompassTopFinancial(snapshot,binding) {
  const top=snapshot?.top,issues=[];
  const start=String(binding.live_start_display).replaceAll('-','/');
  const observed=String(top?.scene?.live_start_display).replaceAll('-','/');
  if(top?.source!=='compass'||top?.cost_basis!=='shop_bound')issues.push('financial_basis_unverified');
  if(top?.scene?.room_id!==binding.room_id||observed!==start)issues.push('financial_scene_unverified');
  if(!Number.isFinite(Date.parse(top?.at))||snapshot?.captured_at!==top.at)issues.push('financial_capture_time_invalid');
  if(!Array.isArray(top?.quality?.issues))issues.push('financial_quality_unverified');
  else issues.push(...top.quality.issues.filter(code=>typeof code!=='string'||!code.startsWith('实时在线人数:')));
  const blocked=issues.some(code=>typeof code!=='string'||!['直播间成交金额:','退款金额:','投放消耗(店铺绑定):'].some(prefix=>code.startsWith(prefix))&&code!=='zero_cost_roi_unknown');
  const labels={gmv:'直播间成交金额:',refund:'退款金额:',cost:'投放消耗(店铺绑定):'};
  const value=key=>!blocked&&!issues.some(code=>typeof code==='string'&&code.startsWith(labels[key]))
    &&Number.isFinite(top?.metrics?.[key])&&top.metrics[key]>=0?top.metrics[key]:null;
  const gmv=value('gmv'),refund=value('refund'),cost=value('cost');
  const netGmv=gmv!==null&&refund!==null?gmv-refund:null;
  const netRoi=netGmv!==null&&cost>0?netGmv/cost:null;
  const board={gmv,refund,cost,net_gmv:netGmv,net_roi:netRoi,overall_cost:cost,overall_roi:null,net_transaction_roi:netRoi,
    coupon_amount:null,source_id:'compass_top',metric_basis:'compass_gmv_minus_refund_over_shop_bound_cost',
    captured_at:top?.at??null,top_metric_source_time:null,
    data_window:{kind:'live_session',room_id:binding.room_id,start_time:start},
    source_fields:{gmv:'直播间成交金额',refund:'退款金额',cost:'投放消耗(店铺绑定)',net_gmv:'gmv-refund',net_roi:'(gmv-refund)/cost'}};
  for(const key of ['cost','net_roi','net_gmv'])if(board[key]===null)issues.push('financial_'+key+'_unknown');
  return {board,issues:[...new Set(issues.map(code=>typeof code==='string'?code:'financial_quality_unverified'))]};
}

export function parseFinancialDom(snapshot, source, binding) {
  const dom = snapshot?.dom ?? '', issues = [];
  if(source==='compass_top')return parseCompassTopFinancial(snapshot,binding);
  if(source==='mcp_room')return parseMcpRoomFinancial(snapshot?.raw,binding,snapshot);
  if(source==='plan_data'&&snapshot?.data_tab_verified&&Array.isArray(snapshot.metric_cards)&&snapshot.metric_cards.some(x=>x.label==='整体消耗(元)'||x.label==='净成交ROI')) {
    issues.push(...inspectPlanDom(dom,binding,{account_dom:snapshot.account_dom}).issues);
    const read=label=>{const rows=snapshot.metric_cards.filter(x=>x.label===label);return rows.length===1?numeric(rows[0].value):null;};
    // The page header's 更新时间 belongs to account balance, not these cards.
    // No metric-card update time is exposed in this verified layout.
    const board={cost:read('整体消耗(元)'),net_roi:read('净成交ROI'),net_gmv:read('净成交金额(元)'),gmv:read('整体成交金额(元)'),refund:read('退款金额(元)'),overall_cost:read('整体消耗(元)'),overall_roi:read('整体ROI'),net_transaction_roi:read('净成交ROI'),coupon_amount:null,source_id:source,metric_basis:'platform_整体消耗_净成交ROI',captured_at:snapshot.captured_at,top_metric_source_time:null,data_window:{kind:'plan_day',date:binding.date},source_fields:{cost:'整体消耗(元)',net_roi:'净成交ROI',net_gmv:'净成交金额(元)',gmv:'整体成交金额(元)',refund:'退款金额(元)',overall_cost:'整体消耗(元)',overall_roi:'整体ROI',net_transaction_roi:'净成交ROI'}};
    for(const key of ['cost','net_roi','net_gmv'])if(board[key]===null)issues.push('financial_'+key+'_unknown');
    return {board,issues};
  }
  let scope = dom, boardBasis = 'multiplication';
  if (source === 'plan_data') {
    issues.push(...inspectPlanDom(dom, binding,{account_dom:snapshot.account_dom}).issues);
    const from = dom.indexOf('- generic: 重点数据概览'), to = dom.indexOf('- heading "数据概览"', from);
    const selected=planTabs(dom).filter(t=>t.name==='数据'&&t.selected);
    if (from < 0 || to < from || selected.length!==1) issues.push('financial_section_unverified');
    scope = from >= 0 && to > from ? dom.slice(from, to) : '';
  } else if (source === 'qianchuan_board') {
    const start = binding.live_start_display.replaceAll('/', '-');
    scope = dom.split('- button "整体趋势"')[0];
    // Both board layouts share a URL. Use the observed selected data basis,
    // never trend legends, plan-day totals or the user's ROI target.
    const modes=[...scope.matchAll(/^\s*- textbox "请选择": (.+)$/gm)].map(m=>unquote(m[1].trim()));
    boardBasis=modes.length===1&&modes[0]==='全域净成交数据'?'net_transaction'
      :modes.length===1&&modes[0]==='乘方数据'?'multiplication':null;
    const header=scope.split(/^\s*- generic: (?:整体消耗|综合成本)\(元\)/m)[0];
    if (!header.includes(binding.live_name) || !header.includes('开播时间：' + start)) issues.push('financial_scene_unverified');
    if (!boardBasis) issues.push('financial_basis_unverified');
  } else throw Error('Explicit supported financial_source required');
  const items = values(scope);
  const net=boardBasis==='net_transaction',costLabel=net?'整体消耗(元)':'综合成本(元)',roiLabel=net?'净成交ROI':'综合营销ROI';
  const board = { cost: boardBasis?one(items, costLabel):null, net_roi: boardBasis?one(items, roiLabel):null,
    net_gmv: boardBasis?one(items, '净成交金额(元)', net?[]:['乘方投放期间']):null,
    gmv:boardBasis?one(items,'整体成交金额(元)'):null,refund:boardBasis?one(items,'退款金额(元)'):null,
    overall_cost:boardBasis?one(items,'整体消耗(元)'):null,overall_roi:boardBasis?one(items,'整体ROI'):null,
    net_transaction_roi:boardBasis?one(items,'净成交ROI'):null,
    coupon_amount: boardBasis==='multiplication'?one(items, '整体成交智能优惠券金额(元)'):null,
    source_id: source, metric_basis: !boardBasis?null:net?'platform_整体消耗_净成交ROI':'platform_综合成本_综合营销ROI', captured_at: snapshot?.captured_at ?? null,
    top_metric_source_time: scope.match(/(\d{2}-\d{2} \d{2}:\d{2})更新/)?.[1] ?? null,
    data_window: source === 'plan_data' ? { kind: 'plan_day', date: binding.date } : { kind: !boardBasis?'unknown':net?'live_net_transaction':'live_multiplication', room_id: binding.room_id },
    source_fields: { cost: boardBasis?costLabel:null, net_roi: boardBasis?roiLabel:null, net_gmv: boardBasis?'净成交金额(元)':null,
      gmv:boardBasis?'整体成交金额(元)':null,refund:boardBasis?'退款金额(元)':null,overall_cost:boardBasis?'整体消耗(元)':null,overall_roi:boardBasis?'整体ROI':null,net_transaction_roi:boardBasis?'净成交ROI':null } };
  if(source==='plan_data'&&!issues.length) {
    const product=parsePlanProductBasis(snapshot,binding);
    const overview=product.type==='multiplication'&&!product.issues.length?planOverviewMetrics(dom):null;
    if(overview) {
      board.source_sections={};
      for(const [key,label] of Object.entries(board.source_fields)) {
        const candidate=overview[label];if(candidate==null)continue;
        const ids=items.flatMap((value,i)=>value===label?[i]:[]);
        // Only a genuinely absent/placeholder primary card can fall back.
        // A duplicate or malformed primary value stays unknown.
        if(board[key]===null&&(ids.length===0||ids.length===1&&['-','--'].includes(items[ids[0]+1]))) {
          board[key]=candidate;board.source_sections[key]='数据概览';
        } else if(board[key]!==null&&board[key]!==candidate) {
          board[key]=null;issues.push('financial_'+key+'_overview_conflict');
        } else if(board[key]!==null)board.source_sections[key]='重点数据概览';
      }
    }
  }
  for (const key of ['cost','net_roi','net_gmv']) if (board[key] === null) issues.push('financial_' + key + '_unknown');
  return { board, issues };
}

const compassFiveLabels = ['用户支付金额','成交金额','在线人数','进入人数','离开人数'];
function nativeFiveMinuteItems(panel) {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(panel?.updated_at_text ?? '') || !Array.isArray(panel?.cards)) return null;
  const items = [];
  for (const label of compassFiveLabels) {
    const cards = panel.cards.filter(card => card?.metric === label);
    if (cards.length > 1) return null;
    if (!cards.length) continue;
    const lines = cards[0].value_lines;
    if (!Array.isArray(lines) || ![3,4].includes(lines.length) || !lines.every(line => typeof line === 'string')
      || lines[0] !== label) return null;
    const money = label === '用户支付金额' || label === '成交金额';
    const format = money ? /^[¥￥]?\d+(?:,\d{3})*(?:\.\d+)?$/ : /^\d+(?:,\d{3})*$/;
    const value = numeric(lines[1]);
    if (!format.test(lines[1]) || !Number.isFinite(value) || (!money && !Number.isSafeInteger(value))) return null;
    const ring = lines.length === 3 && lines[2].startsWith('环比') ? lines[2].slice(2)
      : lines.length === 4 && lines[2] === '环比' ? lines[3] : null;
    if (!/^(?:\d+(?:\.\d+)?%|持平|--?)$/.test(ring ?? '')) return null;
    items.push(label, lines[1], '环比', ring);
  }
  return ['在线人数','进入人数','离开人数'].every(label => items.includes(label)) ? items : null;
}

// Only the observed right-hand five-minute panel; no cumulative metrics or
// realtime-online substitution. Reuse the existing DOM capture without IO.
export function parseCompassFlow(snapshot,binding) {
  const dom=String(snapshot?.dom??'');
  const markers=[...dom.matchAll(/^\s*- (?:generic|paragraph|text): "?近5分钟数据"?\s*$/gm)];
  const scope=markers.length===1?dom.slice(markers[0].index+markers[0][0].length).split(/^\s*- (?:generic|paragraph|text): "?实时评论"?\s*$/m)[0]:'';
  const items=values(scope),times=items.filter(v=>/^\d{2}:\d{2}更新$/.test(v));
  const stamp=Date.parse(snapshot?.captured_at),clock=times.length===1?times[0].match(/^(\d{2}):(\d{2})更新$/):null;
  let updated=null;
  if(Number.isFinite(stamp)&&clock&&+clock[1]<24&&+clock[2]<60) {
    // The Chinese board clock has minute precision, including across midnight.
    const day=new Date(stamp+8*3600000).toISOString().slice(0,10);
    let value=Date.parse(`${day}T${clock[1]}:${clock[2]}:00+08:00`);
    if(value>stamp)value-=86400000;
    updated=new Date(value).toISOString();
  }
  const integer=label=>{const n=one(items,label);return Number.isSafeInteger(n)&&n>=0?n:null;};
  return {source:'compass_five_minutes',binding:{...binding},captured_at:snapshot?.captured_at??null,
    updated_at:updated,enters:integer('进入人数'),leaves:integer('离开人数')};
}

export function parseCompassDom(snapshot, binding) {
  const dom = snapshot?.dom ?? '', issues = [];
  const start = binding.live_start_display.replaceAll('-', '/').slice(0, 16);
  const header = dom.slice(0, dom.indexOf('- generic: 直播间成交金额') < 0 ? 1500 : dom.indexOf('- generic: 直播间成交金额'));
  if (!header.includes(binding.live_name) || !header.includes('开播时间' + start)) issues.push('compass_scene_unverified');
  const compactTop=Object.hasOwn(snapshot??{},'top');
  const i = compactTop ? -1 : dom.indexOf('- generic: 近5分钟数据');
  const scope = i < 0 ? '' : dom.slice(i).split('- generic: 实时评论')[0];
  const endMarker = /^\s*- (?:generic|paragraph|text): "?(?:已下播|直播已结束)"?\s*$/m;
  const ended = endMarker.test(header) || endMarker.test(scope);
  const inLive = /开播时间[^\n]*已开播/.test(header);
  if (ended && inLive) issues.push('compass_live_state_conflict');
  const state = ended ? 'ended' : inLive ? 'live' : 'unknown';
  let items = values(scope);
  let updated = scope.match(/(\d{2}:\d{2})更新/)?.[1] ?? null;
  // The saved native comparison observation is scoped to this five-minute
  // panel and can finish loading after AX. Use it only for an empty AX panel;
  // never combine partial AX values/windows or fall back to realtime fields.
  if (!issues.length && i >= 0 && updated === null && !compassFiveLabels.some(label => items.includes(label))) {
    const nativeItems = nativeFiveMinuteItems(snapshot?.comparison);
    if (nativeItems) { items = nativeItems; updated = snapshot.comparison.updated_at_text; }
  }
  const comparison = {};
  for (const label of compassFiveLabels) {
    const indexes = items.flatMap((v,i) => v === label ? [i] : []);
    if (indexes.length !== 1) continue;
    const i = indexes[0], value = one(items,label);
    const percentText = items[i+2] === '环比' ? items[i+3] : null;
    const percentMatch = typeof percentText === 'string' ? percentText.match(/^(\d+(?:\.\d+)?)%$/) : null;
    const pct = percentMatch ? Number(percentMatch[1]) : null;
    const candidates = (snapshot?.comparison?.cards ?? []).filter(c => c.metric === label && c.percent === pct && pct !== null
      && c.value_lines?.some(line => numeric(line) === value) && value !== null
      && snapshot.comparison.updated_at_text === updated && updated !== null);
    comparison[label] = { percent:pct, direction:percentText === '持平' ? 'flat'
      : candidates.length === 1 && ['up','down'].includes(candidates[0].direction) ? candidates[0].direction : null };
  }
  const five = { updated_at_text: updated,
    payment_gmv: one(items, '用户支付金额') ?? one(items, '成交金额'), online_snapshot: one(items, '在线人数'),
    enters: one(items, '进入人数'), leaves: one(items, '离开人数'), comparison };
  if(!issues.length&&snapshot?.flow?.source==='compass_five_minutes'&&bindingMatches(snapshot.flow.binding,binding)) {
    five.flow=snapshot.flow;
    if(compactTop) {
      five.updated_at=Number.isFinite(Date.parse(snapshot.flow.updated_at))?snapshot.flow.updated_at:null;
      five.enters=Number.isSafeInteger(snapshot.flow.enters)&&snapshot.flow.enters>=0?snapshot.flow.enters:null;
      five.leaves=Number.isSafeInteger(snapshot.flow.leaves)&&snapshot.flow.leaves>=0?snapshot.flow.leaves:null;
    }
  }
  const topFinancial=compactTop?parseCompassTopFinancial({top:snapshot.top,captured_at:snapshot.top?.at},binding):null;
  const topBound=compactTop&&snapshot.top?.scene?.room_id===binding.room_id
    &&String(snapshot.top?.scene?.live_start_display).replaceAll('-','/')===binding.live_start_display.replaceAll('-','/')
    &&snapshot.top?.source==='compass'&&snapshot.top?.cost_basis==='shop_bound'
    &&Array.isArray(snapshot.top.quality?.issues)&&snapshot.top.quality.issues.every(code=>typeof code==='string'
      &&(code==='zero_cost_roi_unknown'||['直播间成交金额:','退款金额:','投放消耗(店铺绑定):'].some(prefix=>code.startsWith(prefix))));
  return { issues, room_id: issues.length ? null : binding.room_id,
    live_start_display: issues.length ? null : start, live_state: issues.length ? 'unknown' : state,
    live_state_observed_at: snapshot?.captured_at ?? null, live_state_evidence: endMarker.test(scope) ? 'compass_five_minute_status' : 'compass_header',
    live_state_source: 'compass', five_minutes: five,
    live_top: issues.length ? null : compactTop ? {source:'compass',captured_at:snapshot.top?.at??null,
      room_id:binding.room_id,live_start_display:start,gmv:topFinancial.board.gmv,refund:topFinancial.board.refund,
      shop_bound_cost:topFinancial.board.cost,realtime_online:topBound&&Number.isSafeInteger(snapshot.top.metrics?.online)&&snapshot.top.metrics.online>=0?snapshot.top.metrics.online:null}
      : { source:'compass',captured_at:snapshot?.captured_at??null,
      room_id:binding.room_id,live_start_display:start,
      gmv:one(values(dom.split('- generic: 综合趋势')[0]),'直播间成交金额（含异常交易）'),
      payment_gmv:one(values(dom.split('- generic: 综合趋势')[0]),'直播间用户支付金额'),
      shop_bound_cost:one(values(dom.split('- generic: 综合趋势')[0]),'投放消耗(店铺绑定)'),
      realtime_online:one(values(dom.split('- generic: 综合趋势')[0]),'实时在线人数') } };
}

export function reduceBrowserCapture(capture, { previous = null, now = capture.finished_at, max_age_seconds, feedback_authority = null, ...options } = {}) {
  const { binding } = capture;
  if (!bindingMatches(binding, binding) || !binding.live_name || !binding.live_start_display) throw Error('Full scene binding required');
  if (!(max_age_seconds > 0)) throw Error('Explicit max_age_seconds required');
  const { board, issues: financialIssues } = parseFinancialDom(capture.financial, capture.financial_source, binding);
  const product=crossCheckProductBasis(capture,board,financialIssues);
  const prior = previous && bindingMatches(previous.binding, binding) ? previous : null;
  let feedbackPrior=prior;
  if(feedback_authority!==null) {
    if(feedback_authority.source!=='control_state'||!bindingMatches(feedback_authority.binding,binding)
      ||!Number.isInteger(feedback_authority.state_revision)||feedback_authority.state_revision<0
      ||!Array.isArray(feedback_authority.completed))throw Error('feedback_authority_unverified');
    for(const item of feedback_authority.completed) {
      const reviewed=Date.parse(item.reviewed_at);
      if(typeof item.task_id!=='string'||!item.task_id||typeof item.event_id!=='string'||!item.event_id
        ||!Number.isFinite(Date.parse(item.feedback_until??item.deadline))||!Number.isFinite(reviewed)||reviewed>Date.parse(now)
        ||typeof item.result!=='string'||!item.result.trim()||typeof item.evidence!=='string'||!item.evidence.trim())throw Error('feedback_authority_unverified');
    }
    // The controller's versioned state owns completed reviews. A reader cache
    // may have missed the intervening action/review and cannot reopen them.
    feedbackPrior={...prior,completed_startup_feedback:[...(prior?.completed_startup_feedback??[]),...feedback_authority.completed]};
  }
  const baseline=prior?.financial_baseline??prior?.compass;
  const sameWindow=baseline?.source_id===board.source_id&&baseline?.metric_basis===board.metric_basis
    &&JSON.stringify(baseline?.data_window)===JSON.stringify(board.data_window);
  // A cumulative same-window cost cannot reset to zero with every sales card.
  // Keep evidence of the last valid sample, never report its values as current.
  const zeroReset=sameWindow&&baseline.cost>0&&board.cost===0&&board.net_roi===0&&board.net_gmv===0;
  if(zeroReset){financialIssues.push('financial_zero_reset_unverified');for(const key of ['cost','net_roi','net_gmv','gmv','refund','overall_cost','overall_roi','net_transaction_roi'])board[key]=null;}
  const scene = parseCompassDom(capture.compass, binding);
  const current = { binding, captured_at: capture.finished_at, phase: capture.phase ?? 'observation', product_basis:product.metadata,
    compass: { ...board, ...scene },
    financial_baseline:financialIssues.length?(sameWindow?baseline:null):{...board},
    active_pool: normalizePoolPages(capture.active, '调控中', binding),
    paused_pool: normalizePoolPages(capture.paused, '手动暂停', binding),
    // Business memory is explicit. Old raw browser fields are never spread into a new round.
    ...Object.fromEntries(['task_state','pending_queue','completed_startup_feedback','external_changes','unresolved_submissions']
      .filter(k => capture.memory?.[k] !== undefined).map(k => [k, capture.memory[k]])), actions: [] };
  const issues = [...(capture.issues ?? []), ...financialIssues, ...scene.issues, ...product.issues].map(i => typeof i === 'string' ? { code: i } : i);
  const samples = [capture.financial, capture.compass, ...(capture.active ?? []), ...(capture.paused ?? [])];
  for (const [index, sample] of samples.entries()) {
    const age = (Date.parse(now) - Date.parse(sample?.captured_at)) / 1000;
    if (!Number.isFinite(age) || age < 0 || age > max_age_seconds) issues.push({ code: 'snapshot_age_invalid', sample: index, age_seconds: Number.isFinite(age) ? age : null });
  }
  const brief = buildDecisionBrief(prior, current, { ...options, now, feedback_previous:feedbackPrior });
  const feedback = reconcileFeedback(feedbackPrior, current, now);
  current.pending_queue = feedback.pending;
  current.completed_startup_feedback = feedback.completed;
  brief.reader = { version: READER_VERSION, channel: 'codex-cua', raw_dom_returned: false, advertising_writes: 0 };
  // The live reader preserves this metadata when it rebuilds the shared brief.
  brief.board.source_fields = {...board.source_fields,product_basis:product.metadata};
  brief.board.coupon_amount = board.coupon_amount;
  brief.live_state_evidence.source = scene.live_state_source;
  brief.five.source = 'compass';
  brief.five.captured_at = capture.compass?.captured_at ?? null;
  brief.tasks.roi_basis = { payment_roi: '页面调控支付ROI（单条整体ROI）', net_roi: '页面调控净成交ROI，仅留证' };
  brief.quality.issues.push(...issues);
  brief.quality.write_ready &&= issues.length === 0;
  return { current, brief };
}
