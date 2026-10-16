/* ===== 千川投控 v4 · 作战室 ===== */
(function (V4) {
  'use strict';
  const { $, esc, fmtM, fmtMoney, fitV, flip } = V4;
  // 数字稳定呈现，同时让读屏器直接读到数值。
  const odo = (element, value) => { if (element) element.textContent = String(value); };

  /* 按账号的数据缓存（模块级，跨 mount 存活）：切账号先秒上缓存再后台刷新（stale-while-revalidate），
     消灭"切账号 → 整页空白等加载" */
  const CACHE = {};
  // 缓存首帧可能在 mount 初始化途中渲染，状态映射须先于首帧就绪。
  const ROI_ST = { top: 'st-ok', good: 'st-ok', warn: 'st-warn', low: 'st-warn', bad: 'st-danger' };

  const HTML = `
  <section class="room-heading command-header"><div><a class="room-back" href="#/overview">← 全部直播间</a><h1 id="roomTitle" data-private="mixed">直播间</h1><p id="roomIdentity" data-private="mixed"></p><details class="room-identity-detail"><summary>场次信息</summary><span id="roomIdentityDetail" data-private="mixed"></span></details></div><span class="room-scope-label">当前场次</span></section>
  <section class="room-target" aria-label="直播间本地目标">
    <div class="room-target-head"><span id="roomCompareBasis">正在读取目标口径…</span><span class="room-state unknown" id="roomCompareState">等待数据</span></div>
    <div class="room-comparison">
      <div><span>目标 ROI</span><strong id="roomGoal">—</strong></div>
      <div><span>与目标相差</span><strong id="roomGap">—</strong></div>
    </div>
    <div id="roomTargetSummary" class="room-target-summary">正在读取本房间目标…</div>
    <details class="room-target-editor" id="roomTargetEditor"><summary>调整本房间目标</summary>
      <form id="roomTargetForm" class="room-target-fields">
        <label for="roomTargetRoi">本地目标 ROI<input id="roomTargetRoi" aria-label="本地目标 ROI" name="target_roi" type="number" min="0.01" step="0.01" required disabled></label>
        <label for="roomTargetBasis">目标口径<select id="roomTargetBasis" aria-label="目标口径" name="target_roi_basis" disabled>
          <option value="unknown">待确认</option><option value="payment">支付 ROI</option><option value="platform_net_1h">平台 1 小时净成交 ROI</option><option value="final_settlement">最终结算 ROI</option><option value="chengfang_comprehensive">乘方综合 ROI</option>
        </select></label>
        <button id="roomTargetSave" type="submit" disabled>保存本房间目标</button>
      </form>
      <p class="room-target-help">目标按直播间独立保留，仅用于本地经营判断。保存不会调整平台计划出价或追投规则。</p>
      <div id="roomTargetStatus" class="cd" role="status"></div>
    </details>
  </section>
  <section class="band-state">
    <!-- 第一行：三秒看完 -->
    <div class="band-head">
      <span class="state-word off" id="stateWord" style="display:none" aria-hidden="true"></span>
      <span class="live-since" id="liveSince" style="display:none"></span>
      <span class="band-vitals" id="bandVitals"></span>
      <span class="live-links" id="liveLinks" style="display:none"></span>
    </div>
    <div id="coreFreshness" style="font-size:12px;color:var(--ink-3);padding:4px 0" role="status">核心数据等待首次采集</div>
    <!-- 第二行：本轮判定 -->
    <div class="band-judgment" id="bandJudgment" style="display:none">
      <span class="j-signal" id="jEmoji"></span>
      <span class="j-text" id="jText">--</span>
    </div>
    <!-- 第三行：关注素材（最多3条） -->
    <div class="band-watch" id="bandWatch" style="display:none"></div>
    <!-- 指标网格 -->
    <div class="band">
      <div class="band-row r1">
        <div class="bcell"><div class="l" id="lCost">本场消耗</div><div class="v num" id="vCost">--</div><div class="s" id="vCostS"></div></div>
        <div class="bcell hero"><div class="l">净 ROI</div><div class="v num" id="roiNum">--</div><div class="s"><span class="delta" id="roiDelta"></span></div></div>
        <div class="bcell"><div class="l" id="lGmv">净成交</div><div class="v num" id="vGmv">--</div><div class="s" id="vGmvS"></div></div>
        <div class="bcell"><div class="l">总流速（15m）</div><div class="v num" id="vFlow">--</div><div class="s" id="vFlowS">主计划＋追投</div></div>
        <div class="bcell"><div class="l">主计划流速</div><div class="v num" id="vBasicFlow">--</div><div class="s" id="vBasicFlowS">近15分钟拆分</div></div>
        <div class="bcell"><div class="l">追投流速</div><div class="v num" id="vAssistFlow">--</div><div class="s" id="vAssistFlowS">近15分钟拆分</div></div>
        <div class="bcell"><div class="l" id="lOrd">订单</div><div class="v num" id="vOrd">--</div><div class="s">净口径</div></div>
        <div class="bcell"><div class="l">在线</div><div class="v num" id="vOn">--</div><div class="s" id="vOnS"></div></div>
        <div class="bcell"><div class="l">GPM</div><div class="v num" id="vGpm">--</div><div class="s" id="vGpmS">千次观看成交</div></div>
      </div>
      <details class="room-metrics-extra"><summary>更多经营指标<span>部分指标尚未接入本房间</span></summary><div class="band-row r2" id="roomMoreMetrics">
        <div class="bcell"><div class="l">观看-成交率</div><div class="v num" id="vW2P">--</div><div class="s">人数口径</div></div>
        <div class="bcell"><div class="l">曝光-观看率</div><div class="v num" id="vS2W">--</div><div class="s">次数口径</div></div>
        <div class="bcell"><div class="l">整体支付ROI</div><div class="v num" id="vRoiAll">--</div><div class="s">账面口径含退款</div></div>
        <div class="bcell"><div class="l">退款率</div><div class="v num" id="vRefund">--</div><div class="s" id="vRefundS">全部口径 · 1h</div></div>
        <div class="bcell"><div class="l">计划出价</div><div class="v num" id="vPlanRoi">--</div><div class="s" id="vPlanRoiS">主计划 ROI 目标</div></div>
        <div class="bcell"><div class="l">余额</div><div class="v num" id="vBal">--</div><div class="s" id="vBalS"></div></div>
        <div class="bcell"><div class="l">预算消耗</div><div class="v num" id="vBudPct">--</div><div class="s"><span id="vBudS">--</span><div class="pbar" style="margin:4px 0 0"><i id="vBudBar" style="width:0%"></i></div></div></div>
      </div></details>
    </div>
  </section>

  <details class="block room-compass" id="roomCompass" aria-label="本场罗盘数据">
    <summary class="sec-title">近5分钟补充数据 <span class="cd" id="compassStatus">展开时读取本场罗盘</span></summary>
    <div id="compassPortrait"></div>
    <div class="wl-pulse" id="compassFive"></div>
    <div class="sec-title" style="margin-top:18px">全场流量结构</div>
    <div id="compassChannels"></div>
  </details>

  <section class="wl-side block" id="wrLive">
      <div class="sec-title">追投任务 <span class="cd" id="boostSum"></span><span class="cd" style="float:right">只读 · 操盘在千川后台</span></div>
      <div role="group" aria-label="追投状态筛选" style="display:flex;flex-wrap:wrap;gap:8px;margin:10px 0"><button type="button" class="btn" data-boost-filter="active" aria-controls="boosts" aria-pressed="true" style="min-height:44px;padding:8px 14px;border-color:var(--accent)">在投</button><button type="button" class="btn" data-boost-filter="paused" aria-controls="boosts" aria-pressed="false" style="min-height:44px;padding:8px 14px">已暂停</button><button type="button" class="btn" data-boost-filter="all" aria-controls="boosts" aria-pressed="false" style="min-height:44px;padding:8px 14px">已读全部</button></div>
      <div class="b-list" id="boosts"></div>
      <div class="b-foot" id="boostFoot"></div>
  </section>

  <details class="room-modules" id="roomModules"><summary>决策记录与补充信息<span id="roomModulesStatus">正在核验本房间数据</span></summary>
  <section class="wr-midrow" id="wrMidRow" style="display:none">
    <div class="block">
      <div class="sec-title">直播间核心漏斗 · 本场</div>
      <div class="wl-funnel2" id="wrFunnel"></div>
    </div>
    <div class="block">
      <div class="sec-title">成交渠道构成 · 本场 <button class="chan-toggle" id="chanToggle" style="display:none">⇆ 观看次数</button></div>
      <div class="wl-channel" id="wrChannel"></div>
    </div>
    <div class="block">
      <div class="sec-title">人群画像 · 实时（罗盘）</div>
      <div class="wl-portrait" id="wrPortrait"></div>
    </div>
  </section>

  <section class="block" id="wrChengfangLive" hidden>
    <div class="sec-title">乘方直播 · 今日 <span class="cd" id="wrChengfangTime"></span></div>
    <div id="wrChengfangPlans"></div>
  </section>

  <section class="main wr-main">
    <div class="block">
      <div class="sec-title"><span id="roomDecisionTitle">决策流</span>
        <span class="m-tabs"><button class="on" data-flow="today">今日</button><button data-flow="all">全部</button></span>
        <input type="date" id="flowDate" style="display:none">
      </div>
      <div class="flow" id="flow">${V4.emptyBox('加载中…')}</div>
    </div>
    <div class="col wr-col">
      <div class="block" id="wrScrBox" style="display:none">
        <div class="sec-title">罗盘实况 · 近5分钟 <span class="cd" id="wrScrUpd"></span></div>
        <div class="wl-pulse" id="wrScrVitals"></div>
        <div class="sec-title" style="margin-top:14px">本场热卖</div>
        <div class="wl-prods" id="wrScrProducts"></div>
        <div class="sec-title" style="margin-top:14px">直播间订单 · 本场已支付 <span class="cd" id="wrOrdUpd"></span></div>
        <div class="wl-orders" id="wrOrders"></div>
        <div class="wr-scr-extra" id="wrScrExtra"></div>
      </div>
      <div class="block" id="bossBlock" style="display:none">
        <div class="sec-title">老板评审</div>
        <div class="boss">
          <div class="g" id="bossG">-</div>
          <div><div class="s" id="bossS"></div>
          <div class="q" id="bossQ"></div></div>
        </div>
      </div>
    </div>
  </section></details>`;

  function mountRoomChooser(view, account, alive) {
    view.innerHTML = `<section class="room-heading command-header"><div><a class="room-back" href="#/overview">← 全部直播间</a><h1>${esc(V4.acctName(account))}</h1><p>选择这个账户下的直播间，进入独立场次。</p></div></section>
      <section class="room-launcher"><div class="room-launcher-head"><h2 id="roomChoiceTitle">正在读取直播间</h2><span class="room-state" id="roomChoiceBadge"></span></div>
      <p id="roomChoiceDescription"></p><div class="room-choice-grid" id="roomChoices"></div>
      <p class="room-choice-error" id="roomChoiceStatus" role="status" hidden></p>
      <div class="room-choice-actions"><button id="reloadRooms" class="work-button" type="button">重新读取直播间</button><a href="#/replay" class="room-choice-link">查看本账户历史场次 →</a><a href="#/onboarding" class="room-choice-link" id="roomCredentialLink" hidden>更新登录状态 →</a></div></section>`;
    const el = id => view.querySelector('#'+id);
    let busy=false, error='';
    function render() {
      if(!alive()) return;
      const state = V4.accountLiveView(V4.watchState(account)), rooms=state.rooms || [];
      el('roomChoiceBadge').textContent=state.label;
      el('roomChoiceBadge').className='room-state '+state.state;
      el('roomChoiceTitle').textContent=state.state==='live' ? (rooms.length ? '选择一个在播房间' : '在播房间待核验') : state.state==='offline' ? '当前账户未开播' : state.state==='credential' ? state.label : busy ? '正在核验直播状态' : state.label;
      el('roomChoiceDescription').textContent=state.state==='live' ? '各直播间独立查看 ROI 目标、数据口径和本场表现。' : state.state==='offline' ? '开播后，直播间会出现在这里。现在可以查看历史场次，或从顶部切换其他账户。' : state.detail || '状态未知不代表未开播。可以重新读取，或先查看其他账户。';
      el('roomChoices').innerHTML=rooms.map(room=>`<button class="room-choice" type="button" data-room-choice="${esc(V4.roomKey(room))}"><strong data-private="mixed">${esc(room.title || room.name || room.anchorName || '直播间')}</strong><span>房间 <span data-private="id">${esc(room.roomId)}</span></span><small>${esc(V4.fmtCnTime(room.startTime).full)} 开播</small><b>进入场次 →</b></button>`).join('');
      el('roomChoices').hidden=!rooms.length;
      el('roomChoices').querySelectorAll('[data-room-choice]').forEach(button=>{button.onclick=()=>{
        if(!V4.setRoom(button.dataset.roomChoice,account)){error='场次已变化，请重新读取后选择。';render();}
      };});
      el('roomChoiceStatus').textContent=error;
      el('roomChoiceStatus').hidden=!error;
      el('roomCredentialLink').hidden=state.state!=='credential';
      el('reloadRooms').disabled=busy;
      el('reloadRooms').textContent=busy?'读取中…':'重新读取直播间';
    }
    async function discover() {
      if(busy || !alive()) return;
      busy=true;error='';render();
      try { await V4.loadRooms(account); }
      catch(e) { if(alive() && V4.accountLiveView(V4.watchState(account)).state==='unknown') error='本次读取未完成，请稍后重试。'; }
      finally { busy=false;render(); }
    }
    const stop=V4.onLiveWatchChange(()=>{error='';render();});
    el('reloadRooms').onclick=discover;
    render();void discover();
    return stop;
  }

  V4.pages.warroom = {
    mount(view) {
      const scope = V4.liveScope(), acct0 = scope.account, scopeKey = V4.liveScopeKey(scope);
      let dead = false;
      const alive = () => !dead && V4.liveScopeKey() === scopeKey;
      if (!scope.room_id) {
        const stop=mountRoomChooser(view,acct0,alive);
        return () => { dead = true;stop(); };
      }
      view.innerHTML = HTML;
      view.querySelector('.band-state').after(view.querySelector('.room-target'));
      view.querySelector('.room-target').after($('wrLive'));
      ['vFlow', 'vBasicFlow', 'vAssistFlow', 'vOn', 'vGpm'].forEach(id => $('roomMoreMetrics').appendChild($(id).closest('.bcell')));
      view.querySelector('.room-metrics-extra').appendChild($('bandJudgment'));
      const S = { mode: 'off', roi: 0, be: V4.breakEven(), delta: 0, hasToday: false, previousSessionRoi: null, dash: null, boostFilter: 'active', boostFrame: null, splitTab: 'today', splitToday: null, flowMode: 'today', marginalFlow: null, marginalRoomId: null };
      const stoppers = [];
      /* 账号快照 + 存活判断：切账号/切页后，在途请求统一作废（不写缓存不写 DOM） */
      const roomScoped = !!scope.room_id;
      const room = V4.room();
      $('roomTitle').textContent = room.title || room.name || room.anchorName || `直播间 ${scope.room_id}`;
      $('roomIdentity').textContent = `${V4.acctName(acct0)} · ${V4.fmtCnTime(scope.start_time).full} 开播`;
      $('roomIdentityDetail').textContent = `房间 ${scope.room_id}`;
      let targetDirty = false, targetSaving = false, targetParams = null, targetRevision = 0;
      function renderTarget(params, fillForm = false) {
        targetParams = params;
        const target = params?.target_roi, basis = params?.target_roi_basis || 'unknown';
        const t = V4.roomTargetView(S.coreReadFailed ? { ...S.dash, dataValid: false } : S.dash, params);
        $('roomCompareBasis').textContent = t.basisLabel;
        $('roomGoal').textContent = t.target == null ? '—' : t.target.toFixed(2);
        $('roomGap').textContent = t.delta == null ? '—' : `${t.delta > 0 ? '+' : ''}${t.delta.toFixed(2)}`;
        $('roomCompareState').textContent = t.status;
        $('roomCompareState').className = 'room-state ' + t.state;
        $('roomGap').dataset.state = t.state;
        $('roomTargetSummary').textContent = target == null ? '设置目标后显示本场差距。' : t.comparable ? `同口径实际 ROI ${t.actual.toFixed(2)} · 达到目标不等于盈利` : '等待同口径有效数据后比较。';
        if (fillForm && !targetDirty) {
          $('roomTargetRoi').value = target == null ? '' : target;
          $('roomTargetBasis').value = basis;
        }
      }
      $('roomTargetForm').oninput = () => { targetDirty = true; };
      $('roomTargetForm').onsubmit = async event => {
        event.preventDefault();
        if (targetSaving || !alive()) return;
        targetSaving = true;
        $('roomTargetRoi').disabled = $('roomTargetBasis').disabled = $('roomTargetSave').disabled = true;
        $('roomTargetStatus').textContent = '正在保存并回读本房间目标…';
        try {
          const params = await V4.saveRoomTarget(scope, { target_roi: $('roomTargetRoi').value, target_roi_basis: $('roomTargetBasis').value });
          if (!alive()) return;
          targetDirty = false;
          targetRevision++;
          renderTarget(params, true);
          $('roomTargetStatus').textContent = '已保存并回读核验本房间目标';
          if (S.dash) S.dash.thresholds = { ...S.dash.thresholds, ...params };
        } catch (error) { if (alive()) $('roomTargetStatus').textContent = '保存未确认：' + error.message; }
        finally { targetSaving = false; if (alive()) $('roomTargetRoi').disabled = $('roomTargetBasis').disabled = $('roomTargetSave').disabled = false; }
      };
      void V4.api('/api/config', { account: acct0, room_id: scope.room_id }).then(result => {
        if (!alive()) return;
        renderTarget(result.account_params, true);
        $('roomTargetRoi').disabled = $('roomTargetBasis').disabled = $('roomTargetSave').disabled = false;
      }).catch(error => { if (alive()) $('roomTargetStatus').textContent = '目标读取失败：' + error.message; });

      /* ===== 切账号秒上：内存 CACHE → sessionStorage（刷新存活）→ 立即上屏（缓存标记），后台拉新覆盖 ===== */
      // F5刷新时跳过缓存恢复，直接拉新数据（避免双层缓存叠加导致旧数据）
      const isReload = performance.getEntriesByType('navigation')[0]?.type === 'reload';
      if (isReload) { try { const ks = []; for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); if (k && k.startsWith('v4c_')) ks.push(k); } ks.forEach(k => sessionStorage.removeItem(k)); } catch (e) {} }
      let C0 = isReload ? null : CACHE[scopeKey];
      if (!C0) {
        const pd = V4.cget('v4c_dash_' + scopeKey, 2 * 3600 * 1000);
        const ps = V4.cget('v4c_split_' + scopeKey + '_' + localDate(0), 2 * 3600 * 1000);
        const pr = V4.cget('v4c_rounds_' + scopeKey, 2 * 3600 * 1000);
        const pp = V4.cget('v4c_pend_' + scopeKey, 2 * 3600 * 1000);
        const pb = V4.cget('v4c_boss_' + scopeKey, 2 * 3600 * 1000);
        if (pd || ps || pr || pp || pb) {
          C0 = {};
          if (pd && pd.data) { C0.j = pd.data.j; C0.updText = pd.data.updText; }
          if (ps && ps.data) { C0.split = ps.data; C0.splitToday = { payload: ps.data, date: localDate(0), ts: ps.ts }; }
          if (pr && pr.data) C0.rounds = pr.data;
          if (pp && pp.data) C0.pend = pp.data;
          if (pb && pb.data !== undefined) C0.boss = pb.data;
          CACHE[scopeKey] = C0; // 回写内存层，后续按内存路径走
        }
      }
      if (C0) {
        if (C0.j) applyDash(C0.j, { fromCache: true }); // 缓存渲染：跳过 home-split 回填与 touch，避免与首轮刷新交错
        if (C0.rounds && !roomScoped) renderRoundsData(C0.rounds);
        if (C0.boss !== undefined) renderBossData(C0.boss);
        if (C0.split) renderSplitData(C0.split);
        if (C0.splitToday) S.splitToday = C0.splitToday;
        if (C0.j) renderCoreFreshness(C0.j);
      } else {
        // 无缓存 → 显示加载中，避免残留上一账号数据
        $('stateWord').textContent = '加载中…';
        $('roiNum').textContent = '--';
        $('upd').textContent = '正在拉取数据…';
      }

      /* ===== 五档状态判定（替代原 top/good/warn/bad 一刀切） =====
         告警 > 亏损 > 偏弱 > 健康 > 观望
         输入：live-dashboard payload j；输出：{state, word, colorClass, reason, actionText} */
      function computeLiveState(j) { const live=j?.live?.isLive; const unknown=typeof live!=='boolean'||j.status_stale===true; return {state:unknown?'watch':live?'watch':'off',word:unknown?'状态待确认':live?'直播中':'未在播',colorClass:live?'st-watch':'st-off',reason:'原始数据展示；本版不提供投放策略判断',actionText:''}; }

      /* ===== 第二行：本轮判定（emoji + 状态词 + 原因 + 建议动作） =====
         之前 apply() 调用但未定义，ReferenceError 把后面的 odo(roiNum) 全堵死，净ROI 卡片永远 -- */
      function renderJudgment() {
        const box = $('bandJudgment');
        if (!box) return;
        const st = S.liveState;
        if (!st) { box.style.display = 'none'; return; }
        box.className = 'band-judgment ' + st.colorClass;
        $('jText').textContent = `${st.reason}${st.actionText ? '，' + st.actionText : ''}`;
        box.style.display = '';
      }

      function currentRoomId(j) {
        const room = j && j.live && j.live.rooms && j.live.rooms[0];
        return room && (room.roomId != null || room.room_id != null)
          ? String(room.roomId != null ? room.roomId : room.room_id)
          : null;
      }

      function renderMarginalFlow() {
        const live = !!(S.dash && S.dash.live && S.dash.live.isLive);
        const idleText = S.dash?.live?.isLive === false && S.dash.status_stale !== true ? '未在直播' : '直播状态待确认';
        const slice = S.marginalFlow;
        const quality = slice && slice.data_quality;
        const hasRate = !!(slice && (slice.total_spend_rate_hour != null || slice.spend_rate_hour != null));
        const hasMinutes = !!(slice && slice.actual_window_minutes != null);
        const rate = hasRate ? Number(slice.total_spend_rate_hour != null ? slice.total_spend_rate_hour : slice.spend_rate_hour) : NaN;
        const minutes = hasMinutes ? Number(slice.actual_window_minutes) : NaN;
        const available = live && slice && slice.stale !== true
          && (quality === 'complete' || quality === 'partial')
          && hasRate && hasMinutes && Number.isFinite(rate) && Number.isFinite(minutes) && minutes > 0;
        const room = S.dash && S.dash.live && S.dash.live.rooms && S.dash.live.rooms[0];
        const startMs = room && room.startTime ? V4.parseT(room.startTime).getTime() : 0;
        const sessionSpend = S.dash && S.dash.today && S.dash.today.cost != null && Number.isFinite(+S.dash.today.cost)
          ? +S.dash.today.cost : null;
        const elapsedMinutes = live && startMs > 0 ? Math.max(0, (Date.now() - startMs) / 60000) : 0;
        const sessionAverage = sessionSpend != null && elapsedMinutes > 0
          ? sessionSpend * 60 / elapsedMinutes : null;
        const liveMetrics = S.dash && S.dash.live_metrics;
        const sessionBasicCost = liveMetrics && liveMetrics.basicCost != null && Number.isFinite(Number(liveMetrics.basicCost))
          ? Number(liveMetrics.basicCost) : NaN;
        const sessionAssistCost = liveMetrics && liveMetrics.assistCost != null && Number.isFinite(Number(liveMetrics.assistCost))
          ? Number(liveMetrics.assistCost) : NaN;
        const sessionBasicAverage = elapsedMinutes > 0 && Number.isFinite(sessionBasicCost)
          ? sessionBasicCost * 60 / elapsedMinutes : NaN;
        const sessionAssistAverage = elapsedMinutes > 0 && Number.isFinite(sessionAssistCost)
          ? sessionAssistCost * 60 / elapsedMinutes : NaN;
        const splitQuality = slice && slice.flow_split_quality;
        const splitMinutes = slice && Number.isFinite(Number(slice.flow_split_actual_minutes))
          ? Math.max(0, Number(slice.flow_split_actual_minutes)) : 0;
        const splitPendingText = splitQuality === 'partial' || splitQuality === 'collecting'
          ? `拆分采样 ${Math.round(splitMinutes)}/15分钟 · 暂不可用于决策`
          : `拆分${splitQuality || '采样中'} · 暂不可用`;
        const basicRate = slice && slice.basic_spend_rate_hour != null ? Number(slice.basic_spend_rate_hour) : NaN;
        const assistRate = slice && slice.assist_spend_rate_hour != null ? Number(slice.assist_spend_rate_hour) : NaN;
        const assistShare = slice && slice.assist_share_pct != null ? Number(slice.assist_share_pct) : NaN;
        const splitAvailable = available && splitQuality === 'complete'
          && Number.isFinite(basicRate) && Number.isFinite(assistRate) && Number.isFinite(assistShare);
        const sessionSplitAvailable = !splitAvailable && live
          && Number.isFinite(sessionBasicAverage) && Number.isFinite(sessionAssistAverage);
        odo($('vFlow'), available ? '¥' + Math.round(rate) + '/h' : '--');
        $('vFlowS').textContent = available
          ? `主计划＋追投 · 实际${minutes}分钟${quality === 'partial' ? ' · 区间形成中' : ''}${sessionAverage != null ? ` · 整场均速 ¥${Math.round(sessionAverage)}/h` : ''}`
          : (live ? '区间不可用' : idleText);
        odo($('vBasicFlow'), splitAvailable ? `¥${Math.round(basicRate)}/h`
          : (sessionSplitAvailable ? `¥${Math.round(sessionBasicAverage)}/h` : (live && ['partial', 'collecting'].includes(splitQuality) ? '采样中' : '--')));
        $('vBasicFlowS').textContent = splitAvailable
          ? `占总流速 ${Math.max(0, 100 - assistShare).toFixed(1)}%`
          : (sessionSplitAvailable ? `本场均速 · ${splitPendingText}` : (live ? splitPendingText : idleText));
        odo($('vAssistFlow'), splitAvailable ? `¥${Math.round(assistRate)}/h`
          : (sessionSplitAvailable ? `¥${Math.round(sessionAssistAverage)}/h` : (live && ['partial', 'collecting'].includes(splitQuality) ? '采样中' : '--')));
        $('vAssistFlowS').textContent = splitAvailable
          ? `追投占比 ${assistShare.toFixed(1)}%`
          : (sessionSplitAvailable ? `本场均速 · ${splitPendingText}` : (live ? splitPendingText : idleText));
        fitV($('vFlow'));
        fitV($('vBasicFlow'));
        fitV($('vAssistFlow'));
      }

      /* ===== 状态渲染 ===== */
      function apply() {
        const st = computeLiveState(S.dash);
        S.liveState = st;
        const w = $('stateWord');
        flip(w, st.word);
        w.className = 'state-word ' + st.colorClass;
        // 生动化：整站粒子背景随盘面盈亏呼吸变色变速（健康绿缓流/临界黄/亏损红湍流/下播灰静止）；
        // 作战室顶部同步状态色环境光晕——颜色唯一来源仍是状态计算，不为装饰新增色彩
        if (V4.pulse) V4.pulse.setMode(S.mode);
        const bandEl = view.querySelector('.band-state');
        if (bandEl) bandEl.style.setProperty('--wrGlow', (V4.PULSE_COLOR[S.mode] || V4.PULSE_COLOR.off) + '2e');
        renderJudgment();
        // 未在播：顶部只留计划出价/余额；净ROI 空或固定上一场终值，不拿今日累计冒充本场
        view.querySelector('.band').classList.toggle('off-compact', S.mode === 'off');
        view.querySelectorAll('.band .bcell').forEach(el => {
          const vidEl = el.querySelector('.v');
          const vid = vidEl ? vidEl.id : '';
          el.style.display = S.mode === 'off' && vid !== 'vPlanRoi' && vid !== 'vBal' ? 'none' : '';
        });
        odo($('roiNum'), S.mode === 'off'
          ? (S.previousSessionRoi != null ? S.previousSessionRoi.toFixed(2) : '--')
          : (S.hasToday === false ? '--' : S.roi.toFixed(2)));
        const d = S.delta;
        $('roiDelta').textContent = S.mode === 'off'
          ? (S.previousSessionRoi != null ? '上一场净ROI · 终值' : '未在播 · 无本场ROI')
          : `${st.reason} · ${st.actionText}${d ? ' · 较上轮 ' + (d >= 0 ? '+' : '') + (+d).toFixed(2) : ''}`;
        // 记分牌状态色：净ROI 对照净保本线三档（2026-07-30 审计修复：此前用支付ROI(tdy.roi)对照净保本线，
        // 支付 2.20/净 1.95 也会被染绿"健康"，偏乐观）/ 余额可用天数<2 danger / 退款率>15% warn、>25% danger
        const tdy = S.dash && S.dash.today;
        const roiAll = tdy && tdy.netRoi != null ? +tdy.netRoi : (tdy && tdy.roi != null ? +tdy.roi : (S.splitAll && S.splitAll.roi != null ? +S.splitAll.roi : null));
        setSt('vRoiAll', roiAll == null ? '' : ROI_ST[V4.modeOf(roiAll, S.be)]);
        const daysLeft = S.dash && S.dash.balance && S.dash.balance.days_left;
        setSt('vBal', daysLeft != null && +daysLeft < 2 ? 'st-danger' : '');
        const rf = S.splitAll && S.splitAll.refund_rate != null ? +S.splitAll.refund_rate : null;
        setSt('vRefund', rf == null ? '' : rf > 25 ? 'st-danger' : rf > 15 ? 'st-warn' : '');
        ['vCost', 'vFlow', 'vBasicFlow', 'vAssistFlow', 'vGmv', 'vOrd', 'vBal', 'vOn', 'vRoiAll', 'vRefund', 'vGpm', 'vW2P', 'vS2W', 'vPlanRoi'].forEach(id => fitV($(id)));
      }

      /* ===== 开播时间/已播时长（直播中"今日第 N 场 · 已播 XhYm"秒级跟手；下播"今日已播 N 场 · 终场定格"） ===== */
      function updateSince(j) {
        const sinceEl = $('liveSince');
        if (!sinceEl) return;
        const room = (j && j.live && j.live.rooms && j.live.rooms[0]) || null;
        const startMs = room && room.startTime ? V4.parseT(room.startTime).getTime() : 0;
        const tSess = (j && j.today_sessions) || null;
        const live = !!(j && j.live && j.live.isLive);
        if (live && startMs && Date.now() > startMs) {
          const st = new Date(startMs);
          const sessTag = tSess && tSess.live_index ? `今日第 ${tSess.live_index} 场 · ` : '';
          sinceEl.textContent = `${sessTag}开播 ${V4.p2(st.getHours())}:${V4.p2(st.getMinutes())} · 已播 ${V4.durTxt(Date.now() - startMs)}`;
          sinceEl.style.display = '';
        } else if (j?.live?.isLive === false && j.status_stale !== true && tSess && tSess.count > 0) {
          const last = (tSess.list || []).slice(-1)[0] || null;
          const endD = last && last.endTime ? V4.parseT(last.endTime) : null;
          sinceEl.textContent = `今日已播 ${tSess.count} 场${endD ? ` · 最近 ${V4.p2(endD.getHours())}:${V4.p2(endD.getMinutes())} 下播` : ''}${view.classList.contains('is-frozen') ? ' · 终场定格' : ''}`;
          sinceEl.style.display = '';
        } else {
          sinceEl.style.display = 'none';
        }
      }

      /* ===== 主数据渲染（payload → 全页，不含拉取；off 回落优先复用 home-split 缓存） ===== */
      async function applyDash(j, opts) {
        if (!alive()) return;
        const fromCache = !!(opts && opts.fromCache);
        S.dash = j;
        const isLive = j.live?.isLive === true;
        const isOffline = j.live?.isLive === false && j.status_stale !== true;
        const roomId = currentRoomId(j);
        if (!isLive || !roomId || S.marginalRoomId !== roomId) {
          S.marginalFlow = null;
          S.marginalRoomId = roomId;
        }
        renderMarginalFlow();
        const sessList = (j.today_sessions && j.today_sessions.list) || [];
        const lastSess = sessList[sessList.length - 1] || null;
        S.previousSessionRoi = lastSess && lastSess.netRoi != null ? +lastSess.netRoi : null;
        if (!isLive && j.today_source !== 'sessions') j.today = null; // 未在播不拿今日累计当本场；上一场净ROI 走 previousSessionRoi 固定展示
        let today = j.today;
        // 上游异常时 today 可能是 {error:...} 异形对象（liveDashboard catch 兜底）：缺核心数值字段按无 today 处理——显示 --，且放行下面的 home-split 回填
        if (today && (typeof today !== 'object' || (typeof today.cost !== 'number' && typeof today.netRoi !== 'number'))) today = null;
        if (!today && isOffline && !j.collecting) {
          // 首页汇总独立更新；不让慢查询阻塞漏斗、渠道等已有快照的渲染。
          const sp = S.splitToday?.date === localDate(0) ? S.splitToday.payload : null;
          const L = sp?.live;
          if (L && !L.unavailable) today = { cost: L.cost, netRoi: L.roi, netGmv: L.gmv, orderCount: L.orders, roi: L.roi };
        }
        j.today = today; // 让 renderPlan 等下游用上回填后的 today（本场/今日口径随 isLive 而定）
        /* ===== 下播冻结：直播中持续快照最后一帧；下播后用快照填满页面（终场定格），不整页清空 ===== */
        if (isLive && !fromCache) {
          S.frozenLive = {
            at: Date.now(),
            funnel: j.funnel || null,
            source: j.source || [],
            decisions: j.decisions || null,
            materials_top: j.materials_top || [],
          };
          V4.cset('v4c_frozen_' + scopeKey, S.frozenLive); // F5 刷新也能恢复终场
        }
        if (!S.frozenLive) { // 懒恢复：切账号/F5 后第一轮下播态也有终场可看
          const pf = V4.cget('v4c_frozen_' + scopeKey, 12 * 3600 * 1000);
          if (pf && pf.data) S.frozenLive = pf.data;
        }
        const fz = (isOffline && S.frozenLive) ? S.frozenLive : null;
        if (fz) {
          if (!j.funnel) j.funnel = fz.funnel;
          if (!j.source || !j.source.length) j.source = fz.source;
          const dj = j.decisions || {};
          const dEmpty = !(dj.redList && dj.redList.length) && !(dj.blackList && dj.blackList.length) && !(dj.potentialList && dj.potentialList.length);
          if (dEmpty && fz.decisions) j.decisions = fz.decisions;
          if ((!j.materials_top || !j.materials_top.length) && fz.materials_top && fz.materials_top.length) j.materials_top = fz.materials_top;
        }
        view.classList.toggle('is-frozen', !!fz); // CSS：冻结区降饱和，视觉上"定格"
        const th = j.thresholds || {};
        S.be = +(th.break_even_roi || (today && today.break_even_roi) || V4.breakEven());
        const netRoi = today ? +(today.netRoi || 0) : 0;
        S.roi = netRoi;
        S.hasToday = !!(isLive && today && today.netRoi != null);
        S.avgPrice=null;S.exploreLine=null;S.mode=isOffline?'off':'uncalibrated';
        S.delta = (j.context && +j.context.roi_delta) || 0;
        const lm = j.live_metrics || {};
        // 文案口径：直播中=本场会话（直播大屏），下播=今日（推直播间日累计）
        $('lCost').textContent = isLive ? '本场消耗' : '今日消耗';
        $('lGmv').textContent = isLive ? '本场净成交' : '今日净成交';
        $('lOrd').textContent = isLive ? '本场订单' : '今日订单';
        odo($('vCost'), today ? fmtMoney(today.cost) : '--');
        $('vCostS').textContent = today && today.cost ? (isLive ? '本场会话' : '今日累计') : '';
        odo($('vGmv'), today ? fmtMoney(today.netGmv) : '--');
        $('vGmvS').textContent = today && today.netGmv ? '扣退款净口径' : '';
        const ordV = today ? (today.orderCount != null ? today.orderCount : today.orders) : null;
        odo($('vOrd'), ordV != null ? String(Math.round(ordV)) : '--'); // 场次聚合口径无订单数，显示 -- 不显示假零
        odo($('vBal'), j.balance && j.balance.total_yuan != null ? fmtM(j.balance.total_yuan) : '--'); // 余额获取失败显示 --，不显示假零
        $('vBalS').textContent = j.balance && j.balance.days_left ? `可用 ${(+j.balance.days_left).toFixed(1)} 天` : '';
        odo($('vOn'), isLive ? (lm.online == null ? '--' : String(Math.round(lm.online))) : (isOffline ? '0' : '--'));
        $('vOnS').textContent = isLive && lm.gpm != null ? `GPM ${Math.round(lm.gpm)}` : '';
        // 新增三格：整体支付ROI（账面）/ 退款率（home-split 全部口径）/ GPM
        odo($('vRoiAll'), today && today.roi != null ? (+today.roi).toFixed(2) : (S.splitAll && S.splitAll.roi != null ? (+S.splitAll.roi).toFixed(2) : '--'));
        odo($('vRefund'), S.splitAll && S.splitAll.refund_rate != null ? (+S.splitAll.refund_rate).toFixed(1) + '%' : '--');
        odo($('vGpm'), isLive && lm.gpm != null ? String(Math.round(lm.gpm)) : '--');
        // 大屏版式新增：观看-成交率 / 曝光-观看率（live_metrics 现成字段）
        odo($('vW2P'), isLive && lm.watchToPayRate != null ? (+lm.watchToPayRate).toFixed(2) + '%' : '--');
        odo($('vS2W'), isLive && lm.showToWatchRate != null ? (+lm.showToWatchRate).toFixed(2) + '%' : '--');
        // 第一行紧凑 vitals（三秒看完）：账号 | 净ROI | 消耗 | 在线 | 余额
        const vitBits = [`<b>${esc(V4.acctName())}</b>`];
        if (today) {
          vitBits.push(`净ROI <b>${today.netRoi == null ? '--' : Number(today.netRoi).toFixed(2)}</b>`);
          vitBits.push(`消耗 <b>${fmtMoney(today.cost)}</b>`);
        }
        if (isLive) vitBits.push(`在线 <b>${lm.online == null ? '--' : Math.round(lm.online)}</b>`);
        if (j.balance && j.balance.total_yuan != null) {
          vitBits.push(`余额 <b>${fmtM(j.balance.total_yuan)}</b>${j.balance.days_left != null ? `（${(+j.balance.days_left).toFixed(1)}天）` : ''}`);
        }
        $('bandVitals').innerHTML = vitBits.join('<span class="sep">|</span>');
        // 开播时间与已播时长（抽成 updateSince：applyDash 调一次 + 秒级 tick 本地推算，时钟跟手）
        updateSince(j);
        // 大屏原始入口（直播中显示）：罗盘大屏 + 千川大屏，新标签打开
        const linksEl = $('liveLinks');
        const room = (j.live && j.live.rooms && j.live.rooms[0]) || null;
        if (linksEl) {
          if (isLive && room && room.roomId) {
            const ai = j.account_info || {};
            const compassUrl = `https://compass.jinritemai.com/screen/live/shop?live_room_id=${room.roomId}&live_app_id=2079&source=compass-live-overview`;
            const qcUrl = `https://qianchuan.jinritemai.com/board-next?live_room_id=${room.roomId}&anchorId=${ai.anchorId || ''}&aavid=${ai.aavid || ''}&fromModule=uni_promotion_v2`;
            linksEl.innerHTML = `<a data-private-link href="${compassUrl}" target="_blank" rel="noopener">罗盘大屏↗</a><a data-private-link href="${qcUrl}" target="_blank" rel="noopener">千川大屏↗</a>`;
            linksEl.style.display = '';
          } else {
            linksEl.style.display = 'none';
          }
        }
        renderBoosts(j);
        renderPlan(j);
        S.funnel = j.funnel || null;
        renderFunnel();
        renderChannel();
        apply();
        renderWatchList(j);
        renderCoreFreshness(j);
        renderTarget(j.thresholds);
        renderRoomCoverage(j);
      }

      function renderRoomCoverage(j) {
        if (!roomScoped) return;
        const ledgerStatus = $('flow').dataset?.ledgerStatus;
        $('roomModulesStatus').textContent = (j?.boost_data_valid === true ? '追投已接入' : '追投待核验')
          + ' · ' + (ledgerStatus || '展开后读取本场决策');
        if (!ledgerStatus) $('flow').innerHTML = V4.emptyBox('展开后读取当前房间本场记录');
        $('roomDecisionTitle').textContent = '本场决策记录';
        view.querySelectorAll('[data-flow]').forEach(button => { button.disabled = true; button.hidden = true; });
        $('wrMidRow').style.display = 'none';
        $('wrScrBox').style.display = 'none';
        $('wrChengfangLive').hidden = true;
        $('vRefundS').textContent = '本房间暂无退款率';
        $('vFlowS').textContent = $('vBasicFlowS').textContent = $('vAssistFlowS').textContent = '本房间暂无流速拆分';
      }


      function renderWatchList(j) { const box=$('bandWatch'); if(box)box.style.display='none'; }

      function renderCoreFreshness(j) {
        const sourceAt = j?.component_times?.core?.source_at || j?.fetchedAt;
        const ts = Date.parse(sourceAt);
        const age = Number.isFinite(ts) ? Math.max(0, Math.floor((Date.now() - ts) / 1000)) : null;
        const isLive = j?.live?.isLive === true;
        const failure = (j?.errors || []).find(e => ['upstream_forbidden', 'cookie_expired'].includes(e.code));
        const missingText = failure?.code === 'upstream_forbidden' ? '千川拒绝访问（HTTP 403）· 请核对官方网页访问状态' :
          failure?.code === 'cookie_expired' ? '千川登录状态已失效 · 请在接入页更新凭据' : '核心数据缺失，等待采集';
        const text = (age == null ? missingText :
          `核心采集 ${new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })} · ${age}秒前` +
          (S.coreReadFailed ? ' · 读取失败，保留旧值' : (isLive && age > 30 ? ' · 更新延迟' : '')));
        const el = $('coreFreshness');
        if (el) {
          el.textContent = text;
          el.style.color = S.coreReadFailed || (isLive && (age == null || age > 30)) ? 'var(--warn)' : 'var(--ink-3)';
          el.title = '显示核心请求的采集起点，不是页面刷新时间；不代表平台内部更新时刻。素材、人群独立更新。';
        }
        if ($('upd')) $('upd').textContent = text;
        renderTarget(targetParams);
      }

      /* ===== 核心 5s 读内存，按房间和场次绑定 ===== */
      let dashFlight = false, dashSeq = 0;
      async function refreshDash() {
        if (dashFlight) return; // 在飞锁：慢接口叠加 30s 轮询会双发
        dashFlight = true;
        const my = ++dashSeq;
        const requestedTargetRevision = targetRevision;
        try {
          let j;
          try { j = await V4.api('/api/live-dashboard', scope, { timeout: 30000 }); }
          catch (e) { // 无感刷新：有旧帧就不砸错误框，下轮自愈；从未有过数据才显示错误
            if (alive() && ['live_session_changed', 'live_room_not_found', 'live_room_required', 'live_session_ambiguous'].includes(e.code)) {
              V4.clearRoom(acct0);
              return;
            }
            if (alive()) { S.coreReadFailed = true; renderCoreFreshness(S.dash); }
            if (alive() && !(S.lastBoosts && S.lastBoosts.length)) $('boosts').innerHTML = V4.errBox(e);
            return;
          }
          if (!alive() || my !== dashSeq) return; // 旧响应不得覆盖新数据
          const responseRoom = j.live?.rooms?.[0];
          if (j.account !== acct0 || String(responseRoom?.roomId || responseRoom?.room_id) !== scope.room_id ||
              String(responseRoom?.startTime || responseRoom?.start_time) !== scope.start_time) {
            S.coreReadFailed = true;
            renderTarget(targetParams);
            $('coreFreshness').textContent = '返回数据与所选直播间或场次不一致，本轮未展示';
            return;
          }
          const C = CACHE[scopeKey] = CACHE[scopeKey] || {};
          if (requestedTargetRevision !== targetRevision) j.thresholds = { ...j.thresholds, ...targetParams };
          S.coreReadFailed = false;
          C.j = j; C.updText = j.fetchedAt || null;
          await applyDash(j);
          if (!alive() || my !== dashSeq) return;
          // 首轮罗盘轮询可能早于直播状态返回；确认在播后立即加载，不空等下一分钟。
          const screenRoom = currentRoomId(j);
          if (j.live?.isLive === true && screenRoom && S.screenStartedRoom !== screenRoom && (!roomScoped || $('roomCompass').open)) {
            S.screenStartedRoom = screenRoom;
            void refreshScreen();
          }
          V4.cset('v4c_dash_' + scopeKey, { j, updText: C.updText });
        } finally { dashFlight = false; }
      }

      /* ===== 追投占比（告警用） ===== */
      function boostPct(j) {
        const lm = j.live_metrics || {};
        if (lm.assistCost == null) return null;
        const cost = (j.today && j.today.cost) || lm.cost || 0;
        const assist = lm.assistCost || 0;
        return cost > 0 ? +(assist / cost * 100).toFixed(1) : null;
      }
      /* 记分牌数值状态色（颜色唯一来源=状态计算）：st-* class 开关 */
      function setSt(id, cls) {
        const el = $(id);
        if (!el) return;
        el.classList.remove('st-ok', 'st-warn', 'st-danger', 'st-live');
        if (cls) el.classList.add(cls);
      }

      /* ===== 告警与待确认操作板块已整体删除（2026-08-03 维护者拍板："需要我管的"卡片多余）——
         pending-ops 人工拍板通道已废（写操作收归 AI+对话拍板）；告警改由维护会话巡查渠道上报 ===== */

      function boostFunnelMarkup(f) {
        const count = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value.toLocaleString('zh-CN') : '--';
        const rate = r => typeof r?.percent === 'number' && Number.isFinite(r.percent)
          ? r.percent.toFixed(2) + '%' : typeof r?.value === 'number' && Number.isFinite(r.value)
            ? r.value.toLocaleString('zh-CN', { maximumFractionDigits: 6 }) + '（单位待核）' : '--';
        const window = f?.window;
        const period = window?.start ? `${window.start}${window.end && window.end !== window.start ? ' 至 ' + window.end : ''} 日期累计` : '统计窗口待核';
        const source = f?.source_type === 'boost_task_report' ? '任务日报' : f?.source_type === 'boost_list_stats' ? '任务列表' : '来源待核';
        const hint = `${period} · ${source} · 非本场归因；平台更新时间及转化率分母待核，不单凭两率停投`;
        return `<div class="b-m" aria-label="追投点击与转化" title="${esc(hint)}"><span>展示 <b>${count(f?.show_cnt)}</b></span><span>点击 <b>${count(f?.click_cnt)}</b></span><span>点击率 <b>${rate(f?.ctr)}</b></span><span>转化率 <b>${rate(f?.cvr)}</b></span></div><div class="cd" style="font-size:11px;margin-top:4px;overflow-wrap:anywhere">${esc(period)} · ${esc(source)} · 平台更新时刻待核</div>`;
      }

      /* ===== 追投任务（无感刷新：快速路径空档时保留旧帧，只有从未有过数据才显示加载态） ===== */
      function renderBoosts(j) {
        S.boostDisplayInput = j; // Filter changes reuse the original quality state without refreshing timestamps.
        const currentRows = Array.isArray(j.boost_tasks) ? j.boost_tasks : [];
        const currentComplete = j.boost_data_valid === true && j.boost_truncated !== true;
        if (roomScoped && !currentComplete && !currentRows.length) {
          const reason = j.boost_coverage?.reason;
          const message = reason === 'room_plan_loading' ? '本房间主计划与追投读取中…'
            : reason === 'primary_plan_ambiguous' ? '本房间匹配多个主计划，暂不能合并追投'
            : reason === 'primary_plan_not_found' ? '尚未核验到本房间对应的主计划'
            : '本房间追投暂未取得，请稍后刷新';
          S.lastBoosts = [];
          S.boostFrame = null;
          $('boosts').innerHTML = V4.emptyBox(message);
          $('boostSum').textContent = '未取得';
          $('boostFoot').textContent = '任务数量未知';
          return;
        }
        const frame = !currentRows.length && j.from_fast_path && S.boostFrame ? S.boostFrame : j;
        const previousFrame = frame !== j;
        const allRows = Array.isArray(frame.boost_tasks) ? frame.boost_tasks : [];
        if (!previousFrame && (!j.from_fast_path || currentRows.length)) S.boostFrame = frame;
        const filter = S.boostFilter || 'active';
        const list = allRows.filter(t => filter === 'all' || (filter === 'paused' ? /暂停/.test(t.status || '') : t.status === '投放中'));
        const complete = currentComplete && !previousFrame;
        const sum = previousFrame ? null : frame.boost_summary;
        const pq = frame.plan;
        const label = filter === 'paused' ? '已读暂停' : filter === 'all' ? '已读全部' : complete ? '在投' : '已读在投';
        const statusSuffix = previousFrame ? ' · 正在更新，显示上次读取' : !complete ? ' · 列表不完整' : '';
        // 数量上限已取消（2026-09-21）：不再显示 /40 的限额，只报在投个数
        const quotaFoot = roomScoped
          ? `${label}追投 ${list.length} 个${statusSuffix} · 主计划 <span data-private="id">${esc(pq?.primary_ad_id || '')}</span> · ${esc(frame.boost_window?.start || '')} 日累计，非本场归因${filter !== 'active' ? ' · 仅当前接口已读任务，非全部历史暂停任务' : ''}`
          : `${label}追投 ${list.length} 个${statusSuffix}${pq && pq.quota_left != null ? ` · 控成本额度 ${fmtM(pq.quota_left)}` : ''}`;
        // 快速路径返回空追投但数据可能还在后台刷新，不误报"无追投"
        if (!list.length) {
          if (!allRows.length && j.from_fast_path && !previousFrame) {
            // 无旧帧：显示轻量占位，完整路径后台跑完自动上屏（2026-08-18 提速）
            $('boosts').innerHTML = V4.emptyBox('追投明细加载中…');
          } else {
            S.lastBoosts = []; // 完整路径的权威空：确实无任务，清掉旧帧
            $('boosts').innerHTML = V4.emptyBox(`当前${complete ? '已读列表中没有' : '尚未读到'}${filter === 'paused' ? '暂停' : filter === 'all' ? '' : '在投'}追投任务`);
          }
          $('boostSum').textContent = !allRows.length && j.from_fast_path && !previousFrame ? '读取中…' : `${label} ${list.length}${statusSuffix}`;
          $('boostFoot').innerHTML = quotaFoot; // footer 独立于 b-list 滚动区，常驻可见
          return;
        }
        S.lastBoosts = list;
        $('boostSum').textContent = `${label} ${list.length}${statusSuffix}${complete && sum?.total_cost != null ? ` · 计划追投日累计消耗 ${fmtMoney(sum.total_cost)}` : ''}`;
        // 历史账户专用说明已从试用包移除。
        const groupRank = { active: 0, passive_stop: 1, offline_wait: 2, manual_paused: 3 };
        const sortedList = list.slice().sort((a, b) => (groupRank[a.board_group] ?? 0) - (groupRank[b.board_group] ?? 0) || (+b.cost || 0) - (+a.cost || 0));
        $('boosts').innerHTML = sortedList.map(t => {
          const active = t.status === '投放中';
          const roi = t.net_roi == null ? null : +t.net_roi;
          const rc = roi != null && S.be > 0 ? V4.stateClass(roi, S.be) : '';
          // 公共版只显示平台状态，不评级。
          const bleeding = false;
          const duration = t.duration_unit === 'seconds' && Number.isSafeInteger(t.duration_seconds) && t.duration_seconds > 0
            ? (t.duration_seconds / 3600).toLocaleString('zh-CN', { maximumFractionDigits: 2 }) + ' 小时' : '--';
          // 历史账户专用说明已从试用包移除。
          return `<div class="b-row${bleeding ? ' bleed' : ''}">
            <div class="b-top"><span class="b-name" title="${esc(t.name)}">${active ? '<i class="b-live-dot"></i>' : ''}${esc(t.name)}<span class="b-st${t.passive_stop ? ' warn' : ''}">${esc(t.status)}</span></span></div>
            <div class="b-m"><span>消耗 <b>${t.cost == null ? '--' : fmtMoney(t.cost)}</b></span><span>净成交 <b>${t.net_gmv == null ? '--' : fmtMoney(t.net_gmv)}</b></span><span>支付 <b>${t.order_count == null ? '--' : t.order_count}</b> 单</span><span>净ROI <b class="${rc}">${roi == null ? '--' : roi.toFixed(2)}</b></span><span>目标 <b>${t.roi_goal != null ? (+t.roi_goal).toFixed(2) : '--'}</b></span><span>预算 <b>${t.budget == null ? '--' : fmtM(t.budget)}</b></span></div>
            ${boostFunnelMarkup(t.funnel)}
            <div class="b-m"><span title="平台实际总时长，非已运行或剩余时长">总时长 <b>${duration}</b></span></div>
          </div>`;
        }).join('');
        $('boostFoot').innerHTML = quotaFoot;
      }

      /* ===== 主计划（无感刷新：快速路径 plan 空档时保留旧帧） ===== */
      let chengfangFlight = false;
      async function refreshChengfangLive() {
        if (roomScoped) return;
        if (chengfangFlight || !alive()) return;
        chengfangFlight = true;
        try {
          const response = await fetch(`/api/chengfang/live?account=${encodeURIComponent(acct0)}`);
          const data = await response.json();
          if (!response.ok || !data.ok) throw new Error(data.error || '乘方直播读取失败');
          if (!alive()) return;
          $('wrChengfangLive').hidden = !data.has_chengfang;
          $('wrChengfangTime').textContent = data.fetched_at ? V4.fmtCnTime(data.fetched_at).full : '';
          const money = value => value == null ? '--' : fmtMoney(value);
          $('wrChengfangPlans').innerHTML = data.plans.map(p => `<div style="padding:10px 0">
            <div>${esc(p.name)} <span class="cd">${esc(p.status || '')} · <span data-private="id">${esc(p.id)}</span></span></div>
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-top:10px">
              <div><span class="cd">综合成本</span><div class="num">${money(p.cost)}</div></div>
              <div><span class="cd">综合营销 ROI</span><div class="num">${p.roi == null ? '--' : (+p.roi).toFixed(2)}</div></div>
              <div><span class="cd">净成交 · 1h</span><div class="num">${money(p.net_gmv)}</div></div>
              <div><span class="cd">净成交订单</span><div class="num">${p.orders == null ? '--' : esc(p.orders)}</div></div>
            </div></div>`).join('');
        } catch (error) {
          if (!alive()) return;
          $('wrChengfangLive').hidden = false;
          $('wrChengfangTime').textContent = '暂未更新';
          $('wrChengfangPlans').innerHTML = V4.emptyBox('乘方直播数据暂不可用');
        } finally { chengfangFlight = false; }
      }

      function renderPlan(j) {
        const p = j.plan;
        if (roomScoped) {
          const basis = { payment: '支付 ROI', platform_net_1h: '平台 1 小时净成交 ROI', chengfang_comprehensive: '乘方综合 ROI' };
          S.lastPlan = p || null;
          odo($('vPlanRoi'), p?.roi_goal == null ? '--' : (+p.roi_goal).toFixed(2));
          $('vPlanRoiS').textContent = p ? `主计划目标 · ${basis[p.roi_goal_basis] || '口径待核验'}` : '主计划待核验';
          // 平台未说明预算周期，不能拿房间总消耗除以计划预算生成进度。
          $('vBudPct').textContent = '--';
          $('vBudS').textContent = p?.budget == null ? '预算未取得' : `计划预算 ${fmtM(p.budget)} · 周期待核验`;
          $('vBudBar').style.width = '0%';
          return;
        }
        if (!p) {
          if (S.lastPlan) return; // 旧帧保留，等完整路径带回新值
          return; // 顶部格保持初始 --（2026-07-31 右列独立卡片已删，无空态可填）
        }
        S.lastPlan = p;
        // 历史账户专用说明已从试用包移除。
        if ($('vPlanRoi')) odo($('vPlanRoi'), p.roi_goal != null ? (+p.roi_goal).toFixed(2) : '--');
        // 历史账户专用说明已从试用包移除。
        const hasCost = S.dash && S.dash.today;
        const pct = +(p.spent_pct || 0);
        if ($('vBudPct')) {
          $('vBudPct').textContent = hasCost ? pct.toFixed(1) + '%' : '--';
          $('vBudPct').style.color = hasCost && pct >= 90 ? 'var(--st-danger)' : hasCost && pct >= 70 ? 'var(--st-warn)' : '';
        }
        // 直播中 today.cost 是本场会话口径，下播无 today 时显示 --（不拿错误口径充数）
        if ($('vBudS')) $('vBudS').textContent = (hasCost ? `${fmtM(S.dash.today.cost)} / ` : '预算 ') + fmtM(p.budget);
        if ($('vBudBar')) $('vBudBar').style.width = Math.min(100, pct) + '%';
      }

      /* ===== Agent 决策流（60s） ===== */
      function filterRounds(rounds) {
        if (!Array.isArray(rounds)) return [];
        if (S.flowMode === 'all') return rounds;
        const d = S.flowDate || localDate(0);
        return rounds.filter(r => String(r.time || '').startsWith(d));
      }
      function renderRoundsData(rounds) {
        const list = filterRounds(rounds);
        if (!list.length) { $('flow').innerHTML = V4.emptyBox(S.flowMode === 'all' ? '暂无巡检记录' : '今日暂无巡检记录'); return; }
        $('flow').innerHTML = list.map((r, i) => {
          const cn = V4.fmtCnTime(r.time);
          const hhmm = cn.full || String(r.round || '');

          /* 操作留痕：优先结构化 actions；旧字符串仅作兼容展示，不再靠原文推断轮次类型。 */
          const NOOP = /^(无操作|无写操作|无|null|none|观望)$/i;
          let ops = Array.isArray(r.actions)
            ? r.actions.map(a => typeof a === 'string' ? a : (a.message || a.description || a.code || a.action || ''))
            : Array.isArray(r.actions_raw) ? r.actions_raw.slice() : String(r.actions || '').split(/[,，]/);
          ops = ops.map(s => String(s || '').trim()).filter(s => s && !NOOP.test(s));

          /* 轮次性质由服务端结构化 code/status 归类，禁止自然语言猜测。 */
          const badge = r.type === 'attention'
            ? '<span class="f-tag stop">需要关注</span>'
            : r.type === 'action' || ops.length
              ? `<span class="f-tag exec">动作轮 · ${ops.length} 项操作</span>`
              : '<span class="f-tag wait">观望轮</span>';

          /* 数字带：消耗 / 净投产比 / 订单（余额不进决策卡，属告警体系） */
          const rawSnapshot = r.snapshot && typeof r.snapshot === 'object' ? r.snapshot : (r.data_snapshot && typeof r.data_snapshot === 'object' ? r.data_snapshot : {});
          const snap = rawSnapshot.metrics && typeof rawSnapshot.metrics === 'object' ? rawSnapshot.metrics : rawSnapshot;
          const pick = (...keys) => { for (const k of keys) { const v = snap[k]; if (v != null && v !== '' && Number.isFinite(+v)) return +v; } return null; };
          const cost = pick('cost', 'today_cost', '消耗');
          const netRoi = pick('net_roi', 'netRoi', 'today_net_roi', '净ROI', '净投产比');
          const orders = pick('orders', 'orders_pay', 'order_count', 'orderCount', '订单', '订单数');
          const be = pick('break_even_roi', 'breakEvenRoi', 'breakEven', 'break_even', '保本线', '保本') || S.be || V4.breakEven();
          const mItems = [];
          if (cost != null) mItems.push(`<div class="f-metric"><div class="fm-l">消耗</div><div class="fm-v num">${V4.fmtMoney(cost)}</div></div>`);
          if (netRoi != null) mItems.push(`<div class="f-metric"><div class="fm-l">净投产比（保本 ${be.toFixed(2)}）</div><div class="fm-v num ${V4.stateClass(netRoi, be)}">${netRoi.toFixed(2)}</div></div>`);
          if (orders != null) mItems.push(`<div class="f-metric"><div class="fm-l">订单</div><div class="fm-v num">${Math.round(orders).toLocaleString('zh-CN')}</div></div>`);
          const metrics = mItems.length ? `<div class="f-metrics">${mItems.join('')}</div>` : '';

          /* 操作留痕区：类型徽章 + 原文（止损红、暂停黄、其余青） */
          const opsHtml = ops.length ? `
            <div class="f-sec-l">本轮操作 · 留痕</div>
            <div class="f-ops">${ops.map(op => {
              const cls = /止损|删除|下线/.test(op) ? 'stop' : /暂停/.test(op) ? 'pause' : 'exec';
              const tag = /删除/.test(op) ? '删除' : /止损/.test(op) ? '止损' : /暂停/.test(op) ? '暂停' : /新建|创建/.test(op) ? '新建追投' : /调.{0,4}(ROI|投产比)/i.test(op) ? '调投产比' : /调预算/.test(op) ? '调预算' : /充值/.test(op) ? '充值' : '操作';
              return `<div class="f-op"><span class="f-op-tag ${cls}">${tag}</span><span class="f-op-t">${esc(op)}</span></div>`;
            }).join('')}</div>` : '';

          /* 决策依据：结构化 judgments 优先，旧 decisions 仅作兼容。 */
          let decRaw = [];
          if (Array.isArray(r.judgments)) {
            decRaw = r.judgments.map(d => typeof d === 'string' ? d : String((d && (d.message || d.reason || d.code)) || ''));
          } else if (Array.isArray(r.decisions)) {
            decRaw = r.decisions.map(d => typeof d === 'string' ? d : String((d && (d.reason || [d.material, d.reason].filter(Boolean).join('：'))) || ''));
          } else if (typeof r.decisions === 'string' && r.decisions.trim()) decRaw = [r.decisions.trim()];
          decRaw = decRaw.map(s => String(s || '').trim()).filter(Boolean);
          const decsHtml = decRaw.length ? `
            <div class="f-sec-l">每轮四问 · 决策依据</div>
            <div class="f-decs">${decRaw.map(d => {
              const m = d.match(/^([^：:，。；;\s]{2,6})[：:]\s*([\s\S]+)$/);
              const tag = m ? m[1] : '决策';
              const bodyText = m ? m[2] : d;
              const cls = /止损|删/.test(tag) ? 'stop' : '';
              return `<div class="f-dec"><span class="f-dec-tag ${cls}">${esc(tag)}</span><span class="f-dec-t">${esc(bodyText)}</span></div>`;
            }).join('')}</div>` : '';

          /* 预期仅作记录；后续事实在决策记录页查看，不显示分数。 */
          const eff = r.expected_effect && typeof r.expected_effect === 'object' ? JSON.stringify(r.expected_effect) : String(r.expected_effect || '').trim();
          const hasEvidence = !!(r.outcome && r.outcome.details && r.outcome.details.after_snapshot_id);
          const loopHtml = (eff || hasEvidence) ? `
            <div class="f-loop">
              <span class="f-loop-l">预期与观测</span>
              <span class="f-loop-t">${esc(eff || '前后快照已保存，见决策记录')}</span>
              <span class="f-loop-s">${hasEvidence ? '已有后续事实 · 不作因果归因' : '仅记录预期'}</span>
            </div>` : '';

          const title = String(r.summary || r.title || r.desc || '巡检记录').trim();
          return `<div class="f-item ${i === 0 ? 'fresh' : ''}">
            <div class="f-meta">${esc(hhmm)} ${badge}</div>
            <div class="f-title">${esc(title)}</div>
            ${metrics}
            ${opsHtml}
            ${decsHtml}
            ${loopHtml}
          </div>`;
        }).join('');
      }
      function bindFlowTabs() {
        if (roomScoped) return;
        const tabs = document.querySelectorAll('[data-flow]');
        const dateIn = $('flowDate');
        tabs.forEach(b => b.onclick = () => {
          tabs.forEach(x => x.classList.remove('on'));
          b.classList.add('on');
          S.flowMode = b.dataset.flow;
          if (S.flowMode === 'today') {
            S.flowDate = null;
            dateIn.style.display = 'none';
          } else if (S.flowMode === 'date') {
            dateIn.style.display = '';
            if (!S.flowDate) dateIn.value = localDate(0);
            S.flowDate = dateIn.value;
          } else {
            dateIn.style.display = 'none';
          }
          renderRoundsData(CACHE[scopeKey] && CACHE[scopeKey].rounds ? CACHE[scopeKey].rounds : []);
        });
        if (dateIn) dateIn.onchange = () => {
          S.flowDate = dateIn.value;
          renderRoundsData(CACHE[scopeKey] && CACHE[scopeKey].rounds ? CACHE[scopeKey].rounds : []);
        };
      }
      bindFlowTabs();
      // 成交渠道构成：成交金额 ⇆ 观看次数 切换
      const chanT = $('chanToggle');
      if (chanT) chanT.onclick = () => { S.chanMetric = S.chanMetric === 'watch' ? 'pay' : 'watch'; renderChannel(); };
      async function refreshRoomRounds() {
        if (!alive() || !$('roomModules').open || S.roomRoundsFlight) return;
        S.roomRoundsFlight = true;
        const sessionKey = scope.start_time ? `${acct0}|${scope.room_id}|${scope.start_time}` : null;
        $('flow').dataset.ledgerStatus = '本场决策读取中';
        renderRoomCoverage(S.dash);
        try {
          if (!sessionKey) throw new Error('当前房间缺少开播时间，无法绑定本场决策记录');
          const data = await V4.api('/api/decision-rounds', { account: acct0, session_key: sessionKey, limit: 20 }, { timeout: 15000 });
          if (!alive()) return;
          if (data?.account_id !== acct0 || !Array.isArray(data.rounds)) throw new Error('账本返回的账户或记录格式无法核验');
          const rows = data.rounds.filter(round => round?.account_id === acct0 && round.session_key === sessionKey);
          renderRoomRounds(rows, data.rounds.length - rows.length);
        } catch (error) {
          if (!alive()) return;
          $('flow').dataset.ledgerStatus = error.status === 404 ? '当前服务未提供决策账本' : '本场决策读取失败';
          $('flow').innerHTML = V4.errBox(error);
        } finally {
          S.roomRoundsFlight = false;
          if (alive()) renderRoomCoverage(S.dash);
        }
      }

      function renderRoomRounds(rounds, excluded = 0) {
        $('flow').dataset.ledgerStatus = `本场 ${rounds.length} 轮记录${excluded ? ` · ${excluded} 条归属不符已省略` : ''}`;
        const link = '<a href="#/decisions">查看完整本场记录与回执 →</a>';
        if (!rounds.length) { $('flow').innerHTML = V4.emptyBox('本场暂无已绑定的决策记录') + link; return; }
        $('flow').innerHTML = '<div class="cd">仅当前房间本场 · 最近20轮 · ' + link + '</div>' + rounds.map(round => {
          const title = typeof round.summary === 'string' && round.summary.trim() ? round.summary : '本轮未填写摘要';
          const actions = Array.isArray(round.actions) ? round.actions : (round.actions == null ? [] : [round.actions]);
          const snapshot = round.snapshot?.verified === true ? '观测快照已绑定' : '观测快照未验证';
          return `<div class="f-item"><div class="f-meta">${esc(V4.fmtCnTime(round.observed_at || round.recorded_at).full || '时间未记录')} · ${snapshot}</div>
            <div class="f-title">${esc(title.slice(0, 180))}</div>
            <div class="cd">${actions.length ? `${actions.length} 条动作声明，验证状态见完整记录` : '未记录投放动作'}</div></div>`;
        }).join('');
      }

      async function refreshRounds() {
        if (roomScoped) return refreshRoomRounds();
        let j;
        try { j = await V4.api('/api/agent-rounds'); }
        catch (e) { if (alive()) $('flow').innerHTML = V4.errBox(e); return; }
        if (!alive()) return;
        const C = CACHE[scopeKey] = CACHE[scopeKey] || {};
        C.rounds = j.rounds || [];
        V4.cset('v4c_rounds_' + scopeKey, C.rounds); // 持久化：F5 刷新秒恢复
        renderRoundsData(C.rounds);
      }

      /* ===== 老板评审（60s） ===== */
      function renderBossData(c) {
        if (!c) { $('bossBlock').style.display = 'none'; return; }
        $('bossBlock').style.display = '';
        $('bossG').textContent = c.grade || '-';
        $('bossG').className = 'g g-' + (c.grade || 'B');
        $('bossS').innerHTML = `${esc(c.date || '')} 评定 <b>${c.total_score != null ? esc(String(c.total_score)) : '--'}</b> / 100`;
        $('bossQ').textContent = '"' + (c.summary || c.scoring_note || '').slice(0, 120) + '"';
      }
      async function refreshBoss() {
        if (roomScoped) return;
        try {
          const j = await V4.api('/api/agent-memory', { type: 'decisions', limit: 50, accountId: '' });
          if (!alive()) return;
          const list = (j.decisions || j.items || []).filter(r => /critique$/.test(String(r.round || '')));
          list.sort((a, b) => String(b.date || b.time || '').localeCompare(String(a.date || a.time || '')));
          const C = CACHE[scopeKey] = CACHE[scopeKey] || {};
          C.boss = list.length ? list[0] : null;
          V4.cset('v4c_boss_' + scopeKey, C.boss); // 持久化：F5 刷新秒恢复
          renderBossData(C.boss);
        } catch (e) {}
      }

      /* ===== 店铺成交三分口径（全部/推商品/推直播间） ===== */
      function localDate(offset) { const d = new Date(Date.now() + offset * 86400000); return `${d.getFullYear()}-${V4.p2(d.getMonth() + 1)}-${V4.p2(d.getDate())}`; }
      function renderSplitData(j) {
        const box = $('splitBox');
        const rows = [j.all, j.product, j.live].filter(Boolean);
        // 失败必须与真零区分，包括合并口径中任一来源不可用的情况。
        if (rows.some(r => r.unavailable || r.base_unavailable || r.cf_unavailable)) {
          if (box) box.innerHTML = V4.errBox(new Error('千川限频或网络波动，该口径暂时获取失败（不是 ¥0），稍后自动重试'));
          return false;
        }
        S.splitAll = j.all || null; // 退款率/整体ROI 给顶部 vitals 用
        apply();
        if (box) box.innerHTML = rows.map(r => {
          const rc = V4.stateClass(r.roi, S.be);
          const rfTxt = r.refund_rate != null && Number.isFinite(+r.refund_rate) ? (+r.refund_rate).toFixed(1) + '%' : '--';
          const ordTxt = r.orders != null && Number.isFinite(+r.orders) ? Math.round(r.orders) : '--';
          const roiTxt = r.roi != null && Number.isFinite(+r.roi) ? (+r.roi).toFixed(2) : '--';
          return `<div class="cell">
            <div class="lab">${esc(r.label)}<span class="rf">退款 ${rfTxt} · ${ordTxt} 单${j.finalized ? ' · 终值' : ''}</span></div>
            <div class="cost num">${fmtMoney(r.cost)}</div>
            <div class="sub"><span>净成交 <b>${fmtMoney(r.gmv)}</b></span><span>${r.roi_source === 'derived_net_gmv_div_cost' ? '计算ROI' : 'ROI'} <b class="${rc}">${roiTxt}</b></span></div>
          </div>`;
        }).join('');
        return true;
      }
      let splitFlight = false;
      async function refreshSplit(which) {
        if (roomScoped) return;
        if (splitFlight) return; // 在飞锁：tab 点击与 60s 轮询可并发
        splitFlight = true;
        const box = $('splitBox');
        try {
          const date = which === 'today' ? localDate(0) : localDate(-1);
          const j = await V4.api('/api/home-split', { date });
          if (!alive()) return;
          const C = CACHE[scopeKey] = CACHE[scopeKey] || {};
          C.split = j;
          if (which === 'today') { // F1：缓存今日 payload 给 applyDash 下播回落复用
            S.splitToday = { payload: j, date, ts: Date.now() };
            C.splitToday = S.splitToday;
            V4.cset('v4c_split_' + scopeKey + '_' + date, j); // 会话持久化
          }
          if (S.dash?.live?.isLive === false) await applyDash({ ...S.dash }, { fromCache: true });
          renderSplitData(j); // 失败不单独重试，由 60s 轮询统一重试
        } catch (e) { if (alive() && box) box.innerHTML = V4.errBox(e); }
        finally { splitFlight = false; }
      }
      // 仅后台读取今日千川首页汇总，供退款率和下播兜底使用；可视化已移至工作台。

      /* ===== 直播间核心漏斗（罗盘大屏版式：横条 + SVG 连接线/箭头，2026-07-27 抄截图） ===== */
      function renderFunnel() {
        const f = S.funnel;
        const el = $('wrFunnel');
        if (!el) return;
        const counts = f && f.counts && typeof f.counts === 'object' ? f.counts : {};
        const ratesMap = f && f.rates && typeof f.rates === 'object' ? f.rates : {};
        const metric = (modern, legacy) => {
          const value = modern != null ? modern : legacy;
          return value != null && Number.isFinite(+value) ? +value : null;
        };
        const show = metric(counts.shows, f && f.show);
        const watch = metric(counts.views, f && f.watch);
        const click = metric(counts.product_clicks, f && f.click);
        const order = metric(counts.pay_orders, f && f.order);
        const hasCounts = [show, watch, click, order].some(v => v != null);
        if (!f || f.data_valid === false || !hasCounts) { el.innerHTML = '<div style="color:var(--ink-3);font-size:11px;padding:8px 0">' + (S.dash?.live?.isLive === true ? '本场漏斗数据待更新，正在独立采集' : '暂无本场漏斗数据') + '</div>'; return; }
        const steps = [
          ['直播间整体曝光次数', show],
          ['直播间观看次数', watch],
          ['商品点击次数', click],
          ['成交订单数', order],
        ];
        const showToWatchRate = metric(ratesMap.show_to_watch, f.showToWatchRate);
        const watchToClickRate = metric(ratesMap.watch_to_click, f.watchToClickRate);
        const clickToPayRate = metric(ratesMap.click_to_pay, f.clickToPayRate);
        const watchToPayRate = metric(ratesMap.watch_to_pay, f.watchToPayRate);
        const rates = [null, showToWatchRate, watchToClickRate, clickToPayRate];
        const rateTips = ['', '曝光→观看', '观看→点击', '点击→成交'];
        const max = Math.max(...steps.map(s => s[1] == null ? 0 : s[1]), 1);
        const ROW = 32, GAP = 7, MAXW = 72; // 条宽上限 72%，右侧留给连接线与转化率
        const H = steps.length * ROW + (steps.length - 1) * GAP;
        const w = steps.map(s => Math.max(24, Math.round((s[1] == null ? 0 : s[1]) / max * MAXW)));
        const bars = steps.map(([n, v], i) =>
          `<div class="fn2-bar" style="width:${w[i]}%;top:${i * (ROW + GAP)}px"><span>${n}</span><b>${v == null ? '--' : v.toLocaleString()}</b></div>`).join('');
        const paths = [], labels = [];
        // 逐级连接线：上条底边右缘 → 右移 → 竖线下探 → 左进本条顶边（箭头指入）
        for (let i = 1; i < steps.length; i++) {
          const x1 = w[i - 1] * 10, x2 = w[i] * 10;
          const lx = Math.max(x1, x2) + 25;
          const y1 = (i - 1) * (ROW + GAP) + ROW;
          const y2 = i * (ROW + GAP);
          paths.push(`<path d="M${x1},${y1} H${lx} V${y2} H${x2}" class="fn2-ln" marker-end="url(#fnArr)"/>`);
          if (rates[i] != null) labels.push(`<div class="fn2-lb" title="${rateTips[i]}" style="left:${(lx / 10 + 1).toFixed(1)}%;top:${(y1 + y2) / 2 - 8}px">${(+rates[i]).toFixed(2)}%</div>`);
        }
        // 长括号（截图右下 2.37%）：观看 → 成交 整体转化，虚线
        // 从观看条【中点】出发、到成交条【中点】进入——与逐级连接线（底边→顶边）错开 y 区间，不打架
        if (watchToPayRate != null && steps.length >= 4) {
          const x1 = w[1] * 10, x2 = w[3] * 10;
          const lx = 840; // 固定在 84%，避开逐级标注（~43%）与条体（≤72%）
          const y1 = 1 * (ROW + GAP) + ROW / 2;
          const y2 = 3 * (ROW + GAP) + ROW / 2;
          paths.push(`<path d="M${x1},${y1} H${lx} V${y2} H${x2}" class="fn2-ln fn2-ln-total" marker-end="url(#fnArr)"/>`);
          labels.push(`<div class="fn2-lb fn2-lb-total" title="观看→成交整体转化" style="left:${(lx / 10 + 1).toFixed(1)}%;top:${(y1 + y2) / 2 - 8}px">${watchToPayRate.toFixed(2)}%</div>`);
        }
        el.innerHTML = `<div class="fn2-stage" style="height:${H}px">${bars}
          <svg class="fn2-svg" viewBox="0 0 1000 ${H}" preserveAspectRatio="none">
            <defs><marker id="fnArr" markerWidth="7" markerHeight="7" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 z" class="fn2-arr"/></marker></defs>
            ${paths.join('')}
          </svg>${labels.join('')}</div>`;
        $('wrMidRow').style.display = '';
      }

      /* ===== 成交渠道构成（环形图 + 图例，⇆ 成交金额/观看次数 切换） ===== */
      const CH_COLORS = ['#dbe7ff', '#a8c7fa', '#6ea8fe', '#3d7bfd', '#1f56d8', '#123a9e'];
      function renderChannel() {
        const el = $('wrChannel');
        const toggle = $('chanToggle');
        if (!el) return;
        const rawSource = S.dash && S.dash.source;
        const src = Array.isArray(rawSource) ? rawSource : [];
        const metric = S.chanMetric === 'watch' ? 'watch' : 'pay';
        const rows = src.map(c => ({ name: c.channel || '其他', pay: +c.pay || 0, watch: +c.watch || 0 }))
          .filter(c => c.pay > 0 || c.watch > 0);
        if (!rows.length) {
          el.innerHTML = '<div style="color:var(--ink-3);font-size:11px;padding:8px 0">' + (S.dash?.live?.isLive === true ? '本场渠道数据待更新，正在独立采集' : '暂无本场渠道数据') + '</div>';
          if (toggle) toggle.style.display = 'none';
          return;
        }
        if (toggle) { toggle.style.display = ''; toggle.textContent = metric === 'pay' ? '⇆ 观看次数' : '⇆ 成交金额'; }
        const total = rows.reduce((s, c) => s + c[metric], 0) || 1;
        const sorted = rows.slice().sort((a, b) => b[metric] - a[metric]);
        // Top4 + 其余合并（源数据若已有"其他"渠道则并入它，避免图例出现两个"其他"），再按当前口径降序
        const items = sorted.slice(0, 4);
        const rest = sorted.slice(4);
        if (rest.length) {
          const exist = items.find(c => c.name === '其他');
          if (exist) {
            exist.pay += rest.reduce((s, c) => s + c.pay, 0);
            exist.watch += rest.reduce((s, c) => s + c.watch, 0);
          } else {
            items.push({ name: '其他', pay: rest.reduce((s, c) => s + c.pay, 0), watch: rest.reduce((s, c) => s + c.watch, 0) });
          }
        }
        items.sort((a, b) => b[metric] - a[metric]);
        el.innerHTML = `<div class="chan-wrap">
          <canvas class="chan-donut" width="224" height="224"></canvas>
          <div class="chan-legend">${items.map((c, i) => `<div class="chan-li"><i style="background:${CH_COLORS[i % CH_COLORS.length]}"></i><span class="nm" title="${esc(c.name)}">${esc(c.name)}</span><b>${(c[metric] / total * 100).toFixed(2)}%</b></div>`).join('')}</div>
        </div>`;
        drawDonut(el.querySelector('canvas'), items.map((c, i) => ({ v: c[metric], color: CH_COLORS[i % CH_COLORS.length] })), metric === 'pay' ? '成交金额' : '观看次数');
        $('wrMidRow').style.display = '';
      }
      function drawDonut(cv, segs, label) {
        if (!cv) return;
        const ctx = cv.getContext('2d');
        const W = cv.width, H = cv.height, cx = W / 2, cy = H / 2;
        const R = Math.min(W, H) / 2 - 8, r = R * 0.62;
        ctx.clearRect(0, 0, W, H);
        const total = segs.reduce((s, x) => s + x.v, 0) || 1;
        let a = -Math.PI / 2;
        for (const s of segs) {
          const a2 = a + (s.v / total) * Math.PI * 2;
          ctx.beginPath();
          ctx.arc(cx, cy, R, a, a2);
          ctx.arc(cx, cy, r, a2, a, true);
          ctx.closePath();
          ctx.fillStyle = s.color;
          ctx.fill();
          a = a2;
        }
        const ink = (getComputedStyle(document.documentElement).getPropertyValue('--ink') || '#f1f5f9').trim();
        ctx.fillStyle = ink;
        ctx.font = `600 ${Math.round(R * 0.26)}px "PingFang SC", "Microsoft YaHei", sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(label, cx, cy);
      }
      function renderPortrait() {
        const p = S.portrait || {};
        const el = $('wrPortrait');
        if (!el) return;
        const sections = [
          { key: 'diff', label: '只看不买用户画像', badge: 'Top3', empty: '暂无相关数据' },
          { key: 'watch', label: '看播核心用户画像', empty: S.portraitError ? '罗盘画像读取失败，正在重试' : '当前看播样本不足' },
          { key: 'pay', label: '购买核心用户画像', empty: '近5分钟成交人数过少' },
        ];
        el.innerHTML = sections.map(section => {
          const item = p[section.key];
          const rows = item && item.map ? Object.values(item.map).filter(Boolean) : [];
          const stale = section.key === 'watch' && S.portraitStale ? '<span class="portrait-stale">上次成功</span>' : '';
          const badge = section.badge ? `<span class="portrait-badge">${section.badge}</span>` : '';
          const body = rows.length
            ? `<div class="portrait-values">${rows.map(v => `<span class="portrait-chip">${esc(v)}</span>`).join('')}</div>`
            : `<div class="portrait-empty">${esc(section.empty)}</div>`;
          return `<div class="pc"><div class="t">${esc(section.label)} ${badge}${stale}</div>${body}</div>`;
        }).join('');
        $('wrMidRow').style.display = '';
      }

      /* ===== 罗盘大屏侧栏：首轮确认在播即加载，之后 60s 更新；订单不阻塞画像 ===== */
      function renderRoomScreen(j) {
        const localTime = value => value ? new Date(value).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' }) : '--';
        const number = (value, digits = 2) => value == null ? '—' : Number(value).toLocaleString('zh-CN', { maximumFractionDigits: digits });
        const cash = value => value == null ? '—' : '¥' + number(value);
        $('compassStatus').textContent = `近5分钟 ${localTime(j.five_window?.start)}–${localTime(j.five_window?.end)} · 采集 ${localTime(j.fetched_at)}${j.partial ? ' · 部分数据未取得' : ''}`;
        const portrait = j.portrait?.watch;
        const tags = Object.values(portrait?.map || {}).filter(v => typeof v === 'string' && v);
        $('compassPortrait').innerHTML = `<div class="portrait-values" style="margin:10px 0"><span>实时看播用户画像</span>${tags.length ? tags.map(v => `<span class="portrait-chip">${esc(v)}</span>`).join('') : `<span>${j.errors?.portrait ? '画像读取失败' : '当前样本不足'}</span>`}</div>`;
        $('compassFive').innerHTML = (j.five || []).map(c => {
          const label = c.aggregation === 'five_minute_average' ? '在线人数（5分钟均值）' : c.name;
          const value = c.unit === '元' ? cash(c.value) : number(c.value) + (c.value == null ? '' : c.unit);
          const change = c.change_pct == null ? '环比 —' : `环比 ${c.change_pct > 0 ? '↑ ' : c.change_pct < 0 ? '↓ ' : ''}${Math.abs(c.change_pct).toFixed(2)}%`;
          return `<div class="p" title="${esc(c.tip || '')}"><div class="l">${esc(label)}</div><div class="v num">${value}</div><div class="s">${change}</div></div>`;
        }).join('') || V4.emptyBox('近5分钟数据未取得');
        const dist = j.traffic_distribution;
        const rows = dist?.rows || [];
        $('compassChannels').innerHTML = rows.length ? `<div style="overflow-x:auto"><table style="width:100%;text-align:right;border-collapse:collapse"><thead><tr><th style="text-align:left">渠道</th><th>流量占比</th><th>用户支付金额占比</th><th>渠道千次观看成交</th></tr></thead><tbody>${rows.map(c => `<tr><td style="text-align:left;padding:7px 0">${esc(c.name)}${dist.separation_mode === 'natural_paid' ? ` · ${c.group === 'paid' ? '付费' : '自然'}` : ''}</td><td>${c.watch_share_pct == null ? '—' : c.watch_share_pct.toFixed(2) + '%'}</td><td>${c.pay_share_pct == null ? '—' : c.pay_share_pct.toFixed(2) + '%'}</td><td>${cash(c.gpm)}</td></tr>`).join('')}</tbody></table></div>` : V4.emptyBox('渠道结构未取得');
        if (dist?.notice) { const note = document.createElement('p'); note.textContent = dist.notice; note.style.color = 'var(--ink-3)'; $('compassChannels').prepend(note); }
      }
      async function refreshRoomScreen() {
        if (!alive() || S.screenFlight || !$('roomCompass').open) return;
        if (S.dash?.live?.isLive !== true) { $('compassStatus').textContent = '等待本场在播状态核验'; return; }
        S.screenFlight = true;
        $('compassStatus').textContent = '正在读取本场罗盘…';
        try {
          const j = await V4.api('/api/compass/screen', scope, { timeout: 45000 });
          if (!alive()) return;
          if (j.account_id !== acct0 || j.room_id !== scope.room_id || j.room?.start_time !== scope.start_time) throw new Error('罗盘场次不匹配，本轮未展示');
          renderRoomScreen(j);
        } catch (e) {
          if (!alive()) return;
          $('compassStatus').textContent = e.message || '罗盘数据读取失败';
          for (const id of ['compassPortrait', 'compassFive', 'compassChannels']) $(id).innerHTML = '';
        } finally { S.screenFlight = false; }
      }
      async function refreshScreen() {
        if (roomScoped) return refreshRoomScreen();
        if (!alive() || S.screenFlight) return;
        S.screenFlight = true;
        const roomAtRequest = currentRoomId(S.dash);
        try {
        let j;
        try { j = await V4.api('/api/compass/screen', { account: acct0 }); }
        catch (e) {
          if (alive() && currentRoomId(S.dash) === roomAtRequest) {
            $('wrScrBox').style.display = '';
            $('wrScrUpd').textContent = '读取失败，稍后重试';
            S.portraitError = e.message || '读取失败';
            S.portraitStale = !!S.portrait;
            renderPortrait();
          }
          return;
        }
        if (!alive() || currentRoomId(S.dash) !== roomAtRequest) return;
        const box = $('wrScrBox');
        if (!j || !j.ok || !j.live) { box.style.display = 'none'; return; }
        if (j.room?.room_id && String(j.room.room_id) !== String(roomAtRequest)) return;
        box.style.display = '';
        S.portrait = j.portrait || null;
        S.portraitError = j.portrait_error || (j.errors && j.errors.portrait) || null;
        S.portraitStale = !!j.portrait_stale;
        renderPortrait();
        $('wrScrUpd').textContent = String(j.fetched_at || '').slice(11, 19) + (j.stale ? '（旧）' : '');
        const extras = [];
        (j.warn || []).slice(0, 2).forEach(w => extras.push(`<span class="warn"><span class="signal-dot warn"></span> ${esc(w.text)}</span>`));
        $('wrScrExtra').innerHTML = extras.join('<br>');
        const pick = ['用户支付金额', '在线人数', '进入人数', '离开人数', '评论次数', 'UV价值'];
        const fiveCards = (j.five || []).filter(c => pick.includes(c.name));
        $('wrScrVitals').innerHTML = fiveCards.length ? fiveCards.map(c => {
          const v = c.value == null ? '--' : (c.unit === '元'
            ? '¥' + (+c.value).toLocaleString('zh-CN', { maximumFractionDigits: 2 })
            : (+c.value).toLocaleString('zh-CN', { maximumFractionDigits: 1 }));
          const s = c.change_pct == null ? '' :
            `<b class="${c.change_pct >= 0 ? 'good' : 'bad'}">${c.change_pct >= 0 ? '↑' : '↓'}${Math.abs(c.change_pct)}%</b>`;
          // Sparkline 迷你走势（2026-08-18 吸收罗盘大屏：卡片背景叠分钟级波形）
          const pts = (c.trend || []).filter(p => p.v != null).map(p => +p.v);
          let spark = '';
          if (pts.length > 1) {
            const mn = Math.min(...pts), mx = Math.max(...pts), rg = (mx - mn) || 1;
            const px = pts.map((val, i) => `${(i / (pts.length - 1) * 100).toFixed(1)},${(19 - (val - mn) / rg * 16).toFixed(1)}`).join(' ');
            spark = `<svg class="spark" viewBox="0 0 100 20" preserveAspectRatio="none"><polyline points="${px}" fill="none" stroke="rgba(93,150,248,.7)" stroke-width="1.4"/></svg>`;
          }
          return `<div class="p" title="${esc(c.tip || '')}"><div class="l">${esc(c.name)}</div><div class="v num">${v}</div><div class="s">${s}</div>${spark}</div>`;
        }).join('')
          : `<div style="color:var(--ink-3);font-size:11px;padding:6px 0">${j.errors?.five ? '近5分钟数据读取失败，稍后重试' : '近5分钟暂无数据'}</div>`;
        const prods = (j.products || []).filter(p => p.pay_gmv > 0).slice(0, 5);
        $('wrScrProducts').innerHTML = prods.length ? prods.map(p =>
          `<div class="pr">${p.image ? `<img src="${esc(p.image)}" loading="lazy" onerror="this.style.display='none'">` : ''}<span class="t" title="${esc(p.title)}">${esc(p.title)}</span><b>¥${(+p.pay_gmv).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}</b></div>`).join('')
          : `<div style="color:var(--ink-3);font-size:11px;padding:6px 0">${j.errors?.products ? '本场热卖读取失败，稍后重试' : '本场暂无成交商品'}</div>`;
        // 直播间订单流（2026-08-18：罗盘 live_order 签名端点，服务端 20s 缓存；失败静默）
        // 两级展示：①按品聚合（哪个品卖了多少单，主导）②订单明细流（辅助）
        // 2026-08-18 修复：品名(product_title)优先展示，规格(sku_product_title)作后缀标注——此前规格优先看不出卖的是啥
        let ords = null;
        try { ords = await V4.api('/api/compass/live-orders', { account: acct0 }); } catch (e) { ords = null; }
        if (!alive() || currentRoomId(S.dash) !== roomAtRequest) return;
        if (ords && ords.ok) {
          const prods = ords.products || [];
          const olist = ords.orders || [];
          const shortName = (t, n = 14) => (t && t.length > n ? t.slice(0, n) + '…' : (t || '未知品'));
          const prodHtml = prods.length ? prods.map(p => {
            const name = p.product_title || '未知品';
            const spec = p.sku_title && p.sku_title !== name ? `·${p.sku_title}` : '';
            return `<div class="op" title="${esc(name)}"><span class="t">${esc(shortName(name))}</span><span class="s">${esc(spec)}</span><span class="c">${p.order_cnt}单${p.item_num > p.order_cnt ? '·' + p.item_num + '件' : ''}</span><b>¥${(+p.amount).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}</b></div>`;
          }).join('')
            : '<div style="color:var(--ink-3);font-size:11px;padding:6px 0">本场暂无已支付订单</div>';
          const ordHtml = olist.length ? `<div style="font-size:10.5px;color:var(--ink-3);padding:6px 0 2px">最近订单</div><div class="wl-ordgrid">` + olist.slice(0, 10).map(o => {
            const name = o.product_title || '未知品';
            const time = o.order_ts ? new Date(o.order_ts * 1000).toTimeString().slice(0, 8) : '';
            return `<div class="oc">
              <div class="oc-top"><span class="oc-buyer">${esc(o.nick_name || '')}</span><span class="oc-time">${esc(time)}</span><span class="oc-paid">●已支付</span></div>
              <div class="oc-mid">${o.sku_product_img ? `<img src="${esc(o.sku_product_img)}" loading="lazy" onerror="this.style.display='none'">` : ''}<div class="oc-txt"><div class="oc-name" title="${esc(name)}">${esc(shortName(name, 16))}</div><div class="oc-spec"><span>${esc(o.sku_product_title || '')}</span><i>×${o.item_num || 1}</i></div></div></div>
              <div class="oc-bot"><button class="oc-copy" data-oid="${esc(o.order_id || '')}" title="复制订单号">单号 <span data-private="id">${esc(String(o.order_id || '').slice(-6))}</span></button><b>¥${o.order_amount != null ? (+o.order_amount).toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : '-'}</b></div>
            </div>`;
          }).join('') + '</div>' : '';
          $('wrOrders').innerHTML = prodHtml + ordHtml;
          $('wrOrdUpd').textContent = ords.total != null ? `${ords.total} 单` : '';
          // 复制单号按钮（卡片式订单，2026-08-18）
          document.querySelectorAll('#wrOrders .oc-copy').forEach(b => {
            b.onclick = (ev) => {
              ev.stopPropagation();
              const oid = b.dataset.oid || '';
              if (!oid) return;
              const restoreLabel = () => { b.innerHTML = `单号 <span data-private="id">${esc(oid.slice(-6))}</span>`; };
              (navigator.clipboard ? navigator.clipboard.writeText(oid) : Promise.reject(new Error('no-clipboard'))).then(() => {
                b.textContent = '已复制';
                setTimeout(restoreLabel, 1500);
              }).catch(() => { b.textContent = '复制失败'; setTimeout(restoreLabel, 2500); });
            };
          });
        } else {
          $('wrOrdUpd').textContent = '订单读取失败，稍后重试';
        }
        } finally { S.screenFlight = false; }
      }

      /* ===== 轮询 ===== */
      view.querySelectorAll('[data-boost-filter]').forEach(button => {
        button.onclick = () => {
          if (!alive()) return;
          S.boostFilter = button.dataset.boostFilter;
          view.querySelectorAll('[data-boost-filter]').forEach(item => {
            const selected = item === button;
            item.setAttribute('aria-pressed', String(selected));
            item.style.borderColor = selected ? 'var(--accent)' : '';
          });
          if (S.boostDisplayInput || S.dash || S.boostFrame) renderBoosts(S.boostDisplayInput || S.dash || S.boostFrame);
        };
      });
      renderRoomCoverage();
      if (roomScoped) $('roomCompass').addEventListener('toggle', () => {
        if ($('roomCompass').open) void refreshRoomScreen();
      });
      if (roomScoped) $('roomModules').addEventListener('toggle', () => {
        if ($('roomModules').open) void refreshRoomRounds();
      });
      // 已播时长秒级跳动：直播中"已播 XhYm"每秒本地推算（数据仍 15s 轮询，只是时钟跟手）
      const sinceTimer = setInterval(() => { if (alive() && S.dash) { updateSince(S.dash); renderCoreFreshness(S.dash); } }, 1000);
      stoppers.push(() => clearInterval(sinceTimer));
      // 核心 5s 读服务端内存，慢请求不阻塞核心卡片。
      stoppers.push(V4.poll(refreshDash, () => S.dash?.live?.isLive === false ? 30000 : 5000));
      stoppers.push(V4.poll(refreshChengfangLive, 60000));
      // 决策流/评审：首次立即执行（本地缓存秒恢复），后续 60s 轮询
      stoppers.push(V4.poll(() => Promise.allSettled([refreshRounds(), refreshBoss()]), 60000));
      // 首轮由 poll 发起一次；不再额外调用造成重复请求。
      stoppers.push(V4.poll(() => refreshSplit('today'), 300000));
      stoppers.push(V4.poll(() => S.dash?.live?.isLive === true ? refreshScreen() : undefined, 60000));  // 历史账户专用说明已从试用包移除。

      return function unmount() {
        dead = true; // 在途请求统一作废
        stoppers.forEach(s => s());
      };
    },
  };

})(window.V4);
