/* Persistent demo mode: renders a full dashboard without touching real account APIs. */
(function (V4) {
  'use strict';
  const KEY = 'v4-demo-mode';
  let active = false;
  let scheduled = false;

  function isActive() {
    try { return localStorage.getItem(KEY) === '1'; } catch (_) { return active; }
  }
  function setActive(value) {
    active = !!value;
    try { localStorage.setItem(KEY, active ? '1' : '0'); } catch (_) {}
    document.body.classList.toggle('demo-mode-active', active);
    ensureToggle();
    if (active) {
      if (location.hash !== '#/overview') location.hash = '#/overview';
      renderDemo();
    } else {
      location.reload();
    }
  }

  function ensureToggle() {
    const host = document.querySelector('header.top .top-r');
    if (!host) return;
    let button = host.querySelector('.demo-toggle');
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'demo-toggle';
      button.innerHTML = '<span class="demo-label">演示模式</span><span class="demo-switch" aria-hidden="true"></span>';
      host.insertBefore(button, host.firstChild);
      button.onclick = () => setActive(!isActive());
    }
    const on = isActive();
    button.classList.toggle('on', on);
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
    button.title = on ? '关闭演示模式，返回真实数据' : '开启演示模式，使用本地示例数据';
  }

  function miniLine(points, color) {
    const pts = points.map((v, i) => `${i * 14 + 2},${30 - v}`).join(' ');
    return `<svg viewBox="0 0 90 34" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }

  function dashboardHtml() {
    const rows = [
      ['主计划｜直播稳定放量','live','投放中','¥4,320.00','3.83','428',72],
      ['追投｜晚间优质人群','live','投放中','¥2,860.00','4.12','196',55],
      ['测试计划｜新素材A','warn','观察中','¥1,420.00','2.41','88',34],
      ['老客召回｜人群包','pause','已暂停','¥0.00','—','0',0],
      ['追投｜高意向承接','live','投放中','¥3,118.00','3.67','241',84],
    ];
    const table = rows.map(r => `<tr><td>${r[0]}</td><td><span class="demo-status ${r[1]}"><i></i>${r[2]}</span></td><td>${r[3]}</td><td class="roi">${r[4]}</td><td>${r[5]}</td><td><div class="demo-progress"><b>${r[6]}%</b><span class="bar"><i style="width:${r[6]}%"></i></span></div></td><td>•••</td></tr>`).join('');
    return `
      <section class="demo-dashboard" aria-label="演示工作台">
        <section class="demo-hero">
          <div><h1>让每一次投放更有把握</h1><p>今天也把每一分预算花明白。稳稳投，慢慢长；先看证据，再做动作。</p><span class="demo-hero-tag"><i></i>演示数据 · 投放操作由外部 Agent 完成</span></div>
          <div class="demo-scribble">稳定投放<br>持续生长 ♥</div>
        </section>
        <section class="demo-kpis">
          <article class="demo-kpi"><div class="topline"><span class="ico">¥</span>今日消耗</div><div class="value">¥ 12,628.00</div><div class="delta hot">↑ 12.5%　较昨日</div>${miniLine([18,12,16,8,11,5],'#f2798f')}</article>
          <article class="demo-kpi"><div class="topline"><span class="ico">▣</span>净成交</div><div class="value">¥ 48,920.00</div><div class="delta up">↑ 18.7%　较昨日</div>${miniLine([24,17,20,12,14,5],'#5f96f7')}</article>
          <article class="demo-kpi"><div class="topline"><span class="ico">▰</span>订单量</div><div class="value">1,236</div><div class="delta up">↑ 9.3%　较昨日</div>${miniLine([25,18,21,12,15,7],'#43c68a')}</article>
          <article class="demo-kpi"><div class="topline"><span class="ico">▥</span>净 ROI</div><div class="value">3.87</div><div class="delta up">↑ 6.2%　较昨日</div>${miniLine([22,14,19,10,13,6],'#8d76ee')}</article>
        </section>
        <div class="demo-main">
          <section class="demo-card demo-trend">
            <div class="demo-card-head"><h2>近期投放趋势</h2><span class="meta">最近 7 天 · 演示数据</span></div>
            <div class="demo-tabs"><span class="on">消耗</span><span>净成交</span><span>订单量</span><span>ROI</span></div>
            <div class="demo-chart-wrap">
              <svg viewBox="0 0 760 220" preserveAspectRatio="none" role="img" aria-label="最近七天投放趋势">
                <defs><linearGradient id="demoArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#75a9ff" stop-opacity=".35"/><stop offset="1" stop-color="#75a9ff" stop-opacity=".02"/></linearGradient></defs>
                ${[40,80,120,160,200].map(y=>`<line class="grid" x1="44" x2="744" y1="${y}" y2="${y}"/>`).join('')}
                ${['09/10','09/11','09/12','09/13','09/14','09/15','09/16'].map((t,i)=>`<text x="${50+i*114}" y="214">${t}</text>`).join('')}
                <path class="area" d="M52 173 C105 142 135 115 168 119 S245 143 282 151 S360 101 398 96 S480 84 514 82 S625 70 738 58 L738 200 L52 200 Z"/>
                <path class="line" d="M52 173 C105 142 135 115 168 119 S245 143 282 151 S360 101 398 96 S480 84 514 82 S625 70 738 58"/>
                ${[[52,173],[168,119],[282,151],[398,96],[514,82],[626,74],[738,58]].map(p=>`<circle class="point" cx="${p[0]}" cy="${p[1]}" r="4"/>`).join('')}
              </svg>
            </div>
          </section>
          <section class="demo-card demo-table-card">
            <div class="demo-card-head"><h2>账户 / 计划概览</h2><span class="meta">演示账号 · 只读</span></div>
            <table class="demo-table"><thead><tr><th>计划名称</th><th>状态</th><th>今日消耗</th><th>净 ROI</th><th>订单</th><th>预算使用</th><th>操作</th></tr></thead><tbody>${table}</tbody></table>
          </section>
        </div>
        <aside class="demo-side">
          <section class="demo-card">
            <div class="demo-card-head"><h2 class="demo-agent-head">Agent 状态 <i class="pulse"></i></h2><span class="meta">外部 Agent</span></div>
            <div class="demo-agent-stats"><div><span>最近活动</span><b>3 分钟前</b></div><div><span>今日建议</span><b>5 条</b></div><div><span>执行状态</span><b>正常</b></div></div>
            <div class="demo-agent-ok">✓ Agent 连接正常 · 前端只展示结果与证据</div>
          </section>
          <section class="demo-card">
            <div class="demo-card-head"><h2>最近决策摘要</h2><span class="meta">查看全部 ›</span></div>
            <div class="demo-feed"><div class="demo-feed-row"><time>10:21</time><p><b>本机数据已更新</b>，示例未执行广告操作。</p><span class="tag">已读</span></div><div class="demo-feed-row"><time>09:40</time><p><b>原始指标记录</b>，保留来源与时间。</p><span class="tag">观察</span></div><div class="demo-feed-row"><time>08:15</time><p><b>账户资料已核对</b>，示例未连接真实账户。</p><span class="tag">测试</span></div></div>
          </section>
          <section class="demo-card">
            <div class="demo-card-head"><h2>通知与提醒</h2><span class="meta">4 条</span></div>
            <div class="demo-alert-list"><div class="demo-alert danger"><span class="dot">!</span><span>本版不提供投放策略建议。</span></div><div class="demo-alert warn"><span class="dot">◷</span><span>主计划预算已使用 72%，注意后续流速变化。</span></div><div class="demo-alert"><span class="dot">✓</span><span>直播状态和账户 Cookie 均正常。</span></div></div>
          </section>
          <section class="demo-card">
            <div class="demo-card-head"><h2>需要关注的证据</h2><span class="meta">演示</span></div>
            <div class="demo-evidence"><div><b>3</b><span>ROI 信号</span></div><div><b>2</b><span>预算信号</span></div><div><b>4</b><span>数据新鲜度</span></div></div>
          </section>
        </aside>
        <section class="demo-companion"><strong>数据在变，方向要更清楚</strong><span>愿每一分投入都有依据，每一次调整都有回声。</span></section>
      </section>`;
  }

  function renderDemo() {
    if (!isActive()) return;
    const view = document.getElementById('view');
    if (!view) return;
    if (!view.querySelector('.demo-dashboard')) view.innerHTML = dashboardHtml();
    document.body.classList.add('demo-mode-active');
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      ensureToggle();
      if (isActive()) renderDemo();
    });
  }

  function start() {
    active = isActive();
    ensureToggle();
    document.body.classList.toggle('demo-mode-active', active);
    if (active) setTimeout(renderDemo, 0);
    V4.onViewUpdate(() => { ensureToggle(); if (isActive()) renderDemo(); });
    addEventListener('hashchange', schedule);
  }
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start, { once: true });
})(window.V4 || {});
