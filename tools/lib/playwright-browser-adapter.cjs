'use strict';

/** Playwright/CDP 通道：Agent 决定调用读或写；每个操作核验明确绑定的页面。 */

class PlaywrightBrowserAdapterError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PlaywrightBrowserAdapterError';
    this.code = code;
    this.details = details && typeof details === 'object' ? details : {};
  }

  toJSON() {
    return { ok: false, code: this.code, message: this.message, details: this.details };
  }
}

function fail(code, message, details) {
  throw new PlaywrightBrowserAdapterError(code, message, details);
}

function isObject(value) {
  return value !== null && typeof value === 'object';
}

async function callMaybe(target, name, args = []) {
  if (!target || typeof target[name] !== 'function') return undefined;
  return await target[name](...args);
}

function normalizeId(value, field) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' && typeof value !== 'number') {
    fail('browser_identity_invalid', `${field} 必须是字符串或数字`);
  }
  if (typeof value === 'number' && !Number.isSafeInteger(value)) fail('browser_identity_invalid', field + ' 必须使用无精度损失的字符串');
  return String(value);
}

function normalizeDateRange(value) {
  if (value == null || value === '') return null;
  if (Array.isArray(value)) {
    if (value.length !== 2 || value.some(item => !/^\d{4}-\d{2}-\d{2}$/.test(String(item)))) return null;
    return value.map(String);
  }
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return [text, text];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return normalizeDateRange(parsed);
  } catch { /* fall through */ }
  const parts = text.split(',').map(part => part.trim()).filter(Boolean);
  return parts.length === 2 && parts.every(part => /^\d{4}-\d{2}-\d{2}$/.test(part)) ? parts : null;
}

function urlParams(url) {
  const parsed = new URL(url);
  const params = new URLSearchParams(parsed.search);
  // Qianchuan occasionally puts the app state after #?. Include it while
  // treating conflicting duplicate values as an identity failure.
  if (parsed.hash.startsWith('#?')) {
    const hashParams = new URLSearchParams(parsed.hash.slice(2));
    for (const [key, value] of hashParams) params.append(key, value);
  }
  return { parsed, params };
}

function readUniqueParam(params, names) {
  const values = [];
  for (const name of names) values.push(...params.getAll(name));
  const nonEmpty = values.map(String).filter(Boolean);
  const unique = [...new Set(nonEmpty)];
  if (unique.length > 1) return { conflict: true, values: unique };
  return { value: unique[0] || null, values: unique };
}

function wrapReadError(error, operation) {
  if (error instanceof PlaywrightBrowserAdapterError) throw error;
  fail('browser_read_failed', `浏览器只读操作失败：${operation}`, { operation, cause: String(error?.message || error) });
}

