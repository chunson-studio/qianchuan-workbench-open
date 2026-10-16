// 仅在 Codex cua_repl 中调用；不是独立 Node / Playwright 浏览器入口。
// 读取旧版全域调控池，无广告写入。每页读取前重新选择状态，避免跨页共享筛选。
// cfg: advertiser_id, primary_ad_id, date, pool（调控中 / 手动暂停）, on_checkpoint。
var readQianchuanControlPool = async function(tab, cfg) {
  const started = Date.now();
  let lastDom = '';
  const pool = cfg.pool;
  const stamp = async (id, status, extra = {}) => {
    await cfg.on_checkpoint({ channel: 'codex-cua', id, status, pool,
      captured_at: new Date().toISOString(), elapsed_ms: Date.now() - started,
      tab_id: tab.id, advertiser_id: cfg.advertiser_id,
      primary_ad_id: cfg.primary_ad_id, date: cfg.date, dom: lastDom, ...extra });
  };
  const identity = async () => {
    const u = new URL(await tab.url());
    if (u.protocol !== 'https:' || u.hostname !== 'qianchuan.jinritemai.com' ||
        u.pathname !== '/uni-prom/detail' || u.searchParams.get('aavid') !== cfg.advertiser_id ||
        u.searchParams.get('adId') !== cfg.primary_ad_id) throw new Error('账户或主计划URL不匹配');
    await tab.playwright.getByText('计划ID：' + cfg.primary_ad_id, {exact:true}).waitFor({state:'visible',timeoutMs:5000});
    await tab.playwright.getByText('ID：' + cfg.advertiser_id, {exact:true}).waitFor({state:'visible',timeoutMs:5000});
    const dates = await tab.playwright.getByRole('textbox', {name:/请选择开始日期|请选择结束日期/})
      .evaluateAll(es => es.map(e => e.value));
    if (dates.length !== 2 || dates.some(d => d !== cfg.date)) throw new Error('日期范围不匹配');
  };
  const filterValue = () => tab.playwright.getByRole('textbox', {name:'请选择',exact:true})
    .nth(2).evaluate(e => e.value);
  try {
    if (!cfg.advertiser_id || !cfg.primary_ad_id || !cfg.date ||
        !['调控中','手动暂停'].includes(pool) || typeof cfg.on_checkpoint !== 'function') {
      throw new Error('缺少绑定、调控池或即时留证回调');
    }
    if (await tab.playwright.getByRole('button',{name:'提交',exact:true}).isVisible()) {
      throw new Error('已有未提交表单，不改变其列表筛选');
    }
    await identity();
    lastDom = await tab.playwright.domSnapshot();
    await stamp('control.pool.identity', 'read_verified');
    if (await tab.playwright.getByRole('textbox', {name:'请选择',exact:true}).count() !== 3) {
      throw new Error('当前不是已验证的调控列表筛选结构');
    }
    // 显式单页复用：当前DOM筛选已匹配时仍排序刷新，并在刷新后再次核身份与筛选。
    // 默认保留旧跨页重选行为；此选项不跳过表格刷新或完整性核验。
    if (cfg.reuse_current_filter !== true || await filterValue() !== pool) {
      // 即便本页当前显示目标状态也重新选择：另一页可能已经改变共享筛选。
      if (!(await tab.playwright.getByText('全部（包括已删除）',{exact:true}).filter({visible:true}).count())) {
        await tab.playwright.getByRole('textbox', {name:'请选择',exact:true}).nth(2).click();
      }
      await tab.getAXState({emit:false});
      if (pool === '手动暂停') {
        await tab.playwright.getByText('已暂停', {exact:true}).filter({visible:true}).last().click();
        await tab.getAXState({emit:false});
        await tab.playwright.getByText('手动暂停', {exact:true}).filter({visible:true}).last().click();
        await tab.getAXState({emit:false});
      } else {
        await tab.playwright.getByText('调控中', {exact:true}).filter({visible:true}).last().click();
        await tab.getAXState({emit:false});
      }
    }
    lastDom = await tab.playwright.domSnapshot();
    if (await filterValue() !== pool) throw new Error('目标状态筛选未生效');
    await stamp('control.pool.filter', 'read_verified');
    const refresh_started_at = new Date().toISOString();
    await tab.playwright.getByRole('columnheader', {name:'调控消耗',exact:true}).click();
    await tab.getAXState({emit:false});
    await identity();
    lastDom = await tab.playwright.domSnapshot();
    if (await filterValue() !== pool) throw new Error('刷新后筛选被另一页改变');
    const refresh_completed_at = new Date().toISOString();
    await stamp('control.pool.sort_refresh', 'read_verified', {refresh_started_at, refresh_completed_at});
    const cells = await tab.playwright.getByRole('row').filter({hasText:'ID:'})
      .evaluateAll(es => es.map(e => Array.from(e.querySelectorAll('td')).map(c => c.innerText)));
    const counts = [...lastDom.matchAll(/共\s*(\d+)\s*条(?:记录|任务)/g)].map(m => Number(m[1]));
    const emptyVerified = cells.length === 0 && counts.length > 0 && counts.every(n => n === 0)
      && /暂无数据/.test(lastDom) && !/加载中|正在加载|加载失败|请求失败|Loading/i.test(lastDom);
    if (!counts.length || counts.some(n => n !== cells.length) || (cells.length === 0 && !emptyVerified)) {
      throw new Error('调控列表分页不完整或未加载完成');
    }
    const headers = await tab.playwright.getByRole('columnheader').allTextContents({timeoutMs:5000});
    const hasVisibleNetColumn = headers.some(h => h.trim() === '调控净成交ROI');
    if (!['任务名称','调控状态','调控消耗'].every(label => headers.some(h => h.trim() === label))) {
      throw new Error('调控列表表头未核验');
    }
    const rateCell = (cells, label) => cells[headers.findIndex(h => h.trim() === label)]?.trim() || '';
    const expectedCellCount = hasVisibleNetColumn ? 17 : 16;
    const ids = new Set();
    const tasks = cells.map(c => {
      const id = c[1]?.match(/ID:\s*(\d+)/)?.[1];
      if (c.length !== expectedCellCount || !id || ids.has(id) ||
          (pool === '调控中' ? c[3] !== '调控中' : !c[3].includes('手动暂停'))) {
        throw new Error('行结构、任务ID或状态不匹配');
      }
      ids.add(id);
      const numeric = v => /^\d+(?:\.\d+)?$/.test(v?.trim() || '') ? Number(v) : null;
      return {task_id:id, name:c[1].split('\n')[0], status:c[3], budget:numeric(c[4]),
        duration_hours:numeric(c[8].split('\n')[0]), cost:numeric(c[11]),
        payment_roi:numeric(c[12]), payment_orders:numeric(c[13]),
        ctr_pct:/^\d+(?:\.\d+)?%$/.test(rateCell(c,'调控点击率'))?Number(rateCell(c,'调控点击率').slice(0,-1)):null,
        conversion_rate_pct:/^\d+(?:\.\d+)?%$/.test(rateCell(c,'调控转化率'))?Number(rateCell(c,'调控转化率').slice(0,-1)):null,
        rate_source:'browser_调控点击率_调控转化率',
        displayed_net_roi:hasVisibleNetColumn?numeric(c[16]):null,
        displayed_net_roi_basis:hasVisibleNetColumn?'browser_调控净成交ROI_口径待核验':null,
        created_at_text:c[10], raw_cells:c};
    });
    const result = {ok:true, channel:'codex-cua', status:'read_verified', ad_writes:0,
      binding:{advertiser_id:cfg.advertiser_id,primary_ad_id:cfg.primary_ad_id,date:cfg.date,tab_id:tab.id},
      pool, complete:true, total:cells.length, empty_verified:emptyVerified, headers, tasks, refresh_started_at, refresh_completed_at,
      captured_at:new Date().toISOString(), elapsed_ms:Date.now()-started};
    await stamp('control.pool.table', 'read_verified', {result});
    return result;
  } catch (error) {
    const result = {ok:false, channel:'codex-cua', status:'read_failed', ad_writes:0,
      pool, complete:false, error:String(error.message || error), elapsed_ms:Date.now()-started};
    if (typeof cfg.on_checkpoint === 'function') await stamp('control.pool.failure', 'read_failed', {result});
    return result;
  }
};
// 已走通的“刷新在投 -> 零单阈值 -> 精确ID多选 -> 暂停确认 -> 暂停池回读”。
// cfg 还需 target_ids、reason、execute；可传 zero_order_cost 限制为零单阈值暂停。
// paused_tab 可指定独立回读页。调用者负责当前业务策略、场次及ROI来源核验。
// 阈值由当前用户任务传入，不是平台规则。当前恢复权限由调用者核对。
var replayQianchuanControlPause = async function(tab, cfg) {
  let submitted = false;
  const targetIds = [...new Set((cfg.target_ids || cfg.trial_ids || []).map(String))];
  const threshold = cfg.zero_order_cost;
  const zeroOrderOnly = threshold !== undefined;
  const pausedTab = cfg.paused_tab || tab;
  let before = [];
  let pauseIds = [];
  const checkpoint = async (id, status, extra = {}) => cfg.on_checkpoint({
    channel:'codex-cua', id, status, captured_at:new Date().toISOString(),
    tab_id:tab.id, advertiser_id:cfg.advertiser_id, primary_ad_id:cfg.primary_ad_id,
    date:cfg.date, target_ids:pauseIds, dom:await tab.playwright.domSnapshot(), ...extra
  });
  try {
    if (!targetIds.length || (zeroOrderOnly && (!Number.isFinite(threshold) || threshold <= 0)) ||
        (!zeroOrderOnly && !cfg.reason) || typeof cfg.on_checkpoint !== 'function') {
      throw new Error('缺少目标ID、明确暂停依据或留证回调');
    }
    const cached = cfg.active_snapshot;
    const cachedAge = cached ? Date.now() - Date.parse(cached.captured_at) : Infinity;
    const reusable = cached?.ok && cached.complete && cached.pool === '调控中' &&
      cached.binding?.advertiser_id === cfg.advertiser_id && cached.binding?.primary_ad_id === cfg.primary_ad_id &&
      cached.binding?.date === cfg.date && cached.binding?.tab_id === tab.id && cachedAge >= 0 && cachedAge <= 30000;
    const active = reusable ? cached : await readQianchuanControlPool(tab, {...cfg,pool:'调控中'});
    if (!active.ok) throw new Error(active.error);
    before = active.tasks.filter(t => targetIds.includes(t.task_id));
    const candidates = zeroOrderOnly ? before.filter(t => t.cost !== null && t.cost >= threshold && t.payment_orders === 0) : before;
    pauseIds = candidates.map(t => t.task_id);
    if (!pauseIds.length || cfg.execute !== true) {
      return {ok:true, mode:cfg.execute === true?'no_action':'dry_run', ad_writes:0,
        target_ids:pauseIds, before, missing_from_active:targetIds.filter(id=>!before.some(t=>t.task_id===id))};
    }
    const selected = await tab.playwright.getByRole('checkbox').evaluateAll(es =>
      es.filter(e => e.checked || e.getAttribute('aria-checked') === 'true').length);
    if (selected) throw new Error('已有选中任务，不覆盖人工批量选择');
    await checkpoint('control.pause.intent','prepared',{before:candidates,zero_order_cost:threshold,reason:cfg.reason});
    for (const id of pauseIds) {
      const row = tab.playwright.getByRole('row').filter({hasText:'ID: ' + id});
      if (await row.count() !== 1) throw new Error('暂停目标ID不唯一');
      await row.getByRole('checkbox').check();
      await tab.getAXState({emit:false});
      await checkpoint('control.row.select','read_verified',{task_id:id});
    }
    const selectedIds = await tab.playwright.getByRole('row').filter({hasText:'ID:'})
      .evaluateAll(es => es.filter(e => Array.from(e.querySelectorAll('input,[role="checkbox"]'))
        .some(c => c.checked || c.getAttribute('aria-checked') === 'true'))
        .map(e => e.innerText.match(/ID:\s*(\d+)/)?.[1]));
    if (selectedIds.length !== pauseIds.length || selectedIds.some(id => !pauseIds.includes(id))) {
      throw new Error('选中ID与暂停清单不一致');
    }
    await tab.playwright.getByRole('button',{name:'暂停',exact:true}).click();
    await tab.getAXState({emit:false});
    const dom = await tab.playwright.domSnapshot();
    const expected = '确定暂停所选的' + pauseIds.length + '条任务吗？';
    if (!dom.includes(expected)) throw new Error('暂停确认文案或数量不匹配');
    await checkpoint('control.pause.dialog','opened');
    submitted = true;
    await tab.playwright.getByRole('button',{name:'确定',exact:true}).click();
    await tab.getAXState({emit:false});
    await checkpoint('control.pause.submit','submitted');
    const paused = await readQianchuanControlPool(pausedTab,{...cfg,pool:'手动暂停'});
    if (!paused.ok || pauseIds.some(id => !paused.tasks.some(t => t.task_id === id))) {
      throw new Error('提交后未完整回读手动暂停状态');
    }
    const result = {ok:true, status:'write_verified', ad_writes:pauseIds.length,
      action:'pause', target_ids:pauseIds, before:candidates,
      after:paused.tasks.filter(t => pauseIds.includes(t.task_id)), paused_snapshot:paused, retry_write:false};
    await checkpoint('control.pause','write_verified',{result});
    return result;
  } catch (error) {
    const result = {ok:false, status:submitted?'unconfirmed':'not_submitted',
      ad_writes:submitted?null:0, target_ids:pauseIds, before,
      error:String(error.message || error), retry_write:false};
    if (typeof cfg.on_checkpoint === 'function') await checkpoint('control.pause.failure',result.status,{result});
    return result;
  }
};
var pauseQianchuanZeroOrderTrials = async function(tab,cfg) {
  if (!Number.isFinite(cfg.zero_order_cost)) throw new Error('缺少明确零单阈值');
  return replayQianchuanControlPause(tab,cfg);
};

