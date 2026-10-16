'use strict';

const { PORT, manual_config } = require('../lib/config');
const { sendJSON } = require('../lib/utils');
const { validateAccount } = require('../lib/api-helpers');

const overviewCache = new Map();
const CACHE_TTL_MS = 30 * 1000;
const PARTIAL_CACHE_TTL_MS = 5 * 1000;

function requestError(code, component, message, options = {}) {
  const error = new Error(message);
  error.code = code;
  error.component = component;
  error.retryable = options.retryable === true;
  if (options.timeoutMs != null) error.timeout_ms = options.timeoutMs;
  if (options.status != null) error.status = options.status;
  return error;
}

// 本机回环调内部 API，复用各路由的缓存与错误契约。每个子项有自己的期限，
// 一个可选模块悬挂不能把整个工作台拖到 HTTP 总期限。
async function localFetch(path, options = {}) {
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 10000;
  const component = options.component || 'v4_overview_subrequest';
  const baseUrl = options.baseUrl || `http://127.0.0.1:${PORT}`;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  let response;
  try {
    response = await fetchImpl(baseUrl + path, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const timedOut = error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw requestError(
      timedOut ? 'timeout' : (error.code || 'upstream_unavailable'),
      component,
      timedOut ? `${component} 超过 ${timeoutMs}ms` : (error.message || `${component} 请求失败`),
      { retryable: true, timeoutMs: timedOut ? timeoutMs : null },
    );
  }
  let body = null;
  try { body = await response.json(); } catch {}
  if (!response.ok || (body && body.ok === false)) {
    throw requestError(
      body && body.code || `http_${response.status}`,
      body && body.component || component,
      body && (body.error || body.message) || `HTTP ${response.status}`,
      { retryable: !!(body && body.retryable), status: response.status },
    );
  }
  return body;
}

function publicError(error, fallbackComponent) {
  return {
    code: String(error && error.code || 'subrequest_failed'),
    component: String(error && error.component || fallbackComponent || 'unknown'),
    retryable: error && error.retryable === true,
    ...(error && error.timeout_ms != null ? { timeout_ms: Number(error.timeout_ms) } : {}),
    message: String(error && error.message || '子项读取失败'),
  };
}

async function runComponents(definitions, options = {}) {
  const settled = await Promise.allSettled(definitions.map(def => localFetch(def.path, {
    timeoutMs: def.timeoutMs,
    component: def.component || def.key,
    baseUrl: options.baseUrl,
    fetchImpl: options.fetchImpl,
  })));
  const data = {};
  const errors = [];
  settled.forEach((result, index) => {
    const def = definitions[index];
    if (result.status === 'fulfilled') data[def.key] = result.value;
    else {
      data[def.key] = null;
      errors.push(publicError(result.reason, def.component || def.key));
    }
  });
  return { data, errors };
}

function localDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function shiftDate(value, days) {
  const date = new Date(value + 'T00:00:00');
  date.setDate(date.getDate() + days);
  return localDate(date);
}

function coreDefinitions(account, today) {
  const q = encodeURIComponent(account);
  return [
    { key: 'dash', component: 'live_dashboard', timeoutMs: 10000, path: `/api/live-dashboard?account=${q}&slim=1` },
    // 工作台的主经营数据必须使用千川首页三分口径，不能在该接口失败时
    // 回退为直播大屏的单场消耗。直播趋势/流速只在直播场次页读取。
    { key: 'split', component: 'home_split', timeoutMs: 5000, path: `/api/home-split?account=${q}&date=${today}&quick=1` },
    { key: 'rounds', component: 'decision_rounds', timeoutMs: 5000, path: `/api/agent-rounds?account=${q}&limit=20` },
    { key: 'pend', component: 'pending_ops', timeoutMs: 5000, path: `/api/pending-ops?account=${q}&status=pending` },
  ];
}

function slowDefinitions(account, today) {
  const q = encodeURIComponent(account);
  return [
    { key: 'dash', component: 'live_dashboard_full', timeoutMs: 10000, path: `/api/live-dashboard?account=${q}` },
    { key: 'chengfang', component: 'chengfang', timeoutMs: 20000, path: `/api/chengfang/dashboard?account=${q}&section=chengfang&date=${today}` },
    { key: 'uni_product', component: 'uni_product', timeoutMs: 20000, path: `/api/chengfang/dashboard?account=${q}&section=uni_product&date=${today}` },
    { key: 'crowd', component: 'compass_snapshot', timeoutMs: 15000, path: `/api/compass?account=${q}` },
    { key: 'goods', component: 'compass_goods', timeoutMs: 15000, path: `/api/compass/goods?account=${q}&range=7d` },
  ];
}

async function valueSection(account, today, options = {}) {
  const launch = manual_config && manual_config.system_launch_date;
  const yesterday = shiftDate(today, -1);
  if (!launch || !/^\d{4}-\d{2}-\d{2}$/.test(launch) || launch > yesterday) {
    return { value: null, errors: [] };
  }
  const preStart = shiftDate(launch, -7);
  const preEnd = shiftDate(launch, -1);
  const q = encodeURIComponent(account);
  const { data, errors } = await runComponents([
    { key: 'pre', component: 'value_pre', timeoutMs: 15000, path: `/api/overview?account=${q}&start=${preStart}&end=${preEnd}` },
    { key: 'post', component: 'value_post', timeoutMs: 15000, path: `/api/overview?account=${q}&start=${launch}&end=${yesterday}` },
    { key: 'today', component: 'value_today', timeoutMs: 10000, path: `/api/overview?account=${q}&start=${today}&end=${today}` },
  ], options);
  return {
    value: {
      launch,
      pre_range: [preStart, preEnd],
      post_range: [launch, yesterday],
      today_range: [today, today],
      pre: data.pre,
      post: data.post,
      today: data.today,
    },
    errors,
  };
}

function buildOverviewPayload(account, mode, result, valueResult = { value: null, errors: [] }) {
  let errors = result.errors || [];
  let value = null;
  if (mode === 'slow') {
    value = valueResult.value;
    errors = errors.concat(valueResult.errors || []);
  }
  const mainFailed = mode === 'core' && !result.data.dash;
  const mainError = mainFailed && errors.find(error => error.component === 'live_dashboard');
  return {
    ok: !mainFailed,
    ...(mainFailed ? {
      code: mainError && mainError.code || 'live_dashboard_failed',
      component: mainError && mainError.component || 'live_dashboard',
      retryable: mainError ? mainError.retryable === true : true,
      error: mainError && mainError.message || '核心盘面读取失败',
    } : {}),
    account,
    mode,
    primary_data_valid: !mainFailed,
    partial: errors.length > 0,
    errors,
    ...result.data,
    ...(mode === 'slow' ? { value, dash: {
      ...(result.data.dash || {}),
      chengfang: result.data.chengfang || null,
      uni_product: result.data.uni_product || null,
    } } : {}),
  };
}

/**
 * GET /api/v4-overview?account=<id>[&include_slow=1]
 *
 * 默认只返回工作台首屏核心数据；低频经营/商品诊断在用户展开后用 include_slow=1 加载。
 * 所有子项独立超时并进入 errors[]，不会再因一个 Promise 悬挂让整页一直显示骨架。
 */
async function handleV4Overview(req, res, url) {
  if (req.method !== 'GET') {
    return sendJSON(res, { ok: false, code: 'method_not_allowed', error: 'Method Not Allowed' }, 405);
  }
  let account;
  try {
    account = validateAccount(url.searchParams.get('account') || url.searchParams.get('accountId'));
  } catch (error) {
    return sendJSON(res, { ok: false, code: error.code || 'invalid_account', error: error.message }, error.statusCode || 400);
  }
  const includeSlow = url.searchParams.get('include_slow') === '1';
  const mode = includeSlow ? 'slow' : 'core';
  const cacheKey = `${account}|${mode}`;
  const cached = overviewCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < cached.ttlMs) {
    return sendJSON(res, { ...cached.payload, cached: true });
  }

  const today = localDate();
  const definitions = includeSlow ? slowDefinitions(account, today) : coreDefinitions(account, today);
  const [result, valueResult] = await Promise.all([
    runComponents(definitions),
    includeSlow ? valueSection(account, today) : Promise.resolve({ value: null, errors: [] }),
  ]);
  const payload = buildOverviewPayload(account, mode, result, valueResult);
  if (!payload.ok) {
    const status = payload.code === 'timeout' ? 504 : 502;
    return sendJSON(res, payload, status);
  }
  const ttlMs = payload.split?.pending || payload.split?.refreshing ? 1000
    : payload.partial ? PARTIAL_CACHE_TTL_MS : CACHE_TTL_MS;
  overviewCache.set(cacheKey, { ts: Date.now(), ttlMs, payload });
  return sendJSON(res, payload);
}

module.exports = handleV4Overview;
module.exports._test = {
  localFetch,
  runComponents,
  publicError,
  coreDefinitions,
  slowDefinitions,
  valueSection,
  buildOverviewPayload,
  _cache: overviewCache,
};
