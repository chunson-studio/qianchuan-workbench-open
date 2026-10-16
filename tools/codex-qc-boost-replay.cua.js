// 在 Codex cua_repl 会话中加载并调用；不是独立 Node/Playwright CLI。
// 目标：把已经验证过的千川画面追投流程固化成短路径回放，避免每一步完整扫描页面。
// 默认 dry-run；只有显式传 execute:true 才会提交广告动作。

var replayQianchuanBoostCreate = async function(tab, cfg) {
  const started = Date.now();
  const trace = [];
  const receipts = [];
  let pendingSubmission = false;
  const stamp = (step, extra = {}) => trace.push({ step, elapsed_ms: Date.now() - started, ...extra });
  const requireValue = (key) => {
    if (cfg[key] === undefined || cfg[key] === null || cfg[key] === '') throw new Error(`缺少参数：${key}`);
    return cfg[key];
  };
  // Subsequent click/fill retains Playwright actionability checks. Some CUA
  // backends time out on waitFor even after returning a unique rendered match.
  const ready = async (locator, timeoutMs = 2500) => {
    await tab.getAXState({emit:false});
    if(await locator.count()===1)return;
    // One bounded wait, then inspect fresh state. Repeating the same stale
    // selector deadline adds latency without establishing new evidence.
    try {await locator.waitFor({ state: 'visible', timeoutMs });}
    catch(error) {
      await tab.getAXState({emit:false});
      // The backend supplies an exact-selector unique visible match even
      // when its separate wait command times out. The following click/fill
      // still performs actionability checks; no submission is repeated.
      if(await locator.count()!==1&&!/"matchCount":1[\s\S]*"visibleCount":1/.test(String(error.message)))throw error;
    }
  };
  const exactText = (value) => tab.playwright.getByText(value, { exact: true });
  const actionTimeout={timeoutMs:10000};

  const advertiserId = String(requireValue('advertiser_id'));
  const primaryAdId = String(requireValue('primary_ad_id'));
  const materialId = String(requireValue('material_id'));
  const count = Number(requireValue('count'));
  const budget = String(requireValue('budget'));
  const durationHours = String(requireValue('duration_hours'));
  if (cfg.material_type !== undefined && !['live_screen','video'].includes(cfg.material_type)) throw new Error('unsupported_material_type');
  if (!Number.isInteger(count) || count < 1 || count > 50) throw new Error('count 必须是 1-50 的整数');
  if (!/^\d+(?:\.\d+)?$/.test(budget) || Number(budget) <= 0) throw new Error('budget 必须是正数');
  if (!/^\d+(?:\.\d+)?$/.test(durationHours) || Number(durationHours) < 0.5 || Number(durationHours) > 24) throw new Error('duration_hours 必须在 0.5-24 之间');
  if (cfg.defer_readback === true && typeof cfg.readback_batch !== 'function') throw new Error('批次回读必须提供当前通道的原任务读取回调');

  const verifyIdentity = async () => {
    const url = new URL(await tab.url());
    if (url.protocol !== 'https:' || url.hostname !== 'qianchuan.jinritemai.com' || !['/overall-prom/detail', '/uni-prom/detail'].includes(url.pathname)) {
      throw new Error('当前页面不是已验证的千川计划详情页');
    }
    if (url.searchParams.get('aavid') !== advertiserId || url.searchParams.get('adId') !== primaryAdId) {
      throw new Error('页面账户或主计划与回放参数不匹配');
    }
    if (typeof cfg.validate_identity === 'function') await cfg.validate_identity();
    else {
      await ready(exactText(`计划ID：${primaryAdId}`));
      await ready(exactText(`ID：${advertiserId}`));
    }
    // URL 身份是主要闸门；日期由页面 URL 自带，避免为日期控件做全页扫描。
    return url.href;
  };

  const sectionTab = async (name) => {
    const modern = tab.playwright.getByRole('tab', { name, exact: true });
    const count = await modern.count();
    if (count === 1) return modern;
    if (count > 1) throw new Error('plan_tab_not_unique');
    const observed = [...(await tab.playwright.domSnapshot()).matchAll(/^\s*- tab "(Tab ([1-9]\d*) of ([1-9]\d*) ([^"]+))"/gm)]
      .filter(m => Number(m[2]) <= Number(m[3]) && m[4] === name);
    if (observed.length > 1) throw new Error('plan_tab_not_unique');
    if (observed.length === 1) {
      const prefixed = tab.playwright.getByRole('tab', {name:observed[0][1],exact:true});
      if (await prefixed.count() !== 1) throw new Error('plan_tab_not_unique');
      return prefixed;
    }
    return tab.playwright.getByText(name, { exact: true }).first();
  };
  const checkpoint = async (id, status, details = {}) => {
    if (cfg.on_checkpoint) await cfg.on_checkpoint({ channel: 'codex-cua', id, status, observed_at: new Date().toISOString(), ...details });
  };
  const openMaterials = async () => {
    let resolvedType=cfg.material_type;
    const row = tab.playwright.getByRole('row').filter({ hasText: materialId });
    // Observed full-domain and multiplication pages use different CSS prefixes.
    // Both wrappers were observed; exact text on a nested span may match twice.
    // Scope to the bound row and keep the unique-entry check for either layout.
    const entry = row.locator('span.oc-promotion-operation-action-item,span.main-vmok-plugin-oc-promotion-operation-action-item').filter({hasText:/^追投$/});
    // The bound row is the creation entry, not another material review. Reuse it
    // when it is already visible instead of clicking the same section again.
    if (await entry.count() !== 1 || !await entry.isVisible()) {
      const tabLocator = await sectionTab('素材');
      await ready(tabLocator);
      await tabLocator.click(actionTimeout);
      await tab.getAXState({ emit: false });
      stamp('materials_navigation');
    } else {
      stamp('materials_entry_reused');
    }
    // The page remembers its material subtype. Find this authorized ID before
    // opening a form; a video list is not proof that a live-screen ID is absent.
    if (await entry.count() !== 1 || !await entry.isVisible()) {
      const kinds = cfg.material_type ? [cfg.material_type] : ['live_screen','video'];
      for (const kind of kinds) {
        let option = kind === 'video'
          ? tab.playwright.locator('div.main-vmok-plugin-radio-item').filter({hasText:/^视频$/}).filter({visible:true})
          : exactText('直播间画面').filter({visible:true});
        if(kind==='live_screen'&&new URL(await tab.url()).pathname==='/overall-prom/detail') {
          const observed=tab.playwright.locator('div[data-e2e="oc_emptyKey_overall-prom/detail_4"]').filter({hasText:/^直播间画面$/}).filter({visible:true});
          if(await observed.count()===1)option=observed;
        }
        if (await option.count() !== 1) continue;
        await option.click(actionTimeout);await tab.getAXState({emit:false});
        await checkpoint('materials.category','opened',{material_type:kind,material_id:materialId});
        if (await entry.count() === 1 && await entry.isVisible()) {resolvedType=kind;break;}
      }
    }
    await ready(entry);
    if (await entry.count() !== 1) throw new Error('material_entry_not_unique');
    if (resolvedType) {
      const text = await row.innerText();
      if (!new RegExp('(?:素材)?ID\\s*[:：]\\s*'+materialId+'(?:\\D|$)').test(text)) throw new Error('material_id_not_verified');
      if (resolvedType === 'video' && (!new RegExp('素材ID\\s*[:：]\\s*'+materialId+'(?:\\D|$)').test(text) || !text.includes('审核通过'))) throw new Error('approved_video_not_verified');
    }
    await checkpoint('materials.open', 'opened', { material_id: materialId, purpose: 'bound_creation_entry' });
    return row;
  };

  const extractTaskId = (text) => {
    const match = String(text || '').match(/(?:任务|追投)?\s*ID\s*[：:]\s*([A-Za-z0-9_-]+)/i);
    return match ? match[1] : null;
  };

  try {
    await verifyIdentity();
    stamp('identity_verified');
    if (cfg.refresh !== false) {
      await tab.reload();
      await ready(exactText(`计划ID：${primaryAdId}`));
      stamp('refreshed');
    }
    let row = await openMaterials();
    stamp('material_row_ready');

    for (let index = 0; index < count; index++) {
      const before = Date.now();
      const openButton = row.locator('span.oc-promotion-operation-action-item,span.main-vmok-plugin-oc-promotion-operation-action-item').filter({hasText:/^追投$/});
      const formInputs=tab.playwright.getByRole('textbox',{name:'请输入',exact:true}).filter({visible:true});
      const formBudget = formInputs.nth(0);
      const formDuration = formInputs.nth(1);
      const taskNameInput = tab.playwright.getByRole('textbox',{name:'请输入任务名称，1-50个字符',exact:true}).filter({visible:true});
      try {
        await openButton.click(actionTimeout);
        await ready(taskNameInput,2000);
      } catch (error) {
        // Consecutive creation can hit the preceding drawer's closing render.
        // Inspect the actual state before retrying only the non-writing entry.
        const dom = await tab.playwright.domSnapshot();
        await checkpoint('boost.form.open', 'attempt_failed', { index: index + 1, dom, error: String(error.message || error) });
        const entryState={name_inputs:await taskNameInput.count(),submit_buttons:await tab.playwright.getByRole('button', { name: '提交', exact: true }).count(),
          entry_count:await openButton.count(),entry_visible:await openButton.isVisible(),
          relevant_dom:dom.split('\n').filter(line=>/tab .*selected|dialog|请输入任务名称|button "提交"|追投素材|素材ID/.test(line)).slice(-12)};
        stamp('form_entry_failed_state',entryState);
        if (entryState.name_inputs || entryState.submit_buttons || entryState.entry_count !== 1 || !entryState.entry_visible) throw error;
        await openButton.click(actionTimeout);
        await taskNameInput.waitFor({ state: 'visible', timeoutMs: 3000 });
        stamp('form_entry_recovered', { index: index + 1 });
      }
      if(await formInputs.count()!==2||await taskNameInput.count()!==1)throw new Error('create_form_inputs_not_unique');
      // Refresh the DOM evaluation scope after opening a new drawer. CUA
      // otherwise may expose the preceding drawer's cached input value.
      await tab.playwright.domSnapshot();
      const platformName = await taskNameInput.evaluate(element => String(element.value || ''));
      await checkpoint('boost.form.open', 'opened', { index: index + 1, platform_name: platformName });
      if (!platformName.trim()) throw new Error('任务名称未生成，停止回放');
      const taskName = platformName;
      if (taskName.length > 50 || /[\r\n\u0000]/.test(taskName)) throw new Error('平台默认任务名称无效，保留原文不提交');
      // Request IDs belong to the operation ledger, never to the platform name.
      // Persist the real lookup name before a submit can become uncertain.
      await cfg.on_name_prepared?.({ platform_name: platformName, task_name: taskName, name_prefix: '', index: index + 1 });
      await formBudget.fill(budget,actionTimeout);
      await formDuration.fill(durationHours,actionTimeout);
      // Commit the controlled duration field before submission; its blur can replace the button.
      await formDuration.press('Tab',actionTimeout);
      if (await taskNameInput.evaluate(element => String(element.value || '')) !== taskName) throw new Error('task_name_changed_before_submit');
      if (await formBudget.evaluate(element => Number(element.value)) !== Number(budget)
        || await formDuration.evaluate(element => Number(element.value)) !== Number(durationHours)) throw new Error('create_parameters_changed_before_submit');
      stamp('form_filled', { index: index + 1, task_name: taskName });
      await checkpoint('boost.form.fill', 'read_verified', { task_name: taskName, budget, duration_hours: durationHours });

      if (!cfg.execute) {
        await tab.playwright.getByRole('button', { name: '取消', exact: true }).click(actionTimeout);
        receipts.push({ index: index + 1, task_name: taskName, status: 'dry_run' });
        row = await openMaterials();
        continue;
      }

      const submittedAt = new Date().toISOString();
      await checkpoint('boost.submit.intent', 'read_verified', { task_name: taskName, index: index + 1, submitted_at: submittedAt });
      pendingSubmission = true;
      await tab.playwright.getByRole('button', { name: '提交', exact: true }).click(actionTimeout);
      await tab.getAXState({ emit: false });
      // CUA may time out waiting for hidden even after the button disappeared.
      // Observe the form, then rely on the exact task row for write confirmation.
      const submitButton = tab.playwright.getByRole('button', { name: '提交', exact: true });
      if (await submitButton.count() && await submitButton.isVisible()) {
        try { await submitButton.waitFor({ state: 'hidden', timeoutMs: Math.max(800, Math.min(15000, Number(cfg.submit_hidden_timeout_ms) || 2500)) }); }
        catch { await tab.getAXState({ emit: false }); }
      }
      let formStillVisible = await submitButton.count() && await submitButton.isVisible();
      for(let attempt=0;formStillVisible&&attempt<3;attempt++) {
        const freshDom=await tab.playwright.domSnapshot();
        formStillVisible=/- button "提交"/.test(freshDom)&&freshDom.includes('请输入任务名称，1-50个字符');
      }
      if (formStillVisible) throw new Error('提交后表单仍可见，先查证原任务');
      if (cfg.readback_next_round === true) {
        const receipt={index:index+1,task_name:taskName,status:'submitted_pending_readback',submitted_at:submittedAt};
        receipts.push(receipt);
        await checkpoint('boost.submit.pending','submitted_pending_readback',receipt);
        if(index+1<count)row=await openMaterials();
        continue;
      }
      if (typeof cfg.read_created === 'function') {
        // The unified entry supplies the full exact-name read once. Do not do
        // a partial row read here and then repeat the entire lookup outside.
        await checkpoint('boost.submit.pending','submitted_pending_readback',{index:index+1,task_name:taskName,submitted_at:submittedAt});
        const read=await cfg.read_created(taskName),task=read?.task;
        if(!read?.complete||!task?.task_id||task.name!==taskName||task.status!=='调控中'
          ||task.budget!==Number(budget)||task.duration_hours!==Number(durationHours)
          ||!Number.isFinite(Date.parse(task.created_at))||Date.parse(task.created_at)<Math.floor(Date.parse(submittedAt)/1000)*1000)
          throw new Error('exact_created_task_readback_unverified');
        receipts.push({index:index+1,task_name:taskName,task_id:task.task_id,status:'write_verified',after:task,evidence:read.evidence,elapsed_ms:Date.now()-before});
        pendingSubmission=false;stamp('write_verified',{index:index+1,task_id:task.task_id});
        await checkpoint('boost.create','write_verified',receipts.at(-1));
        if(index+1<count)row=await openMaterials();
        continue;
      }
      if (cfg.defer_readback === true) {
        // A closed form is only a submitted request, not proof of creation.
        // Keep exact names durable, stay on the material page, then verify the
        // entire small batch in the control list once. Never repeat a request.
        receipts.push({ index: index + 1, task_name: taskName, status: 'submitted_pending_readback', submitted_at: submittedAt });
        await checkpoint('boost.submit.pending', 'submitted_pending_readback', receipts[receipts.length - 1]);
        if (index + 1 < count) row = await openMaterials();
        continue;
      }
      // 提交后页面通常切到“调控”；只等待目标任务行，不抓整页快照。
      // A successful submission normally navigates here itself. Only click
      // the section when the control-list filters are actually absent.
      const visiblePoolFilters = tab.playwright.getByRole('textbox', { name: '请选择', exact: true }).filter({ visible: true });
      if (await visiblePoolFilters.count() !== 3) {
        const controlTab = await sectionTab('调控');
        await ready(controlTab, 5000);
        await controlTab.click(actionTimeout);
        await tab.getAXState({ emit: false });
        stamp('control_navigation_required');
      } else {
        stamp('control_auto_navigation_reused');
      }
      // The page retains its previous pool filter after creation. Reveal the original task;
      // changing this read filter never submits a second advertising request.
      const poolFilters = tab.playwright.getByRole('textbox', { name: '请选择', exact: true });
      if (await poolFilters.count() !== 3) throw new Error('提交后状态筛选结构变化，先查证原任务');
      const poolFilter = poolFilters.nth(2);
      const poolValue = await poolFilter.evaluate(element => String(element.value || ''));
      if (!['调控中', '全部（包括已删除）'].includes(poolValue)) {
        const option = tab.playwright.locator('div.ovui-cascader-panel__item-label').filter({ hasText: /^调控中$/ }).filter({ visible: true });
        if (!await option.count()) await poolFilter.click(actionTimeout);
        await tab.getAXState({ emit: false });
        await option.click(actionTimeout);
        await tab.getAXState({ emit: false });
        if (await poolFilter.evaluate(element => String(element.value || '')) !== '调控中') throw new Error('提交后调控中筛选未生效，先查证原任务');
        await checkpoint('boost.control.filter', 'read_verified', { task_name: taskName, filter: '调控中' });
      }
      const taskRow = tab.playwright.getByRole('row').filter({ hasText: taskName });
      await ready(taskRow, 5000);
      const taskId = await taskRow.count() === 1 ? extractTaskId(await taskRow.innerText()) : null;
      if (!taskId) throw new Error(`第 ${index + 1} 条提交后未回读任务ID：${taskName}`);
      receipts.push({ index: index + 1, task_name: taskName, task_id: taskId, status: 'write_verified', elapsed_ms: Date.now() - before });
      pendingSubmission = false;
      stamp('write_verified', { index: index + 1, task_id: taskId });
      await checkpoint('boost.create', 'write_verified', { index: index + 1, task_id: taskId, task_name: taskName });
      if (index + 1 < count) row = await openMaterials();
    }

    if (cfg.execute && cfg.defer_readback === true) {
      const result = await cfg.readback_batch({ task_names: receipts.map(r => r.task_name) });
      if (!result?.complete || !Array.isArray(result.rows)) throw new Error('批次原任务回读不完整，禁止重提');
      for (const receipt of receipts) {
        const matches = result.rows.filter(c => c[1]?.split('\n')[0] === receipt.task_name);
        const c = matches.length === 1 ? matches[0] : null;
        const taskId = c && extractTaskId(c[1]);
        if (!taskId || c[3]?.trim() !== '调控中' || Number(c[4]) !== Number(budget)
          || Number(c[8]?.split('\n')[0]) !== Number(durationHours)) throw new Error('原任务名称、参数或状态未匹配：' + receipt.task_name);
        Object.assign(receipt, { task_id: taskId, status: 'write_verified', verified_at: new Date().toISOString() });
        await checkpoint('boost.create', 'write_verified', { ...receipt, after: c, readback_mode: 'batch' });
      }
      pendingSubmission = false;
      stamp('batch_readback_verified', { count: receipts.length });
    }

    return { ok: true, mode: cfg.execute ? 'browser_replay_execute' : 'browser_replay_dry_run', effect_status:cfg.execute&&cfg.readback_next_round?'submitted_pending_readback':undefined, ad_writes:cfg.execute&&cfg.readback_next_round?null:cfg.execute?receipts.length:0, confirmed_writes:cfg.execute&&cfg.readback_next_round?0:undefined, binding: { advertiser_id: advertiserId, primary_ad_id: primaryAdId, material_id: materialId }, receipts, after:receipts.flatMap(r=>r.after?[r.after]:[]), trace, elapsed_ms: Date.now() - started };
  } catch (error) {
    const confirmedWrites = receipts.filter(item => item.status === 'write_verified').length;
    return { ok: false, mode: cfg.execute ? 'browser_replay_execute' : 'browser_replay_dry_run', ad_writes: pendingSubmission ? null : confirmedWrites, confirmed_writes: confirmedWrites, effect_status: pendingSubmission ? 'unconfirmed' : confirmedWrites ? 'partial' : 'not_submitted', retry_write: false, binding: { advertiser_id: advertiserId, primary_ad_id: primaryAdId, material_id: materialId }, receipts, trace, error: String(error.message || error), elapsed_ms: Date.now() - started };
  }
};

