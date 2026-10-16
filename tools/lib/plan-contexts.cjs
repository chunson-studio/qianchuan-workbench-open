'use strict';

const fs = require('node:fs');

const ROOT_KEYS = ['schema_version', 'contexts'];
const CONTEXT_KEYS = [
  'context_id',
  'account_id',
  'advertiser_id',
  'account_name',
  'plan_id',
  'plan_type',
  'product_name',
  'douyin_account_id',
  'roi_metric',
  'platform_target_roi',
  'operating_target_roi',
  'live_room_id',
  'browser_profile_name',
  'status',
  'source_note',
];
const PLAN_TYPES = new Set(['quan_yu', 'cheng_fang', 'unknown']);
const STATUSES = new Set(['verified', 'pending']);
const ROI_METRICS = new Set(['comprehensive_roi', 'payment_roi', 'net_roi', 'unknown']);
const PLAN_ROI_METRICS = new Map([
  ['quan_yu', 'payment_roi'],
  ['cheng_fang', 'comprehensive_roi'],
]);

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
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

function requireString(value, field) {
  if (!nonEmptyString(value)) fail('plan_contexts_invalid', `${field} 必须是非空字符串`);
}

function requireNullableString(value, field) {
  if (value !== null) requireString(value, field);
}

function requireRoi(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail('plan_contexts_invalid', `${field} 必须是非负有限数字`);
  }
}

function validateContext(context) {
  if (!isRecord(context) || !hasOnlyKeys(context, CONTEXT_KEYS)
    || Object.keys(context).length !== CONTEXT_KEYS.length) {
    fail('plan_contexts_invalid', '计划上下文字段不完整或包含未知字段');
  }
  for (const field of ['context_id', 'account_id', 'advertiser_id', 'account_name', 'plan_id', 'product_name', 'douyin_account_id', 'roi_metric', 'source_note']) {
    requireString(context[field], field);
  }
  if (context.context_id !== `${context.account_id}|plan_${context.plan_id}`) {
    fail('plan_contexts_invalid', 'context_id 必须绑定 account_id 和 plan_id');
  }
  if (!/^\d+$/.test(context.advertiser_id)) fail('plan_contexts_invalid', 'advertiser_id 必须是数字字符串');
  if (!/^\d+$/.test(context.plan_id)) fail('plan_contexts_invalid', 'plan_id 必须是数字字符串');
  if (!PLAN_TYPES.has(context.plan_type)) fail('plan_contexts_invalid', 'plan_type 无效');
  if (!STATUSES.has(context.status)) fail('plan_contexts_invalid', 'status 无效');
  if (!ROI_METRICS.has(context.roi_metric)) fail('plan_contexts_invalid', 'roi_metric 无效');
  if (PLAN_ROI_METRICS.has(context.plan_type) && context.roi_metric !== PLAN_ROI_METRICS.get(context.plan_type)) {
    fail('plan_contexts_invalid', 'plan_type 与 roi_metric 不匹配');
  }
  if (context.plan_type === 'unknown' && context.roi_metric !== 'unknown') {
    fail('plan_contexts_invalid', '未知计划类型只能使用 unknown roi_metric');
  }
  if (context.platform_target_roi !== null) requireRoi(context.platform_target_roi, 'platform_target_roi');
  if (context.status === 'verified' && context.platform_target_roi === null) {
    fail('plan_contexts_invalid', 'verified 计划必须有 platform_target_roi');
  }
  if (context.operating_target_roi !== null) requireRoi(context.operating_target_roi, 'operating_target_roi');
  requireNullableString(context.live_room_id, 'live_room_id');
  requireNullableString(context.browser_profile_name, 'browser_profile_name');
  return context;
}

function validatePlanContexts(registry) {
  if (!isRecord(registry) || !hasOnlyKeys(registry, ROOT_KEYS)
    || Object.keys(registry).length !== ROOT_KEYS.length
    || registry.schema_version !== 1 || !Array.isArray(registry.contexts)
    || registry.contexts.length === 0) {
    fail('plan_contexts_invalid', '计划上下文登记格式无效');
  }
  const ids = new Set();
  const planIds = new Set();
  for (const context of registry.contexts) {
    validateContext(context);
    if (ids.has(context.context_id)) fail('plan_contexts_ambiguous', '计划上下文 context_id 重复');
    if (planIds.has(context.plan_id)) fail('plan_contexts_ambiguous', '计划 ID 重复登记');
    ids.add(context.context_id);
    planIds.add(context.plan_id);
  }
  return registry;
}

/**
 * Read-only loader for private plan metadata. It never writes, logs, opens a
 * browser, or reaches the network.
 */
function loadPlanContexts(file) {
  if (!nonEmptyString(file)) fail('plan_contexts_unreadable', '计划上下文登记文件不可读');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    fail('plan_contexts_unreadable', '计划上下文登记文件不可读');
  }
  let registry;
  try {
    registry = JSON.parse(String(text).replace(/^\uFEFF/, ''));
  } catch {
    fail('plan_contexts_invalid_json', '计划上下文登记不是合法 JSON');
  }
  return validatePlanContexts(registry);
}

module.exports = { loadPlanContexts, validatePlanContexts };
