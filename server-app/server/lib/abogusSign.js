// server/lib/abogusSign.js
// a_bogus 服务端签名（2026-07-29）：罗盘签名风控端点（five_min_data/live_screen/product）
// 历史账户专用说明已从试用包移除。
// 本模块在 Node vm 沙箱里补浏览器环境，跑字节官方签名 SDK（bdms.js），
// 利用 SDK 会改写 XMLHttpRequest.open 的 URL 追加 a_bogus 的特性截获签名——
// 不逆向算法、不开浏览器；SDK 升级只需重新下载文件+微调环境 shim。
//
// 维护要点：
// - SDK 缓存 cache/abogus/bdms.js，24h 或加载失败自动重下（URL 从罗盘首页 HTML 动态提取，不硬编码）
// - 签名 UA 必须与 compassDirect 请求 UA 一致（a_bogus 内容含 UA）
// - 风控若升级导致签名失效：表现=端点重新返回风控码、页面回到空态，按报错迭代 shim
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..', '..');
const SDK_DIR = path.join(ROOT, 'cache', 'abogus');
const SDK_PATH = path.join(SDK_DIR, 'bdms.js');
const SDK_PAGE = 'https://compass.jinritemai.com/shop';
const SDK_MAX_AGE_MS = 24 * 3600 * 1000;

// 签名 UA：与 compassDirect DEFAULT_UA 保持一致（签名内容含 UA，不一致会被风控识别）
const SIGN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

let ctx = null;          // vm 沙箱（含已 init 的 bdms）
let ctxFailedAt = 0;     // 初始化熔断：失败后 5 分钟内不反复重建
let sdkDownloading = null;

/* ---------- SDK 获取：页面 HTML 动态提取 bdms URL（版本升级路径会变） ---------- */
function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': SIGN_UA, ...headers } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(httpsGet(new URL(res.headers.location, url).toString(), headers));
      }
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    }).on('error', reject);
  });
}