// 已验证的生命周期回放：按任务 ID 选择后执行暂停、恢复、停止或删除。
// 预算/时长“修改”目前页面没有稳定的编辑控件证据，遇到 update 会明确阻断，不猜按钮。
var replayQianchuanBoostAction = async function(tab, cfg) {
  if (cfg.action === 'update') return { ok:false, code:'browser_update_not_verified',
    message:'预算/时长编辑尚未完成当前CUA通道验收', ad_writes:0, effect_status:'not_submitted' };
  const { executeQianchuanTaskAction } = await import('./codex-qc-browser-steps.cua.mjs');
  return executeQianchuanTaskAction(tab, cfg);
};

var replayQianchuanBoostPauseBatch = async function(tab, cfg) {
  return replayQianchuanBoostAction(tab, {...cfg, action:'pause'});
};

var replayQianchuanBoost = async function(tab, cfg) {
  if (cfg?.action === 'pause' && cfg.target_ids) return replayQianchuanBoostPauseBatch(tab, cfg);
  return cfg && cfg.action && cfg.action !== 'create'
    ? replayQianchuanBoostAction(tab, cfg)
    : replayQianchuanBoostCreate(tab, cfg || {});
};

if (typeof module !== 'undefined') module.exports = { replayQianchuanBoostCreate, replayQianchuanBoostAction, replayQianchuanBoostPauseBatch, replayQianchuanBoost };
