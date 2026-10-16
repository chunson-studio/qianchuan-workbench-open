'use strict';

const fs = require('node:fs');

const REGISTRY_KEYS = ['schema_version', 'bindings'];
const BINDING_KEYS = [
  'account_id',
  'advertiser_id',
  'primary_ad_id',
  'browser_type',
  'extension_instance_id',
  'profile_name',
  'status',
];
const PROFILE_BINDING_KEYS = [
  'account_id',
  'browser_type',
  'extension_instance_id',
  'profile_name',
  'status',
  'advertisers',
];
const ADVERTISER_BINDING_KEYS = ['advertiser_id', 'primary_ad_ids'];
const REQUEST_KEYS = [
  'account_id',
  'advertiser_id',
  'primary_ad_id',
  'browser_type',
  'extension_instance_id',
  'profile_name',
  'status',
];

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value, keys) {
  const allowed = new Set(keys);
  return Object.keys(value).every(key => allowed.has(key));
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function requireNonEmptyString(value, code = 'browser_binding_invalid') {
  if (!nonEmptyString(value)) fail(code, '浏览器绑定包含无效字符串字段');
}

function validateEntry(entry) {
  if (!isRecord(entry) || !hasOnlyKeys(entry, BINDING_KEYS)
    || Object.keys(entry).length !== BINDING_KEYS.length) {
    fail('browser_bindings_invalid_registry', '浏览器绑定登记格式无效');
  }
  for (const key of ['account_id', 'advertiser_id', 'primary_ad_id', 'extension_instance_id', 'profile_name']) {
    requireNonEmptyString(entry[key], 'browser_bindings_invalid_registry');
  }
  if (entry.browser_type !== 'extension' || entry.status !== 'active') {
    fail('browser_bindings_invalid_registry', '浏览器绑定登记状态或类型无效');
  }
  return entry;
}

function validateAdvertiserScope(scope) {
  if (!isRecord(scope) || !hasOnlyKeys(scope, ADVERTISER_BINDING_KEYS)
    || Object.keys(scope).length !== ADVERTISER_BINDING_KEYS.length
    || !nonEmptyString(scope.advertiser_id)
    || !Array.isArray(scope.primary_ad_ids)
    || scope.primary_ad_ids.length === 0
    || scope.primary_ad_ids.some(id => !nonEmptyString(id))) {
    fail('browser_bindings_invalid_registry', '浏览器绑定广告户范围无效');
  }
  if (new Set(scope.primary_ad_ids).size !== scope.primary_ad_ids.length) {
    fail('browser_bindings_invalid_registry', '浏览器绑定主计划范围重复');
  }
  return scope;
}

function validateProfileEntry(entry) {
  if (!isRecord(entry) || !hasOnlyKeys(entry, PROFILE_BINDING_KEYS)
    || Object.keys(entry).length !== PROFILE_BINDING_KEYS.length) {
    fail('browser_bindings_invalid_registry', '浏览器 Profile 绑定登记格式无效');
  }
  for (const key of ['account_id', 'extension_instance_id', 'profile_name']) {
    requireNonEmptyString(entry[key], 'browser_bindings_invalid_registry');
  }
  if (entry.browser_type !== 'extension' || entry.status !== 'active' || !Array.isArray(entry.advertisers)
    || entry.advertisers.length === 0) {
    fail('browser_bindings_invalid_registry', '浏览器 Profile 绑定登记状态或类型无效');
  }
  const advertisers = new Set();
  for (const scope of entry.advertisers) {
    validateAdvertiserScope(scope);
    if (advertisers.has(scope.advertiser_id)) {
      fail('browser_bindings_ambiguous', '浏览器 Profile 绑定存在重复广告户');
    }
    advertisers.add(scope.advertiser_id);
  }
  return entry;
}

function validateRegistry(registry) {
  if (!isRecord(registry) || !hasOnlyKeys(registry, REGISTRY_KEYS)
    || Object.keys(registry).length !== REGISTRY_KEYS.length
    || ![1, 2].includes(registry.schema_version) || !Array.isArray(registry.bindings)) {
    fail('browser_bindings_invalid_registry', '浏览器绑定登记格式无效');
  }

  const accounts = new Set();
  const extensionInstances = new Map();
  for (const entry of registry.bindings) {
    if (registry.schema_version === 1) validateEntry(entry);
    else validateProfileEntry(entry);
    if (accounts.has(entry.account_id)) {
      fail('browser_bindings_ambiguous', '浏览器绑定登记存在重复账户');
    }
    accounts.add(entry.account_id);
    const previousAccount = extensionInstances.get(entry.extension_instance_id);
    if (previousAccount !== undefined) {
      // An extension instance is one physical/profile installation and cannot
      // be used to select two accounts. Treat same-account duplicates as
      // ambiguous through the account check above as well.
      fail('browser_bindings_extension_reused', '浏览器扩展实例被多个账户复用');
    }
    extensionInstances.set(entry.extension_instance_id, entry.account_id);
  }
  return registry;
}

function readRuntimeBrowserId(browserIdentity) {
  const values = [];
  for (const key of ['browserId', 'browser_id', 'id']) {
    if (Object.hasOwn(browserIdentity, key)) {
      requireNonEmptyString(browserIdentity[key], 'browser_identity_invalid');
      values.push(browserIdentity[key]);
    }
  }
  if (values.length === 0) fail('browser_identity_missing', '浏览器身份缺少临时浏览器标识');
  if (new Set(values).size !== 1) fail('browser_identity_invalid', '浏览器身份包含冲突的临时浏览器标识');
  return values[0];
}

function readRuntimeType(browserIdentity) {
  const values = [];
  for (const key of ['browserType', 'browser_type']) {
    if (Object.hasOwn(browserIdentity, key)) {
      requireNonEmptyString(browserIdentity[key], 'browser_identity_invalid');
      values.push(browserIdentity[key]);
    }
  }
  if (isRecord(browserIdentity.metadata)) {
    for (const key of ['browserType', 'browser_type']) {
      if (Object.hasOwn(browserIdentity.metadata, key)) {
        requireNonEmptyString(browserIdentity.metadata[key], 'browser_identity_invalid');
        values.push(browserIdentity.metadata[key]);
      }
    }
  }
  if (values.length > 0 && (new Set(values).size !== 1 || values[0] !== 'extension')) {
    fail('browser_binding_type_mismatch', '浏览器类型不是已登记扩展');
  }
  return values[0] || 'extension';
}

function readRuntimeMetadata(browserIdentity) {
  if (!isRecord(browserIdentity.metadata)
    || !Object.hasOwn(browserIdentity.metadata, 'extensionInstanceId')
    || !nonEmptyString(browserIdentity.metadata.extensionInstanceId)) {
    fail('browser_identity_missing', '浏览器身份缺少扩展实例元数据');
  }
  const extensionInstanceId = browserIdentity.metadata.extensionInstanceId;
  const profileValues = [];
  for (const source of [browserIdentity, browserIdentity.metadata]) {
    if (!isRecord(source)) continue;
    if (Object.hasOwn(source, 'profileName')) {
      requireNonEmptyString(source.profileName, 'browser_identity_invalid');
      profileValues.push(source.profileName);
    }
  }
  if (profileValues.length === 0) fail('browser_identity_missing', '浏览器身份缺少 Profile 元数据');
  if (new Set(profileValues).size !== 1) {
    fail('browser_identity_invalid', '浏览器身份包含冲突的 Profile 元数据');
  }
  return { extensionInstanceId, profileName: profileValues[0] };
}

function checkRuntimeScope(browserIdentity, expected) {
  // Some browser adapters echo the page scope in their metadata. If present,
  // it is evidence to check, never a source of the requested scope.
  const sources = [browserIdentity, browserIdentity.metadata];
  const fields = [
    ['account_id', 'accountId', 'browser_binding_account_mismatch'],
    ['advertiser_id', 'advertiserId', 'browser_binding_advertiser_mismatch'],
    ['primary_ad_id', 'primaryAdId', 'browser_binding_plan_mismatch'],
  ];
  for (const [snake, camel, code] of fields) {
    const values = [];
    for (const source of sources) {
      if (!isRecord(source)) continue;
      for (const key of [snake, camel]) {
        if (Object.hasOwn(source, key)) {
          requireNonEmptyString(source[key], 'browser_identity_invalid');
          values.push(source[key]);
        }
      }
    }
    if (values.length > 0 && (new Set(values).size !== 1 || values[0] !== expected[snake])) {
      fail(code, '浏览器身份与请求绑定不匹配');
    }
  }
}

function validateRequestedBinding(binding) {
  if (!isRecord(binding) || !hasOnlyKeys(binding, REQUEST_KEYS)) {
    fail('browser_binding_invalid', '请求绑定格式无效');
  }
  for (const key of ['account_id', 'advertiser_id', 'primary_ad_id']) {
    requireNonEmptyString(binding[key], 'browser_binding_invalid');
  }
  for (const key of ['browser_type', 'extension_instance_id', 'profile_name', 'status']) {
    if (Object.hasOwn(binding, key)) requireNonEmptyString(binding[key], 'browser_binding_invalid');
  }
  if (Object.hasOwn(binding, 'browser_type') && binding.browser_type !== 'extension') {
    fail('browser_binding_type_mismatch', '请求绑定不是扩展类型');
  }
  if (Object.hasOwn(binding, 'status') && binding.status !== 'active') {
    fail('browser_binding_inactive', '请求绑定未处于 active 状态');
  }
}

/**
 * Read and strictly validate the local Chrome extension binding registry.
 * This function has no write, logging, browser, network, or credential access.
 */
function loadBrowserBindings(file) {
  if (!nonEmptyString(file)) fail('browser_bindings_unreadable', '浏览器绑定登记文件不可读');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    fail('browser_bindings_unreadable', '浏览器绑定登记文件不可读');
  }
  let registry;
  try {
    registry = JSON.parse(String(text).replace(/^\uFEFF/, ''));
  } catch {
    fail('browser_bindings_invalid_json', '浏览器绑定登记不是合法 JSON');
  }
  return validateRegistry(registry);
}