async function downloadSdk() {
  if (sdkDownloading) return sdkDownloading;
  sdkDownloading = (async () => {
    try {
      const page = await httpsGet(SDK_PAGE);
      const m = page.body.match(/(?:https?:)?\/\/[^"']*?rc-client-security\/web\/stable\/[^"']*?bdms\.js/);
      if (!m) throw new Error('bdms url not found in page');
      const sdkUrl = m[0].startsWith('//') ? 'https:' + m[0] : m[0];
      const sdk = await httpsGet(sdkUrl);
      if (sdk.status !== 200 || !sdk.body.includes('bdms')) throw new Error('sdk download invalid');
      fs.mkdirSync(SDK_DIR, { recursive: true });
      fs.writeFileSync(SDK_PATH + '.tmp', sdk.body);
      fs.renameSync(SDK_PATH + '.tmp', SDK_PATH);
      console.log('[abogus] SDK 已更新:', sdkUrl);
      return true;
    } catch (e) {
      console.warn('[abogus] SDK 下载失败:', e.message);
      return false;
    } finally {
      sdkDownloading = null;
    }
  })();
  return sdkDownloading;
}

function ensureSdkFresh() {
  try {
    const st = fs.statSync(SDK_PATH);
    if (Date.now() - st.mtimeMs < SDK_MAX_AGE_MS) return true;
    downloadSdk(); // 过期：后台重下，本次先用旧文件
    return true;
  } catch {
    downloadSdk(); // 缺失：后台重下，本次签不了
    return false;
  }
}

/* ---------- vm 沙箱：补浏览器环境（对着 SDK 报错迭代出来的清单） ---------- */
function buildSandbox() {
  const screen = {
    availHeight: 1040, availLeft: 0, availTop: 0, availWidth: 1920,
    colorDepth: 24, height: 1080, isExtended: false,
    orientation: { angle: 0, onchange: null, type: 'landscape-primary' },
    pixelDepth: 24, width: 1920,
  };
  // SDK 在 init 时改写 XMLHttpRequest.prototype.open 追加 a_bogus——open 时截获签名后 URL
  const holder = { signedUrl: null };
  function XMLHttpRequest() { this._headers = {}; }
  XMLHttpRequest.prototype.open = function (method, url) { holder.signedUrl = url; this._url = url; };
  XMLHttpRequest.prototype.send = function () {};
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) { this._headers[k] = v; };
  XMLHttpRequest.prototype.getAllResponseHeaders = function () { return ''; };
  XMLHttpRequest.prototype.addEventListener = function () {};
  XMLHttpRequest.prototype.removeEventListener = function () {};

  const window = {
    onwheelx: { _Ax: '0X21' }, // SDK 环境检测的怪癖字段，缺了直接跑挂
    innerHeight: 932, innerWidth: 1707, outerWidth: 1920, outerHeight: 1040,
    requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    screen, devicePixelRatio: 1, XMLHttpRequest,
  };
  window.parent = window; window.top = window; window.self = window; window.window = window;
  const location = {
    href: SDK_PAGE, protocol: 'https:', host: 'compass.jinritemai.com',
    hostname: 'compass.jinritemai.com', pathname: '/shop', search: '', hash: '',
    origin: 'https://compass.jinritemai.com', ancestorOrigins: { length: 0 },
  };
  const document = {
    all: {}, documentElement: { style: {} }, cookie: '', referrer: '', title: '', readyState: 'complete',
    createElement: () => ({
      classList: { add() {}, remove() {} }, style: {}, setAttribute() {},
      getAttribute: () => null, getContext: () => null, appendChild() {}, remove() {},
    }),
    createEvent: () => ({ initEvent() {} }),
    addEventListener() {}, removeEventListener() {},
    getElementsByTagName: () => [], querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
    body: { appendChild() {}, removeChild() {} }, head: { appendChild() {} },
  };
  const navigator = {
    userAgent: SIGN_UA, appName: 'Netscape', appVersion: SIGN_UA.replace('Mozilla/', ''),
    platform: 'Win32', language: 'zh-CN', languages: ['zh-CN', 'zh'],
    vendor: 'Google Inc.', hardwareConcurrency: 8, deviceMemory: 8,
    maxTouchPoints: 0, cookieEnabled: true, doNotTrack: null, webdriver: false,
    plugins: { length: 5 }, mimeTypes: { length: 2 }, productSub: '20030107', vendorSub: '',
  };
  const storage = () => ({ getItem: () => null, setItem() {}, removeItem() {}, clear() {}, length: 0, key: () => null });
  const performance = { now: () => Date.now(), timeOrigin: Date.now() - 1000 };
  const crypto = { getRandomValues: (a) => require('crypto').randomFillSync(a), subtle: {} };
  const sandbox = {
    window, self: window, globalThis: window, console, location, document, navigator, screen,
    localStorage: storage(), sessionStorage: storage(), performance, XMLHttpRequest,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    requestAnimationFrame: () => 0, cancelAnimationFrame: () => {}, // 顶层补全：SDK 定时器回调直接引用全局 rAF（2026-08-03 崩服务根因）
    fetch: async () => ({}), Image: function () {}, WebSocket: function () {},
    crypto, history: { pushState() {}, replaceState() {}, length: 1 },
    URL, URLSearchParams, TextEncoder, TextDecoder,
  };
  Object.assign(window, { location, document, navigator, performance, atob: sandbox.atob, btoa: sandbox.btoa, crypto });
  // 防御层（2026-08-03）：SDK 是外部代码，异步回调里可能引用缺失全局/抛任意异常。
  // 若异常从 vm 定时器回调逃逸 → uncaughtException 崩整个服务（今日实测，pm2 重启 900+ 次）。
  // 方案：包装 setTimeout/setInterval，回调在沙箱内 try-catch，异常只 warn 不逃逸——不干扰 vm 内置对象
  // （曾试 Proxy 包装全局，vm 初始化内置 Object/Array 被破坏，废弃）。
  // 注：包装后回调异常被吞，签名失败静默降级（signUrl 返回 null），调用方已有降级路径。
  const wrapTimer = (fn) => function (...args) {
    const cb = args[0];
    if (typeof cb !== 'function') return fn.apply(this, args);
    const wrapped = function () {
      try { return cb.apply(this, arguments); }
      catch (e) { console.warn('[abogus] SDK 定时器回调异常（已拦截，防崩服务）:', e.message); return undefined; }
    };
    return fn.apply(this, [wrapped, ...args.slice(1)]);
  };
  sandbox.setTimeout = wrapTimer(setTimeout);
  sandbox.setInterval = wrapTimer(setInterval);
  return { sandbox, window, XMLHttpRequest, holder };
}

/* ---------- 初始化（惰性 + 失败熔断 5 分钟） ---------- */
function ensureCtx() {
  if (ctx) return ctx;
  if (Date.now() - ctxFailedAt < 5 * 60 * 1000) return null;
  if (!ensureSdkFresh()) { ctxFailedAt = Date.now(); return null; }
  try {
    const code = fs.readFileSync(SDK_PATH, 'utf8');
    const env = buildSandbox();
    vm.runInNewContext(code, env.sandbox, { timeout: 10000 });
    if (!env.window.bdms || typeof env.window.bdms.init !== 'function') {
      throw new Error('bdms 未导出 init');
    }
    // aid/pageId 从罗盘首页 _SdkGlueInit 配置来（与 cookie gfkadpd 一致）；签名实测对两店通用
    env.window.bdms.init({ aid: 4499, pageId: 20590, ddrt: 3, paths: { include: ['/compass_api', '/business_api'] } });
    ctx = env;
    console.log('[abogus] 签名沙箱初始化完成');
    return ctx;
  } catch (e) {
    console.warn('[abogus] 沙箱初始化失败（5 分钟熔断）:', e.message);
    ctxFailedAt = Date.now();
    return null;
  }
}

/**
 * 给 URL 追加 a_bogus 签名。
 * @param {string} url 完整 URL（https://compass.jinritemai.com/...）
 * @returns {string|null} 签名后 URL；失败返回 null（调用方降级为不签名直发）
 */
function signUrl(url) {
  const env = ensureCtx();
  if (!env) return null;
  try {
    env.holder.signedUrl = null;
    const xhr = new env.window.XMLHttpRequest();
    xhr.open('GET', url);
    xhr.send();
    const signed = env.holder.signedUrl;
    if (!signed || !signed.includes('a_bogus=')) return null;
    return signed;
  } catch (e) {
    console.warn('[abogus] 签名失败:', e.message);
    return null;
  }
}

module.exports = { signUrl, SIGN_UA };
