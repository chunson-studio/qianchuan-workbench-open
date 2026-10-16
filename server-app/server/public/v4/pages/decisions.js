/* ===== 千川数据工作台 v4 · 决策记录（只读、平台中立） ===== */
(function (V4) {
  'use strict';
  const { esc } = V4;

  const HTML = `
  <style>
    .dc-head{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;margin-bottom:22px}
    .dc-head h1{font-size:24px;margin:0 0 7px;letter-spacing:.02em}.dc-head p{margin:0;color:var(--ink-3);font-size:12.5px;line-height:1.7}
    .dc-note{max-width:480px;padding:11px 14px;border:1px solid var(--line);border-radius:var(--r);color:var(--ink-2);font-size:11.5px;line-height:1.65;background:var(--panel)}
    .dc-note b{color:var(--ink)}.dc-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--line);border:1px solid var(--line);border-radius:var(--r);overflow:hidden;margin-bottom:18px}
    .dc-stat{background:var(--panel);padding:14px 16px}.dc-stat span{display:block;color:var(--ink-3);font-size:10.5px;letter-spacing:.08em}.dc-stat b{display:block;margin-top:6px;font:650 21px var(--mono);color:var(--ink)}
    .dc-tools{display:flex;align-items:center;justify-content:space-between;gap:14px;border-bottom:1px solid var(--line);padding:0 0 12px;margin-bottom:4px}
    .dc-filter{display:flex;gap:6px;flex-wrap:wrap}.dc-filter button{border:1px solid var(--line);background:transparent;color:var(--ink-3);font:600 11px inherit;padding:6px 11px;border-radius:999px;cursor:pointer}
    .dc-filter button.on{color:var(--ink);border-color:var(--steel);background:rgba(110,168,254,.08)}.dc-source{font:10.5px var(--mono);color:var(--ink-3)}
    .dc-list{position:relative;padding-left:25px}.dc-list:before{content:'';position:absolute;left:7px;top:18px;bottom:18px;width:1px;background:var(--line)}
    .dc-card{position:relative;padding:16px 0 17px;border-bottom:1px solid var(--line)}.dc-card:before{content:'';position:absolute;left:-21px;top:22px;width:7px;height:7px;border-radius:50%;background:var(--steel);box-shadow:0 0 0 4px var(--bg)}
    .dc-card.has-action:before{background:var(--good)}.dc-card.has-error:before{background:var(--danger)}
    .dc-top{display:flex;align-items:flex-start;justify-content:space-between;gap:18px}.dc-title{font-size:14px;font-weight:700;color:var(--ink);line-height:1.55}.dc-time{font:10.5px var(--mono);color:var(--ink-3);white-space:nowrap}
    .dc-tags{display:flex;gap:6px;flex-wrap:wrap;margin:7px 0 11px}.dc-tag{border:1px solid var(--line);border-radius:4px;padding:2px 7px;font-size:10px;color:var(--ink-3)}.dc-tag.live{color:var(--good)}.dc-tag.unverified{color:var(--st-warn)}
    .dc-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:18px}.dc-col h3{font-size:10px;letter-spacing:.12em;color:var(--ink-3);margin:0 0 7px}.dc-item{font-size:11.5px;color:var(--ink-2);line-height:1.65;padding:3px 0;overflow-wrap:anywhere}.dc-item b{color:var(--ink);font-weight:600}.dc-empty{font-size:11px;color:var(--ink-3)}
    .dc-foot{display:flex;gap:14px;flex-wrap:wrap;margin-top:11px;font:10.5px var(--mono);color:var(--ink-3)}.dc-foot code{font:inherit;color:var(--ink-2)}
    @media(max-width:1000px){.dc-grid{grid-template-columns:1fr 1fr}.dc-stats{grid-template-columns:1fr 1fr}.dc-head{display:block}.dc-note{margin-top:14px;max-width:none}}
    @media(max-width:640px){.dc-grid{grid-template-columns:1fr}.dc-top{display:block}.dc-time{display:block;margin-top:5px}.dc-tools{align-items:flex-start;flex-direction:column}.dc-list{padding-left:20px}}
  </style>
  <section class="dc-head">
    <div><h1>决策记录</h1><p>还原每一轮 Agent 看到了什么、如何判断、给了什么建议、实际做了什么。</p><p id="dcScope" data-private="mixed"></p></div>
    <div class="dc-note"><b>记录与回执</b>　查看历史判断和已核验的操作结果。要调整投放，可向 Agent 下达任务。</div>
  </section>
  <section class="dc-stats">
    <div class="dc-stat"><span>记录轮次</span><b id="dcTotal">--</b></div>
    <div class="dc-stat"><span>当前场次</span><b id="dcSession">--</b></div>
    <div class="dc-stat"><span>有已验证动作</span><b id="dcActions">--</b></div>
    <div class="dc-stat"><span>待后续观测验证</span><b id="dcPending">--</b></div>
  </section>
  <div class="dc-tools"><div class="dc-filter" id="dcFilters">
    <button type="button" data-filter="all" class="on">本账户全部</button>
    <button type="button" data-filter="session">当前房间本场</button>
    <button type="button" data-filter="actions">本账户已验证动作</button>
    <button type="button" data-filter="pending">本账户待后续观测</button>
  </div><span class="dc-source" id="dcSource">读取中…</span></div>
  <div class="dc-list" id="dcList">${V4.emptyBox('正在读取决策台账…')}</div>`;

  const phaseLabel = { pre_live: '开播前', live: '直播中', post_live: '下播复盘', offline: '离线诊断', legacy: '历史记录' };
  const sectionFallback = { observations: '未记录结构化观测', judgments: '未记录结构化判断', recommendations: '未记录结构化建议', actions: '本轮无投放动作' };
  let activePage = null;
  // One listener per loaded module; mounted page state is never shared/reused.
  V4.onRoomChange?.(account => activePage?.roomChanged(account));

  function array(value) { return Array.isArray(value) ? value : (value == null || value === '' ? [] : [value]); }
  function unusableLegacyText(value) {
    const text = String(value == null ? '' : value).trim();
    if (!text || /^\[object Object\]$/i.test(text)) return true;
    if (/\?{4,}/.test(text)) return true;
    const questionMarks = (text.match(/\?/g) || []).length;
    return text.length >= 12 && questionMarks / text.length > 0.35;
  }
  function textOf(value) {
    if (value == null) return '';
    if (typeof value === 'string') return unusableLegacyText(value) ? '' : value;
    if (typeof value !== 'object') return String(value);
    const direct = value.message || value.label || value.summary || value.reason || value.description || value.code || value.action;
    if (direct != null && !unusableLegacyText(direct)) return String(direct);
    const parts = Object.values(value).filter(item => typeof item === 'string' && !unusableLegacyText(item)).slice(0, 3);
    return parts.join('；');
  }
  function codeOf(value) { return value && typeof value === 'object' && value.code ? String(value.code) : ''; }
  function compact(value, limit) {
    const raw = textOf(value);
    const text = (raw || '历史记录未结构化，原文不可可靠展示').replace(/出血/g, '高消耗低回报').replace(/判死/g, '判定停止').replace(/劣质档/g, '低效档');
    return text.length > limit ? text.slice(0, limit - 1) + '…' : text;
  }
  function hasActions(round) {
    if (!round.account_id) return false;
    return array(round.actions).some(item => {
      const text = textOf(item).trim();
      return verifiedAction(item)
        && text && !/^(无操作|无写操作|无|null|none|观望)$/i.test(text);
    });
  }
  function verifiedAction(item) {
    const receipt = item?.receipt || item;
    return item && item.verified === true && item.success === true && !!item.operation_id
      && receipt.effect_status === 'confirmed' && receipt.readback?.verified === true;
  }
  function hasFollowup(round) {
    const outcome = round.outcome, detail = outcome?.details;
    return outcome?.status === 'observed' && !!(detail?.before_snapshot_id && detail?.after_snapshot_id
      && detail?.before_metrics && detail?.after_metrics);
  }
  function normalizeLegacy(round) {
    return {
      round_id: round.round_id || round.round || null,
      account_id: round.account_id || round.account || null,
      session_key: round.session_key || null,
      phase: round.phase || 'legacy',
      recorded_at: round.recorded_at || round.time || null,
      observed_at: round.observed_at || round.time || null,
      summary: round.summary || round.title || '',
      snapshot: round.snapshot || (round.snapshot_id ? { snapshot_id: round.snapshot_id } : null),
      observations: array(round.observations),
      judgments: array(round.judgments || round.decisions),
      recommendations: array(round.recommendations),
      actions: array(round.actions_raw || round.actions),
      outcome: round.outcome || null,
      source: round.source || {},
    };
  }
  function fmtTime(value) { return V4.fmtCnTime(value).full || '--'; }
  function renderItems(round, key) {
    const values = array(round[key]).filter(item => textOf(item).trim()).slice(0, 6);
    if (!values.length) return `<div class="dc-empty">${sectionFallback[key]}</div>`;
    return values.map(item => {
      const code = codeOf(item);
      const verification = key === 'actions'
        ? (round.account_id && verifiedAction(item) ? '<b>回执已确认</b>　' : '<b style="color:var(--st-warn)">未验证声明</b>　')
        : '';
      return `<div class="dc-item">${verification}${code ? `<b>${esc(code)}</b>　` : ''}${esc(compact(item, 180))}</div>`;
    }).join('');
  }
  function filteredRounds(state) {
    if (state.filter === 'session') return state.rounds.filter(round => round.session_key && round.session_key === state.currentSession);
    if (state.filter === 'actions') return state.rounds.filter(hasActions);
    if (state.filter === 'pending') return state.rounds.filter(round => !hasFollowup(round));
    return state.rounds;
  }
  function render(state, $) {
    const rounds = filteredRounds(state);
    $('dcTotal').textContent = state.rounds.length;
    $('dcSession').textContent = state.currentSession ? state.rounds.filter(round => round.session_key === state.currentSession).length : '未选择';
    $('dcActions').textContent = state.rounds.filter(hasActions).length;
    $('dcPending').textContent = state.rounds.filter(round => !hasFollowup(round)).length;
    $('dcSource').textContent = `结构化账本 · 最新100轮${state.excluded ? ` · ${state.excluded} 条归属不符已省略` : ''}`;
    if (!rounds.length) { $('dcList').innerHTML = V4.emptyBox('该筛选条件下暂无记录'); return; }
    $('dcList').innerHTML = rounds.map(round => {
      const actions = hasActions(round);
      const source = round.source || {};
      const sourceVerified = source.task_ref_verified === true;
      const snapshotId = round.snapshot && round.snapshot.snapshot_id || round.snapshot_id || null;
      const meta = round.snapshot && round.snapshot.meta || {};
      const freshness = meta.freshness || '未记录';
      const title = compact(round.summary || array(round.judgments)[0] || '本轮未填写摘要', 120);
      const hasError = array(meta.errors).length > 0;
      const outcome = round.outcome || null;
      const outcomeDetails = outcome && outcome.details || {};
      const hasEvidence = hasFollowup(round);
      const outcomeTag = hasEvidence
        ? '<span class="dc-tag">前后事实已记录 · 非因果结论</span>'
        : '<span class="dc-tag unverified">后续事实缺失</span>';
      const evidenceFoot = hasEvidence
        ? `<span>后续快照 <code data-private="id">${esc(outcomeDetails.after_snapshot_id)}</code></span>`
        : '';
      const metricLabels = { spend: '消耗', payment_gmv: '支付成交额', payment_roi: '平台支付ROI', payment_orders: '支付订单', net_gmv: '净成交额（原字段）', net_roi: '净ROI（原字段）', orders: '净订单' };
      const b = outcomeDetails.before_metrics || {}, a = outcomeDetails.after_metrics || {};
      const value = v => v == null || v === '' ? '缺失' : String(v);
      const factsHtml = hasEvidence ? `<details class="dc-col"><summary>查看前后数据（${esc(fmtTime(outcomeDetails.before_source_at))} → ${esc(fmtTime(outcomeDetails.after_source_at))}）</summary>
        <div class="dc-empty">前后口径：${esc(outcomeDetails.before_financial_basis ? JSON.stringify(outcomeDetails.before_financial_basis) : '未记录')} → ${esc(outcomeDetails.after_financial_basis ? JSON.stringify(outcomeDetails.after_financial_basis) : '未记录')}。口径缺失或不同不能直接比较。</div>
        ${Object.entries(metricLabels).map(([key, label]) => `<div class="dc-item">${label}：${esc(value(b[key]))} → ${esc(value(a[key]))}</div>`).join('')}
        <div class="dc-empty">同场观测可能包含结算回流、其他投放与经营变化，不据此判定单次动作好坏。</div></details>` : '';
      return `<article class="dc-card${actions ? ' has-action' : ''}${hasError ? ' has-error' : ''}">
        <div class="dc-top"><div class="dc-title">${esc(title)}</div><time class="dc-time">${esc(fmtTime(round.observed_at || round.recorded_at))}</time></div>
        <div class="dc-tags"><span class="dc-tag ${round.phase === 'live' ? 'live' : ''}">${esc(phaseLabel[round.phase] || round.phase || '未分类')}</span><span class="dc-tag">数据 ${esc(freshness)}</span>${!round.account_id ? '<span class="dc-tag unverified">账户标识缺失</span>' : ''}${round.snapshot?.verified !== true ? '<span class="dc-tag unverified">观测快照未验证</span>' : ''}${source.task_ref && !sourceVerified ? '<span class="dc-tag unverified">任务来源未验证</span>' : ''}${outcomeTag}</div>
        <div class="dc-grid"><section class="dc-col"><h3>观测事实</h3>${renderItems(round, 'observations')}</section><section class="dc-col"><h3>判断</h3>${renderItems(round, 'judgments')}</section><section class="dc-col"><h3>建议</h3>${renderItems(round, 'recommendations')}</section><section class="dc-col"><h3>实际动作</h3>${renderItems(round, 'actions')}</section></div>
        ${factsHtml}
        <div class="dc-foot">${round.session_key ? `<span>场次 <code data-private="id">${esc(round.session_key)}</code></span>` : '<span>未绑定直播场次</span>'}${snapshotId ? `<span>观测快照 <code data-private="id">${esc(snapshotId)}</code></span>` : '<span>未绑定数据快照</span>'}${evidenceFoot}${round.round_id ? `<span>轮次 <code data-private="id">${esc(round.round_id)}</code></span>` : ''}</div>
      </article>`;
    }).join('');
  }

  V4.pages.decisions = {
    mount(root) {
      root.innerHTML = HTML;
      const $ = id => root.querySelector('#' + id);
      const account = V4.acct();
      const currentSession = () => {
        const scope = V4.liveScope?.();
        return scope?.account === account && scope.room_id && scope.start_time
          ? `${account}|${scope.room_id}|${scope.start_time}` : null;
      };
      const state = { rounds: [], currentSession: currentSession(), excluded: 0, loaded: false };
      state.filter = state.currentSession ? 'session' : 'all';
      let dead = false, inFlight = false, queued = false, requestId = 0;
      const alive = () => !dead && V4.acct() === account;
      const updateScope = () => {
        $('dcScope').textContent = state.filter === 'session'
          ? (state.currentSession ? '只显示当前选择房间的本场记录。' : '尚未选择房间场次，请先到直播间选择。')
          : '显示本账户记录；可能包含不同房间和历史场次。';
        $('dcFilters').querySelectorAll('button').forEach(button => {
          button.classList.toggle('on', button.dataset.filter === state.filter);
          button.disabled = button.dataset.filter === 'session' && !state.currentSession;
        });
      };
      const loading = () => {
        state.rounds = []; state.loaded = false;
        for (const id of ['dcTotal', 'dcSession', 'dcActions', 'dcPending']) $(id).textContent = '--';
        $('dcSource').textContent = '读取中…';
        $('dcList').innerHTML = V4.emptyBox('正在读取决策台账…');
      };
      const refresh = async () => {
        if (!alive()) return;
        if (inFlight) { queued = true; return; }
        inFlight = true;
        const id = ++requestId, session = state.filter === 'session' ? state.currentSession : null;
        try {
          if (state.filter === 'session' && !session) throw new Error('尚未选择房间场次');
          const data = await V4.api('/api/decision-rounds', {
            account, limit: 100, ...(session ? { session_key: session } : {}),
          }, { timeout: 15000 });
          if (!alive() || id !== requestId) return;
          if (data?.account_id !== account || !Array.isArray(data.rounds)) throw new Error('账本返回的账户或记录格式无法核验');
          const rows = data.rounds.map(normalizeLegacy);
          state.rounds = rows.filter(round => (!round.account_id || round.account_id === account)
            && (!session || round.account_id === account && round.session_key === session));
          state.excluded = rows.length - state.rounds.length;
          state.loaded = true;
          state.rounds.sort((a, b) => Date.parse(b.recorded_at || b.observed_at || 0) - Date.parse(a.recorded_at || a.observed_at || 0));
          render(state, $); V4.touch();
        } catch (error) {
          if (!alive() || id !== requestId) return;
          state.rounds = []; state.loaded = false;
          for (const id of ['dcTotal', 'dcSession', 'dcActions', 'dcPending']) $(id).textContent = '--';
          $('dcSource').textContent = error.status === 404 ? '当前服务未提供决策账本' : '账本本次读取失败';
          $('dcList').innerHTML = V4.errBox(error);
        } finally {
          inFlight = false;
          if (queued && alive()) { queued = false; void refresh(); }
        }
      };
      $('dcFilters').querySelectorAll('button').forEach(button => {
        button.onclick = () => {
          if (!alive() || button.disabled || state.filter === button.dataset.filter) return;
          state.filter = button.dataset.filter; requestId++;
          updateScope(); loading(); void refresh();
        };
      });
      const page = { roomChanged(changedAccount) {
        if (!alive() || changedAccount !== account) return;
        const nextSession = currentSession();
        if (nextSession === state.currentSession) return;
        state.currentSession = nextSession; updateScope();
        if (state.filter === 'session') { requestId++; loading(); void refresh(); }
        else if (state.loaded) render(state, $);
      } };
      activePage = page; updateScope();
      const stop = V4.poll(refresh, 60000);
      return () => { dead = true; requestId++; stop(); if (activePage === page) activePage = null; };
    },
  };
})(window.V4);