function browserLocator(raw, path = 'locator', beforeOperation = async () => {}) {
  if (!raw || typeof raw !== 'object') fail('locator_unavailable', `${path} 不可用`);
  const read = async (method, args = []) => {
    await beforeOperation();
    try {
      if (typeof raw[method] !== 'function') fail('locator_method_unavailable', `${path}.${method} 不可用`, { method });
      const result = await raw[method](...args);
      await beforeOperation();
      return result;
    } catch (error) { wrapReadError(error, `${path}.${method}`); }
  };
  const action = async (method, args) => {
    await beforeOperation();
    if (typeof raw[method] !== 'function') fail('locator_method_unavailable', path + '.' + method + ' 不可用');
    try {
      const result = await raw[method](...args);
      await beforeOperation();
      return result;
    } catch (error) {
      fail('browser_action_unconfirmed', '浏览器动作结果未确认；先回读，不能重发', { operation: method, effect_status: 'unconfirmed', retry_write: false, cause: String(error?.message || error) });
    }
  };
  const facade = {
    click: (...args) => action('click', args),
    hover: (...args) => action('hover', args),
    fill: (...args) => action('fill', args),
    press: (...args) => action('press', args),
    check: (...args) => action('check', args),
    uncheck: (...args) => action('uncheck', args),
    selectOption: (...args) => action('selectOption', args),
    count: (...args) => read('count', args),
    allTextContents: (...args) => read('allTextContents', args),
    allInnerTexts: (...args) => read('allInnerTexts', args),
    textContent: (...args) => read('textContent', args),
    innerText: (...args) => read('innerText', args),
    getAttribute: (...args) => read('getAttribute', args),
    inputValue: (...args) => read('inputValue', args),
    isChecked: (...args) => read('isChecked', args),
    isVisible: (...args) => read('isVisible', args),
    isEnabled: (...args) => read('isEnabled', args),
    evaluate: (...args) => read('evaluate', args),
    evaluateAll: (...args) => read('evaluateAll', args),
    waitFor: (options = {}) => {
      const { timeoutMs, ...rest } = options;
      return read('waitFor', [{ ...rest, ...(timeoutMs == null ? {} : { timeout: timeoutMs }) }]);
    },
    first: () => browserLocator(raw.first(), `${path}.first`, beforeOperation),
    last: () => browserLocator(raw.last(), `${path}.last`, beforeOperation),
    nth: index => browserLocator(raw.nth(index), `${path}.nth(${index})`, beforeOperation),
    filter: options => browserLocator(raw.filter(options), `${path}.filter`, beforeOperation),
    locator: (selector,options) => browserLocator(raw.locator(selector,options), `${path}.locator`, beforeOperation),
    getByRole: (role, options) => browserLocator(raw.getByRole(role, options), `${path}.getByRole`, beforeOperation),
    getByText: (text, options) => browserLocator(raw.getByText(text, options), `${path}.getByText`, beforeOperation),
    getByPlaceholder: (text, options) => browserLocator(raw.getByPlaceholder(text, options), `${path}.getByPlaceholder`, beforeOperation),
    getByLabel: (text, options) => browserLocator(raw.getByLabel(text, options), `${path}.getByLabel`, beforeOperation),
    getByTestId: (text) => browserLocator(raw.getByTestId(text), `${path}.getByTestId`, beforeOperation),
  };
  return Object.freeze(facade);
}

function browserPage(page, beforeOperation) {
  const domSnapshot = async () => {
    await beforeOperation();
    try {
      const body = typeof page.locator === 'function' ? page.locator('body') : null;
      let value;
      if (body && typeof body.innerText === 'function') value = String(await body.innerText());
      else if (typeof page.content === 'function') value = String(await page.content());
      if (value !== undefined) { await beforeOperation(); return value; }
      fail('dom_snapshot_unavailable', '页面不支持只读 DOM 快照');
    } catch (error) {
      if (error instanceof PlaywrightBrowserAdapterError) throw error;
      fail('browser_read_failed', '页面 DOM 快照读取失败', { cause: String(error?.message || error) });
    }
  };
  const locator = selector => {
    if (typeof selector !== 'string' || !selector.trim()) fail('locator_invalid', 'locator 需要非空选择器');
    try { return browserLocator(page.locator(selector), `locator(${selector})`, beforeOperation); }
    catch (error) { wrapReadError(error, `locator(${selector})`); }
  };
  const facade = {
    url: async () => {
      try { return typeof page.url === 'function' ? await page.url() : ''; }
      catch (error) { wrapReadError(error, 'page.url'); }
    },
    title: async () => {
      try { await beforeOperation(); const value=await page.title(); await beforeOperation(); return value; }
      catch (error) { wrapReadError(error, 'page.title'); }
    },
    content: async () => {
      try { await beforeOperation(); const value=await page.content(); await beforeOperation(); return value; }
      catch (error) { wrapReadError(error, 'page.content'); }
    },
    domSnapshot,
    locator,
    getByRole: (role, options) => {
      try { return browserLocator(page.getByRole(role, options), `getByRole(${role})`, beforeOperation); }
      catch (error) { wrapReadError(error, `getByRole(${role})`); }
    },
    getByText: (text, options) => {
      try { return browserLocator(page.getByText(text, options), `getByText(${text})`, beforeOperation); }
      catch (error) { wrapReadError(error, `getByText(${text})`); }
    },
    getByPlaceholder: (text, options) => {
      try { return browserLocator(page.getByPlaceholder(text, options), `getByPlaceholder(${text})`, beforeOperation); }
      catch (error) { wrapReadError(error, `getByPlaceholder(${text})`); }
    },
    getByLabel: (text, options) => {
      try { return browserLocator(page.getByLabel(text, options), `getByLabel(${text})`, beforeOperation); }
      catch (error) { wrapReadError(error, `getByLabel(${text})`); }
    },
    getByTestId: text => {
      try { return browserLocator(page.getByTestId(text), `getByTestId(${text})`, beforeOperation); }
      catch (error) { wrapReadError(error, `getByTestId(${text})`); }
    },
  };
  return Object.freeze(facade);
}