/**
 * Verify one requested read binding against the complete local registry and
 * the current runtime browser metadata. Runtime browser IDs are evidence only;
 * they are never looked up in or persisted to the registry.
 */
function validateBrowserBinding(registry, binding, browserIdentity) {
  validateRegistry(registry);
  validateRequestedBinding(binding);
  if (!isRecord(browserIdentity)) fail('browser_identity_invalid', '浏览器身份格式无效');

  const accountEntries = registry.bindings.filter(entry => entry.account_id === binding.account_id);
  if (accountEntries.length === 0) fail('browser_binding_account_mismatch', '请求账户没有已登记浏览器绑定');
  const matches = registry.schema_version === 1
    ? accountEntries
      .filter(entry => entry.advertiser_id === binding.advertiser_id)
      .filter(entry => entry.primary_ad_id === binding.primary_ad_id)
    : accountEntries.filter(entry => entry.advertisers.some(scope =>
      scope.advertiser_id === binding.advertiser_id && scope.primary_ad_ids.includes(binding.primary_ad_id)));
  if (matches.length === 0) {
    const hasAdvertiser = registry.schema_version === 1
      ? accountEntries.some(entry => entry.advertiser_id === binding.advertiser_id)
      : accountEntries.some(entry => entry.advertisers.some(scope => scope.advertiser_id === binding.advertiser_id));
    fail(hasAdvertiser ? 'browser_binding_plan_mismatch' : 'browser_binding_advertiser_mismatch',
      hasAdvertiser ? '请求主计划与登记不匹配' : '请求广告户与登记不匹配');
  }
  if (matches.length !== 1) fail('browser_bindings_ambiguous', '请求绑定匹配多个登记项');
  const entry = matches[0];

  if (Object.hasOwn(binding, 'extension_instance_id')
    && binding.extension_instance_id !== entry.extension_instance_id) {
    fail('browser_binding_instance_mismatch', '请求扩展实例与登记不匹配');
  }
  if (Object.hasOwn(binding, 'profile_name') && binding.profile_name !== entry.profile_name) {
    fail('browser_binding_profile_mismatch', '请求 Profile 与登记不匹配');
  }

  readRuntimeType(browserIdentity);
  const runtimeBrowserId = readRuntimeBrowserId(browserIdentity);
  const runtime = readRuntimeMetadata(browserIdentity);
  checkRuntimeScope(browserIdentity, binding);
  if (runtime.extensionInstanceId !== entry.extension_instance_id) {
    fail('browser_binding_instance_mismatch', '当前扩展实例与登记不匹配');
  }
  if (runtime.profileName !== entry.profile_name) {
    fail('browser_binding_profile_mismatch', '当前 Profile 与登记不匹配');
  }

  const identity = {
    account_id: binding.account_id,
    advertiser_id: binding.advertiser_id,
    primary_ad_id: binding.primary_ad_id,
    browser_type: entry.browser_type,
    extension_instance_id: entry.extension_instance_id,
    profile_name: entry.profile_name,
    status: entry.status,
  };
  return {
    ok: true,
    verified: true,
    identity,
    binding: { ...identity },
    evidence: {
      browser_id: runtimeBrowserId,
      browser_id_scope: 'runtime_only',
      extension_instance_id: runtime.extensionInstanceId,
      profile_name: runtime.profileName,
    },
  };
}

module.exports = { loadBrowserBindings, validateBrowserBinding };