// 旧版单条手动暂停任务恢复：本机已核验“开启”按钮、单条确认和在投回读。
// 不判断是否值得恢复；调用者必须按当前授权、人数和整体ROI提供reason。
var replayQianchuanControlResume = async function(tab,cfg) {
  let submitted = false;
  const ids = [...new Set((cfg.target_ids || []).map(String))];
  let before = [];
  const stamp = async (id,status,extra={}) => cfg.on_checkpoint({channel:'codex-cua',id,status,
    advertiser_id:cfg.advertiser_id,primary_ad_id:cfg.primary_ad_id,date:cfg.date,
    target_ids:ids,captured_at:new Date().toISOString(),dom:await tab.playwright.domSnapshot(),...extra});
  try {
    if (ids.length !== 1 || !cfg.reason || typeof cfg.on_checkpoint !== 'function') {
      throw new Error('恢复只使用已验证的单条路径，需精确ID、理由及即时留证');
    }
    const paused = await readQianchuanControlPool(tab,{...cfg,pool:'手动暂停'});
    if (!paused.ok) throw new Error(paused.error);
    before = paused.tasks.filter(t=>ids.includes(t.task_id));
    if (!before.length) return {ok:true,mode:'no_action',ad_writes:0,missing_from_paused:ids};
    if (cfg.execute !== true) return {ok:true,mode:'dry_run',ad_writes:0,target_ids:ids,before};
    const selected = await tab.playwright.getByRole('checkbox').evaluateAll(es=>
      es.some(e=>e.checked || e.getAttribute('aria-checked')==='true'));
    if (selected) throw new Error('已有人工选择，不覆盖草稿');
    await stamp('control.resume.intent','prepared',{before,reason:cfg.reason});
    const row = tab.playwright.getByRole('row').filter({hasText:'ID: ' + ids[0]});
    if (await row.count() !== 1) throw new Error('恢复目标ID不唯一');
    await row.getByRole('checkbox').check();
    await tab.getAXState({emit:false});
    await stamp('control.resume.row_select','read_verified');
    const selectedIds = await tab.playwright.getByRole('row').filter({hasText:'ID:'}).evaluateAll(es=>
      es.filter(e=>Array.from(e.querySelectorAll('input,[role="checkbox"]')).some(c=>
        c.checked || c.getAttribute('aria-checked')==='true')).map(e=>e.innerText.match(/ID:\s*(\d+)/)?.[1]));
    if (selectedIds.length !== 1 || selectedIds[0] !== ids[0]) throw new Error('恢复选中ID不匹配');
    await tab.playwright.getByRole('button',{name:'开启',exact:true}).click();
    await tab.getAXState({emit:false});
    if (!(await tab.playwright.domSnapshot()).includes('确定开启所选的1条任务吗？')) {
      throw new Error('恢复确认数量或文案不匹配');
    }
    await stamp('control.resume.dialog','opened');
    submitted = true;
    await tab.playwright.getByRole('button',{name:'确定',exact:true}).click();
    await tab.getAXState({emit:false});
    await stamp('control.resume.submit','submitted');
    const active = await readQianchuanControlPool(cfg.active_tab || tab,{...cfg,pool:'调控中'});
    const after = active.tasks?.filter(t=>ids.includes(t.task_id));
    if (!active.ok || after?.length !== 1 || after[0].budget !== before[0].budget ||
        after[0].duration_hours !== before[0].duration_hours) throw new Error('恢复后状态或参数未回读确认');
    const result = {ok:true,status:'write_verified',action:'resume',ad_writes:1,target_ids:ids,
      before,after,active_snapshot:active,captured_at:new Date().toISOString(),retry_write:false};
    await stamp('control.resume','write_verified',{result});
    return result;
  } catch(error) {
    const result = {ok:false,status:submitted?'unconfirmed':'not_submitted',ad_writes:submitted?null:0,
      target_ids:ids,before,error:String(error.message||error),retry_write:false};
    if(typeof cfg.on_checkpoint==='function') await stamp('control.resume.failure',result.status,{result});
    return result;
  }
};