class PlaywrightBrowserAdapter {
  constructor(options = {}) {
    this.options = { ...options };
    this._browser = options.browser || null;
    this._context = options.context || null;
    this._page = options.page || null;
    this._connected = Boolean(this._page);
    this._ownsBrowser = false;
    this._closed = false;
    this._binding = null;
  }

  async connect(expected = this.options.binding) {
    if (this._closed) fail('browser_adapter_closed', '浏览器适配器已关闭');
    if (this._binding) {
      if (expected && (String(expected.advertiser_id) !== this._binding.advertiser_id || String(expected.primary_ad_id) !== this._binding.primary_ad_id)) fail('browser_binding_conflict', '适配器已绑定其他目标，请建立独立连接');
      const dateInput = expected?.date_range ?? expected?.date;
      if (dateInput != null && JSON.stringify(normalizeDateRange(dateInput)) !== JSON.stringify(normalizeDateRange(this._binding.date_range ?? this._binding.date))) fail('browser_binding_conflict', '日期绑定已变化，请建立独立连接');
      await this._beforeOperation();
      return { ok: true, adapter: 'playwright-cdp', reused: true };
    }
    try {
      if (!this._browser && !this._page) {
        let playwright = this.options.playwright || this.options.playwrightModule;
        if (!playwright) {
          try { playwright = require('node:module').createRequire(require('node:path').resolve(__dirname, '../../server-app/package.json'))(this.options.playwright_package || 'playwright-core'); }
          catch (error) { fail('playwright_unavailable', 'Playwright 依赖不可用，请注入 Playwright 模块或运行项目依赖安装', { package: this.options.playwright_package || 'playwright-core', cause: String(error?.message || error) }); }
        }
        if (!playwright?.chromium || typeof playwright.chromium.connectOverCDP !== 'function') {
          fail('playwright_unavailable', '注入的 Playwright 模块缺少 chromium.connectOverCDP');
        }
        const endpoint = this.options.cdp_url || this.options.endpoint_url;
        if (typeof endpoint !== 'string' || !/^(https?|wss?):\/\//i.test(endpoint)) {
          fail('cdp_endpoint_required', 'Playwright/CDP 连接需要有效的 cdp_url');
        }
        this._browser = await playwright.chromium.connectOverCDP(endpoint, { timeout: this.options.connect_timeout_ms || 15000 });
        this._ownsBrowser = true; // connectOverCDP close releases our transport, not the external Chrome process.
      }
      if (!expected || !normalizeId(expected.advertiser_id, 'advertiser_id') || !normalizeId(expected.primary_ad_id, 'primary_ad_id')) fail('browser_binding_required', '连接需要明确的广告户和主计划');
      const binding = { advertiser_id: String(expected.advertiser_id), primary_ad_id: String(expected.primary_ad_id),
        ...(expected.date_range != null ? { date_range: expected.date_range } : {}), ...(expected.date != null ? { date: expected.date } : {}) };
      if (this._page) {
        await this._assertPageIdentity(binding, this._page);
      } else {
        const contexts = this._context ? [this._context] : await callMaybe(this._browser, 'contexts') || [];
        const matches = [];
        for (const context of contexts) {
          for (const page of await callMaybe(context, 'pages') || []) {
            if (typeof page.isClosed === 'function' && page.isClosed()) continue;
            try { await this._assertPageIdentity(binding, page); matches.push({ context, page }); } catch (error) {
              if (!(error instanceof PlaywrightBrowserAdapterError)) throw error;
            }
          }
        }
        if (matches.length !== 1) fail(matches.length ? 'browser_page_ambiguous' : 'page_unavailable', '没有唯一匹配账户和主计划的页面', { matches: matches.length });
        this._context = matches[0].context;
        this._page = matches[0].page;
      }
      this._binding = binding;
      this._connected = true;
      return { ok: true, adapter: 'playwright-cdp', reused: false, url: await this.currentUrl() };
    } catch (error) {
      if (error instanceof PlaywrightBrowserAdapterError) throw error;
      fail('browser_connect_failed', 'Playwright/CDP 连接失败', { cause: String(error?.message || error) });
    }
  }

