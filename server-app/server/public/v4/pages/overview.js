/* Account overview consumes only the browser controller's saved local summaries. */
(function (V4) {
  'use strict';
  const esc = V4.esc;
  const amount = value => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('zh-CN', { maximumFractionDigits: 2, minimumFractionDigits: 2 }) : '未知';
  const count = value => Number.isSafeInteger(value) && value >= 0 ? String(value) : '未知';
  const when = value => value ? V4.fmtCnTime(value).full : '未记录';
  const status = { live: '上次记录在播', ended: '已结束', unknown: '直播状态待确认' };
  const stamp = value => V4.parseT(value)?.getTime() || 0;
  function metrics(s) {
    const m = s.metrics;
    const rows = [[m.cost_label, amount(m.cost) + (m.cost == null ? '' : ' 元')],
      ['卖出金额', amount(m.gmv) + (m.gmv == null ? '' : ' 元')], [m.roi_label, amount(m.roi)],
      ...(V4.websiteFeatures.compass ? [['在线人数', count(m.online)]] : []), ['当前追投', count(m.active_tasks)]];
    return `<div class="snapshot-metrics" style="--snapshot-metric-columns:${rows.length}">` + rows.map(([k, v]) => `<div><span>${esc(k)}</span><strong class="num">${esc(v)}</strong></div>`).join('') + '</div>';
  }
  V4.pages.overview = { mount(view) {
    let disposed = false, data = null, failure = '', flight = false, query = '', expanded = null;
    view.innerHTML = `<section class="command-header"><div><h1>多账号总览</h1><p>一行一个账号，点开查看经营数据。</p></div></section>
      <section class="snapshot-toolbar"><label class="snapshot-search"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg><input id="snapshotSearch" type="search" placeholder="搜索账号或直播间" aria-label="搜索账号或直播间" autocomplete="off"></label><span id="snapshotCount" class="snapshot-note" role="status"></span><button class="work-button" id="snapshotRefresh" type="button">刷新本机记录</button></section>
      <div class="snapshot-caption"><p class="snapshot-note">数据来自最近一次读盘，按场次展示。</p><span id="snapshotReadAt" class="snapshot-note"></span></div>
      <div id="snapshotMessage" role="status" aria-live="polite"></div><div id="snapshotAccounts" class="snapshot-accounts"></div>`;
    const el = id => view.querySelector('#' + id);
    function fresh(s) {
      if (!s) return { label: '暂无数据', current: false };
      const times = [s.captured_at, s.financial_at, ...(V4.websiteFeatures.compass ? [s.online_at] : [])].map(stamp);
      const unknown = times.some(t => !t || t > Date.now() + 5000) || s.issues.includes('local_source_conflict');
      const expired = times.some(t => (Date.now() - t) / 1000 > data.max_age_seconds);
      const value = failure ? 'stale' : unknown ? 'unknown' : expired ? 'stale' : 'current';
      return { label: value === 'current' ? '最近已更新' : value === 'stale' ? '历史数据' : '数据待确认', current: value === 'current' };
    }
    function applyExpansion() {
      for (const card of view.querySelectorAll('.snapshot-account')) {
        const open = card.dataset.accountId === expanded, button = card.querySelector('.snapshot-toggle'), panel = card.querySelector('.snapshot-panel');
        card.classList.toggle('is-open', open); button.setAttribute('aria-expanded', String(open));
        panel.inert = !open; panel.setAttribute('aria-hidden', String(!open));
      }
    }
    function render() {
      if (disposed || !data) return;
      const active = document.activeElement;
      const focusAccount = el('snapshotAccounts').contains(active) ? active.closest('[data-account-id]')?.dataset.accountId : null;
      const focusConfig = active?.hasAttribute('data-config');
      const accounts = data.accounts.filter(a => [a.name, a.id, ...data.sessions.filter(s => s.account_id === a.id).map(s => s.name)].join(' ').toLocaleLowerCase().includes(query));
      if (!accounts.some(a => a.id === expanded)) expanded = null;
      el('snapshotCount').textContent = query ? `${accounts.length} / ${data.accounts.length} 个账号` : `${accounts.length} 个账号`;
      const message = el('snapshotMessage');
      message.textContent = failure || (data.issues.length ? '部分本机记录无法读取，以下只展示已读取的资料。' : '');
      message.className = message.textContent ? 'snapshot-warning' : '';
      el('snapshotAccounts').innerHTML = accounts.map((a, index) => {
        const sessions = data.sessions.filter(s => s.account_id === a.id).sort((a, b) => stamp(b.binding.session_started_at) - stamp(a.binding.session_started_at) || stamp(b.captured_at) - stamp(a.captured_at)), plans = new Map();
        for (const s of sessions) if (!plans.has(s.binding.primary_ad_id)) plans.set(s.binding.primary_ad_id, s);
        const latest = sessions[0], f = fresh(latest), name = a.name || a.id;
        const summary = latest ? `${plans.size > 1 ? plans.size + ' 个主计划 · ' : ''}最近场次 · ${latest.name}` : '连接后由 Codex 读盘';
        return `<section class="snapshot-account" data-account-id="${esc(a.id)}">
          <h2 class="snapshot-account-title"><button class="snapshot-toggle" id="snapshot-toggle-${index}" type="button" aria-expanded="false" aria-controls="snapshot-panel-${index}">
            <span class="snapshot-avatar" data-private="mixed" aria-hidden="true">${esc(Array.from(name)[0])}</span>
            <span class="snapshot-identity"><strong data-private="mixed">${esc(name)}</strong><span data-private="mixed">${esc(summary)}</span></span>
            <span class="snapshot-mini"><span>${esc(latest?.metrics.cost_label || '消耗')}</span><strong class="num">${latest ? esc(amount(latest.metrics.cost)) : '—'}</strong></span>
            <span class="snapshot-mini"><span>${esc(latest?.metrics.roi_label || 'ROI')}</span><strong class="num">${latest ? esc(amount(latest.metrics.roi)) : '—'}</strong></span>
            <span class="snapshot-badge${f.current ? ' is-current' : ''}">${f.label}</span><svg class="snapshot-chevron" viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5"><path d="m6 8 4 4 4-4"/></svg>
          </button></h2>
          <div class="snapshot-panel" id="snapshot-panel-${index}" role="region" aria-labelledby="snapshot-toggle-${index}" aria-hidden="true" inert><div class="snapshot-panel-clip"><div class="snapshot-panel-body">
            ${plans.size ? [...plans.values()].map(s => `<article class="snapshot-card"><div class="snapshot-card-heading"><div><h3 data-private="mixed">${esc(s.name)}</h3><p>开播 ${esc(when(s.binding.session_started_at))} · ${esc(status[s.live_state] || status.unknown)}</p></div><span class="snapshot-badge${fresh(s).current ? ' is-current' : ''}">${fresh(s).label}</span></div>
              ${metrics(s)}<div class="snapshot-scene-meta"><span data-private="mixed">主计划 ${esc(s.binding.primary_ad_id)}</span><span>读盘于 ${esc(when(s.captured_at))}</span></div>
              ${s.pending_count > 0 ? `<p class="snapshot-attention">有 ${count(s.pending_count)} 项操作尚未确认</p>` : ''}
              ${s.issues.includes('local_source_conflict') ? '<p class="snapshot-warning">该场次记录有冲突，数据待确认。</p>' : ''}</article>`).join('') : '<div class="snapshot-empty"><strong>尚无读盘数据</strong><p>由 Codex 完成本场读盘后，这里会显示经营数据。</p></div>'}
            <footer class="snapshot-account-footer"><span>仅展示各主计划最近场次</span><button class="work-button" type="button" data-config="${esc(a.id)}">管理账户</button></footer>
          </div></div></div></section>`;
      }).join('') || `<div class="snapshot-empty">${query ? '没有找到匹配的账号或直播间。' : '暂无账户。'}</div>`;
      applyExpansion();
      view.querySelectorAll('.snapshot-toggle').forEach(button => { button.onclick = () => {
        const id = button.closest('[data-account-id]').dataset.accountId;
        expanded = expanded === id ? null : id; applyExpansion();
      }; });
      view.querySelectorAll('[data-config]').forEach(button => { button.onclick = () => { V4.setAcct(button.dataset.config); location.hash = '#/onboarding'; }; });
      if (focusAccount) [...view.querySelectorAll('[data-account-id]')].find(c => c.dataset.accountId === focusAccount)?.querySelector(focusConfig ? '[data-config]' : '.snapshot-toggle')?.focus({ preventScroll: true });
    }
    async function refresh() {
      if (flight || disposed) return;
      flight = true; el('snapshotRefresh').disabled = true;
      try {
        const next = await V4.api('/api/workbench-snapshot', null, { skipAccountParam: true, timeout: 15000, retryNetwork: false });
        if (disposed) return;
        if (!next?.ok || next.schema_version !== 1 || !Array.isArray(next.accounts) || !Array.isArray(next.sessions)) throw Error('本机摘要格式不完整');
        data = next; failure = '';
        el('snapshotReadAt').textContent = '本机读取 ' + V4.nowStr();
        const badge = document.getElementById('liveT'); if (badge) badge.textContent = '本机摘要';
        document.getElementById('live')?.classList.remove('on');
      } catch (error) {
        if (!disposed) { failure = '本机摘要读取失败，请重试；已展示内容不代表当前状态。'; el('snapshotMessage').textContent = failure; el('snapshotMessage').className = 'snapshot-warning'; }
      } finally { if (!disposed) { render(); el('snapshotRefresh').disabled = false; } flight = false; }
    }
    el('snapshotSearch').oninput = event => { query = event.target.value.trim().toLocaleLowerCase(); render(); };
    el('snapshotAccounts').onkeydown = event => {
      if (event.key === 'Escape' && expanded !== null) {
        const button = view.querySelector('.snapshot-account.is-open .snapshot-toggle');
        expanded = null; applyExpansion(); button?.focus(); event.preventDefault();
      }
    };
    el('snapshotRefresh').onclick = refresh;
    const stop = V4.poll(refresh, 30000), age = V4.poll(render, 15000);
    return () => { disposed = true; stop(); age(); };
  } };
})(window.V4);
