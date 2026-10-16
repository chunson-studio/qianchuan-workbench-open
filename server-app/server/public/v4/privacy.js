/* Display privacy only. Request scopes, option values and response objects stay intact. */
(function () {
  'use strict';
  function createCatalog() {
    const accounts = new Map(), names = new Map(), ids = new Set();
    let revision = 0, accountCount = 0;
    const compiled = new Map();
    function remember(map, key, value) { if (map.get(key) !== value) { map.set(key, value); revision++; } }
    const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    function account(value) {
      const id = String(value.id || value.accountId || value.account_id || value.aavid || '');
      if (!id) return;
      if (!accounts.has(id)) accounts.set(id, accounts.get('account_' + id) || accounts.get(String(value.aavid || '')) || `账户 ${++accountCount}`);
      const alias = accounts.get(id);
      if (value.aavid) accounts.set(String(value.aavid), alias);
      remember(names, id, alias);
      for (const key of ['name', 'accountName', 'account_name']) {
        if (value[key]) remember(names, String(value[key]), alias);
      }
    }
    function capture(value, context = '', seen = new WeakSet()) {
      if (!value || typeof value !== 'object' || seen.has(value)) return;
      seen.add(value);
      if (Array.isArray(value)) { value.forEach(item => capture(item, context, seen)); return; }
      if (/^(accounts|archived_accounts|account|candidates)$/.test(context) || value.accountName || value.account_name) account(value);
      for (const [key, item] of Object.entries(value)) {
        if (/^(?:id|aavid|account|session_key|task_ref)$|(?:_id|Id|_ids|Ids)$/.test(key)) {
          for (const id of Array.isArray(item) ? item : [item]) {
            if ((typeof id === 'string' || typeof id === 'number') && String(id) && !ids.has(String(id))) { ids.add(String(id)); revision++; }
          }
        }
        capture(item, key, seen);
      }
    }
    function redact(value, identityContext = false) {
      let text = String(value == null ? '' : value);
      // One replacement pass prevents aliases from being matched as source names.
      let matcher = compiled.get(identityContext);
      if (!matcher || matcher.revision !== revision) {
        const replacements = new Map([...ids].filter(id => identityContext || !/^\d+$/.test(id)).map(id => [id, '••••']));
        for (const [name, alias] of names) replacements.set(name, alias);
        const keys = [...replacements.keys()].filter(Boolean).sort((a, b) => b.length - a.length);
        matcher = { revision, replacements, pattern: keys.length ? new RegExp(keys.map(escape).join('|'), 'g') : null };
        compiled.set(identityContext, matcher);
      }
      if (matcher.pattern) {
        text = text.replace(matcher.pattern, (match, offset, source) => {
          if (names.has(match) && !accounts.has(match)) return matcher.replacements.get(match);
          // A short room ID must not hide a metric containing those digits.
          const before = source[offset - 1] || '', after = source[offset + match.length] || '';
          return /[\w.,¥￥]/.test(before) || /[\w.,%]/.test(after) ? match : matcher.replacements.get(match);
        });
      }
      return text.replace(/((?:\b[a-z_]*id\b|\b[a-z_]*_key\b|房间|直播间|计划|素材|订单号|单号)\s*[:：=#]?\s*)([a-zA-Z0-9_-]*\d[a-zA-Z0-9_-]{2,})(?![\w.%])/gi, '$1••••');
    }
    return { capture, redact, accountLabel: id => accounts.get(String(id)) || '账户' };
  }
  if (typeof module === 'object' && module.exports) { module.exports = createCatalog; return; }

  const V4 = window.V4, catalog = createCatalog(), key = 'v4-privacy';
  const originals = new WeakMap(), attributes = new WeakMap(), inputTypes = new WeakMap(), links = new WeakMap();
  let enabled = false, refreshing = false;
  try { enabled = localStorage.getItem(key) === '1'; } catch (_) {}
  const options = { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['title', 'aria-label', 'placeholder', 'alt', 'label', 'href', 'data-private'] };
  const ignored = 'script,style,noscript,#clock,#upd,#privacyToggle';
  const observer = new MutationObserver(records => {
    if (enabled && records.some(record => !(record.target.parentElement || record.target).closest?.(ignored))) refresh();
  });
  function replaceText(node, transform) {
    const current = node.nodeValue, previous = originals.get(node);
    const raw = previous && current === previous.masked ? previous.raw : current;
    const masked = enabled ? transform(raw) : raw;
    originals.set(node, { raw, masked });
    if (current !== masked) node.nodeValue = masked;
  }
  function refresh() {
    if (refreshing || !document.body) return;
    refreshing = true;
    observer.disconnect();
    try {
      catalog.capture(V4.ACCTS || [], 'accounts');
      catalog.capture(V4.archivedAccounts || [], 'archived_accounts');
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement;
        if (!parent || parent.closest(ignored)) continue;
        const sensitive = parent.closest('[data-private]');
        replaceText(node, raw => {
          if (sensitive?.dataset.private === 'id') return raw.trim() ? '••••' : raw;
          if (sensitive?.dataset.private === 'avatar') return catalog.accountLabel(sensitive.dataset.privateAccount).replace('账户 ', '').padStart(2, '0');
          return catalog.redact(raw, sensitive?.dataset.private === 'mixed');
        });
      }
      for (const element of document.body.querySelectorAll('[title],[aria-label],[placeholder],[alt],option[label]')) {
        if (element.closest(ignored)) continue;
        let saved = attributes.get(element);
        if (!saved) { saved = new Map(); attributes.set(element, saved); }
        for (const attribute of ['title', 'aria-label', 'placeholder', 'alt', 'label']) {
          if (!element.hasAttribute(attribute)) continue;
          const current = element.getAttribute(attribute), previous = saved.get(attribute);
          const raw = previous && current === previous.masked ? previous.raw : current;
          const kind = element.closest('[data-private]')?.dataset.private;
          const masked = enabled ? (kind === 'id' && raw ? '••••' : catalog.redact(raw, kind === 'mixed')) : raw;
          saved.set(attribute, { raw, masked });
          if (current !== masked) element.setAttribute(attribute, masked);
        }
      }
      for (const input of document.querySelectorAll('input')) {
        const originalType = inputTypes.get(input) || input.type;
        if (!['text', 'search'].includes(originalType)) continue;
        const sensitive = input.hasAttribute('data-private') || catalog.redact(input.value, true) !== input.value;
        if (enabled && sensitive) {
          if (!inputTypes.has(input)) inputTypes.set(input, originalType);
          if (input.type !== 'password') input.type = 'password';
        } else if (inputTypes.has(input)) { input.type = originalType; inputTypes.delete(input); }
      }
      for (const link of document.querySelectorAll('a[data-private-link]')) {
        const current = link.getAttribute('href'), previous = links.get(link);
        const raw = previous && current === previous.masked ? previous.raw : current;
        // Hide identifying query strings from the hover status bar as well.
        const masked = enabled ? raw.split('?')[0] : raw;
        links.set(link, { raw, masked });
        if (current !== masked) link.setAttribute('href', masked);
      }
    } finally { refreshing = false; observer.observe(document.documentElement, options); }
  }
  function setEnabled(value, persist = true) {
    enabled = !!value;
    if (persist) { try { localStorage.setItem(key, enabled ? '1' : '0'); } catch (_) {} }
    document.documentElement.dataset.privacy = enabled ? 'on' : 'off';
    const button = document.getElementById('privacyToggle');
    button.setAttribute('aria-pressed', String(enabled));
    button.querySelector('span').textContent = enabled ? '隐私已开启' : '隐私模式';
    button.title = enabled ? '关闭隐私模式，显示账户名称和 ID' : '隐藏账户名称和各类 ID，保留经营数据';
    refresh();
  }
  V4.privacy = {
    capture: value => catalog.capture(value),
    get enabled() { return enabled; },
    text: value => enabled ? catalog.redact(value, true) : String(value),
    accountLabel: id => enabled ? catalog.accountLabel(id) : V4.acctName(id),
    refresh, setEnabled,
  };
  document.getElementById('privacyToggle').addEventListener('click', () => setEnabled(!enabled));
  document.addEventListener('input', event => { if (enabled && event.target.matches('input')) refresh(); });
  function openPrivateLink(event) {
    const link = event.target.closest?.('a[data-private-link]');
    if (!enabled || !link || !links.has(link) || event.button > 1) return;
    event.preventDefault();
    window.open(links.get(link).raw, '_blank', 'noopener');
  }
  document.addEventListener('click', openPrivateLink);
  document.addEventListener('auxclick', openPrivateLink);
  window.addEventListener('storage', event => { if (event.key === key) setEnabled(event.newValue === '1', false); });
  V4.onAccountsChange(refresh);
  setEnabled(enabled, false);
})();
