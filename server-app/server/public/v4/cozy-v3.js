/* Cozy V3 interactions: tooltip, right-column ordering, transitions and no-data guidance. */
(function () {
  'use strict';
  let scheduled = false;

  function orderDemoSide() {
    const side = document.querySelector('.demo-side');
    if (!side) return;
    const cards = [...side.children];
    const pick = label => cards.find(card => (card.querySelector('h2')?.textContent || '').includes(label));
    const desired = [pick('Agent 状态'), pick('通知与提醒'), pick('最近决策摘要'), pick('需要关注的证据')].filter(Boolean);
    desired.forEach(card => side.appendChild(card));
  }

  function enhanceChart() {
    const wrap = document.querySelector('.demo-chart-wrap');
    if (!wrap || wrap.dataset.cozyV3Chart === '1') return;
    wrap.dataset.cozyV3Chart = '1';
    let tip = wrap.querySelector('.demo-chart-tip');
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'demo-chart-tip';
      wrap.appendChild(tip);
    }
    const points = [...wrap.querySelectorAll('circle.point')];
    const dates = ['09/10','09/11','09/12','09/13','09/14','09/15','09/16'];
    const values = ['¥5,200','¥10,200','¥9,100','¥7,800','¥11,800','¥12,400','¥13,900'];
    points.forEach((point, i) => {
      point.setAttribute('tabindex', '0');
      point.setAttribute('role', 'button');
      point.setAttribute('aria-label', `${dates[i]} 消耗 ${values[i]}`);
      const show = () => {
        const pr = point.getBoundingClientRect();
        const wr = wrap.getBoundingClientRect();
        tip.style.left = `${pr.left - wr.left + pr.width / 2}px`;
        tip.style.top = `${pr.top - wr.top}px`;
        tip.innerHTML = `<span>${dates[i]} · 演示数据</span><b>${values[i]}</b>`;
        tip.classList.add('on');
      };
      const hide = () => tip.classList.remove('on');
      point.addEventListener('mouseenter', show);
      point.addEventListener('mouseleave', hide);
      point.addEventListener('focus', show);
      point.addEventListener('blur', hide);
    });
  }

  function softenCopy() {
    const hero = document.querySelector('.demo-hero');
    if (hero && hero.dataset.cozyV3Copy !== '1') {
      hero.dataset.cozyV3Copy = '1';
      const h1 = hero.querySelector('h1');
      const p = hero.querySelector('p');
      if (h1) h1.textContent = '让每一次投放更有把握';
      if (p) p.textContent = '把复杂数据理清，把每一分预算花明白；先看证据，再做动作。';
    }
    const companion = document.querySelector('.demo-companion');
    if (companion && companion.dataset.cozyV3Copy !== '1') {
      companion.dataset.cozyV3Copy = '1';
      const strong = companion.querySelector('strong');
      const span = companion.querySelector('span');
      if (strong) strong.textContent = '稳稳投，慢慢长';
      if (span) span.textContent = '愿每一分投入都有依据，每一次调整都有回声。';
    }
  }

  function wireDemoSwitchTransition() {
    const button = document.querySelector('.demo-toggle');
    if (!button || button.dataset.cozyV3Switch === '1') return;
    button.dataset.cozyV3Switch = '1';
    button.addEventListener('click', () => {
      document.body.classList.add('demo-switching');
      setTimeout(() => document.body.classList.remove('demo-switching'), 420);
    }, { capture: true });
  }

  function routeName() {
    return (location.hash || '#/overview').replace(/^#\/?/, '') || 'overview';
  }

  function ensureNoDataState() {
    const view = document.getElementById('view');
    const demoButton = document.querySelector('.demo-toggle');
    if (!view || !demoButton || routeName() !== 'overview') return;
    const demoOn = demoButton.classList.contains('on');
    const hasAccounts = !!(window.V4 && Array.isArray(window.V4.ACCTS) && window.V4.ACCTS.length);
    const existing = view.querySelector('.cozy-empty-state');
    if (demoOn || hasAccounts) { existing?.remove(); return; }
    if (view.querySelector('.demo-dashboard')) return;
    if (!existing) {
      const empty = document.createElement('section');
      empty.className = 'cozy-empty-state';
      empty.innerHTML = `<div class="cozy-empty-visual" aria-hidden="true"></div><div class="cozy-empty-copy"><span class="cozy-empty-eyebrow">当前暂无真实盘面</span><h2>先看看完整工作台，或者接入你的千川账号</h2><p>演示模式只使用本地示例数据，不会连接千川，也不会执行任何投放操作。</p><div class="cozy-empty-actions"><button type="button" data-empty-demo>开启演示模式</button><button type="button" class="secondary" data-empty-onboard>前往接入账号</button></div></div>`;
      view.innerHTML = '';
      view.appendChild(empty);
      empty.querySelector('[data-empty-demo]').onclick = () => document.querySelector('.demo-toggle')?.click();
      empty.querySelector('[data-empty-onboard]').onclick = () => { location.hash = '#/onboarding'; };
    }
  }

  function enhance() {
    scheduled = false;
    orderDemoSide();
    enhanceChart();
    softenCopy();
    wireDemoSwitchTransition();
    setTimeout(ensureNoDataState, 350);
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(enhance);
  }

  document.addEventListener('DOMContentLoaded', schedule, { once: true });
  addEventListener('hashchange', schedule);
  window.V4.onViewUpdate(enhance);
  schedule();
})();