  _requirePage() {
    if (this._closed) fail('browser_adapter_closed', '浏览器适配器已关闭');
    if (!this._connected || !this._page) fail('browser_not_connected', '浏览器适配器尚未连接');
    if (this._browser && typeof this._browser.isConnected === 'function' && !this._browser.isConnected()) fail('browser_disconnected', 'CDP 连接已断开');
    if (typeof this._page.isClosed === 'function' && this._page.isClosed()) fail('browser_page_closed', '已绑定的页面已关闭');
    return this._page;
  }

  async _beforeOperation() {
    this._requirePage();
    if (!this._binding) fail('browser_binding_required', '操作前需要 connect(binding)');
    await this.assertIdentity(this._binding);
  }

  async currentUrl() {
    const page = this._requirePage();
    try {
      const url = typeof page.url === 'function' ? await page.url() : page.url;
      if (typeof url !== 'string' || !url) fail('browser_url_unavailable', '当前页面 URL 不可读');
      return url;
    } catch (error) {
      if (error instanceof PlaywrightBrowserAdapterError) throw error;
      fail('browser_url_unavailable', '当前页面 URL 不可读', { cause: String(error?.message || error) });
    }
  }

  async assertIdentity(expected = {}) {
    return this._assertPageIdentity(expected, this._requirePage());
  }