// 旧版单条时长修改：先点击行状态显示已验证的铅笔，再编辑第二个“请输入”。
// requested_hours与expected_hours/expected_budget由当轮判断显式传入，不固定调3小时。
var replayQianchuanControlDuration = async function(tab,cfg) {
  let submitted = false;
  let before = null;
  const stamp = async (id,status,extra={}) => cfg.on_checkpoint({channel:'codex-cua',id,status,
    advertiser_id:cfg.advertiser_id,primary_ad_id:cfg.primary_ad_id,date:cfg.date,
    task_id:cfg.task_id,captured_at:new Date().toISOString(),dom:await tab.playwright.domSnapshot(),...extra});
  try {
    if (!cfg.task_id || !cfg.reason || !Number.isFinite(cfg.requested_hours) ||
        cfg.requested_hours < 0.5 || cfg.requested_hours > 24 ||
        !Number.isFinite(cfg.expected_hours) || !Number.isFinite(cfg.expected_budget) ||
        typeof cfg.on_checkpoint !== 'function') throw new Error('缺少时长、前值、依据或留证回调');
    const active = await readQianchuanControlPool(tab,{...cfg,pool:'调控中'});
    if (!active.ok) throw new Error(active.error);
    before = active.tasks.find(t=>t.task_id===String(cfg.task_id));
    if (!before || before.duration_hours !== cfg.expected_hours || before.budget !== cfg.expected_budget) {
      throw new Error('目标或预算/时长前值已变化，重新判断');
    }
    if (cfg.requested_hours === before.duration_hours || cfg.execute !== true) {
      return {ok:true,mode:cfg.execute===true?'no_action':'dry_run',ad_writes:0,before,
        requested_hours:cfg.requested_hours};
    }
    const selected = await tab.playwright.getByRole('checkbox').evaluateAll(es=>
      es.some(e=>e.checked || e.getAttribute('aria-checked')==='true'));
    if (selected) throw new Error('已有人工选择，不覆盖草稿');
    await stamp('control.duration.intent','prepared',{before,requested_hours:cfg.requested_hours,reason:cfg.reason});
    const row = tab.playwright.getByRole('row').filter({hasText:'ID: ' + cfg.task_id});
    if (await row.count() !== 1) throw new Error('时长目标ID不唯一');
    await row.getByText('调控中',{exact:true}).click();
    await tab.getAXState({emit:false});
    await stamp('control.duration.actions_reveal','opened');
    const edit = row.locator('iconpark-icon[name="oc-icon-light-edit"]');
    if (await edit.count() !== 1 || !(await edit.isVisible())) throw new Error('已验证的编辑按钮不可见');
    await edit.click();
    await tab.getAXState({emit:false});
    await stamp('control.duration.edit_open','opened');
    const inputs = tab.playwright.getByRole('textbox',{name:'请输入',exact:true});
    const values = await inputs.evaluateAll(es=>es.map(e=>e.value));
    const name = await tab.playwright.getByRole('textbox',{name:'请输入任务名称，1-50个字符',exact:true})
      .evaluate(e=>e.value);
    if (values.length !== 2 || Number(values[0]) !== before.budget ||
        Number(values[1]) !== before.duration_hours || name !== before.name) throw new Error('编辑表单对象或参数不匹配');
    await inputs.nth(1).fill(String(cfg.requested_hours));
    await inputs.nth(1).press('Tab');
    await tab.getAXState({emit:false});
    const edited = await inputs.evaluateAll(es=>es.map(e=>e.value));
    if (edited.length !== 2 || Number(edited[0]) !== before.budget || Number(edited[1]) !== cfg.requested_hours) {
      throw new Error('受控输入尚未生效');
    }
    await stamp('control.duration.form','read_verified',{values:edited});
    submitted = true;
    await tab.playwright.getByRole('button',{name:'提交',exact:true}).click();
    await tab.getAXState({emit:false});
    await stamp('control.duration.submit','submitted');
    await tab.playwright.getByRole('button',{name:'提交',exact:true}).waitFor({state:'hidden',timeoutMs:10000});
    const afterPool = await readQianchuanControlPool(tab,{...cfg,pool:'调控中'});
    const after = afterPool.tasks?.find(t=>t.task_id===String(cfg.task_id));
    if (!afterPool.ok || after?.duration_hours !== cfg.requested_hours || after?.budget !== before.budget) {
      throw new Error('提交后时长或预算未回读确认');
    }
    const result = {ok:true,status:'write_verified',action:'update_duration',ad_writes:1,
      task_id:cfg.task_id,before,after,active_snapshot:afterPool,captured_at:new Date().toISOString(),retry_write:false};
    await stamp('control.duration','write_verified',{result});
    return result;
  } catch(error) {
    const result = {ok:false,status:submitted?'unconfirmed':'not_submitted',ad_writes:submitted?null:0,
      task_id:cfg.task_id,before,error:String(error.message||error),retry_write:false};
    if(typeof cfg.on_checkpoint==='function') await stamp('control.duration.failure',result.status,{result});
    return result;
  }
};

