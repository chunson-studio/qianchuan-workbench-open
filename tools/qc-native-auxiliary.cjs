'use strict';

const { getChromePageTarget } = require('./attach-qc-chrome.playwright.cjs');

const fail = code => { throw Object.assign(new Error(code), { code }); };
const keys = (value, names) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => names.includes(key));
const nonempty = value => typeof value === 'string' && value.trim() && value.length <= 500;
const compact = value => value.replace(/\s+/g, '');

function classifyUrl(value) {
  let url;
  try { url = new URL(value); } catch { fail('auxiliary_url_invalid'); }
  if (url.username || url.password || url.protocol !== 'https:') fail('auxiliary_url_invalid');
  let kind;
  if (url.origin === 'https://compass.jinritemai.com') {
    if (url.pathname === '/screen/live/shop') kind = 'compass_screen';
    else if (url.pathname === '/shop/live-detail') kind = 'compass_detail';
    // Observed: work/browser-actions/runs/compass-entry-20261001/live-navigation.json.
    else if (/^\/shop\/live-overview\/?$/.test(url.pathname)) kind = 'compass_overview';
    else if (/^\/shop\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]*$/.test(url.pathname)) kind = 'compass_overview_candidate';
  } else if (url.origin === 'https://qianchuan.jinritemai.com' && url.pathname === '/board-next') kind = 'qianchuan_screen';
  if (!kind) fail('auxiliary_url_not_allowed');
  return { url, kind };
}

function validateBinding(binding) {
  if (!binding || !nonempty(binding.browser_context_id) || !/^\d+$/.test(binding.advertiser_id || '')) fail('auxiliary_binding_required');
}

function verifyUrl(value, binding, expectedUrl, roomId) {
  const { url, kind } = classifyUrl(value);
  if (expectedUrl !== undefined && url.href !== classifyUrl(expectedUrl).url.href) fail('auxiliary_url_mismatch');
  if (kind === 'qianchuan_screen') {
    const aliases = ['aavid', 'advertiser_id', 'advertiserId'].flatMap(name => url.searchParams.getAll(name));
    if (!aliases.length || aliases.some(id => id !== binding.advertiser_id)) fail('auxiliary_advertiser_mismatch');
  }
  if (roomId !== undefined) {
    const ids = url.searchParams.getAll('live_room_id');
    if (ids.length !== 1 || ids[0] !== roomId) fail('auxiliary_room_mismatch');
  }
  return { url: url.href, kind };
}

