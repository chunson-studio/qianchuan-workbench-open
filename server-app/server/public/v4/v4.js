/* ===== 千川投控 v4 · 壳：路由 + 顶条 ===== */
(function (V4) {
  'use strict';
  const $ = V4.$;

  V4.pages = V4.pages || {};
  const ROUTES = ['overview', 'onboarding'];
  const loaded = {};
  let current = null;   // { name, unmount }
  let mountSeq = 0;     // mount 序号守卫

  document.querySelector('.skip-link')?.addEventListener('click', event => {
    event.preventDefault();
    const view = document.getElementById('view');
    view?.focus({ preventScroll: true });
    view?.scrollIntoView({ block: 'start' });
  });

  /* ----- Liquid Glass：动态卡片识别 + 状态边光 + 指针折射 -----
     页面内容会持续轮询并替换 innerHTML，因此不能只在 mount 时绑定一次。
     MutationObserver 只观察结构与 class；data-glass-state 自身不会反复触发。 */
  const GLASS_HEAVY = [
    '.block', '.band', '.pg-ov-band', '.pg-ov-card', '.pg-ov-gcol',
    '.pg-com-shop', '.dc-note', '.pg-sys-health-card',
    '.pg-sys-logbox', '.pg-mat-model', '.acct-manager'
  ].join(',');
  const GLASS_COMPACT = [
    '.w-item', '.f-snap', '.f-metrics', '.f-loop', '.b-row', '.m-row',
    '.bt-cell', '.wl-ordgrid .oc', '.wl-portrait .pc', '.pg-mat-mc',
    '.pg-com-mrow', '.pg-com-trow', '.dc-card', '.pg-rpl-srow',
    '.pg-rpl-mo', '.pg-sys-op-row', '.pg-sys-fill-item', '.band-judgment',
    '.pg-ov-kpi', '.pg-ov-split-cell', '.pg-mat-au-block', '.dc-stat', '.vital'
  ].join(',');
  const GLASS_ALL = `${GLASS_HEAVY},${GLASS_COMPACT}`;
  const GLASS_STATE_SELECTORS = {
    danger: [
      '.st-danger', '.st-loss', '.badge-danger', '.b-row.bleed', '.dc-card.has-error',
      '.pg-sys-st.danger', '.state-word.bad', '.m-v.bad', '.m-roi.bad',
      '.pg-com-mroi.bad', '.v.bd', '.pg-ov-al.danger', '.err-box'
    ],
    warn: [
      '.st-warn', '.st-weak', '.st-alert', '.badge-warn', '.state-word.warn',
      '.state-word.low', '.m-v.warn', '.m-v.low', '.m-roi.warn', '.m-roi.low',
      '.pg-com-mroi.warn', '.pg-com-mroi.low', '.pg-sys-health-card .v.warn',
      '.v.warn', '.dc-tag.unverified', '.v.wn', '.pg-ov-al.warn', '.portrait-stale'
    ],
    live: [
      '.st-live', '.badge-live', '.b-live-dot', '.pg-ov-h .st.live',
      '.dc-tag.live', '.pg-rpl-liveb', '.live.on'
    ],
    ok: [
      '.st-ok', '.badge-ok', '.dc-card.has-action', '.state-word.good',
      '.state-word.top', '.m-v.good', '.m-v.top', '.m-roi.good', '.m-roi.top',
      '.pg-com-mroi.good', '.pg-com-mroi.top', '.pg-sys-health-card .v.good',
      '.v.good', '.pg-sys-st.good', '.v.gd', '.pg-com-trow.hit', '.pg-com-mrow.hit'
    ]
  };
  let glassObserver = null;
  let glassVisibilityObserver = null;
  let glassPointerFrame = 0;
  let activeGlassCard = null;
  let lastGlassPointer = null;

  function normalizeGlassState(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (/danger|loss|error|bad|bleed|风险|危险/.test(raw)) return 'danger';
    if (/warn|weak|alert|low|注意|预警/.test(raw)) return 'warn';
    if (/live|running|active|直播|在投/.test(raw)) return 'live';
    if (/ok|good|healthy|success|正常|健康/.test(raw)) return 'ok';
    return '';
  }

  function glassMatches(card, selector) {
    try { return card.matches(selector) || !!card.querySelector(selector); }
    catch (_) { return false; }
  }

  function glassState(card) {
    const declared = normalizeGlassState(card.dataset.uiState || card.dataset.state || card.getAttribute('aria-status'));
    if (declared) return declared;
    // 严格固定优先级：危险 > 预警 > 在播 > 正常 > 中性。
    for (const state of ['danger', 'warn', 'live', 'ok']) {
      if (GLASS_STATE_SELECTORS[state].some(selector => glassMatches(card, selector))) return state;
    }
    return 'neutral';
  }

  function enhanceGlassCard(card) {
    if (!(card instanceof HTMLElement)) return;
    card.classList.add('liquid-card');
    card.classList.toggle('liquid-card--compact', card.matches(GLASS_COMPACT));
    card.classList.toggle('liquid-card--hero', card.matches('.band,.pg-ov-band'));
    card.dataset.glassState = glassState(card);
    if (!card.querySelector(':scope > .liquid-card__aura')) {
      const aura = document.createElement('span');
      aura.className = 'liquid-card__aura';
      aura.setAttribute('aria-hidden', 'true');
      card.prepend(aura);
    }
    if (glassVisibilityObserver && !card.dataset.glassObserved) {
      card.dataset.glassObserved = '1';
      glassVisibilityObserver.observe(card);
    } else if (!glassVisibilityObserver) {
      card.classList.add('is-glass-visible');
    }
  }

  function refreshLiquidGlass(root) {
    if (document.documentElement.dataset.uiEffects === 'minimal') return;
    const scope = root && root.querySelectorAll ? root : document;
    if (scope instanceof HTMLElement && scope.matches(GLASS_ALL)) enhanceGlassCard(scope);
    scope.querySelectorAll(GLASS_ALL).forEach(enhanceGlassCard);
  }
  V4.refreshLiquidGlass = refreshLiquidGlass;

  function scheduleLiquidGlass() { V4.refreshViewEffects(); }

  function clearGlassPointer(card) {
    const target = card || activeGlassCard;
    if (!target) return;
    target.classList.remove('is-glass-hover');
    target.style.removeProperty('--glass-x');
    target.style.removeProperty('--glass-y');
    target.style.removeProperty('--glass-rx');
    target.style.removeProperty('--glass-ry');
    if (target === activeGlassCard) activeGlassCard = null;
  }

  function renderGlassPointer() {
    glassPointerFrame = 0;
    const point = lastGlassPointer;
    const card = activeGlassCard;
    if (!point || !card || !card.isConnected) return;
    const rect = card.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const nx = Math.max(0, Math.min(1, (point.x - rect.left) / rect.width));
    const ny = Math.max(0, Math.min(1, (point.y - rect.top) / rect.height));
    card.style.setProperty('--glass-x', `${(nx * 100).toFixed(1)}%`);
    card.style.setProperty('--glass-y', `${(ny * 100).toFixed(1)}%`);
    if (!card.classList.contains('liquid-card--compact') && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      card.style.setProperty('--glass-rx', `${((.5 - ny) * .7).toFixed(2)}deg`);
      card.style.setProperty('--glass-ry', `${((nx - .5) * .8).toFixed(2)}deg`);
    }
  }

  function installLiquidGlass() {
    if (document.documentElement.dataset.uiEffects === 'minimal') return;
    if (glassObserver || !document.body) return;
    if ('IntersectionObserver' in window) {
      glassVisibilityObserver = new IntersectionObserver(entries => {
        entries.forEach(entry => entry.target.classList.toggle('is-glass-visible', entry.isIntersecting));
      }, { rootMargin: '120px 0px', threshold: 0.01 });
    }
    refreshLiquidGlass(document);
    glassObserver = V4.onViewUpdate(mutations => {
      if (glassVisibilityObserver) mutations.forEach(mutation => mutation.removedNodes.forEach(node => {
        if (!(node instanceof HTMLElement)) return;
        const removedCards = node.matches('.liquid-card') ? [node] : [];
        node.querySelectorAll('.liquid-card').forEach(card => removedCards.push(card));
        removedCards.forEach(card => {
          glassVisibilityObserver.unobserve(card);
          card.removeAttribute('data-glass-observed');
        });
      }));
      refreshLiquidGlass(document);
    });
    document.addEventListener('pointermove', event => {
      if (!event.target || !event.target.closest) return;
      const card = event.target.closest('.liquid-card');
      if (card !== activeGlassCard) {
        clearGlassPointer(activeGlassCard);
        activeGlassCard = card;
        if (card) card.classList.add('is-glass-hover');
      }
      if (!card) return;
      lastGlassPointer = { x: event.clientX, y: event.clientY };
      if (!glassPointerFrame) glassPointerFrame = requestAnimationFrame(renderGlassPointer);
    }, { passive: true });
    document.addEventListener('pointerout', event => {
      if (activeGlassCard && (!event.relatedTarget || !activeGlassCard.contains(event.relatedTarget))) clearGlassPointer(activeGlassCard);
    }, { passive: true });
    window.addEventListener('blur', () => clearGlassPointer(activeGlassCard));
  }

  /* ----- 顶条：账户 → 房间，两级上下文选择 ----- */
  let accountManager = null;
  function renderFeatureNav() {
    document.querySelectorAll('[data-feature]').forEach(node => {
      node.hidden = V4.features && V4.features[node.dataset.feature] === false;
    });
  }
  function renderAccts() {
    const el = $('accts');
    if (!el) return;
    document.body.dataset.accountState = V4.accountsError ? 'error' : V4.ACCTS.length ? 'ready'
      : V4.archivedAccounts?.length ? 'archived' : 'empty';
    if (!V4.ACCTS.length) {
      el._contextMarkup = null;
      const label = V4.accountsError ? '账号列表加载失败' : '尚未接入账号';
      el.innerHTML = `<div class="acct-control"><div class="acct-tabs" role="group" aria-label="账号列表"><span class="acct-loading">${V4.esc(label)}</span></div><button class="acct-add" type="button" aria-label="添加账号" title="添加账号">＋</button><button class="acct-manage" type="button" aria-label="管理账号">管理</button></div>`;
      const add = el.querySelector('.acct-add');
      if (add) add.onclick = () => openAccountManager(true);
      const manage = el.querySelector('.acct-manage');
      if (manage) manage.onclick = () => openAccountManager(false);
      return;
    }
    const selected = V4.acct();
    const accountOptions = V4.ACCTS.map(a => '<option value="'+V4.esc(a.id)+'"'+(a.id===selected?' selected':'')+'>'+V4.esc(a.name || a.id)+'</option>').join('');
    const markup = '<div class="acct-control"><label class="account-control"><span>账户</span><select id="accountSelect" aria-label="选择账户">'+accountOptions+'</select></label><button class="acct-add" type="button" aria-label="添加账号" title="添加账号">＋</button><button class="acct-manage" type="button" aria-label="管理账号">管理</button></div>';
    if (el._contextMarkup === markup) return;
    const focusedId = el.contains(document.activeElement) ? document.activeElement.id : '';
    el.innerHTML = markup;
    el._contextMarkup = markup;
    el.querySelector('#accountSelect').onchange = event => V4.setAcct(event.target.value);
    const add = el.querySelector('.acct-add');
    if (add) add.onclick = () => openAccountManager(true);
    const manage = el.querySelector('.acct-manage');
    if (manage) manage.onclick = () => openAccountManager(false);
    if (focusedId) el.querySelector('#'+focusedId)?.focus({preventScroll:true});
  }

  function safeAccounts(value) {
    return Array.isArray(value) ? value : [];
  }

  function closeAccountManager() {
    if (!accountManager) return;
    const closing = accountManager;
    accountManager = null;
    document.removeEventListener('keydown', closing.onKeydown);
    closing.background.forEach(([node, wasInert]) => { node.inert = wasInert; });
    document.body.style.overflow = closing.previousOverflow;
    closing.node.remove();
    const trigger = closing.trigger?.isConnected ? closing.trigger : document.querySelector('.acct-manage');
    trigger?.focus({ preventScroll: true });
  }
  // 其他界面完成账户操作后可能移除弹窗；同时释放焦点与滚动限制。
  V4.onViewUpdate(() => { if (accountManager && !accountManager.node.isConnected) closeAccountManager(); });

  function managerRows(accounts, kind) {
    if (!accounts.length) return '<div class="acct-manager-empty">暂无</div>';
    return accounts.map(account => {
      const id = V4.esc(account.id);
      const name = V4.esc(account.name || account.id);
      const be = account.break_even_roi != null ? `保本 ${V4.esc(account.break_even_roi)}` : '保本未配';
      const liveState = V4.accountLiveView(V4.watchState(account.id));
      const badgeHtml = `<span class="room-state account-badge ${liveState.state}">${V4.esc(liveState.label)}</span>`;

      if (kind === 'active') {
        return `<div class="acct-manager-row"><div><strong>${name}${badgeHtml}</strong><span class="num" data-private="id">${id}</span><small>${be}</small></div><button class="acct-row-action danger" type="button" data-account-action="remove" data-account-id="${id}" data-account-name="${name}">移出</button></div>`;
      }
      return `<div class="acct-manager-row"><div><strong>${name}</strong><span class="num" data-private="id">${id}</span><small>${be}</small></div><div style="display:flex;gap:6px;"><button class="acct-row-action" type="button" data-account-action="restore" data-account-id="${id}" data-account-name="${name}">恢复</button><button class="acct-row-action danger" type="button" data-account-action="purge" data-account-id="${id}" data-account-name="${name}">彻底删除</button></div></div>`;
    }).join('');
  }

  function renderAccountManager() {
    if (!accountManager) return;
    const active = safeAccounts(V4.ACCTS);
    const archived = safeAccounts(V4.archivedAccounts);
    const node = accountManager.node;
    node.querySelector('.acct-manager-content').innerHTML = `
      <div class="acct-manager-note">在本场浏览器登录千川，由 Codex 核验账户和直播间后接续。无需手动导出或粘贴 Cookie。</div>
      <section class="acct-manager-section"><h3>可用账号 <span>${active.length}</span></h3>${managerRows(active, 'active')}</section>
      <section class="acct-manager-section"><h3>已移出账号 <span>${archived.length}</span></h3>${managerRows(archived, 'archived')}</section>
      <div class="acct-manager-status" style="margin-top:12px;font-size:12px;color:var(--ink-2);" aria-live="polite"></div>
      <section class="acct-manager-section"><button class="acct-primary" data-onboarding>接入新账号或继续配置</button></section>`;

    node.querySelectorAll('[data-account-action]').forEach(button => {
      button.onclick = () => executeAccountAction(button, button.dataset.accountAction, button.dataset.accountId, button.dataset.accountName);
    });
    node.querySelector('[data-onboarding]').onclick = () => { closeAccountManager(); location.hash = '#/onboarding'; };
  }

  async function executeAccountAction(button, action, id, name) {
    if (!accountManager) return;
    const humanAction = action === 'remove' ? '移出' : (action === 'purge' ? '彻底删除' : '恢复');
    const status = accountManager.node.querySelector('.acct-manager-status');
    button.disabled = true;
    if (status) status.textContent = `正在${humanAction}「${name || id}」…`;
    try {
      const payload = { id, confirm: true, permanent: action === 'purge' };
      const result = (action === 'remove' || action === 'purge')
        ? await V4.apiJson('/api/accounts', 'DELETE', payload, { includeAccount: false, timeout: 20000 })
        : await V4.apiJson('/api/accounts', 'POST', { action: 'restore', ...payload }, { includeAccount: false, timeout: 20000 });
      applyAccountRegistryResult(result, action === 'restore' ? id : '');
      const refreshedStatus = accountManager && accountManager.node.querySelector('.acct-manager-status');
      if (refreshedStatus) {
        refreshedStatus.innerHTML = `<span style="color:var(--st-ok,#22c55e);">✓ 账号「${V4.esc(name || id)}」已${humanAction}。</span>`;
      }
    } catch (error) {
      if (status) {
        status.innerHTML = `<span style="color:var(--st-danger,#ef4444);">✗ 操作失败：${V4.esc((error && error.message) || '未知错误')}</span>`;
      }
      button.disabled = false;
    }
  }


  function applyAccountRegistryResult(result, selectId) {
    if (!result || !result.ok || !Array.isArray(result.accounts)) throw new Error((result && result.error) || '账号管理响应格式错误');
    V4.archivedAccounts = safeAccounts(result.archived_accounts);
    V4.setAccounts(result.accounts);
    if (selectId) V4.setAcct(selectId);
    renderAccts();
    renderAccountManager();

  }

  function openAccountManager(focusAdd) {
    if (focusAdd) { location.hash = '#/onboarding'; return; }
    if (accountManager && !accountManager.node.isConnected) closeAccountManager();
    if (accountManager) return;
    const trigger = document.activeElement;
    const node = document.createElement('div');
    node.className = 'acct-manager-backdrop';
    node.innerHTML = `<section class="acct-manager" role="dialog" aria-modal="true" aria-labelledby="acct-manager-title"><header><div><h2 id="acct-manager-title">账号管理</h2><p>添加、移出和恢复账号</p></div><button class="acct-manager-close" type="button" aria-label="关闭账号管理">×</button></header><div class="acct-manager-content"></div></section>`;
    const onKeydown = event => {
      if (event.key === 'Escape') { event.preventDefault(); closeAccountManager(); return; }
      if (event.key !== 'Tab') return;
      const focusable = [...node.querySelectorAll('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')]
        .filter(element => element.getClientRects().length && !element.closest('[inert]'));
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (!first) { event.preventDefault(); return; }
      if (!node.contains(document.activeElement) || (event.shiftKey && document.activeElement === first)) {
        event.preventDefault(); (event.shiftKey ? last : first).focus();
      } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    const background = [...document.body.children].filter(element => !['SCRIPT', 'STYLE', 'LINK'].includes(element.tagName))
      .map(element => [element, element.inert]);
    accountManager = { node, onKeydown, trigger, background, previousOverflow: document.body.style.overflow };
    background.forEach(([element]) => { element.inert = true; });
    document.body.style.overflow = 'hidden';
    document.body.appendChild(node);
    refreshLiquidGlass(node);
    document.addEventListener('keydown', onKeydown);
    node.querySelector('.acct-manager-close').onclick = closeAccountManager;
    node.onclick = event => { if (event.target === node) closeAccountManager(); };
    renderAccountManager();
    node.querySelector('.acct-manager-close').focus();
  }

  function renderLiveStatus() {
    renderAccts();
    $('live').classList.remove('on');
    $('liveT').textContent = '本机记录';
  }

  /* ----- 路由 ----- */
  function routeOf() {
    const h = (location.hash || '').replace(/^#\/?/, '');
    if (['warroom', 'decisions', 'replay'].includes(h)) history.replaceState(null, '', '#/overview');
    return ROUTES.includes(h) ? h : 'overview';
  }

  async function mount() {
    closeAccountManager();
    const name = routeOf();
    const my = ++mountSeq; // 序号守卫：await 期间再次切页，本次挂载作废
    document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('on', a.dataset.r === name));
    if (!V4.acct() && name !== 'onboarding') {
      if (current && typeof current.unmount === 'function') { try { current.unmount(); } catch (e) {} }
      current = null;
      if (V4.accountsReady && !V4.accountsError) { location.hash = '#/onboarding'; return; }
      const view = $('view');
      view.innerHTML = V4.emptyBox(V4.accountsError ? `账户列表读取失败：${V4.accountsError}` : '正在读取账户配置…');
      if (V4.accountsError) {
        const retry = document.createElement('button');
        retry.type = 'button'; retry.className = 'work-button'; retry.textContent = '重新读取账户';
        retry.onclick = async () => {
          retry.disabled = true; retry.textContent = '读取中…';
          await V4.retryAccounts();
          if (my !== mountSeq) return;
          renderAccts(); mount();
        };
        view.querySelector('.empty')?.appendChild(retry);
      }
      return;
    }
    if (current && current.name === name) return;
    if (current && typeof current.unmount === 'function') { try { current.unmount(); } catch (e) {} }
    current = null; // 立即占位，避免脚本加载期间重复 unmount
    const view = $('view');
    view.setAttribute('aria-busy', 'true');
    view.innerHTML = '<div class="page-loading" role="status"><span></span>正在打开页面…</div>';
    if (!loaded[name]) loaded[name] = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = '/v4/pages/' + name + '.js?v=' + encodeURIComponent(document.documentElement.dataset.build || '1');
      script.onload = () => {
        if (typeof V4.pages[name]?.mount === 'function') resolve();
        else { script.remove(); reject(new Error('页面模块未就绪')); }
      };
      script.onerror = () => { script.remove(); reject(new Error('页面加载失败')); };
      document.body.appendChild(script);
    }).catch(error => { delete loaded[name]; throw error; });
    await loaded[name].catch(error => { console.error('[v4] 页面脚本加载失败', name, error); });
    if (my !== mountSeq) return; // await 期间已切到别的页，丢弃不挂载
    view.removeAttribute('aria-busy');
    const pg = V4.pages[name];
    if (pg && typeof pg.mount === 'function') {
      try {
        current = { name, unmount: pg.mount(view) };
        scheduleLiquidGlass(view);
      } catch (renderError) {
        console.error('[v4] 页面渲染执行异常:', name, renderError);
        view.innerHTML = `<div class="wip"><div class="w-t">页面脚本执行异常</div><div class="w-s" style="color:var(--st-danger,#ef4444);font-family:var(--font-data,monospace);">${V4.esc(renderError.message || String(renderError))}</div><button id="retryPage" type="button">重试</button></div>`;
        view.querySelector('#retryPage').addEventListener('click', mount);
      }
    } else {
      view.innerHTML = '<div class="wip"><div class="w-t">页面未加载成功</div><div class="w-s">请检查连接后重试</div><button id="retryPage" type="button">重新加载</button> <a href="#/overview">回工作台</a></div>';
      view.querySelector('#retryPage').addEventListener('click', mount);
    }
  }

  /* ----- 启动 ----- */
  V4.pulse = V4.initPulse('pulse'); // 存 handle：作战室按盘面盈亏 setMode，整站背景随状态呼吸变色
  installLiquidGlass();
  renderAccts();
  renderFeatureNav();
  document.addEventListener('v4:features', renderFeatureNav);
  V4.onAccountsChange(renderAccts);
  V4.onRoomsChange(renderAccts);
  V4.onAcctChange(renderLiveStatus);
  addEventListener('hashchange', mount);
  document.querySelector('.skip-link')?.addEventListener('click', event => { event.preventDefault(); $('view').focus(); });
  $('clock').textContent = V4.nowStr();
  setInterval(() => { $('clock').textContent = V4.nowStr(); }, 1000);
  (async () => {
    await V4.loadAccounts();
    if (!V4.ACCTS.length && !V4.accountsError) location.hash = '#/onboarding';
    renderAccts();
    mount();
  })();

})(window.V4);