// 一次调用读取整轮；不把业务判断固化为自动暂停或自动恢复。
// MCP回调可选：浏览器已取得的整体实时净ROI、支付ROI及两池差分可独立使用。
// 若补读平台1小时净ROI，单独核验来源时效，不能覆盖罗盘整体指标。
var runQianchuanBrowserRound = async function(tabs,cfg) {
  const started = Date.now();
  if (!cfg.account_id || !cfg.room_id || cfg.execute === true ||
      !Number.isFinite(cfg.min_net_roi) || !Number.isFinite(cfg.online_cap) ||
      !Number.isFinite(cfg.response_wait_ms) || !Number.isFinite(Date.parse(cfg.live_start_time)) ||
      typeof cfg.on_checkpoint !== 'function') {
    throw new Error('需整轮绑定、当前策略参数与留证回调；整轮只读取，动作另传明确判断');
  }
  const observeLive = async () => {
    const u = new URL(await tabs.live_tab.url());
    if (u.hostname !== 'compass.jinritemai.com' || u.searchParams.get('live_room_id') !== cfg.room_id) {
      throw new Error('罗盘房间不匹配');
    }
    const dom = await tabs.live_tab.playwright.domSnapshot();
    const start = new Date(Date.parse(cfg.live_start_time) + 8 * 3600000).toISOString();
    const visibleStart = start.slice(0,10).replace(/-/g,'/') + ' ' + start.slice(11,16);
    if (!dom.includes('开播时间' + visibleStart)) throw new Error('罗盘开播日期时刻不匹配');
    const values = await tabs.live_tab.playwright.evaluate(() => {
      const label = text => Array.from(document.querySelectorAll('span')).find(e=>e.innerText===text);
      const small = text => {
        const raw = label(text)?.parentElement?.parentElement?.innerText;
        const match = raw?.replace(/,/g,'').match(/\n¥?\s*(\d+(?:\.\d+)?)/);
        return match?Number(match[1]):null;
      };
      let gmvCard = label('直播间成交金额');
      for(let i=0;i<4;i++) gmvCard=gmvCard?.parentElement;
      const digits = Array.from(gmvCard?.querySelectorAll('.odometer-digit') || []);
      // 动画期间可能包含多个过渡数字；这时保留未知，不拼全部数字。
      const stable = digits.length>0 && digits.every(e=>e.querySelectorAll('.odometer-value').length===1);
      const inside = gmvCard?.querySelector('.odometer-inside');
      const displayed = stable?Array.from(inside?.children || []).map(e=>
        e.classList.contains('odometer-digit')?e.querySelector('.odometer-value').innerText:e.innerText).join(''):null;
      const gmv = displayed && /^\d+(?:,\d{3})*(?:\.\d+)?$/.test(displayed)?Number(displayed.replace(/,/g,'')):null;
      return {gmv,gmv_displayed:displayed,refund:small('退款金额'),cost:small('千川消耗') ?? small('投放消耗(店铺绑定)'),
        online:small('实时在线人数')};
    });
    const trafficDom = dom.slice(dom.indexOf('- generic: 近5分钟数据'),dom.indexOf('- generic: 实时评论'));
    const trafficValue = label => {
      const escaped=label.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      const m=trafficDom.match(new RegExp('- (?:generic|text): '+escaped+'\\n- (?:generic|text): [¥"]?(\\d+(?:,\\d{3})*(?:\\.\\d+)?)'));
      return m?Number(m[1].replace(/,/g,'')):null;
    };
    const onlineFallback = dom.match(/(?:generic|text): 实时在线人数\n- (?:generic|text): "?(\d+)"?/);
    if (values.online===null && onlineFallback) values.online=Number(onlineFallback[1]);
    const valid = values.gmv!==null && values.refund!==null && values.cost>0;
    const result = {room_id:cfg.room_id,live_start_time:cfg.live_start_time,
      ...values,net_gmv:valid?values.gmv-values.refund:null,
      net_roi:valid?(values.gmv-values.refund)/values.cost:null,
      roi_basis:'compass_normal_gmv_minus_refund_over_shop_cost',data_valid:valid,
      five_minutes:{updated_at_text:trafficDom.match(/(\d{2}:\d{2})更新/)?.[1] || null,
        payment_gmv:trafficValue('成交金额') ?? trafficValue('用户支付金额'),online:trafficValue('在线人数'),
        enters:trafficValue('进入人数'),leaves:trafficValue('离开人数')},captured_at:new Date().toISOString(),
      refresh_method:'平台自动更新',dom};
    await cfg.on_checkpoint({channel:'codex-cua',id:'compass.auto.observe',status:'read_verified',...result});
    return result;
  };
  const hasMcp = typeof cfg.read_net_metrics==='function';
  // 状态筛选跨页共享：默认同一页面先读暂停池，再读在投池；不并发切换。
  const controlTab = tabs.control_tab || tabs.active_tab;
  const paused = await readQianchuanControlPool(controlTab,{...cfg,pool:'手动暂停'});
  const [activeResult,metricResult,liveResult] = await Promise.allSettled([
    readQianchuanControlPool(controlTab,{...cfg,pool:'调控中'}),hasMcp?cfg.read_net_metrics():Promise.resolve(null),observeLive()
  ]);
  const issues = [];
  const active = activeResult.status === 'fulfilled' ? activeResult.value : null;
  const metrics = metricResult.status === 'fulfilled' ? metricResult.value : null;
  const live = liveResult.status === 'fulfilled' ? liveResult.value : null;
  if (!active?.ok) issues.push(active?.error || '在投读取失败');
  if (!live) issues.push('罗盘身份或读取失败');
  const age = metrics ? Date.now() - Date.parse(metrics.source_at) : Infinity;
  const metricValid = metrics?.ok && metrics.data_valid && !metrics.truncated &&
    metrics.account === cfg.account_id && metrics.ad_id === cfg.primary_ad_id && age >= 0 && age <= 60000;
  if (cfg.require_net_metrics===true && !metricValid) issues.push('净ROI来源、身份、完整性或时效未通过');
  if (metrics) await cfg.on_checkpoint({channel:'qianchuan-mcp',id:'boost.net.observe',
    status:metricValid?'read_verified':'read_failed',captured_at:new Date().toISOString(),data:metrics});
  const metricMap = new Map((metricValid?metrics.tasks:[]).map(t=>[t.id,t]));
  const mergeNet = t=>{
    const m = metricMap.get(t.task_id);
    const inSession = Number(m?.create_time) >= Date.parse(cfg.live_start_time)/1000;
    const taskAge = Date.now()-Date.parse(m?.source_at);
    const netValid = inSession && m?.primary_ad_id === cfg.primary_ad_id &&
      m?.financial_checks?.net_roi?.data_valid === true && Number.isFinite(m.net_roi) &&
      m.metric_roi_basis?.net_roi === 'platform_net_1h' && m.cost > 0 && taskAge>=0 && taskAge<=60000 &&
      (t.status==='调控中'?m.status==='调控中':m.status==='已暂停');
    const {raw_cells,...compact}=t;
    return {...compact,net_roi:netValid?m.net_roi:null,net_roi_basis:'platform_net_1h',
      net_source_at:m?.source_at || null,net_data_valid:netValid};
  };
  const current = (active?.tasks || []).map(mergeNet);
  if (!paused.ok) issues.push(paused.error);
  const pausedTasks = (paused.tasks || []).map(mergeNet);
  const paymentBenchmark = cfg.payment_opportunity_roi ?? cfg.min_net_roi;
  const candidates = current.filter(t=>t.net_roi!==null&&t.net_roi<cfg.min_net_roi).map(t=>({
    task_id:t.task_id,net_roi:t.net_roi,payment_roi:t.payment_roi,
    review_kind:t.payment_orders>0&&t.payment_roi>=paymentBenchmark?'payment_opportunity':'review_pause'}));
  const recoveryCandidates = cfg.resume_allowed===true?pausedTasks.filter(t=>
    t.payment_orders>0 && t.payment_roi>=paymentBenchmark).map(t=>({task_id:t.task_id,
    payment_orders:t.payment_orders,payment_roi:t.payment_roi,net_roi:t.net_roi,
    review_kind:'review_recovery',automatic_action:false})):[];
  const captured_at = new Date().toISOString();
  const binding={account_id:cfg.account_id,advertiser_id:cfg.advertiser_id,primary_ad_id:cfg.primary_ad_id,
    room_id:cfg.room_id,live_start_time:cfg.live_start_time,date:cfg.date};
  const previous=cfg.previous_round;
  const comparable=previous?.ok===true && previous.binding?.room_id===cfg.room_id && previous.binding.account_id===cfg.account_id &&
    previous.binding.primary_ad_id===cfg.primary_ad_id && previous.binding.live_start_time===cfg.live_start_time &&
    previous.binding.date===cfg.date && Date.parse(previous.captured_at)<Date.parse(captured_at);
  const previousTasks=new Map((comparable?[...(previous.tasks || []),...(previous.paused_tasks || [])]:[])
    .map(t=>[t.task_id,t]));
  const difference=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)?Number((a-b).toFixed(4)):null;
  const changes=comparable?[...current,...pausedTasks].map(t=>{
    const p=previousTasks.get(t.task_id);
    return {task_id:t.task_id,previous_status:p?.status || null,status:t.status,
      cost_delta:difference(t.cost,p?.cost),orders_delta:difference(t.payment_orders,p?.payment_orders),
      payment_roi_delta:difference(t.payment_roi,p?.payment_roi),
      ctr_pct_delta:difference(t.ctr_pct,p?.ctr_pct),
      conversion_rate_pct_delta:difference(t.conversion_rate_pct,p?.conversion_rate_pct),
      duration_hours_delta:difference(t.duration_hours,p?.duration_hours)};
  }):[];
  const lastActionAt=cfg.last_action_at || cfg.last_pause_at;
  const elapsedSinceAction=lastActionAt?Date.now()-Date.parse(lastActionAt):null;
  const result = {ok:!issues.length,mode:'observe_and_decide',binding,
    captured_at,elapsed_ms:Date.now()-started,
    active_count_before:current.length,paused_count:paused.tasks?.length ?? null,online:live?.online ?? null,
    net_roi_source_at:metrics?.source_at || null,unknown_net_ids:current.filter(t=>t.net_roi===null).map(t=>t.task_id),issues,
    candidates,recovery_candidates:recoveryCandidates,actions:[],ad_writes:0,
    last_action_at:lastActionAt || null,response_window_pending:elapsedSinceAction!==null&&
      elapsedSinceAction>=0&&elapsedSinceAction<cfg.response_wait_ms,
    live:live?(({dom,...data})=>data)(live):null,tasks:current,paused_tasks:pausedTasks,
    delta:{comparable,window_start:comparable?previous.captured_at:null,window_end:captured_at,changes,
      live:comparable?{gmv:difference(live?.gmv,previous.live?.gmv),cost:difference(live?.cost,previous.live?.cost),
        refund:difference(live?.refund,previous.live?.refund),online:difference(live?.online,previous.live?.online)}:null},
    resume_allowed:cfg.resume_allowed===true};
  await cfg.on_checkpoint({channel:'codex-cua',id:'control.round',status:result.ok?'read_verified':'read_failed',
    captured_at:result.captured_at,result});
  return result;
};
if (typeof module !== 'undefined') module.exports = {readQianchuanControlPool,replayQianchuanControlPause,
  pauseQianchuanZeroOrderTrials,replayQianchuanControlResume,replayQianchuanControlDuration,runQianchuanBrowserRound};