// Read rendered DOM only. No arbitrary evaluator, network request, cookie or
// application state access. Only bounded necessary regions are returned.
function readVisibleAuxiliaryDom({ kind, expected_name } = {}) {
  const visible = node => node && node.getClientRects().length > 0;
  const full = document.body.innerText || '';
  const headerEnd = full.search(/综合趋势|整体趋势|商品列表|实时评论|实时公屏|全场累计用户画像/);
  const lines = full.slice(0, headerEnd < 0 ? 5000 : Math.min(headerEnd, 5000)).split(/\n/);
  const bounded = (startLabel, endLabels, maximum) => {
    const start = full.indexOf(startLabel);
    const ends = endLabels.map(label => full.indexOf(label, start + startLabel.length)).filter(index => index >= 0);
    if (start < 0 || !ends.length) return { raw: null, complete: false, missing: start < 0 ? 'start_marker' : 'end_marker' };
    const raw = full.slice(start, Math.min(...ends));
    return { raw: raw.slice(0, maximum), complete: raw.length <= maximum, truncated: raw.length > maximum };
  };
  const nameLines = lines.flatMap((line, index) => /开播时间|直播中|已结束|已下播|专业版|网络正常/.test(line) ||
    (expected_name && line.replace(/\s/g, '').includes(expected_name.replace(/\s/g, ''))) ? [index] : []);
  const headerIndices = [...new Set(nameLines.flatMap(index => /开播时间/.test(lines[index]) ? [index, index + 1] : [index]))].filter(index => index < lines.length);
  const headerRaw = headerIndices.map(index => lines[index]).join('\n');
  const header = { raw: headerRaw.slice(0, 3000), complete: headerRaw.length <= 3000, truncated: headerRaw.length > 3000 };
  const financial = kind === 'compass_screen' ? bounded('直播大屏', ['综合趋势'], 12000) :
    kind === 'qianchuan_screen' ? bounded('直播大屏', ['整体趋势'], 12000) :
      { raw: null, complete: false, missing: 'region_not_verified_for_page_kind' };
  const fiveMinutes = bounded('近5分钟数据', ['实时评论', '实时公屏', '商品列表', '全场累计用户画像', '实时成交'], 4000);
  const rows = [...document.querySelectorAll('tr,[role="row"]')].filter(visible);
  const matches = kind === 'compass_overview' ? rows.filter(node => expected_name && (node.innerText || '').includes(expected_name)) : [];
  const overviewRows = matches.slice(0, 30).map(node => (node.innerText || '').slice(0, 4000));
  const overview = kind === 'compass_overview' ? { raw: overviewRows.join('\n\n'), rows: overviewRows,
    matching_visible_rows: matches.length, visible_table_rows: rows.length, complete: rows.length > 0 && matches.length <= 30 && matches.every(node => node.innerText.length <= 4000),
    scope: 'matching_rows_on_current_page_only', missing: rows.length ? null : 'table_rows' } : null;
  const links = [...document.querySelectorAll('a[href]')].filter(visible).slice(0, 200)
    .map(node => ({ text: (node.innerText || node.getAttribute('aria-label') || '').trim().slice(0, 200), href: node.href }));
  const rawCards = ['直播间成交金额', '退款金额', '投放消耗(店铺绑定)', '实时在线人数', '综合营销ROI', '全域净成交数据', '乘方数据'].map(label => {
    const matches = [...document.querySelectorAll('span')].filter(node => visible(node) && node.innerText.trim() === label);
    if (matches.length !== 1) return { label, matches: matches.length, raw: null };
    let node = matches[0];
    const levels = label === '直播间成交金额' ? 4 : 2;
    for (let i = 0; i < levels; i++) node = node?.parentElement;
    if (!node || ['BODY', 'HTML'].includes(node.tagName)) return { label, matches: 1, raw: null, missing: 'card_boundary' };
    if (/商品列表|实时评论|实时公屏|全场累计用户画像/.test(node.innerText || '')) return { label, matches: 1, raw: null, missing: 'card_boundary' };
    const digits = [...(node?.querySelectorAll('.odometer-digit') || [])];
    const stable = digits.length > 0 && digits.every(digit => digit.querySelectorAll('.odometer-value').length === 1);
    const displayed = stable ? [...(node?.querySelector('.odometer-inside')?.children || [])].map(child => child.classList.contains('odometer-digit') ? child.querySelector('.odometer-value').innerText : child.innerText).join('') : null;
    return { label, matches: 1, raw: (node.innerText || '').slice(0, 2000), truncated: node.innerText.length > 2000,
      odometer_stable: digits.length ? stable : null, odometer_displayed: displayed };
  });
  const regions = { header, financial, five_minutes: fiveMinutes, ...(overview ? { overview } : {}) };
  const text = [header.raw, financial.raw, fiveMinutes.raw, overview?.raw].filter(Boolean).join('\n\n');
  return { title: document.title, text, text_scope: 'necessary_regions_only', text_truncated: Object.values(regions).some(region => region.truncated === true),
    regions, missing_regions: Object.entries(regions).filter(([key, region]) => key !== 'header' && !region.complete).map(([key]) => key),
    comments_excluded: true, products_excluded: true, links, raw_cards: rawCards,
    warnings: full.split(/\n+/).map(text => text.trim()).filter(text => /登录已过期|请先登录|扫码登录|不是当前登录店铺|无法进入复盘模式|账号类型不支持|身份不符|暂无权限|无权限|无权访问/.test(text)).slice(0, 20) };
}

