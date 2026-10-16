'use strict';

const fs = require('node:fs');

const REGISTRY_KEYS = ['schema_version', 'bindings'];
const ENTRY_KEYS = ['account_id', 'browser_type', 'profile_name', 'cdp_endpoint', 'status', 'advertisers'];
const SCOPE_KEYS = ['advertiser_id', 'primary_ad_ids'];
const REQUEST_KEYS = ['account_id', 'advertiser_id', 'primary_ad_id', 'browser_type', 'profile_name', 'status'];

function fail(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function hasOnlyKeys(value, keys) { const allowed = new Set(keys); return Object.keys(value).every(key => allowed.has(key)); }
function nonEmptyString(value) { return typeof value === 'string' && value.length > 0 && value.trim() === value; }
function requireString(value, code = 'playwright_binding_invalid') {
  if (!nonEmptyString(value)) fail(code, 'Playwright 绑定包含无效字符串字段');
}

function normalizeLocalEndpoint(value) {
  requireString(value, 'playwright_binding_invalid_endpoint');
  let url;
  try { url = new URL(value); } catch { fail('playwright_binding_invalid_endpoint', 'CDP 地址不是合法 URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase())) {
    fail('playwright_binding_non_local_endpoint', 'Playwright/CDP 端点必须是本机地址且不能包含凭据');
  }
  if (!url.port) fail('playwright_binding_invalid_endpoint', 'CDP 地址必须显式包含端口');
  if (url.pathname !== '/' || url.search || url.hash) fail('playwright_binding_invalid_endpoint', 'CDP 登记只接受本机端口根地址');
  if (url.hostname.toLowerCase() === 'localhost') url.hostname = '127.0.0.1';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function validateScope(scope) {
  if (!isRecord(scope) || !hasOnlyKeys(scope, SCOPE_KEYS) || Object.keys(scope).length !== SCOPE_KEYS.length
    || !nonEmptyString(scope.advertiser_id) || !Array.isArray(scope.primary_ad_ids)
    || scope.primary_ad_ids.length === 0 || scope.primary_ad_ids.some(id => !nonEmptyString(id))) {
    fail('playwright_bindings_invalid_registry', 'Playwright 广告户范围无效');
  }
  if (new Set(scope.primary_ad_ids).size !== scope.primary_ad_ids.length) {
    fail('playwright_bindings_ambiguous', 'Playwright 广告户范围包含重复主计划');
  }
  return scope;
}

function validateRegistry(registry) {
  if (!isRecord(registry) || !hasOnlyKeys(registry, REGISTRY_KEYS) || Object.keys(registry).length !== REGISTRY_KEYS.length
    || registry.schema_version !== 1 || !Array.isArray(registry.bindings)) {
    fail('playwright_bindings_invalid_registry', 'Playwright 绑定登记格式无效');
  }
  const accounts = new Set();
  const endpoints = new Set();
  for (const entry of registry.bindings) {
    if (!isRecord(entry) || !hasOnlyKeys(entry, ENTRY_KEYS) || Object.keys(entry).length !== ENTRY_KEYS.length
      || entry.browser_type !== 'playwright-cdp' || entry.status !== 'active' || !Array.isArray(entry.advertisers)
      || entry.advertisers.length === 0) {
      fail('playwright_bindings_invalid_registry', 'Playwright Profile 登记状态或类型无效');
    }
    requireString(entry.account_id, 'playwright_bindings_invalid_registry');
    requireString(entry.profile_name, 'playwright_bindings_invalid_registry');
    const endpoint = normalizeLocalEndpoint(entry.cdp_endpoint);
    if (accounts.has(entry.account_id)) fail('playwright_bindings_ambiguous', 'Playwright 登记存在重复账户');
    if (endpoints.has(endpoint)) fail('playwright_bindings_endpoint_reused', 'CDP 端点被多个账户复用');
    accounts.add(entry.account_id);
    endpoints.add(endpoint);
    const advertisers = new Set();
    for (const scope of entry.advertisers) {
      validateScope(scope);
      if (advertisers.has(scope.advertiser_id)) fail('playwright_bindings_ambiguous', 'Playwright 登记存在重复广告户');
      advertisers.add(scope.advertiser_id);
    }
  }
  return registry;
}

function loadPlaywrightBindings(file) {
  if (!nonEmptyString(file)) fail('playwright_bindings_unreadable', 'Playwright 绑定登记文件不可读');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { fail('playwright_bindings_unreadable', 'Playwright 绑定登记文件不可读'); }
  let registry;
  try { registry = JSON.parse(String(text).replace(/^\uFEFF/, '')); }
  catch { fail('playwright_bindings_invalid_json', 'Playwright 绑定登记不是合法 JSON'); }
  return validateRegistry(registry);
}

function validateRequest(binding) {
  if (!isRecord(binding) || !hasOnlyKeys(binding, REQUEST_KEYS)) fail('playwright_binding_invalid', 'Playwright 请求绑定格式无效');
  for (const key of ['account_id', 'advertiser_id', 'primary_ad_id']) requireString(binding[key], 'playwright_binding_invalid');
  if (Object.hasOwn(binding, 'browser_type') && binding.browser_type !== 'playwright-cdp') fail('playwright_binding_type_mismatch', '请求绑定不是 playwright-cdp 类型');
  if (Object.hasOwn(binding, 'profile_name')) requireString(binding.profile_name, 'playwright_binding_invalid');
  if (Object.hasOwn(binding, 'status') && binding.status !== 'active') fail('playwright_binding_inactive', '请求绑定未处于 active 状态');
}

function validateBrowserIdentity(identity, entry) {
  if (!isRecord(identity)) fail('playwright_identity_invalid', 'Playwright 浏览器身份格式无效');
  const type = identity.browser_type || identity.browserType;
  if (type !== 'playwright-cdp') fail('playwright_binding_type_mismatch', '当前浏览器类型不是 playwright-cdp');
  const profile = identity.profile_name || identity.profileName;
  if (!nonEmptyString(profile)) fail('playwright_identity_missing', '当前浏览器缺少 Profile 名称');
  if (profile !== entry.profile_name) fail('playwright_binding_profile_mismatch', '当前 Profile 与登记不匹配');
  const endpoint = identity.cdp_endpoint || identity.cdpEndpoint;
  if (!nonEmptyString(endpoint)) fail('playwright_identity_missing', '当前浏览器缺少 CDP 端点');
  if (normalizeLocalEndpoint(endpoint) !== normalizeLocalEndpoint(entry.cdp_endpoint)) {
    fail('playwright_binding_endpoint_mismatch', '当前 CDP 端点与登记不匹配');
  }
  const browserId = identity.browser_id || identity.browserId || null;
  if (browserId !== null) requireString(browserId, 'playwright_identity_invalid');
  return { profile_name: profile, browser_id: browserId, cdp_endpoint: normalizeLocalEndpoint(entry.cdp_endpoint) };
}

function validatePlaywrightBinding(registry, binding, browserIdentity) {
  validateRegistry(registry);
  validateRequest(binding);
  if (!isRecord(browserIdentity)) fail('playwright_identity_invalid', '当前 Playwright 浏览器身份不可用');
  const accountEntries = registry.bindings.filter(entry => entry.account_id === binding.account_id);
  if (accountEntries.length === 0) fail('playwright_binding_account_mismatch', '请求账户没有 Playwright 绑定');
  const matches = accountEntries.filter(entry => entry.advertisers.some(scope =>
    scope.advertiser_id === binding.advertiser_id && scope.primary_ad_ids.includes(binding.primary_ad_id)));
  if (matches.length === 0) {
    const hasAdvertiser = accountEntries.some(entry => entry.advertisers.some(scope => scope.advertiser_id === binding.advertiser_id));
    fail(hasAdvertiser ? 'playwright_binding_plan_mismatch' : 'playwright_binding_advertiser_mismatch',
      hasAdvertiser ? '请求主计划与 Playwright 登记不匹配' : '请求广告户与 Playwright 登记不匹配');
  }
  if (matches.length !== 1) fail('playwright_bindings_ambiguous', '请求绑定匹配多个 Playwright 登记项');
  const entry = matches[0];
  if (Object.hasOwn(binding, 'profile_name') && binding.profile_name !== entry.profile_name) {
    fail('playwright_binding_profile_mismatch', '请求 Profile 与登记不匹配');
  }
  const runtime = validateBrowserIdentity(browserIdentity, entry);
  const identity = {
    account_id: binding.account_id,
    advertiser_id: binding.advertiser_id,
    primary_ad_id: binding.primary_ad_id,
    browser_type: entry.browser_type,
    profile_name: entry.profile_name,
    status: entry.status,
  };
  return {
    ok: true,
    verified: true,
    identity,
    binding: { ...identity },
    evidence: {
      browser_id: runtime.browser_id,
      browser_id_scope: 'runtime_only',
      profile_name: runtime.profile_name,
      cdp_endpoint: runtime.cdp_endpoint,
      cdp_endpoint_scope: 'local_only',
    },
  };
}

module.exports = { loadPlaywrightBindings, validatePlaywrightBinding, validateRegistry, normalizeLocalEndpoint };
