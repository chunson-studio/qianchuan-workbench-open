'use strict';
const { parseBoostTable, extractTableFromHeaders } = require('./playwright-boost-read.cjs');
const { requestedValues, fail } = require('../../server-app/server/lib/browserBoostContract.js');
const { getTemplate } = require('../../server-app/server/lib/boostAudienceTemplates.js');
const PATH_TYPES = { '/overall-prom/detail': 'cheng_fang', '/uni-prom/detail': 'quan_yu' };
const FIELD_NAMES = {
  budget: ['预算','调控预算','调控预算(元)','调控预算（元）','追投预算'],
  duration_seconds: ['投放时长','投控时长','总时长','调控时长'], roi_goal: ['ROI目标','目标ROI','ROI目标值','净成交ROI目标','支付ROI目标','综合营销ROI目标'],
  bid: ['出价','手动出价'], name: ['任务名称','追投名称','调控名称'],
};
const compact = text => String(text || '').replace(/\s+/g, '').replace(/[（]/g,'(').replace(/[）]/g,')');
const escape = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function number(text) {
  if (text == null || /^\s*(?:-|—|暂无|未知)?\s*$/.test(text)) return null;
  const clean = String(text).trim().replace(/[¥￥,元\s]/g,'');
  return /^\d+(?:\.\d+)?$/.test(clean) ? Number(clean) : null;
}
function duration(text) {
  const s = String(text || '').trim();
  const hours = s.match(/^(\d+(?:\.\d+)?)\s*(?:小时|h)$/i), seconds = s.match(/^(\d+)\s*秒$/);
  const minutes = s.match(/^(\d+)\s*分钟$/), mixed = s.match(/^(\d+)\s*小时\s*(\d+)\s*分钟$/);
  return seconds ? Number(seconds[1]) : hours ? Number(hours[1])*3600 : minutes ? Number(minutes[1])*60 : mixed ? Number(mixed[1])*3600+Number(mixed[2])*60 : null;
}
const status = value => ({ '投放中': 1, '已暂停': 2, '暂停中': 2, '暂停投放': 2, '已终止': 6, '已停止': 6, '已删除': 99 })[String(value).trim()] ?? null;
// Runs inside the page. Only explicit alerts or observed target values finish this wait.
function observeOutcome({baseline,confirmationAllowed,targetId,requested}) {
  const visible=el=>!!el.getClientRects().length && getComputedStyle(el).visibility!=='hidden';
  const texts=[...document.querySelectorAll('[role="alert"]')].filter(visible).map(el=>el.innerText.trim()).filter(t=>!baseline.includes(t));
  const reject=texts.find(t=>/未开播|不在直播|无法|失败|不能|不支持|不足|超出|已结束|错误|不可/.test(t));
  if(reject)return {accepted:false,text:reject};
  const accepted=texts.find(t=>/成功/.test(t));if(accepted)return {accepted:true,text:accepted};
  if(confirmationAllowed && [...document.querySelectorAll('[role="dialog"]')].some(el=>visible(el)&&/确认|确定/.test(el.innerText)&&/暂停|开启|恢复|停止|删除/.test(el.innerText)))return {confirmation:true};
  if(!targetId||!Object.keys(requested).length)return false;
  const escaped=targetId.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const matches=[...document.querySelectorAll('tr,[role="row"]')].filter(el=>visible(el)&&new RegExp('(?:任务|追投)?ID\\s*[:：#]\\s*'+escaped+'(?!\\d)').test(el.innerText));
  if(matches.length!==1)return false;
  const row=matches[0],table=row.closest('table,[role="table"]');if(!table)return false;
  const headers=[...table.querySelectorAll('th,[role="columnheader"]')].map(el=>el.innerText.replace(/\s+/g,'').replace(/（/g,'(').replace(/）/g,')'));
  const cells=[...(row.cells||row.querySelectorAll('[role="cell"]'))].map(el=>el.innerText.trim());
  const names={status:['状态','调控状态','任务状态'],budget:['调控预算(元)','调控预算','预算'],duration_seconds:['总时长','投控时长','投放时长','调控时长'],roi_goal:['ROI目标','目标ROI'],bid:['出价(元)','手动出价(元)']};
  const values={};
  for(const[key,expected]of Object.entries(requested)){
    const index=headers.findIndex(h=>names[key]?.includes(h));if(index<0)return false;const text=cells[index];let actual=null;
    if(key==='status')actual=({'投放中':1,'已暂停':2,'暂停中':2,'暂停投放':2,'已终止':6,'已停止':6,'已删除':99})[text]??null;
    else if(key==='duration_seconds'){const h=text.match(/^(\d+(?:\.\d+)?)\s*小时$/),s=text.match(/^(\d+)\s*秒$/);actual=h?Number(h[1])*3600:s?Number(s[1]):null;}
    else{const clean=text.replace(/[¥￥,元\s]/g,'');actual=/^\d+(?:\.\d+)?$/.test(clean)?Number(clean):null;}
    if(actual!==expected)return false;values[key]=actual;
  }
  return {accepted:true,target_state_changed:true,values};
}
function tableTargets(table) {
  const idx = names => table.headers.findIndex(h => names.map(compact).includes(compact(h)));
  const taskIndex = idx(['任务名称','调控任务','追投任务']);
  return table.rows.map(cells => {
    const id = cells[taskIndex].match(/(?:任务|追投)\s*(?:ID|编号)\s*[:：#]?\s*(\d+)|\bID\s*[:：#]\s*(\d+)/i);
    if (!id) fail('browser_task_id_unverified','任务ID未核验');
    const cell = names => { const i = idx(names); return i < 0 ? null : cells[i]; };
    const timeText = cell(['创建时间','任务创建时间']);
    const created = timeText && /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d(?::\d\d)?$/.test(timeText.trim())
      ? Date.parse(timeText.trim().replace(' ','T') + (timeText.trim().length === 16 ? ':00' : '') + '+08:00') : NaN;
    return { id: id[1] || id[2], name: cells[taskIndex].split('\n')[0].trim(),
      status: status(cell(['状态','调控状态','任务状态'])), status_label: cell(['状态','调控状态','任务状态']),
      budget: number(cell(['调控预算(元)','调控预算（元）','调控预算','预算'])),
      cost: number(cell(['调控消耗','调控消耗(元)','调控消耗（元）','消耗'])),
      roi_goal: number(cell(['ROI目标','目标ROI'])), bid: number(cell(['出价(元)','手动出价(元)'])),
      duration_seconds: duration(cell(['总时长','投控时长','投放时长','调控时长'])),
      smart_bid_type: /^(放量追投|有限期放量)$/.test(String(cell(['追投方式','调控方式'])||'').trim())?7:null,
      create_time: Number.isFinite(created) ? created/1000 : null,
      payment_roi: number(cell(['支付ROI','支付 ROI'])), net_roi: number(cell(['净成交ROI','净成交 ROI'])),
      comprehensive_roi: number(cell(['综合营销ROI','综合营销 ROI'])),
      orders: number(cell(['支付订单','支付订单数'])),
      passive_stop: /系统|风控|被动/.test(String(cell(['状态','调控状态','任务状态']) || '')),
      optimization: { deepExternalActionName: cell(['优化目标','投放目标']) },
    };
  });
}

// Controls are discovered from rendered DOM, not app state or guessed class names.
// Only unique, visible, semantic controls are actionable. Every discovery is persisted first.
class BrowserBoostPage {
  constructor(adapter, request, clock, evidence) { this.adapter=adapter; this.r=request; this.clock=clock; this.evidence=evidence; this.page=adapter.page(); this.dispatched=false; }
  async record(id, state, value) { await this.evidence(id,state,value); }
  async control(scope, names, id) {
    const observed = await scope.locator('button,[role="button"],a,[role="tab"],input[type="button"],input[type="submit"]').evaluateAll((els,names) => els.map((el,index) => ({
      index, name: (el.getAttribute('aria-label') || el.innerText || el.value || '').trim(),
      visible: !!(el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden'), disabled: el.disabled || el.getAttribute('aria-disabled') === 'true',
    })).filter(el => el.visible && names.includes(el.name)),names);
    if (observed.length !== 1) fail(observed.length ? 'browser_control_ambiguous' : 'browser_action_pending_verification','当前页面没有唯一可核验的控件：'+names.join('/'),423);
    const item=observed[0]; await this.record(id,'observed',{locator:{scope:'current_region',css:'button,[role="button"],a,[role="tab"],input[type="button"],input[type="submit"]',index:item.index,name:item.name},disabled:!!item.disabled});
    if(item.disabled) fail('upstream_action_blocked','平台当前不允许：'+item.name,423);
    return scope.locator('button,[role="button"],a,[role="tab"],input[type="button"],input[type="submit"]').nth(item.index);
  }
  async textControl(text,id) {
    const target=this.page.getByText(text,{exact:true});
    await target.waitFor({state:'visible',timeoutMs:this.clock.timeout(5000)});
    if(await target.count()!==1) fail('browser_control_ambiguous','入口不唯一：'+text,423);
    await this.record(id,'observed',{locator:{text,exact:true}}); return target;
  }
  async identity() {
    const url=await this.adapter.currentUrl(); const type=PATH_TYPES[new URL(url).pathname];
    if(!type) fail('browser_plan_type_pending_verification','此计划页面尚未登记；不能据此推断商品卡不适用',423);
    const a=this.r.advertiser_id,p=this.r.primary_ad_id;
    await this.adapter.assertIdentity({advertiser_id:a,primary_ad_id:p,date_range:[this.r.start,this.r.end]});
    for(const text of ['ID：'+a,'计划ID：'+p]) { const el=this.page.getByText(text,{exact:true}); await el.waitFor({state:'visible',timeoutMs:this.clock.timeout(5000)}); if(await el.count()!==1)fail('browser_visible_identity_mismatch','页面可见身份不唯一或不匹配',409); }
    const dates=await this.page.getByRole('textbox').evaluateAll(els=>els.map(el=>String(el.value || '')).filter(t=>/^\d{4}-\d{2}-\d{2}$/.test(t)));
    if(JSON.stringify(dates)!==JSON.stringify([this.r.start,this.r.end])) fail('browser_date_mismatch','页面日期控件与请求不匹配',409);
    this.planType=type; await this.record('identity','read_verified',{url,plan_type:type,date_range:dates});
  }
  async refresh() {
    await this.clock.stage('load',async()=>{
      const began=new Date().toISOString(); await this.adapter.reload({waitUntil:'domcontentloaded',timeout:this.clock.timeout(15000)});
      await this.identity(); const tab=await this.textControl('调控','tab.controls'); await tab.click({timeout:this.clock.timeout(5000)});
      await this.adapter.waitForFunction(() => {
        const visible = el => !!el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
        const heads=[...document.querySelectorAll('th,[role="columnheader"]')].filter(visible);
        return heads.some(h=>/^(任务名称|调控任务|追投任务)$/.test(h.innerText.trim()))
          && heads.some(h=>/调控预算|^预算$/.test(h.innerText))
          && ![...document.querySelectorAll('[aria-busy="true"],[role="progressbar"]')].some(visible);
      },null,{timeout:this.clock.timeout(15000),polling:'raf'});
      await this.record('reload','read_verified',{refresh_started_at:began,refresh_completed_at:new Date().toISOString()});
    });
  }
  async table() {
    const first=parseBoostTable(await this.page.getByRole('columnheader').evaluateAll(extractTableFromHeaders));
    const second=parseBoostTable(await this.page.getByRole('columnheader').evaluateAll(extractTableFromHeaders));
    if(JSON.stringify(first)!==JSON.stringify(second))fail('browser_table_changed','读取过程中表格变化；本次停止',409);
    this.targets=tableTargets(second); this.tableData=second;
    const controls=await this.page.getByRole('textbox').evaluateAll(els=>els.filter(el=>el.getClientRects().length).map(el=>({placeholder:el.getAttribute('placeholder') || '',value:String(el.value||'')})));
    const filters=controls.filter(el=>el.placeholder==='请选择'), search=controls.find(el=>el.placeholder==='输入任务名称或ID搜索');
    this.complete=this.planType==='quan_yu' && filters.length===3 && filters.every(f=>/^全部/.test(f.value)) && search?.value==='' && second.total_count===this.targets.length;
    await this.record('table','read_verified',{table:second,complete:this.complete}); return this.targets;
  }
  async row(id) {
    const target=this.page.getByRole('row').filter({hasText:new RegExp('(?:任务|追投)?\\s*ID\\s*[:：#]\\s*'+escape(id)+'(?!\\d)')});
    await target.waitFor({state:'visible',timeoutMs:this.clock.timeout(5000)});
    if(await target.count()!==1)fail('browser_target_ambiguous','任务行不唯一，或任务不在当前页',409);
    return target;
  }
  async dialog() { const el=this.page.getByRole('dialog'); await el.waitFor({state:'visible',timeoutMs:this.clock.timeout(5000)}); if(await el.count()!==1)fail('browser_form_ambiguous','表单或确认窗不唯一',423); return el; }
  async fields(scope) {
    const fields=await scope.locator('input,textarea,select').evaluateAll(els=>els.map((el,index)=>{
      let label=(el.getAttribute('aria-label') || [...(el.labels||[])].map(l=>l.innerText).join(' ')).trim();
      if(!label) { let parent=el.parentElement; for(let depth=0;parent&&depth<3;depth++,parent=parent.parentElement) { if(parent.querySelectorAll('input,textarea,select').length===1) { const text=parent.innerText?.trim(); if(text && text.length<100)label=text; } } }
      return {index,label,placeholder:el.getAttribute('placeholder')||'',value:String(el.value||''),type:el.type||el.tagName.toLowerCase(),visible:!!el.getClientRects().length,disabled:!!el.disabled};
    }));
    const mapped={};
    for(const [key,names]of Object.entries(FIELD_NAMES)) {
      const matches=fields.filter(f=>f.visible && !['radio','checkbox','hidden'].includes(f.type) && names.some(name=>compact(f.label).startsWith(compact(name)) || compact(f.placeholder)===compact(name)));
      if(matches.length>1)fail('browser_field_ambiguous','表单字段不唯一：'+key,423);
      if(matches.length) { const field=matches[0]; field.unit=key==='duration_seconds' ? /小时|\(h\)/i.test(field.label)?'hours':/秒/.test(field.label)?'seconds':null : null; mapped[key]=field; }
    }
    await this.record('form.fields','read_verified',{fields:mapped}); return mapped;
  }
  fieldValues(fields) {
    const result={};
    for(const[key,f]of Object.entries(fields)) {
      if(key==='name')result.name=f.value;
      else if(key==='duration_seconds')result[key]=number(f.value)==null?null:f.unit==='hours'?number(f.value)*3600:f.unit==='seconds'?number(f.value):null;
      else result[key]=number(f.value);
    }
    return result;
  }
  async readCurrent(id=this.r.target_id) {
    const rows=await this.table(); const target=id ? rows.find(t=>t.id===id) : rows.filter(t=>t.name===this.r.name);
    const row=Array.isArray(target) ? target.length===1?target[0]:null : target;
    if(!row)fail('browser_target_not_found','未找到唯一任务；列表消失不证明已删除',409);
    return {...row,...(row.duration_seconds!=null?{duration_seconds_source:'refreshed_browser_table',duration_seconds_unit:'seconds'}:{})};
  }
  async audienceFields(scope, fill=false) {
    const template=getTemplate('full_region'), names={AreaReverse:'反向地域',LocationType:'位置类型',District:'地域类型',RegionVer:'地域版本',City:'地域',CityDivide:'地域划分',Age:'年龄'};
    const controls={};
    for(const[key,label]of Object.entries(names)) {
      const el=scope.getByLabel(label,{exact:true});
      if(await el.count()!==1)fail('browser_audience_fields_pending_verification','定向字段未能唯一核验：'+label,423);
      const type=await el.evaluate(node=>({tag:node.tagName,type:node.type,multiple:!!node.multiple,options:node.options?[...node.options].map(o=>o.value):null}));
      const value=template[key];
      if(Array.isArray(value) && (!type.multiple || !value.every(v=>type.options?.includes(String(v)))))fail('browser_audience_options_pending_verification','地域或年龄选项与模板不一致',423);
      if(typeof value==='boolean' && type.type!=='checkbox')fail('browser_audience_fields_pending_verification','地域布尔字段控件不匹配',423);
      if(!Array.isArray(value) && typeof value!=='boolean' && type.tag!=='SELECT')fail('browser_audience_fields_pending_verification','地域枚举字段控件不匹配',423);
      if(type.tag==='SELECT' && !Array.isArray(value) && !type.options.includes(String(value)))fail('browser_audience_options_pending_verification','地域枚举与模板不一致',423);
      controls[key]={el,type,value};
    }
    const observed={};
    for(const[key,{el,type,value}]of Object.entries(controls)) {
      if(fill) {
        if(typeof value==='boolean') await el[value?'check':'uncheck']({timeout:this.clock.timeout(5000)});
        else await el.selectOption(Array.isArray(value)?value.map(String):String(value),{timeout:this.clock.timeout(5000)});
      }
      const raw=await el.evaluate(node=>node.type==='checkbox'?node.checked:node.multiple?[...node.selectedOptions].map(o=>o.value):node.value);
      observed[key]=Array.isArray(value)?raw.map(v=>typeof value[0]==='number'?Number(v):v).sort():typeof value==='number'?Number(raw):raw;
      await this.record('audience.'+key,'read_verified',{field:key,value:observed[key],filled:fill});
    }
    return observed;
  }
  async clearSelection() {
    const checked=this.page.getByRole('row').getByRole('checkbox');
    const entries=await checked.evaluateAll(els=>els.map((el,index)=>({index,checked:el.checked || el.getAttribute('aria-checked')==='true'})));
    for(const item of entries.filter(e=>e.checked)) await checked.nth(item.index).uncheck({timeout:this.clock.timeout(5000)});
    const region=await this.page.domSnapshot();const count=region.match(/(?:已选|已选择|选择了)\s*(\d+)\s*(?:条|项)/);
    if(count&&Number(count[1])!==0)fail('browser_cross_page_selection','尚有跨页选中项，不能提交',409);
    await this.record('selection.clear','read_verified',{checked_count:0});
  }
  async prepare() {
    await this.identity(); await this.refresh(); await this.table();
    if(this.r.action==='list')return {read:{tasks:this.targets,coverage:{scope:'current_page_only',complete:this.complete},plan_type:this.planType}};
    if(this.r.action==='diagnose') {
      const el=await this.control(this.page,['效果诊断','直播诊断','诊断'],'diagnose.open'); await el.click({timeout:this.clock.timeout(5000)});
      this.form=await this.dialog(); const text=await this.form.innerText(); await this.record('diagnose.read','read_verified',{text}); await this.cancel();
      return {read:{diagnosis:text.slice(0,2000),plan_type:this.planType}};
    }
    if(this.r.action==='detail') {
      const before=await this.readCurrent(); const row=await this.row(this.r.target_id);
      await(await this.control(row,['数据','详情'],'detail.open')).click({timeout:this.clock.timeout(5000)});
      this.form=await this.dialog();const text=await this.form.innerText();if(!new RegExp('(?:任务|追投)?ID\\s*[:：#]\\s*'+escape(this.r.target_id)+'(?!\\d)').test(text))fail('browser_detail_identity_unverified','详情未显示本次任务ID',409);await this.record('detail.read','read_verified',{target_id:this.r.target_id,text});
      await this.cancel();
      return {read:{...before,detail:text.slice(0,2000)}};
    }
    this.before=this.r.action==='create'?null:await this.readCurrent();
    await this.clearSelection();
    if(['pause','resume','stop','delete'].includes(this.r.action)) {
      const row=await this.row(this.r.target_id); await row.hover({timeout:this.clock.timeout(5000)});
      this.submit=await this.control(row,({pause:['暂停'],resume:['开启','恢复'],stop:['停止'],delete:['删除']})[this.r.action],this.r.action+'.control');
      this.requested=requestedValues(this.r);
      return {before:this.before,requested:this.requested}; // Do not click a potentially immediate write during preview/preflight.
    }
    if(this.r.action==='create') {
      // The material selection and bidding mode must be visibly available. No first-row fallback.
      if(this.r.assist_task)await(await this.control(this.page,['一键起量'],'create.assist.open')).click({timeout:this.clock.timeout(5000)});
      else {
        await(await this.textControl('素材追投','tab.materials')).click({timeout:this.clock.timeout(5000)});
        for(const id of this.r.mids) { const row=this.page.getByRole('row').filter({hasText:new RegExp('(?:素材)?ID\\s*[:：#]\\s*'+escape(id)+'(?!\\d)')}); await row.waitFor({state:'visible',timeoutMs:this.clock.timeout(5000)});if(await row.count()!==1)fail('browser_material_ambiguous','素材行不唯一或不在当前页',409);const box=row.getByRole('checkbox');if(await box.count()!==1)fail('browser_material_selection_unverified','素材选择框未核验',423);await box.check({timeout:this.clock.timeout(5000)});await this.record('material.select.'+id,'read_verified',{material_id:id}); }
        await(await this.control(this.page,['追投','新建追投'],'create.open')).click({timeout:this.clock.timeout(5000)});
      }
    } else {
      const row=await this.row(this.r.target_id);
      const names=({pause:['暂停'],resume:['开启','恢复'],stop:['停止'],delete:['删除']})[this.r.action] || ['编辑','修改'];
      // Row controls can be exposed on hover; selection remains scoped to the exact task.
      await row.hover({timeout:this.clock.timeout(5000)});
      await(await this.control(row,names,this.r.action+'.open')).click({timeout:this.clock.timeout(5000)});
    }
    this.form=await this.dialog();await this.record(this.r.action+'.form','opened',{target_id:this.r.target_id||null,text:await this.form.innerText()});
    if(this.r.action==='create' && !this.r.assist_task) {
      const mode=this.r.bid!=null?['手动出价追投','手动出价']:this.r.roi_goal!=null?['控成本追投']:['放量追投'];
      const radios=await this.form.getByRole('radio').evaluateAll((els,mode)=>els.map((el,index)=>({index,label:(el.getAttribute('aria-label')||el.parentElement?.innerText||'').trim()})).filter(el=>mode.includes(el.label)),mode);
      if(radios.length!==1)fail('browser_bidding_mode_pending_verification','无法唯一核对追投模式',423);
      await this.form.getByRole('radio').nth(radios[0].index).check({timeout:this.clock.timeout(5000)}); await this.record('create.mode','read_verified',{label:radios[0].label});
    }
    const fields=await this.fields(this.form);const old=this.fieldValues(fields);
    if(this.before)this.before={...this.before,...old};
    const checkedModes=await this.form.getByRole('radio').evaluateAll(els=>els.filter(el=>el.checked||el.getAttribute('aria-checked')==='true').map(el=>(el.getAttribute('aria-label')||el.parentElement?.innerText||'').trim()));
    if(this.before && checkedModes.length===1 && ['放量追投','有限期放量'].includes(checkedModes[0]))this.before.smart_bid_type=7;
    this.requested=requestedValues(this.r);
    this.submit=await this.control(this.form,['确定','确认','提交','保存','创建'],this.r.action+'.submit');
    if(fields.roi_goal) {
      const label=fields.roi_goal.label;
      this.optimization={deepExternalActionName:/综合营销/.test(label)?'综合营销ROI':/净成交|1小时/.test(label)?'净成交ROI':/支付/.test(label)?'支付ROI':null,isOverallRoi:/综合营销/.test(label)?true:null};
    }
    if(this.r.action==='update_audience') {
      this.before.audience=await this.audienceFields(this.form,false);
      this.requested={audience:getTemplate(this.r.audience_template)};
      for(const key of ['City','Age'])this.requested.audience[key].sort();
      await this.audienceFields(this.form,true);
    }
    for(const [key,value]of Object.entries(this.requested)) {
      if(['status','material_ids','audience'].includes(key))continue;
      const f=fields[key];if(!f||f.disabled)fail('browser_field_pending_verification','缺少可编辑字段：'+key,423);
      if(key==='duration_seconds' && !f.unit)fail('browser_duration_unit_unknown','时长单位未核验，不能按小时猜测',423);
      const expected=key==='duration_seconds' && f.unit==='hours'?value/3600:value;
      const input=this.form.locator('input,textarea,select').nth(f.index);
      await input.fill(String(expected),{timeout:this.clock.timeout(5000)});
      if(await input.inputValue()!==String(expected))fail('browser_form_value_mismatch','填写后字段不匹配',409);
      await this.record(this.r.action+'.fill.'+key,'read_verified',{field:key,requested:value,display_value:expected,unit:f.unit});
    }
    return {before:this.before,requested:this.requested};
  }
  async cancel() {
    if(!this.form)return;
    await(await this.control(this.form,['取消','关闭'],'form.cancel')).click({timeout:this.clock.timeout(5000)});
    await this.form.waitFor({state:'hidden',timeoutMs:this.clock.timeout(5000)});
    await this.record('form.cancel','read_verified',{submitted:false});this.form=null;
  }
  async submitOnce(markDispatched) {
    await this.identity();this.clock.timeout(5000);
    // Register the outcome waiter before the click. Polling is condition-based, not a sleep.
    const baseline=await this.page.getByRole('alert').allTextContents();
    const outcomeArgs={baseline,targetId:this.r.target_id,requested:this.requested,confirmationAllowed:['pause','resume','stop','delete'].includes(this.r.action)};
    const outcomePromise=this.adapter.waitForFunction(observeOutcome,outcomeArgs,{timeout:this.clock.timeout(15000),polling:'raf'}).catch(error=>({unknown:true,code:error.code||'browser_outcome_timeout'}));
    await markDispatched(); this.dispatched=true;
    await this.submit.click({timeout:this.clock.timeout(5000)});
    let outcome=await outcomePromise;
    if(outcome.confirmation) {
      const dialog=await this.dialog();await this.record('confirmation','opened',{text:await dialog.innerText()});
      const confirm=await this.control(dialog,['确定','确认'],this.r.action+'.confirm');
      const confirmed=this.adapter.waitForFunction(observeOutcome,{...outcomeArgs,confirmationAllowed:false},{timeout:this.clock.timeout(15000),polling:'raf'}).catch(()=>({unknown:true,code:'browser_outcome_timeout'}));
      await confirm.click({timeout:this.clock.timeout(5000)});outcome=await confirmed;
    }
    await this.record(this.r.action+'.outcome',outcome.accepted?'opened':'attempt_failed',outcome);
    if(outcome.accepted===false) return {status_code:1,upstream_rejected:true,platform_message:outcome.text};
    if(outcome.unknown)return {status_code:0,confirmation_pending:true,confirmation_reason:outcome.code};
    return {status_code:0};
  }
  async readback() {
    await this.refresh(); const target=await this.readCurrent();
    const missing=Object.keys(this.requested).filter(key=>target[key]==null);
    if(this.r.action==='update_audience' || missing.some(key=>['budget','duration_seconds','roi_goal','bid','material_ids'].includes(key))) {
      await(await this.control(await this.row(target.id),['编辑','修改'],'readback.edit.open')).click({timeout:this.clock.timeout(5000)});
      this.form=await this.dialog();Object.assign(target,this.fieldValues(await this.fields(this.form)));
      if(target.duration_seconds!=null){target.duration_seconds_source='refreshed_browser_form';target.duration_seconds_unit='seconds';}
      if(this.r.action==='update_audience')target.audience=await this.audienceFields(this.form,false);
      if(this.r.action==='create' && this.requested.material_ids){const text=await this.form.innerText();const ids=[...text.matchAll(/素材ID\s*[:：#]\s*(\d+)/g)].map(m=>m[1]);if(ids.length)target.material_ids=[...new Set(ids)].sort();}
      await this.cancel();
    }
    // A refreshed table value is evidence. Filled form values are never returned as write readback.
    if(this.r.action==='create') {
      if(target.name!==this.r.name)fail('browser_create_name_mismatch','新任务名称不匹配',409);
      if(!target.id)fail('browser_created_id_unknown','未取得新任务ID',409);
    }
    await this.record('write.readback','read_verified',{actual:target});return target;
  }
  guardReaders() {
    const self=this;
    // Current-page data cannot be promoted to a complete list. Missing session fields fail closed.
    const scopePromise=this.page.domSnapshot().then(text=>{
      const room=text.match(/直播间\s*ID\s*[:：]\s*(\d+)/),start=text.match(/开播时间\s*[:：]\s*(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)/),end=text.match(/下播时间\s*[:：]\s*(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)/);
      const flag=/关联直播间未开播/.test(text)?false:/直播状态\s*[:：]\s*直播中/.test(text)?true:null;
      return {room:room?.[1],start:start?.[1],end:end?.[1],live:flag};
    });
    return {
      async fetchLiveStatus() {const s=await scopePromise;if(s.live===null||!s.room||!s.start)return {error:'browser_live_scope_unverified',data_valid:false};return {isLive:s.live,rooms:s.live?[{roomId:s.room,startTime:s.start}]:[]};},
      async fetchLiveSessions() {const s=await scopePromise;return {data_valid:!!(s.room&&s.start&&s.live!==null),sessions:s.room&&s.start?[{roomId:s.room,startTime:s.start,endTime:s.end,status:s.live?'2':s.end?'4':null}]:[]};},
      async fetchBoostList() { return {status_code:0,truncated:!self.complete,data_valid:true,data:{adInfos:self.targets.map(t=>({id:t.id,status:t.status,adDeliveryName:t.status_label,budget:t.budget==null?null:t.budget*100000,createTime:t.create_time})),adStatsMap:Object.fromEntries(self.targets.map(t=>[t.id,{metrics:{statCostForRoi2Assist:t.cost,totalPayOrderCountForRoi2Assist:t.orders,totalPrepayAndPayOrderRoi2Assist:t.payment_roi}}]))}}; },
    };
  }
}
module.exports={BrowserBoostPage,tableTargets,number,duration,status,PATH_TYPES};