  async _assertPageIdentity(expected, page) {
    const url = typeof page.url === 'function' ? await page.url() : page.url;
    let parsed;
    try { ({ parsed } = urlParams(url)); }
    catch (error) { fail('browser_url_invalid', '当前页面 URL 无法解析', { cause: String(error?.message || error) }); }
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'qianchuan.jinritemai.com') {
      fail('browser_origin_mismatch', '当前页面不是受信任的千川 HTTPS 页面', { origin: parsed.origin });
    }
    const { params } = urlParams(url);
    const advertiser = normalizeId(expected.advertiser_id ?? expected.advertiserId, 'advertiser_id');
    const primary = normalizeId(expected.primary_ad_id ?? expected.primaryAdId, 'primary_ad_id');
    const dateInput = expected.date_range ?? expected.dateRange ?? expected.date;
    const dateRange = normalizeDateRange(dateInput);
    if (dateInput != null && !dateRange) fail('browser_identity_invalid', '请求日期范围格式无效');
    const checks = [];
    const checkParam = (field, value, names) => {
      if (value == null) return;
      const result = readUniqueParam(params, names);
      if (result.conflict) fail('browser_identity_conflict', `${field} 在 URL 中存在冲突值`, { field, values: result.values });
      if (!result.value) fail('browser_identity_missing', `URL 缺少 ${field}`, { field });
      if (result.value !== value) fail('browser_identity_mismatch', `${field} 与页面 URL 不匹配`, { field, expected: value, actual: result.value });
      checks.push(field);
    };
    checkParam('advertiser_id', advertiser, ['aavid', 'advertiser_id', 'advertiserId']);
    checkParam('primary_ad_id', primary, ['adId', 'primary_ad_id', 'primaryAdId']);
    if (dateRange) {
      const dateResult = readUniqueParam(params, ['dr', 'dateRange', 'date_range', 'date']);
      if (dateResult.conflict) fail('browser_identity_conflict', '日期参数在 URL 中存在冲突值', { values: dateResult.values });
      const actual = normalizeDateRange(dateResult.value);
      if (!actual) fail('browser_identity_missing', 'URL 缺少可识别的日期范围', { field: 'date_range' });
      if (actual[0] !== dateRange[0] || actual[1] !== dateRange[1]) fail('browser_identity_mismatch', '日期范围与页面 URL 不匹配', { expected: dateRange, actual });
      checks.push('date_range');
    }
    return { ok: true, verified: true, url, origin: parsed.origin, checked: checks };
  }

  browserIdentity() {
    return {
      browserType: 'playwright-cdp',
      profileName: this.options.profile_name || this.options.profileName || null,
      cdpEndpoint: this.options.cdp_url || this.options.endpoint_url || null,
      browserId: this.options.browser_id || this.options.browserId || null,
    };
  }

  async reload(options = {}) {
    await this._beforeOperation();
    const page = this._requirePage();
    try {
      if (typeof page.reload !== 'function') fail('reload_unavailable', '当前页面不支持刷新');
      await page.reload(options);
      await this._beforeOperation();
      return { ok: true, url: await this.currentUrl(), reloaded: true };
    } catch (error) {
      if (error instanceof PlaywrightBrowserAdapterError) throw error;
      fail('browser_reload_failed', '浏览器页面刷新失败', { cause: String(error?.message || error) });
    }
  }

  page() { return browserPage(this._requirePage(), () => this._beforeOperation()); }
  readPage() { return this.page(); }
  async waitForFunction(predicate, arg, options = {}) {
    await this._beforeOperation();
    const result = await this._requirePage().waitForFunction(predicate, arg, options);
    try { const value = await result.jsonValue(); await this._beforeOperation(); return value; }
    finally { await result.dispose(); }
  }
  async screenshot(options = {}) { await this._beforeOperation(); return this._requirePage().screenshot(options); }

  /**
   * Adapt this bound page to the existing CUA-neutral capture contract.
   * The default getAXState is a DOM-backed settle probe; callers that have a
   * real accessibility-tree provider should inject it through options.
   */
  asReadWorkflowTab(options = {}) {
    const adapter = this;
    const getAXState = typeof options.getAXState === 'function'
      ? options.getAXState
      : async () => ({
        accessibility: { document_text: await adapter.domSnapshot(), source: 'playwright-dom' },
      });
    return {
      get playwright() { return adapter.page(); },
      url: () => adapter.currentUrl(),
      reload: reloadOptions => adapter.reload(reloadOptions),
      getAXState,
    };
  }
  locator(selector) { return this.page().locator(selector); }
  getByRole(role, options) { return this.page().getByRole(role, options); }
  getByText(text, options) { return this.page().getByText(text, options); }
  getByPlaceholder(text, options) { return this.page().getByPlaceholder(text, options); }
  getByLabel(text, options) { return this.page().getByLabel(text, options); }
  getByTestId(text) { return this.page().getByTestId(text); }

  async domSnapshot() { return this.page().domSnapshot(); }

  async close() {
    if (this._closed) return { ok: true, closed: false, already_closed: true };
    let browserClosed = false;
    try {
      if (this._ownsBrowser && this._browser && typeof this._browser.close === 'function') {
        await this._browser.close();
        browserClosed = true;
      }
      this._page = null;
      this._context = null;
      this._browser = null;
      this._connected = false;
      this._closed = true;
      return { ok: true, closed: true, browser_closed: browserClosed };
    } catch (error) {
      fail('browser_close_failed', '浏览器适配器关闭失败', { cause: String(error?.message || error) });
    }
  }
}

function createPlaywrightBrowserAdapter(options = {}) {
  return new PlaywrightBrowserAdapter(options);
}

function structuredError(error) {
  if (error instanceof PlaywrightBrowserAdapterError) return error.toJSON();
  return { ok: false, code: 'browser_adapter_error', message: String(error?.message || error), details: {} };
}

module.exports = {
  PlaywrightBrowserAdapter,
  PlaywrightBrowserAdapterError,
  createPlaywrightBrowserAdapter,
  structuredError,
  browserLocator,
};