/** Fixed read/navigation operations for the already authorized Browser.
 * Neither profile matching nor visible room text proves Compass shop identity.
 * A snapshot returns raw DOM and warnings, never a business ROI or a live-state
 * assertion. Open accepts URLs observed in this host/profile only; it opens a
 * new tab once through the bound plan page, preserving existing pages/forms.
 */
function createQianchuanNativeAuxiliaryOperations({ browser, observedUrls = [] } = {}) {
  if (!browser || typeof browser.contexts !== 'function' || typeof browser.isConnected !== 'function') fail('auxiliary_browser_required');
  if (!Array.isArray(observedUrls)) fail('auxiliary_observations_invalid');
  const observed = new Map();
  const remember = (profile, value) => {
    const url = classifyUrl(value).url.href;
    if (!observed.has(profile)) observed.set(profile, new Set());
    observed.get(profile).add(url);
  };
  for (const item of observedUrls) {
    if (!keys(item, ['browser_context_id', 'url']) || !nonempty(item.browser_context_id)) fail('auxiliary_observations_invalid');
    remember(item.browser_context_id, item.url);
  }
  const pages = () => {
    if (!browser.isConnected()) fail('auxiliary_browser_disconnected');
    return browser.contexts().flatMap(context => context.pages()).filter(page => !page.isClosed());
  };
  const check = async (page, binding, spec = {}) => {
    validateBinding(binding);
    const target = await getChromePageTarget(page);
    if (target.browserContextId !== binding.browser_context_id || (spec.target_id && target.targetId !== spec.target_id)) fail('auxiliary_profile_mismatch');
    const parsed = verifyUrl(page.url(), binding, spec.expected_url, spec.room_id);
    verifyUrl(target.url, binding, parsed.url, spec.room_id);
    return { target, ...parsed };
  };
  const locate = async (binding, input) => {
    const found = [];
    for (const page of pages()) {
      try { classifyUrl(page.url()); } catch { continue; }
      const target = await getChromePageTarget(page);
      if (target.targetId === input.target_id) found.push(page);
    }
    if (found.length !== 1) fail('auxiliary_target_not_unique');
    await check(found[0], binding, input);
    return found[0];
  };
  return {
    auxiliary_list: { kind: 'read', run: async ({ binding, input }) => {
      if (!keys(input, [])) fail('auxiliary_list_options_invalid');
      validateBinding(binding);
      const results = await Promise.allSettled(pages().map(async page => {
        try { classifyUrl(page.url()); } catch { return null; }
        const target = await getChromePageTarget(page);
        if (target.browserContextId !== binding.browser_context_id) return null;
        const before = await check(page, binding, { target_id: target.targetId });
        const title = await page.title();
        await check(page, binding, { target_id: target.targetId, expected_url: before.url });
        remember(binding.browser_context_id, before.url);
        return { target_id: target.targetId, browser_context_id: target.browserContextId, url: before.url, title, kind: before.kind,
          profile_verified: true, shop_identity_verified: false, scene_verified: false };
      }));
      const failures = results.filter(item => item.status === 'rejected').length;
      return { ok: true, pages: results.filter(item => item.status === 'fulfilled' && item.value).map(item => item.value),
        discovery_complete: failures === 0, unreadable_candidates: failures, advertising_writes: 0 };
    } },
    auxiliary_snapshot: { kind: 'read', run: async ({ binding, input }) => {
      if (!keys(input, ['target_id', 'expected_url', 'room_id', 'expected_name', 'expected_start_time']) ||
          !nonempty(input.target_id) || !nonempty(input.expected_url) ||
          (!nonempty(input.expected_name) && input.room_id === undefined) ||
          (input.room_id !== undefined && (typeof input.room_id !== 'string' || !/^\d+$/.test(input.room_id))) ||
          (input.expected_name !== undefined && !nonempty(input.expected_name)) ||
          (input.expected_start_time !== undefined && !nonempty(input.expected_start_time))) fail('auxiliary_snapshot_options_invalid');
      const page = await locate(binding, input);
      const before = await check(page, binding, input);
      const dom = await page.evaluate(readVisibleAuxiliaryDom, { kind: before.kind, expected_name: input.expected_name });
      await check(page, binding, input);
      if (input.expected_name && !compact(dom.text).includes(compact(input.expected_name))) fail('auxiliary_visible_name_mismatch');
      if (input.expected_start_time && !compact(dom.text).includes(compact(input.expected_start_time))) fail('auxiliary_start_time_mismatch');
      remember(binding.browser_context_id, before.url);
      const links = dom.links.filter(link => { try {
        const parsed = verifyUrl(link.href, binding);
        return parsed.kind !== 'compass_overview_candidate' && ['', '#', '#data'].includes(new URL(parsed.url).hash);
      } catch { return false; } });
      for (const link of links) remember(binding.browser_context_id, link.href);
      return { ok: true, target_id: input.target_id, browser_context_id: binding.browser_context_id, url: before.url,
        kind: before.kind, profile_verified: true, room_url_verified: input.room_id !== undefined,
        visible_name_verified: !!input.expected_name, start_time_text_verified: !!input.expected_start_time,
        shop_identity_verified: false, login_warning: dom.warnings.some(text => /登录已过期|请先登录|扫码登录/.test(text)),
        identity_warning: dom.warnings.some(text => /不是当前登录店铺|身份不符|账号类型不支持|无权|权限/.test(text)),
        source: 'visible_dom', captured_at: new Date().toISOString(), ...dom, links, advertising_writes: 0 };
    } },
    auxiliary_ui: { kind: 'write', run: async ({ binding, input }) => {
      if (!keys(input, ['target_id', 'expected_url', 'expected_name', 'expected_start_time', 'label', 'timeoutMs']) ||
          !nonempty(input.target_id) || !nonempty(input.expected_url) || !nonempty(input.expected_name) || !nonempty(input.expected_start_time) ||
          !['大屏', '详情'].includes(input.label) || !Number.isSafeInteger(input.timeoutMs ?? 10000) ||
          (input.timeoutMs ?? 10000) < 1 || (input.timeoutMs ?? 10000) > 30000) fail('auxiliary_ui_options_invalid');
      const page = await locate(binding, input);
      const source = await check(page, binding, input);
      if (source.kind !== 'compass_overview') fail('auxiliary_overview_required');
      // Observed row/text locator: exact-compass-live-entry.cua.mjs and
      // work/browser-actions/runs/demo_beta-20261008-0941/罗盘概览原文.txt.
      const row = page.getByRole('row').filter({ hasText: input.expected_name }).filter({ hasText: input.expected_start_time }).filter({ visible: true });
      if (await row.count() !== 1 || await row.getByText(input.expected_name, { exact: true }).filter({ visible: true }).count() !== 1) fail('auxiliary_scene_row_not_unique');
      const target = row.getByText(input.label, { exact: true }).filter({ visible: true });
      if (await target.count() !== 1) fail('auxiliary_scene_button_not_unique');
      const rowText = await row.innerText();
      if (!compact(rowText).includes(compact(input.expected_start_time))) fail('auxiliary_start_time_mismatch');
      const timeout = input.timeoutMs ?? 10000;
      const expectedKind = input.label === '大屏' ? 'compass_screen' : 'compass_detail';
      let rowHandle, targetHandle;
      let destination;
      try {
        rowHandle = await row.elementHandle();
        targetHandle = await target.elementHandle();
        if (!rowHandle || !targetHandle || !await targetHandle.evaluate((element, container) =>
          container.isConnected && element.isConnected && container.contains(element), rowHandle)) fail('auxiliary_scene_target_changed');
        const href = await targetHandle.evaluate(element => element.closest('a[href]')?.getAttribute('href') || '');
        if (href && !/^(?:#|javascript:void\(0\);?)$/i.test(href)) {
          if (classifyUrl(new URL(href, source.url).href).kind !== expectedKind) fail('auxiliary_scene_href_mismatch');
        }
        await check(page, binding, input);
        const popup = page.waitForEvent('popup', { timeout });
        const samePage = page.waitForURL(url => url.href !== source.url, { timeout, waitUntil: 'domcontentloaded' }).then(() => page);
        const navigation = Promise.any([popup, samePage]).then(result => ({ page: result }), error => ({ error }));
        await targetHandle.click({ timeout });
        const outcome = await navigation;
        if (outcome.error) fail('auxiliary_navigation_unconfirmed');
        destination = outcome.page;
      } finally {
        await targetHandle?.dispose().catch(() => {});
        await rowHandle?.dispose().catch(() => {});
      }
      await destination.waitForURL(url => { try { return classifyUrl(url.href).kind === expectedKind; } catch { return false; } },
        { timeout, waitUntil: 'domcontentloaded' });
      const actual = await check(destination, binding);
      const ids = new URL(actual.url).searchParams.getAll('live_room_id');
      if (ids.length !== 1 || !/^\d+$/.test(ids[0])) fail('auxiliary_destination_room_missing');
      remember(binding.browser_context_id, actual.url);
      return { ok: true, action: 'scene_navigation', label: input.label, source_row: rowText.slice(0, 4000),
        target_id: actual.target.targetId, url: actual.url, room_id: ids[0], browser_context_id: binding.browser_context_id,
        profile_verified: true, scene_verified: false, shop_identity_verified: false, requires_snapshot: true,
        retry_write: false, advertising_writes: 0 };
    } },
    auxiliary_open: { kind: 'write', run: async ({ page, binding, input }) => {
      if (!keys(input, ['url', 'timeoutMs']) || !nonempty(input.url) || !Number.isSafeInteger(input.timeoutMs ?? 15000) ||
          (input.timeoutMs ?? 15000) < 1 || (input.timeoutMs ?? 15000) > 30000) fail('auxiliary_open_options_invalid');
      validateBinding(binding);
      const parsed = verifyUrl(input.url, binding);
      // Other /shop routes can be listed/read when already open, but an
      // unverified settings/account route must never become a navigation API.
      if (parsed.kind === 'compass_overview_candidate') fail('auxiliary_navigation_route_unverified');
      const destination = parsed.url;
      if (!observed.get(binding.browser_context_id)?.has(destination)) fail('auxiliary_url_not_observed');
      const opener = await getChromePageTarget(page);
      if (opener.browserContextId !== binding.browser_context_id || opener.targetId !== binding.target_id) fail('auxiliary_opener_mismatch');
      const pending = page.waitForEvent('popup', { timeout: input.timeoutMs ?? 15000 }).then(result => ({ page: result }), error => ({ error }));
      const opened = await page.evaluate(url => !!window.open(url, '_blank'), destination);
      if (!opened) fail('auxiliary_popup_unconfirmed');
      const popup = await pending;
      if (popup.error) fail('auxiliary_popup_unconfirmed');
      await popup.page.waitForURL(destination, { waitUntil: 'domcontentloaded', timeout: input.timeoutMs ?? 15000 });
      const actual = await check(popup.page, binding, { expected_url: destination });
      return { ok: true, opened: true, target_id: actual.target.targetId, url: actual.url,
        browser_context_id: actual.target.browserContextId, profile_verified: true,
        scene_verified: false, shop_identity_verified: false, requires_snapshot: true, retry_write: false, advertising_writes: 0 };
    } },
  };
}

module.exports = { createQianchuanNativeAuxiliaryOperations };
