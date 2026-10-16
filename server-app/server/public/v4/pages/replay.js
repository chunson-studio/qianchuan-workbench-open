/* ===== 千川投控 v4 · 直播复盘 ===== */
(function (V4) {
  'use strict';
  const { esc, fmtM, odo, fitV, flip } = V4;
  const WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const NS = 'http://www.w3.org/2000/svg';
  const CH = { w: 760, h: 280, pl: 44, pr: 52, pt: 16, pb: 30 };

  const HTML = `
  <style>
  /* 指标按容器宽度换行，金额不再挤进五个等分的窄卡片。 */
  .pg-rpl-state { grid-template-columns:minmax(0,1fr); }
  .pg-rpl-state .vitals { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr)); min-width:0; }
  .pg-rpl-state .vital { min-width:0; container-type:inline-size; }
  .pg-rpl-state .vital .v { font-size:clamp(16px,16cqw,30px); }
  .pg-rpl-state .vital .v.sm { font-size:clamp(16px,14cqw,26px); }
  .pg-rpl-state .vital .v.xs { font-size:clamp(14px,12cqw,22px); }
  .pg-rpl-main { display:grid; grid-template-columns:1fr 1.5fr; gap:32px; margin-top:24px; align-items:start; }
  /* 场次列表：细线分隔，选中行左侧 3px 状态色条 */
  .pg-rpl-sess { margin-top:8px; }
  .pg-rpl-srow { position:relative; display:grid; grid-template-columns:1fr auto; gap:2px 14px;
    padding:13px 12px 12px 16px; border-top:1px solid var(--line); cursor:pointer; transition:background .2s; }
  .pg-rpl-srow:first-child { border-top:0; }
  .pg-rpl-srow:hover { background:rgba(148,163,184,.03); }
  .pg-rpl-srow.on { background:var(--panel-2); }
  .pg-rpl-srow::before { content:''; position:absolute; left:0; top:12px; bottom:12px; width:3px; border-radius:2px;
    background:transparent; transition:background .3s; }
  .pg-rpl-srow.on::before { background:var(--sc, var(--steel)); }
  .pg-rpl-sdate { font-size:13.5px; font-weight:650; }
  .pg-rpl-srow:not(.on) .pg-rpl-sdate { color:var(--ink-2); }
  .pg-rpl-sdate .wd { font-size:11px; color:var(--ink-3); font-weight:500; margin-left:7px; }
  .pg-rpl-liveb { display:inline-block; font-size:10px; font-weight:600; color:var(--good);
    background:rgba(52,211,153,.1); border-radius:4px; padding:1px 6px; margin-left:7px; letter-spacing:.04em; vertical-align:1px; }
  .pg-rpl-sroi { font-family:var(--mono); font-size:15px; font-weight:700; text-align:right; color:var(--ink-3); }
  .pg-rpl-sroi.top { color:var(--gold); } .pg-rpl-sroi.good { color:var(--good); }
  .pg-rpl-sroi.warn { color:var(--warn); } .pg-rpl-sroi.low { color:var(--orange); } .pg-rpl-sroi.bad { color:var(--danger); }
  .pg-rpl-smeta { grid-column:1 / -1; display:flex; gap:14px; font-size:11px; color:var(--ink-3); flex-wrap:wrap; }
  .pg-rpl-smeta b { color:var(--ink-2); font-family:var(--mono); font-weight:600; }
  /* 图表 */
  .pg-rpl-chartwrap { position:relative; }
  .pg-rpl-chartwrap svg { width:100%; height:auto; display:block; }
  .pg-rpl-charthead { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  .pg-rpl-charthead > [data-q="chartTitle"] { margin-right:auto; }
  .pg-rpl-curve-tabs { display:inline-flex; padding:2px; border:1px solid var(--line); border-radius:7px; background:var(--panel-2); }
  .pg-rpl-curve-tabs button { border:0; border-radius:5px; padding:4px 10px; background:transparent; color:var(--ink-3);
    font:600 10.5px/1.4 var(--sans); cursor:pointer; transition:background .18s,color .18s,box-shadow .18s; }
  .pg-rpl-curve-tabs button:hover { color:var(--ink-2); }
  .pg-rpl-curve-tabs button.on { color:var(--ink); background:var(--panel); box-shadow:0 1px 4px rgba(15,20,27,.12); }
  .pg-rpl-curve-tabs button:focus-visible { outline:2px solid var(--steel); outline-offset:2px; }
  .pg-rpl-curve-meta { font-size:10.5px; color:var(--ink-3); white-space:nowrap; }
  .pg-rpl-legend { display:flex; gap:18px; margin-top:10px; font-size:11px; color:var(--ink-3); align-items:center; flex-wrap:wrap; }
  .pg-rpl-legend i { display:inline-block; width:14px; height:2px; border-radius:1px; margin-right:6px; vertical-align:middle; }
  .pg-rpl-legend .dash i { height:0; border-top:1px dashed rgba(148,163,184,.5); }
  /* 关键时刻 */
  .pg-rpl-moments { margin-top:6px; border-top:1px solid var(--line); padding-top:4px; }
  .pg-rpl-mo { display:flex; gap:10px; align-items:baseline; padding:8px 0; border-top:1px solid var(--line); font-size:12.5px; }
  .pg-rpl-mo:first-child { border-top:0; }
  .pg-rpl-mo .t { font-family:var(--mono); font-size:11px; color:var(--ink-3); flex-shrink:0; width:44px; }
  .pg-rpl-mo i { width:6px; height:6px; border-radius:50%; flex-shrink:0; position:relative; top:-1px; }
  .pg-rpl-mo .txt { color:var(--ink-2); line-height:1.6; }
  /* 素材表：窄屏容器横向滚动 */
  .pg-rpl-mtwrap { overflow-x:auto; }
  .pg-rpl-mt { width:100%; min-width:540px; border-collapse:collapse; margin-top:4px; }
  .pg-rpl-mt th { font-size:10px; color:var(--ink-3); letter-spacing:.12em; font-weight:600; text-align:right;
    padding:8px 6px; border-bottom:1px solid var(--line-2); white-space:nowrap; }
  .pg-rpl-mt th:first-child { text-align:left; }
  .pg-rpl-mt td { padding:10px 6px; border-bottom:1px solid var(--line); font-size:12.5px; text-align:right; }
  .pg-rpl-mt tr:last-child td { border-bottom:0; }
  .pg-rpl-mt td:first-child { text-align:left; color:var(--ink-2); max-width:230px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .pg-rpl-mt td.num { font-family:var(--mono); font-variant-numeric:tabular-nums; color:var(--ink-2); }
  .pg-rpl-mt td.roi { font-weight:700; }
  .pg-rpl-mt td.roi.top { color:var(--gold); } .pg-rpl-mt td.roi.good { color:var(--good); }
  .pg-rpl-mt td.roi.warn { color:var(--warn); } .pg-rpl-mt td.roi.low { color:var(--orange); } .pg-rpl-mt td.roi.bad { color:var(--danger); }
  .pg-rpl-mtag { font-size:10px; font-weight:600; padding:2px 8px; border-radius:4px; letter-spacing:.04em; white-space:nowrap; }
  .pg-rpl-mtag.up { background:rgba(52,211,153,.1); color:var(--good); }
  .pg-rpl-mtag.watch { background:rgba(251,191,36,.1); color:var(--warn); }
  .pg-rpl-mtag.stop { background:rgba(248,113,113,.1); color:var(--danger); }
  .pg-rpl-mtag.keep { background:rgba(148,163,184,.1); color:var(--ink-3); }
  /* 复盘总结 */
  .pg-rpl-ai p { font-size:12.5px; color:var(--ink-2); line-height:1.9; white-space:pre-line; margin:0; overflow-wrap:anywhere; word-break:break-word; }
  .pg-rpl-ai .src { font-size:10.5px; color:var(--ink-3); margin-bottom:10px; padding-bottom:10px;
    border-bottom:1px solid var(--line); letter-spacing:.06em; overflow-wrap:anywhere; }
  .pg-rpl-mo .txt { overflow-wrap:anywhere; }
  @media (max-width:1100px) { .pg-rpl-main { grid-template-columns:1fr; } }
  </style>

  <section class="state pg-rpl-state">
    <div class="state-left">
      <div class="state-word off" data-q="stateWord" style="display:none" aria-hidden="true"></div>
      <div class="state-sub">
        <span class="roi num" data-q="roiNum">--</span>
        <span class="delta" data-q="roiDelta"></span>
      </div>
    </div>
    <div class="vitals">
      <div class="vital"><div class="l">整场消耗</div><div class="v num" data-q="vCost">--</div><div class="s" data-q="vCostS"></div></div>
      <div class="vital"><div class="l">净成交</div><div class="v num" data-q="vGmv">--</div><div class="s">平台1小时净口径</div></div>
      <div class="vital"><div class="l">订单</div><div class="v num" data-q="vOrd">--</div><div class="s">净口径</div></div>
      <div class="vital"><div class="l">时长</div><div class="v num" data-q="vDur">--</div><div class="s" data-q="vDurS"></div></div>
      <div class="vital"><div class="l">场均GPM</div><div class="v num" data-q="vGpm">--</div><div class="s" data-q="vGpmS"></div></div>
    </div>
  </section>

  <section class="pg-rpl-main">
    <div class="col">
      <div>
        <div class="sec-title"><span data-q="sessTitle">近 7 天场次</span> <span class="cd" data-q="sessCnt"></span>
          <span class="m-tabs" data-q="rangeTabs"><button class="on" data-days="7">7天</button><button data-days="14">14天</button><button data-days="30">30天</button></span>
        </div>
        <div class="pg-rpl-sess" data-q="sess">${V4.emptyBox('加载中…')}</div>
      </div>
      <div class="block pg-rpl-ai">
        <div class="sec-title" data-q="aiTitle">复盘总结</div>
        <div data-q="aiBody">${V4.emptyBox('选择场次后生成')}</div>
      </div>
    </div>

    <div class="col">
      <div class="block">
        <div class="sec-title pg-rpl-charthead">
          <span data-q="chartTitle">本场走势 · 分钟粒度</span>
          <span class="pg-rpl-curve-tabs" data-q="curveTabs" role="group" aria-label="曲线范围">
            <button class="on" data-mode="session" aria-pressed="true">本场</button><button data-mode="day" aria-pressed="false">当天全天</button>
          </span>
          <span class="pg-rpl-curve-meta" data-q="curveMeta"></span>
          <span class="cd" data-q="boardLinks">净ROI × 累计消耗</span>
        </div>
        <div class="pg-rpl-chartwrap" data-q="chartWrap">${V4.emptyBox('选择场次后加载')}</div>
        <div class="pg-rpl-legend">
          <span><i data-q="lgRoi" style="background:var(--steel)"></i>净ROI·累计（左轴）</span>
          <span><i style="background:var(--steel); opacity:.6"></i>累计消耗（右轴）</span>
          <span class="dash"><i></i><span data-q="lgBe">保本 --</span></span>
        </div>
        <div class="sec-title" style="margin-top:16px">关键时刻 <span class="cd">拐点为系统推导</span></div>
        <div class="pg-rpl-moments" data-q="moments"></div>
      </div>
      <div class="block">
        <div class="sec-title">本场素材表现 <span class="cd" data-q="matCnt"></span></div>
        <div class="pg-rpl-mtwrap"><table class="pg-rpl-mt">
          <thead><tr><th>素材</th><th>消耗</th><th>净成交</th><th>订单</th><th>净ROI</th></tr></thead>
          <tbody data-q="mats"></tbody>
        </table></div>
      </div>
    </div>
  </section>`;

  V4.pages.replay = {
    mount(view) {
      view.innerHTML = HTML;
      const q = n => view.querySelector('[data-q="' + n + '"]');
      const S = { sessions: [], sel: -1, reqId: 0, curveReqId: 0, curveMode: 'session', be: null, settleMin: 90, rangeDays: 7 };
      const stoppers = [];
      let liveStop = null;
      const chartLayout = { width: 0, svg: null, redraw: null, frame: 0 };
      /* 账号快照 + 存活判断：切账号/切页后，在途请求统一作废（view 容器是复用的，旧闭包会命中新 DOM） */
      const acct0 = V4.acct();
      let dead = false;
      const alive = () => !dead && V4.acct() === acct0;

      /* ----- 工具 ----- */
      const p2 = V4.p2;
      const metricNumber = value => (typeof value === 'number' || typeof value === 'string' && value.trim() !== '')
        && Number.isFinite(Number(value)) ? Number(value) : null;
      // 历史场次保本线只认该场详情，不能借用当前选择的房间或目标 ROI。
      const replayBreakEven = d => { const value = metricNumber(d?.thresholds?.break_even_roi); return value > 0 ? value : null; };
      const replayMode = (roi, be) => roi != null && be != null ? V4.modeOf(roi, be) : 'uncalibrated';
      const pDate = V4.parseT;
      const md = d => V4.fmtCnTime(d).md;
      const hm = d => V4.fmtCnTime(d).hm;
      const chinaDate = d => new Date(d.getTime() + 8 * 3600000);
      const fmtD = d => { const c = chinaDate(d); return c.getUTCFullYear() + '-' + p2(c.getUTCMonth() + 1) + '-' + p2(c.getUTCDate()); };
      const durText = ms => { const m = Math.max(0, Math.round(ms / 60000)); return Math.floor(m / 60) + 'h' + p2(m % 60) + 'm'; };
      const isLive = s => String(s.status) === '2';
      const sessEnd = s => (s.endTime && s.endTime !== '-') ? pDate(s.endTime) : new Date();
      /* 下播约90分钟内继续观察平台1小时净口径回流；过窗只停止这段补读，不证明最终结算。 */
      const settled = s => {
        if (isLive(s)) return false;
        const e = (s.endTime && s.endTime !== '-') ? pDate(s.endTime).getTime() : 0;
        // 2026-07-30 审计T1：异常场次 endTime 缺失/'-' 时按已结算处理——
        // 否则 settled 永 false，永久挂"结算中"徽章且 60s 穿透重拉不止（服务端 qianchuanTabs 确实会产出 '-'）
        if (e === 0) return true;
        return (Date.now() - e) > (S.settleMin || 90) * 60000;
      };
      /* 场次列表上色：固定刻度 ≥3 金 / ≥2 绿 / ≥1 黄 / <1 红
         （2026-07-25 修复：原写法引用不存在的变量 BE，详情到达后每次打补丁都抛 ReferenceError，
          导致场次列表的净成交/ROI 永远停在 --；现按场次自身保本线取色，S.be 兜底） */
      const roiClsFix = replayMode;
      const roiClsBe = replayMode;
      const timeAt = (cum, i) => V4.fmtCnTime(cum.times[i]).hm;
      const sessionDate = s => fmtD(pDate(s.startTime));
      const sourceTrend = d => (Array.isArray(d && d.trend_minute) && d.trend_minute.length)
        ? d.trend_minute.map(p => ({ time: p.t, cost: p.cost, gmvSettle: p.net_1h }))
        : ((d && d.trend) || []);

      /* 5 分钟增量 → 累计口径（早期小消耗桶比率会爆冲，累计才稳） */
      function cumSeries(trend) {
        let cg = 0, cc = 0;
        const roi = [], cost = [], gmv = [], times = [];
        if (!Array.isArray(trend) || trend.some(p => !p || metricNumber(p.gmvSettle) == null || metricNumber(p.cost) == null)) {
          return { roi, cost, gmv, times, dataValid: false };
        }
        trend.forEach(p => {
          cg += Number(p.gmvSettle); cc += Number(p.cost);
          roi.push(cc > 0 ? cg / cc : 0); cost.push(cc); gmv.push(cg); times.push(p.time);
        });
        return { roi, cost, gmv, times, dataValid: true };
      }
      /* 冷启动裁剪：累计消耗到达 max(¥50, 终值1%) 之前的桶比率仍会爆冲（¥4.71 消耗 139.8 成交 → ROI 29），
         绘图与拐点推导从到达下限的桶开始，避免一根毛刺压扁整局曲线 */
      function trimCold(cum) {
        const n = cum.roi.length;
        if (n < 4) return cum;
        const floor = Math.max(50, (cum.cost[n - 1] || 0) * 0.01);
        let s = 0;
        while (s < n - 2 && cum.cost[s] < floor) s++;
        if (!s) return cum;
        return { roi: cum.roi.slice(s), cost: cum.cost.slice(s), gmv: (cum.gmv || []).slice(s), times: cum.times.slice(s) };
      }

      /* ----- 场次列表 ----- */
      function rowHtml(s) {
        const st = pDate(s.startTime);
        // 优先用接口返回的 netRoi/netGmv（场次列表已带），fallback 到 s.detail（点击后加载的详情）
        const d = s.detail, lm = (d && d.live_metrics) || {};
        const roi = metricNumber(s.netRoi) ?? metricNumber(lm.roiSettle);
        const netGmv = metricNumber(s.netGmv) ?? metricNumber(lm.gmvSettle);
        const beRow = replayBreakEven(d);
        const cls = roi != null ? roiClsFix(roi, beRow) : '';
        return `<span class="pg-rpl-sdate">${md(st)}<span class="wd">${WD[chinaDate(st).getUTCDay()]} · ${hm(st)} 开播</span>${s.archive_stale ? '<span class="pg-rpl-liveb" title="存档来源：' + esc(s.archive_source_at || '时间未知') + '">存档待更新</span>' : isLive(s) ? '<span class="pg-rpl-liveb">直播中</span>' : !settled(s) ? '<span class="pg-rpl-liveb" style="color:var(--st-warn);border-color:var(--st-warn)">回流观察中</span>' : ''}</span>
        <span class="pg-rpl-sroi ${cls}">${roi != null ? roi.toFixed(2) : '--'}</span>
        <span class="pg-rpl-smeta"><span>时长 <b>${isLive(s) || s.endTime && s.endTime !== '-' ? durText(sessEnd(s) - st) : '—'}</b></span><span>消耗 <b>${fmtM(metricNumber(s.cost) ?? metricNumber(lm.cost))}</b></span><span>净成交 <b>${netGmv != null ? fmtM(netGmv) : '--'}</b></span></span>`;
      }
      function rowColor(s) {
        const d = s.detail, lm = (d && d.live_metrics) || {};
        const roi = metricNumber(s.netRoi) ?? metricNumber(lm.roiSettle);
        if (roi == null) return 'var(--steel)';
        return V4.PULSE_COLOR[roiClsFix(roi, replayBreakEven(d))];
      }
      function patchRow(i) {
        const row = q('sess').children[i];
        if (!row || !S.sessions[i]) return;
        row.innerHTML = rowHtml(S.sessions[i]);
        row.style.setProperty('--sc', rowColor(S.sessions[i]));
      }
      function renderSess() {
        const list = S.sessions;
        q('sessCnt').textContent = list.length ? list.length + ' 场' : '';
        if (!list.length) { q('sess').innerHTML = V4.emptyBox(`近 ${S.rangeDays || 7} 天无场次`); return; }
        q('sess').innerHTML = list.map((s, i) =>
          `<div class="pg-rpl-srow ${i === S.sel ? 'on' : ''}" data-i="${i}" style="--sc:${rowColor(s)}" tabindex="0" role="button" aria-pressed="${i === S.sel}">${rowHtml(s)}</div>`).join('');
        q('sess').querySelectorAll('.pg-rpl-srow').forEach(r => {
          r.onclick = () => select(+r.dataset.i);
          r.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(+r.dataset.i); } };
        });
      }
      function markSel() {
        q('sess').querySelectorAll('.pg-rpl-srow').forEach(r => {
          const on = +r.dataset.i === S.sel;
          r.classList.toggle('on', on);
          r.setAttribute('aria-pressed', on);
        });
      }

      /* 先批量读取本机存档，再用两路单日请求补齐缺失/待更新日期；不扩大实时缓存。 */
      let sessionsSeq = 0;
      let accountInfoRequested = false;
      async function loadSessions() {
        const seq = ++sessionsSeq, n = S.rangeDays || 7;
        const days = [];
        for (let i = 0; i < n; i++) days.push(fmtD(new Date(Date.now() - i * 86400000)));
        const results = new Map();
        let cursor = 0, pendingDays = days;
        const successes = new Set();
        const refreshDates = new Set();
        const publish = () => {
          if (!alive() || seq !== sessionsSeq) return;
          const selected = S.sessions[S.sel];
          S.sessions = [...results.values()].flat().sort((a, b) => String(b.startTime).localeCompare(String(a.startTime)));
          S.sel = selected ? S.sessions.findIndex(s => s.roomId === selected.roomId && s.startTime === selected.startTime) : -1;
          renderSess();
          if (!S.sessions.length && successes.size < days.length) {
            q('sess').innerHTML = V4.emptyBox(`已读取 ${successes.size}/${days.length} 天，正在补齐场次…`);
          }
          if (S.sel < 0 && S.sessions.length) void select(0);
          else if (S.sel >= 0 && selected !== S.sessions[S.sel]) void select(S.sel);
        };
        // 账户信息只用于大屏外链；同一次页面挂载不随日期范围重复读取盘面。
        if (!accountInfoRequested) {
          accountInfoRequested = true;
          V4.api('/api/live-dashboard').then(j => {
            if (!alive() || !j?.account_info) return;
            S.accInfo = j.account_info;
            if (S.sel >= 0 && S.sessions[S.sel]) updateBoardLinks(S.sessions[S.sel]);
          }).catch(() => { accountInfoRequested = false; });
        }
        try {
          const catalog = await V4.api('/api/live-replay/sessions', { start: days.at(-1), end: days[0] });
          if (!alive() || seq !== sessionsSeq) return;
          // A legacy server may ignore range parameters. Only accept the explicit
          // archive protocol and exact account/range; otherwise keep daily reads.
          if (catalog.mode === 'archive_catalog' && catalog.account === acct0
            && catalog.date_range?.start === days.at(-1) && catalog.date_range?.end === days[0]
            && Array.isArray(catalog.days)) {
            if (catalog.settle_window_min) S.settleMin = catalog.settle_window_min;
            const seen = new Set();
            for (const day of catalog.days) {
              if (!days.includes(day.date) || seen.has(day.date)) continue;
              seen.add(day.date);
              if (day.status !== 'ready' || day.stale !== false) refreshDates.add(day.date);
              if (Array.isArray(day.sessions)) {
                results.set(day.date, day.sessions.map(s => ({ ...s,
                  archive_stale: day.stale !== false, archive_source_at: day.source_at || null })));
                if (day.status === 'ready' && day.stale === false) successes.add(day.date);
              }
            }
            pendingDays = days.filter(date => !successes.has(date));
            if (results.size) publish();
          }
        } catch { /* 旧服务或索引读取失败时，保留逐日渐进加载。 */ }
        if (!alive() || seq !== sessionsSeq) return;
        // 单日结果到达就显示，不再等待最慢的一天；未存档日期最多两路请求。
        const worker = async () => {
          while (alive() && seq === sessionsSeq && cursor < pendingDays.length) {
            const date = pendingDays[cursor++];
            try {
              const j = await V4.api('/api/live-replay/sessions', { date,
                ...(refreshDates.has(date) ? { refresh: '1' } : {}) });
              if (!alive() || seq !== sessionsSeq) return;
              successes.add(date);
              if (j.settle_window_min) S.settleMin = j.settle_window_min;
              results.set(date, (j.sessions || []).map(s => ({ ...s,
                archive_stale: j.stale === true, archive_source_at: j.fetchedAt || null })));
              publish();
            } catch { /* 其他日期仍然显示，结束后标注缺失。 */ }
          }
        };
        await Promise.all([worker(), worker()]);
        if (!alive() || seq !== sessionsSeq) return;
        if (!successes.size && !results.size) { q('sess').innerHTML = V4.errBox(new Error('场次列表加载失败')); return; }
        if (!S.sessions.length) renderBlank();
        if (successes.size < days.length) {
          const missing = days.length - successes.size;
          if (!S.sessions.length) {
            const message = `已读取 ${successes.size}/${days.length} 天，未发现场次；其余 ${missing} 天待补齐`;
            q('sess').innerHTML = V4.emptyBox(message);
            q('chartWrap').innerHTML = V4.emptyBox(message);
            q('aiBody').innerHTML = V4.emptyBox(message);
            q('roiDelta').textContent = '场次列表尚未完整';
          } else q('sess').insertAdjacentHTML('beforeend', `<div class="cd">${missing} 天暂未读取成功</div>`);
        }
      }

      /* 范围切换：7/14/30 天 */
      q('rangeTabs').querySelectorAll('button').forEach(b => b.onclick = () => {
        if ((+b.dataset.days || 7) === S.rangeDays) return;
        q('rangeTabs').querySelectorAll('button').forEach(x => x.classList.remove('on'));
        b.classList.add('on');
        S.rangeDays = +b.dataset.days || 7;
        if (liveStop) { liveStop(); liveStop = null; } // 2026-07-31 审计P2修复：切范围必停旧场次60s轮询（旧逻辑空范围renderBlank不select，旧定时器幽灵驻留白发请求）
        q('sessTitle').textContent = `近 ${S.rangeDays} 天场次`;
        S.sessions = []; S.sel = -1; S.reqId++;
        S.curveReqId++;
        q('sess').innerHTML = V4.emptyBox('加载中…');
        loadSessions().catch(e => { q('sess').innerHTML = V4.errBox(e); });
      });

      function syncCurveTabs() {
        q('curveTabs').querySelectorAll('button').forEach(b => {
          const on = b.dataset.mode === S.curveMode;
          b.classList.toggle('on', on);
          b.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
      }
      q('curveTabs').querySelectorAll('button').forEach(b => b.onclick = () => {
        const mode = b.dataset.mode === 'day' ? 'day' : 'session';
        if (mode === S.curveMode) return;
        S.curveMode = mode;
        S.curveReqId++;
        syncCurveTabs();
        renderActiveCurve();
      });

      function renderBlank() {
        const w = q('stateWord');
        flip(w, '--'); w.className = 'state-word off';
        q('roiDelta').textContent = `近 ${S.rangeDays || 7} 天无场次`;
        q('chartWrap').innerHTML = V4.emptyBox('无场次数据');
        q('curveMeta').textContent = '';
        q('aiBody').innerHTML = V4.emptyBox('无场次数据');
      }

      /* ----- 选中场次 ----- */
      async function loadDetail(s) {
        if (s.detail) return s.detail;
        if (!s.detailFlight) s.detailFlight = V4.api('/api/live-replay', { roomId: s.roomId, startTime: s.startTime, endTime: s.endTime }).finally(() => { s.detailFlight = null; });
        const d = await s.detailFlight;
        s.detail = d;
        const idx = S.sessions.indexOf(s);
        if (idx >= 0 && alive()) patchRow(idx);
        return d;
      }

      async function select(i) {
        const s = S.sessions[i];
        if (!s) return;
        S.sel = i;
        const rid = ++S.reqId;
        S.curveReqId++;
        markSel();
        if (liveStop) { liveStop(); liveStop = null; }
        q('chartWrap').innerHTML = V4.emptyBox('场次数据加载中…');
        q('moments').innerHTML = '';
        q('mats').innerHTML = ''; q('matCnt').textContent = '';
        q('aiBody').innerHTML = V4.emptyBox('加载中…');
        let d = s.detail;
        if (!d) {
          try { d = await loadDetail(s); }
          catch (e) { if (alive() && rid === S.reqId) q('chartWrap').innerHTML = V4.errBox(e); return; }
        }
        if (d && d.settle_window_min) S.settleMin = d.settle_window_min; // 单场详情也带结算窗口（与场次列表同源）
        if (!alive() || rid !== S.reqId) return;
        renderDetail(s, d);
        /* 直播中与下播未满90分钟的场次60s补读；过窗保留平台快照，不称最终结算。 */
        if (isLive(s) || !settled(s) || d.refreshing || d.replay_preview || d.stale) {
          let skipInitialPoll = true;
          liveStop = V4.poll(async () => {
            if (skipInitialPoll) { skipInitialPoll = false; return; }
            try {
              const nd = await V4.api('/api/live-replay', { roomId: s.roomId, startTime: s.startTime, endTime: s.endTime });
              if (!alive() || S.sessions[S.sel] !== s) return; // 2026-07-31 审计P1修复：60s轮询回调缺 alive() 校验，切页后 patchRow 拿 null 容器级联崩溃
              s.detail = nd; patchRow(S.sel); renderDetail(s, nd);
              if (!isLive(s) && settled(s) && !nd.refreshing && !nd.replay_preview && !nd.stale && liveStop) { liveStop(); liveStop = null; }
            } catch (e) { /* 静默，下轮再试 */ }
          }, () => s.detail?.refreshing || s.detail?.replay_preview ? 5000 : 60000);
          stoppers.push(liveStop);
        }
        V4.touch();
      }

      /* 大屏原始入口（罗盘 + 千川，新标签打开）；accInfo 晚到时点亮后重刷（审核团修竞态） */
      function updateBoardLinks(s) {
        const bl = q('boardLinks');
        if (!bl) return;
        if (!s || !s.roomId) return;
        const ai = S.accInfo || {};
        const compassUrl = `https://compass.jinritemai.com/screen/live/shop?live_room_id=${s.roomId}&live_app_id=2079&source=compass-live-overview`;
        const qcUrl = `https://qianchuan.jinritemai.com/board-next?live_room_id=${s.roomId}&anchorId=${ai.anchorId || ''}&aavid=${ai.aavid || ''}&fromModule=uni_promotion_v2`;
        bl.innerHTML = `<a href="${compassUrl}" target="_blank" rel="noopener" style="color:var(--st-live);text-decoration:none">罗盘大屏↗</a> · <a href="${qcUrl}" target="_blank" rel="noopener" style="color:var(--st-live);text-decoration:none">千川大屏↗</a>`;
      }

      function renderSessionCurve(s, d) {
        const be = replayBreakEven(d);
        const cum = trimCold(cumSeries(sourceTrend(d)));
        const lm = d.live_metrics || {};
        const finalRoi = metricNumber(lm.roiSettle);
        const moments = deriveMoments(cum, d);
        q('chartTitle').textContent = '本场走势 · 分钟粒度';
        q('curveMeta').textContent = `${sessionDate(s)} · ${hm(pDate(s.startTime))} 开播 · 分钟增量累计`;
        drawChart(cum, replayMode(finalRoi, be), be, moments, d.roi2_log || []);
        renderMoments(moments, d);
      }

      /* 当天全天只累计实际分钟增量，不用场次汇总缩放或摊造曲线。
         不跨场硬连线；直播空档保留为空白。 */
      function buildDaySeries(items) {
        const ordered = items.slice().sort((a, b) => String(a.s.startTime).localeCompare(String(b.s.startTime)));
        const roi = [], cost = [], gmv = [], times = [], segments = [];
        let offsetCost = 0, offsetGmv = 0;
        ordered.forEach(({ s, d }, order) => {
          const raw = cumSeries(sourceTrend(d));
          if (!raw.dataValid || !raw.times.length) return;
          const lastCost = raw.cost.length ? raw.cost[raw.cost.length - 1] : 0;
          const lastGmv = raw.gmv.length ? raw.gmv[raw.gmv.length - 1] : 0;
          const start = roi.length;
          raw.times.forEach((t, i) => {
            const c = offsetCost + raw.cost[i];
            const g = offsetGmv + raw.gmv[i];
            times.push(t); cost.push(c); gmv.push(g); roi.push(c > 0 ? g / c : 0);
          });
          if (roi.length > start) {
            segments.push({
              start, end: roi.length - 1, order,
              label: `第${order + 1}场`,
              startTime: s.startTime, endTime: s.endTime,
              cost: lastCost, gmv: lastGmv,
              roi: lastCost > 0 ? lastGmv / lastCost : 0,
            });
          }
          offsetCost += lastCost;
          offsetGmv += lastGmv;
        });
        return { cum: { roi, cost, gmv, times }, segments, totalCost: offsetCost, totalGmv: offsetGmv };
      }

      async function renderDayCurve(anchor) {
        const date = sessionDate(anchor);
        const candidates = S.sessions.filter(s => sessionDate(s) === date)
          .sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)));
        const crid = ++S.curveReqId;
        q('chartTitle').textContent = '当天全天走势 · 真实时间轴';
        q('curveMeta').textContent = `${date} · ${candidates.length} 场`;
        q('chartWrap').innerHTML = V4.emptyBox(`正在合并 ${candidates.length} 场曲线…`);
        q('moments').innerHTML = '';
        const settledResults = await Promise.all(candidates.map(async s => {
          try { return { s, d: await loadDetail(s) }; }
          catch (error) { return { s, error }; }
        }));
        if (!alive() || crid !== S.curveReqId || S.curveMode !== 'day') return;
        const usable = settledResults.filter(x => x.d && sourceTrend(x.d).length && cumSeries(sourceTrend(x.d)).dataValid);
        const failed = settledResults.length - usable.length;
        if (!usable.length) {
          q('chartWrap').innerHTML = V4.emptyBox('当天各场均无可用趋势数据');
          q('moments').innerHTML = failed ? V4.emptyBox(`${failed} 场读取失败或趋势为空`) : '';
          return;
        }
        const day = buildDaySeries(usable);
        const beValues = usable.map(x => replayBreakEven(x.d));
        const be = beValues.every(value => value != null && value === beValues[0]) ? beValues[0] : null;
        S.be = be;
        const finalRoi = day.totalCost > 0 ? day.totalGmv / day.totalCost : 0;
        const logs = usable.flatMap(x => x.d.roi2_log || []);
        q('curveMeta').textContent = `${date} · ${usable.length}/${candidates.length} 场 · 分钟增量累计 · 消耗 ${fmtM(day.totalCost)} · 净ROI ${finalRoi.toFixed(2)}${failed ? ' · 部分缺失' : ''}`;
        drawChart(day.cum, replayMode(finalRoi, be), be, [], logs, { timeScale: true, segments: day.segments });
        renderDayMoments(day.segments, failed);
      }

      function renderDayMoments(segments, failed) {
        const rows = segments.map(seg => ({
          t: `${hm(pDate(seg.startTime))}`,
          col: V4.PULSE_COLOR[replayMode(seg.roi, S.be)],
          txt: `${seg.label} ${hm(pDate(seg.startTime))}–${seg.endTime && seg.endTime !== '-' ? hm(pDate(seg.endTime)) : '直播中'} · 消耗 ${fmtM(seg.cost)} · 净成交 ${fmtM(seg.gmv)} · 净ROI ${seg.roi.toFixed(2)}`,
        }));
        if (failed) rows.push({ t: '—', col: '#FBBF24', txt: `${failed} 场读取失败或趋势为空，本图按可用场次合并` });
        renderMoments(rows);
      }

      function renderActiveCurve() {
        const s = S.sessions[S.sel];
        if (!s || !s.detail) return;
        if (S.curveMode === 'day') renderDayCurve(s).catch(e => {
          if (alive() && S.curveMode === 'day') q('chartWrap').innerHTML = V4.errBox(e);
        });
        else renderSessionCurve(s, s.detail);
      }

      function renderDetail(s, d) {
        const lm = d.live_metrics || {};
        const be = replayBreakEven(d);
        S.be = be;
        updateBoardLinks(s);
        // 2026-08-02 大屏增强：分钟级趋势优先（{t,cost,net_1h}→统一字段），缺失回退旧 5 分钟 trend
        const cum = trimCold(cumSeries(sourceTrend(d)));
        const finalRoi = metricNumber(lm.roiSettle);
        const live = isLive(s);
        const stl = settled(s);
        const mode = replayMode(finalRoi, be);
        const st = pDate(s.startTime);

        const w = q('stateWord');
        flip(w, finalRoi == null ? '数据待补齐' : be == null ? '保本线未配置' : V4.WORD[mode]); w.className = 'state-word ' + mode;
        odo(q('roiNum'), finalRoi == null ? '—' : finalRoi.toFixed(2));
        q('roiDelta').textContent = `平台1小时净ROI · ${be == null ? '保本线未配置' : `保本 ${be.toFixed(2)}`} · ${md(st)} ${WD[chinaDate(st).getUTCDay()]}${live ? ' · 直播中（实时）' : stl ? ' · 平台口径快照' : ' · 回流观察中'} · 非最终结算${d.refreshing || d.replay_preview ? ' · 已有数据先显示，正在补齐' : d.refresh_error ? ' · 更新失败，保留已有数据' : ''}`;

        const cost = metricNumber(lm.cost) ?? metricNumber(s.cost), gmv = metricNumber(lm.gmvSettle), orders = metricNumber(lm.orders);
        odo(q('vCost'), cost == null ? '—' : fmtM(cost));
        q('vCostS').textContent = cost == null ? '消耗数据缺失' : live ? '实时累计' : '本场累计';
        odo(q('vGmv'), gmv == null ? '—' : fmtM(gmv));
        odo(q('vOrd'), orders == null ? '—' : String(Math.round(orders)));
        // 2026-07-31 审计P2修复：endTime 缺失的异常场次 sessEnd 用当前时间，历史场次时长每天疯长（700h+荒谬值）——直播中方可用实时，否则显 --
        odo(q('vDur'), (s.endTime && s.endTime !== '-') || isLive(s) ? durText(sessEnd(s) - st) : '--');
        q('vDurS').textContent = hm(st) + ' 开播';
        const gpm = metricNumber(lm.gpm);
        odo(q('vGpm'), gpm == null ? '—' : String(Math.round(gpm)));
        q('vGpmS').textContent = gpm == null ? 'GPM 数据缺失' : '本场场均值';
        ['vCost', 'vGmv', 'vOrd', 'vDur', 'vGpm'].forEach(n => fitV(q(n)));

        renderActiveCurve();
        renderMats(d, be);
        renderAi(s, d, { lm, cum, finalRoi });
      }

      /* ----- 关键时刻：累计 ROI 序列推导拐点（首尾除外，变化率最大的 ±1 点）+ 风险告警 ----- */
      function deriveMoments(cum, d) {
        const r = cum.roi, out = [];
        if (r.length >= 3) {
          let up = null, dn = null;
          for (let i = 1; i < r.length - 1; i++) {
            const dlt = r[i] - r[i - 1];
            if (!up || dlt > up.d) up = { i, d: dlt };
            if (!dn || dlt < dn.d) dn = { i, d: dlt };
          }
          if (up && up.d > 0.05) out.push({ i: up.i, col: r[up.i] >= 3 ? '#F5B84E' : '#34D399', t: timeAt(cum, up.i), txt: `ROI 拐点 ${r[up.i - 1].toFixed(2)}→${r[up.i].toFixed(2)}（约 ${timeAt(cum, up.i)}，系统推导）` });
          if (dn && dn.d < -0.05 && (!up || dn.i !== up.i)) out.push({ i: dn.i, col: '#F87171', t: timeAt(cum, dn.i), txt: `ROI 拐点 ${r[dn.i - 1].toFixed(2)}→${r[dn.i].toFixed(2)}（约 ${timeAt(cum, dn.i)}，系统推导）` });
          out.sort((a, b) => a.i - b.i);
        }
        (d.riskAlerts || []).forEach(a => out.push({
          i: -1, col: a.level === 'danger' ? '#F87171' : '#FBBF24', t: '—',
          txt: String(a.msg || '') + '（风险告警）',
        }));
        return out;
      }
      function renderMoments(moments) {
        q('moments').innerHTML = moments.length ? moments.map(m =>
          `<div class="pg-rpl-mo"><span class="t">${esc(m.t)}</span><i style="background:${m.col}"></i><span class="txt">${esc(m.txt)}</span></div>`).join('')
          : V4.emptyBox('本场无明显拐点或告警');
      }

      /* ----- SVG 双线图（参考 mock drawChart） ----- */
      function el(tag, attrs) { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; }
      function drawChart(cum, mode, be, moments, roi2log, options = {}) {
        const wrap = q('chartWrap');
        const n = cum.roi.length;
        const hasBe = Number.isFinite(be) && be > 0;
        q('lgBe').textContent = hasBe ? '保本 ' + be.toFixed(2) : '保本线未配置';
        if (n < 2) { chartLayout.redraw = null; wrap.innerHTML = V4.emptyBox(cum.dataValid === false ? '趋势指标不完整，累计曲线暂不可用' : '本场趋势数据不足'); return; }
        const w = Math.max(240, Math.round(wrap.clientWidth || CH.w)), h = w < 500 ? 240 : CH.h;
        wrap.innerHTML = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${options.timeScale ? '当天' : '本场'}累计净ROI与消耗走势"></svg>`;
        const svg = wrap.firstChild;
        chartLayout.width = Math.round(wrap.clientWidth || CH.w);
        chartLayout.svg = svg;
        chartLayout.redraw = () => drawChart(cum, mode, be, moments, roi2log, options);
        const { pl, pr, pt, pb } = CH, iw = w - pl - pr, ih = h - pt - pb;
        const maxTicks = Math.max(2, Math.min(10, Math.floor(iw / 66) + 1));
        const roiRange = hasBe ? [...cum.roi, be] : cum.roi;
        const rMin = Math.min(...roiRange) * .85, rMax0 = Math.max(...roiRange) * 1.12;
        const rMax = rMax0 > rMin ? rMax0 : rMin + 1;
        const cMax = Math.max(cum.cost[n - 1], 1) * 1.05;
        const pointMs = cum.times.map(t => pDate(t).getTime());
        const validPointMs = pointMs.filter(Number.isFinite);
        const segmentBounds = (options.segments || []).flatMap(seg => [
          pDate(seg.startTime).getTime(),
          pDate(seg.endTime).getTime(),
        ]).filter(Number.isFinite);
        const timeScale = !!options.timeScale && validPointMs.length === n;
        const chartStartMs = timeScale ? Math.min(...validPointMs, ...segmentBounds) : 0;
        const chartEndMs0 = timeScale ? Math.max(...validPointMs, ...segmentBounds) : 0;
        const chartEndMs = chartEndMs0 > chartStartMs ? chartEndMs0 : chartStartMs + 1;
        const XMs = ms => pl + (ms - chartStartMs) / (chartEndMs - chartStartMs) * iw;
        const X = i => timeScale ? XMs(pointMs[i]) : pl + i / (n - 1) * iw;
        const YR = v => pt + (1 - (v - rMin) / (rMax - rMin)) * ih;
        const YC = v => pt + (1 - v / cMax) * ih;
        const mono = 'Consolas,monospace';

        /* 全天模式用浅色带标出每场，并保留两场之间的真实时间空档。 */
        if (timeScale && options.segments && options.segments.length) {
          options.segments.forEach((seg, idx) => {
            const sm = pDate(seg.startTime).getTime();
            const em0 = pDate(seg.endTime).getTime();
            const em = Number.isFinite(em0) ? em0 : pointMs[seg.end];
            if (!Number.isFinite(sm) || !Number.isFinite(em)) return;
            const x1 = Math.max(pl, XMs(sm)), x2 = Math.min(w - pr, XMs(em));
            svg.appendChild(el('rect', { x: x1, y: pt, width: Math.max(1, x2 - x1), height: ih,
              fill: idx % 2 ? 'rgba(96,165,250,.025)' : 'rgba(148,163,184,.035)' }));
            svg.appendChild(el('line', { x1, y1: pt, x2: x1, y2: pt + ih, stroke: 'rgba(148,163,184,.20)', 'stroke-width': 1, 'stroke-dasharray': '2 4' }));
            const label = el('text', { x: x1 + 5, y: pt + 11, fill: '#788391', 'font-size': 9.5, 'font-family': mono });
            label.textContent = `${seg.label} ${hm(pDate(seg.startTime))}`; svg.appendChild(label);
          });
        }

        [0, .5, 1].forEach(f => {
          const v = rMin + (rMax - rMin) * f, y = YR(v);
          svg.appendChild(el('line', { x1: pl, y1: y, x2: w - pr, y2: y, stroke: 'rgba(148,163,184,.07)', 'stroke-width': 1 }));
          const t = el('text', { x: pl - 8, y: y + 3, 'text-anchor': 'end', fill: '#788391', 'font-size': 10, 'font-family': mono });
          t.textContent = v.toFixed(1); svg.appendChild(t);
        });
        const tc = el('text', { x: w - pr + 8, y: YC(cum.cost[n - 1]) + 3, fill: '#788391', 'font-size': 10, 'font-family': mono });
        tc.textContent = fmtM(cum.cost[n - 1]); svg.appendChild(tc);
        const tc0 = el('text', { x: w - pr + 8, y: pt + ih + 3, fill: '#788391', 'font-size': 10, 'font-family': mono });
        tc0.textContent = '¥0'; svg.appendChild(tc0);
        if (hasBe) {
          const yBE = YR(be);
          svg.appendChild(el('line', { x1: pl, y1: yBE, x2: w - pr, y2: yBE, stroke: 'rgba(148,163,184,.35)', 'stroke-width': 1, 'stroke-dasharray': '3 5' }));
          const tb = el('text', { x: pl + 4, y: yBE - 5, fill: 'rgba(139,149,163,.8)', 'font-size': 10 });
          tb.textContent = '保本 ' + be.toFixed(2); svg.appendChild(tb);
        }
        /* 时间刻度：全天按真实时钟等距，本场按点位抽样；两者均控制在 12 个以内。 */
        if (timeScale) {
          const ticks = Math.min(maxTicks, Math.max(2, Math.ceil((chartEndMs - chartStartMs) / 3600000) + 1));
          for (let k = 0; k < ticks; k++) {
            const ms = chartStartMs + (chartEndMs - chartStartMs) * k / (ticks - 1);
            const t = el('text', { x: XMs(ms), y: h - 10, 'text-anchor': k === 0 ? 'start' : k === ticks - 1 ? 'end' : 'middle', fill: '#788391', 'font-size': 10, 'font-family': mono });
            t.textContent = hm(new Date(ms)); svg.appendChild(t);
          }
        } else {
          const step = Math.max(1, Math.ceil((n - 1) / (maxTicks - 1)));
          for (let i = 0; i < n; i += step) {
            const t = el('text', { x: X(i), y: h - 10, 'text-anchor': 'middle', fill: '#788391', 'font-size': 10, 'font-family': mono });
            t.textContent = timeAt(cum, i); svg.appendChild(t);
          }
          if ((n - 1) % step !== 0) {
            const t = el('text', { x: X(n - 1), y: h - 10, 'text-anchor': 'middle', fill: '#788391', 'font-size': 10, 'font-family': mono });
            t.textContent = timeAt(cum, n - 1); svg.appendChild(t);
          }
        }

        const ranges = options.segments && options.segments.length ? options.segments : [{ start: 0, end: n - 1 }];
        const path = (arr, Y) => ranges.map(range => {
          const parts = [];
          for (let i = range.start; i <= range.end; i++) parts.push((i === range.start ? 'M' : 'L') + X(i).toFixed(1) + ' ' + Y(arr[i]).toFixed(1));
          return parts.join(' ');
        }).join(' ');
        const pc = el('path', { d: path(cum.cost, YC), fill: 'none', stroke: '#7C8DA6', 'stroke-width': 1.2, 'stroke-linejoin': 'round', opacity: .55 });
        svg.appendChild(pc);
        const col = V4.PULSE_COLOR[mode];
        const pr_ = el('path', { d: path(cum.roi, YR), fill: 'none', stroke: col, 'stroke-width': 1.8, 'stroke-linejoin': 'round', opacity: .95 });
        svg.appendChild(pr_);

        /* 关键时刻标记 */
        moments.filter(m => m.i >= 0 && m.i < n).forEach(m => {
          svg.appendChild(el('circle', { cx: X(m.i), cy: YR(cum.roi[m.i]), r: 3.4, fill: m.col, stroke: '#0F141B', 'stroke-width': 1.5 }));
          const t = el('text', { x: X(m.i), y: YR(cum.roi[m.i]) - 9, 'text-anchor': 'middle', fill: m.col, 'font-size': 10, 'font-family': mono, opacity: .9 });
          t.textContent = timeAt(cum, m.i); svg.appendChild(t);
        });

        /* 调控动作标记（2026-08-02 roi2Log 接入）：竖虚线+hover 显示动作详情 */
        (roi2log || []).forEach(l => {
          if (!l.ts || !cum.times.length) return;
          const t0 = timeScale ? chartStartMs : pDate(cum.times[0]).getTime();
          const t1 = timeScale ? chartEndMs : pDate(cum.times[n - 1]).getTime();
          const ts = l.ts * 1000;
          if (ts < t0 || ts > t1 || t1 <= t0) return;
          const x = timeScale ? XMs(ts) : pl + (ts - t0) / (t1 - t0) * iw;
          const line = el('line', { x1: x, y1: pt, x2: x, y2: pt + ih, stroke: 'rgba(96,165,250,.55)', 'stroke-width': 1, 'stroke-dasharray': '4 3' });
          const clean = String(l.text || '').replace(/\$\$\{|\}\$/g, ' ').replace(/\s+/g, ' ').trim();
          const title = el('title', {});
          title.textContent = `${hm(new Date(ts))} ${l.type || ''} ${clean}`.slice(0, 120);
          line.appendChild(title);
          svg.appendChild(line);
        });

        /* hover 互动（2026-08-03 维护者）：十字线+双曲线圆点+tooltip（时间/累计消耗/累计净ROI） */
        const hoverG = el('g', { opacity: 0 });
        const vLine = el('line', { y1: pt, y2: pt + ih, stroke: 'rgba(148,163,184,.5)', 'stroke-width': 1 });
        const dotC = el('circle', { r: 3.4, fill: '#7C8DA6', stroke: '#0F141B', 'stroke-width': 1.2 });
        const dotR = el('circle', { r: 4, fill: col, stroke: '#0F141B', 'stroke-width': 1.5 });
        hoverG.appendChild(vLine); hoverG.appendChild(dotC); hoverG.appendChild(dotR);
        svg.appendChild(hoverG);
        wrap.style.position = 'relative';
        const tip = document.createElement('div');
        tip.style.cssText = 'position:absolute;pointer-events:none;display:none;background:#151c26;border:1px solid var(--line);border-radius:6px;padding:6px 9px;font-size:11px;font-family:Consolas,monospace;color:#dbe4ee;z-index:5;white-space:normal;max-width:calc(100% - 8px);box-sizing:border-box;box-shadow:0 4px 14px rgba(0,0,0,.35)';
        wrap.appendChild(tip);
        const overlay = el('rect', { x: pl, y: pt, width: iw, height: ih, fill: 'transparent' });
        svg.appendChild(overlay);
        overlay.addEventListener('mousemove', ev => {
          const r = svg.getBoundingClientRect();
          const mx = (ev.clientX - r.left) * (w / r.width); // 屏幕 px → viewBox 坐标
          let i;
          if (timeScale) {
            const targetMs = chartStartMs + Math.max(0, Math.min(1, (mx - pl) / iw)) * (chartEndMs - chartStartMs);
            let best = Infinity; i = 0;
            pointMs.forEach((ms, idx) => { const delta = Math.abs(ms - targetMs); if (delta < best) { best = delta; i = idx; } });
          } else {
            i = Math.round((mx - pl) / iw * (n - 1));
            i = Math.max(0, Math.min(n - 1, i));
          }
          hoverG.setAttribute('opacity', 1);
          vLine.setAttribute('x1', X(i)); vLine.setAttribute('x2', X(i));
          dotC.setAttribute('cx', X(i)); dotC.setAttribute('cy', YC(cum.cost[i]));
          dotR.setAttribute('cx', X(i)); dotR.setAttribute('cy', YR(cum.roi[i]));
          tip.style.display = 'block';
          const seg = (options.segments || []).find(x => i >= x.start && i <= x.end);
          tip.textContent = `${seg ? seg.label + ' · ' : ''}${timeAt(cum, i)} · 累计消耗 ${fmtM(cum.cost[i])} · 累计净ROI ${cum.roi[i].toFixed(2)}`;
          const px = ev.clientX - r.left, py = ev.clientY - r.top;
          const tipWidth = tip.offsetWidth;
          const right = px + 14;
          const left = px - tipWidth - 14;
          tip.style.left = Math.max(4, Math.min(right + tipWidth <= wrap.clientWidth - 4 ? right : left, wrap.clientWidth - tipWidth - 4)) + 'px';
          tip.style.top = Math.max(4, py - 36) + 'px';
        });
        overlay.addEventListener('mouseleave', () => { hoverG.setAttribute('opacity', 0); tip.style.display = 'none'; });

        /* 绘制动画：stroke-dashoffset 一次（RM 时跳过） */
        [pc, pr_].forEach((p, k) => {
          if (V4.RM.matches || document.documentElement.dataset.uiEffects === 'minimal') return;
          const len = p.getTotalLength();
          p.style.strokeDasharray = len; p.style.strokeDashoffset = len;
          p.getBoundingClientRect();
          p.style.transition = `stroke-dashoffset ${k ? 1.5 : 1.1}s cubic-bezier(.4,0,.2,1) ${k * .25}s`;
          p.style.strokeDashoffset = '0';
          setTimeout(() => { p.style.strokeDasharray = 'none'; p.style.transition = ''; }, 2200);
        });
        q('lgRoi').style.background = col;
      }

      /* ----- 素材表现表（video/live/carousel 合并，按消耗降序） ----- */
      function allMats(d) {
        const M = d.materials || {};
        return [...(M.video || []), ...(M.live || []), ...(M.carousel || [])]
          .filter(m => +m.cost > 0)
          .sort((a, b) => (+b.cost || 0) - (+a.cost || 0));
      }
      function renderMats(d, be) {
        const list = allMats(d);
        q('matCnt').textContent = list.length ? list.length + ' 条' : '';
        if (!list.length) {
          q('mats').innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--ink-3)">暂无素材消耗记录</td></tr>';
          return;
        }
        q('mats').innerHTML = list.map(m => {
          const roi = metricNumber(m.roiSettle), orders = metricNumber(m.orders);
          const roiValid = roi != null;
          const name = m.name || m.material_id || '--';
          /* 2026-08-03 维护者：素材表现只呈现数据，不出任何硬编码结论（原"放量/观察/止损"标签列已删） */
          return `<tr><td data-private="${m.name ? 'mixed' : 'id'}" title="${esc(name)}">${esc(name)}</td><td class="num">${fmtM(m.cost)}</td><td class="num">${fmtM(m.gmvSettle)}</td><td class="num">${orders != null ? Math.round(orders) : '--'}</td><td class="num roi ${roiValid ? roiClsBe(roi, be) : ''}">${roiValid ? roi.toFixed(2) : '--'}</td></tr>`;
        }).join('');
      }

      /* ----- 复盘总结：纯数据小结 ----- */
      async function renderAi(s, d, ctx) {
        q('aiTitle').textContent = '数据小结';
        const { lm, finalRoi } = ctx;
        const lines = [];
        const roiKnown = lm.roiSettle != null && lm.roiSettle !== '' && Number.isFinite(Number(lm.roiSettle));
        lines.push(`① 平台1小时净ROI ${roiKnown ? Number(lm.roiSettle).toFixed(2) : '缺失'}${isLive(s) ? '（实时）' : !settled(s) ? '（仍可能回流）' : ''}，不是最终财务利润。`);
        lines.push('② 任务级本场追投归因缺失；日期范围历史不与本场总消耗计算占比，不用0补齐。');
        const mats = allMats(d);
        if (mats.length) lines.push(`③ TOP 消耗素材「${mats[0].name || '--'}」，净ROI ${mats[0].roiSettle == null ? '缺失' : mats[0].roiSettle}。`);
        lines.push('④ 未绑定本场历史策略，不自动生成盈亏判定和追投/暂停建议。');
        q('aiBody').innerHTML = `<div class="src">无当日 Agent 复盘缓存 · 以下为纯数据小结（非 AI 生成）</div><p>${esc(lines.join('\n'))}</p>`;
      }

      if (typeof ResizeObserver === 'function') {
        const chartObserver = new ResizeObserver(() => {
          if (!alive() || !chartLayout.redraw || q('chartWrap').firstChild !== chartLayout.svg) return;
          const width = Math.round(q('chartWrap').clientWidth);
          if (!width || width === chartLayout.width || chartLayout.frame) return;
          chartLayout.frame = requestAnimationFrame(() => {
            chartLayout.frame = 0;
            if (alive() && q('chartWrap').firstChild === chartLayout.svg) chartLayout.redraw?.();
          });
        });
        chartObserver.observe(q('chartWrap'));
        stoppers.push(() => { chartObserver.disconnect(); cancelAnimationFrame(chartLayout.frame); chartLayout.redraw = null; });
      }
      loadSessions().catch(e => { if (alive()) q('sess').innerHTML = V4.errBox(e); });

      return function unmount() {
        dead = true; // 在途请求统一作废
        stoppers.forEach(f => { try { f(); } catch (e) {} });
        if (liveStop) { try { liveStop(); } catch (e) {} liveStop = null; }
        S.reqId++;
      };
    },
  };

})(window.V4);
