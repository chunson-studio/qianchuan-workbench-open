/* Command theme: presentation only. Account, data and action contracts stay in their owning pages. */
(function (V4) {
  'use strict';
  const poem = {
    title: '早发白帝城', author: '唐 · 李白',
    lines: ['朝辞白帝彩云间，', '千里江陵一日还。', '两岸猿声啼不住，', '轻舟已过万重山。']
  };
  const poemLines = () => '<p class="poem-lines">' + poem.lines.map(line => '<span>' + line + '</span>').join('') + '</p>';
  const pages = {
    overview: ['', '多账号总览', '集中查看 Codex 最近保存的经营数据与操作记录。'],
    warroom: ['', '当前直播间', '本场表现与房间目标'],
    decisions: ['DECISION INTELLIGENCE', '决策记录', ''],
    replay: ['SESSION ANALYTICS', '场次复盘', '沿着数据，回看每一次关键变化。'],
    onboarding: ['WORKSPACE SETTINGS', '账号管理', '账户资料与浏览器接续']
  };
  const paths = {
    overview: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    warroom: '<path d="M3 12h4l3-7 4 14 3-7h4"/>',
    decisions: '<path d="M8 4h12M8 12h12M8 20h12"/><circle cx="3" cy="4" r="1"/><circle cx="3" cy="12" r="1"/><circle cx="3" cy="20" r="1"/>',
    replay: '<path d="M3 10a9 9 0 1 1 1 7M3 4v6h6M12 7v5l3 2"/>',
    onboarding: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="16" cy="17" r="3"/>'
  };
  const route = () => (location.hash || '#/overview').replace(/^#\/?/, '').split('?')[0];
  const icon = name => '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + (paths[name] || paths.overview) + '</svg>';

  function sidebar() {
    let side = document.querySelector('.workbench-sidebar');
    if (!side) {
      side = document.createElement('aside');
      side.className = 'workbench-sidebar';
      side.innerHTML = '<a class="workbench-brand" href="#/overview" aria-label="千川工作台 · 直播间总览"><span class="brand-name">千川</span><span class="brand-kind">工作台</span></a><div class="nav-caption">工作空间</div><nav aria-label="工作台导航"></nav><div class="sidebar-art" data-art-scene="river" aria-hidden="true"></div><figure class="sidebar-bottom sidebar-poem"><figcaption><span class="poem-title">' + poem.title + '</span><span class="poem-author">' + poem.author + '</span></figcaption>' + poemLines() + '</figure>';
      document.body.appendChild(side);
    }
    const source = document.querySelector('header.top #nav');
    const target = side.querySelector('nav');
    const signature = source ? [...source.querySelectorAll('a')].map(a => a.href + a.textContent).join('|') : '';
    if (signature && signature !== target.dataset.signature) {
      target.replaceChildren();
      for (const link of source.querySelectorAll('a')) {
        const copy = link.cloneNode(true);
        copy.removeAttribute('id');
        const label = document.createElement('span');
        label.textContent = copy.textContent;
        copy.replaceChildren(label);
        copy.insertAdjacentHTML('afterbegin', icon(copy.dataset.r));
        target.appendChild(copy);
      }
      target.dataset.signature = signature;
    }
    for (const link of target.querySelectorAll('a')) {
      const active = link.dataset.r === route();
      link.classList.toggle('on', active);
      if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
    }
  }

  function heading() {
    const view = document.getElementById('view');
    const name = route();
    document.body.dataset.page = name;
    const config = pages[name];
    if (!view || !view.firstElementChild || !config) return;
    view.dataset.page = name;
    let hero = view.querySelector('.command-header');
    if (hero) return;
    if (name === 'overview') {
      hero = view.querySelector('.pg-ov-intro');
      if (!hero) return;
      hero.querySelector('h1').textContent = config[1];
      hero.querySelector('p').textContent = config[2];
    } else if (name === 'decisions') {
      hero = view.querySelector('.dc-head');
      if (!hero) return;
    } else if (name === 'onboarding') {
      hero = view.querySelector('.onboard-intro');
      if (!hero) return;
    } else {
      hero = document.createElement('section');
      const copy = document.createElement('div');
      const h1 = document.createElement('h1'); h1.textContent = config[1];
      const p = document.createElement('p'); p.textContent = config[2];
      copy.append(h1, p); hero.append(copy);
      view.prepend(hero);
    }
    hero.classList.add('command-header');
    hero.setAttribute('aria-label', config[1]);
  }

  function theme() {
    const paper = document.documentElement.getAttribute('data-theme') === 'paper';
    const button = document.getElementById('themeToggle');
    if (button) {
      const label = paper ? '深色模式' : '浅色模式';
      if (button.textContent !== label) button.textContent = label;
      button.title = '切换到' + label;
    }
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', paper ? '#f6f2e9' : '#112820');
  }

  function roomLayout() {
    const view = document.getElementById('view');
    if (route() !== 'warroom') return;
    const primary = view?.querySelector('.band-row.r1');
    const online = view?.querySelector('#vOn')?.closest('.bcell');
    // Present the existing online count in the first row; its page still owns data and polling.
    if (primary && online && online.parentElement !== primary) primary.appendChild(online);
  }

  function demoNotice() {
    if (!window.QC_DEMO || document.querySelector('.sample-notice')) return;
    const bar = document.createElement('section');
    bar.className = 'sample-notice'; bar.setAttribute('aria-label', '示例工作区');
    bar.innerHTML = '<span><strong>示例工作区</strong>虚构数据 · 不连接真实账户</span><a href="/v4#/onboarding">连接我的账户 →</a>';
    document.querySelector('header.top').after(bar);
  }
  function art() {
    const hero = document.querySelector('#view .command-header');
    if (!hero || hero.querySelector('.hero-art')) return;
    // Keep the complete poem available when the fixed sidebar is hidden or too short.
    const sheet = document.createElement('details');
    sheet.className = 'mobile-poem';
    const title = document.createElement('summary');
    title.textContent = poem.title + ' · ' + poem.author;
    sheet.append(title); sheet.insertAdjacentHTML('beforeend', poemLines());
    (hero.querySelector('h1')?.parentElement || hero).append(sheet);
    const scene = document.createElement('div');
    scene.className = 'hero-art'; scene.dataset.artScene = 'silk'; scene.setAttribute('aria-hidden', 'true');
    const verse = document.createElement('span'); verse.className = 'art-poem'; verse.textContent = poem.lines[3].replace('。', '');
    scene.append(verse); hero.append(scene);
  }
  function enhance() { sidebar(); heading(); roomLayout(); theme(); demoNotice(); art(); }
  V4.onViewUpdate(enhance);
  addEventListener('hashchange', V4.refreshViewEffects);
  document.addEventListener('v4:features', V4.refreshViewEffects);
})(window.V4);
