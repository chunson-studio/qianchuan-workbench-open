'use strict';

const fs = require('fs');
const path = require('path');
const { normalizeRoiBasis } = require('./roiBasis');

const PROFILE_VERSION = '2.0';
const EXECUTION_MODES = Object.freeze([
  'agent_decides',
  'recommendation_only',
  'confirm_writes',
  'auto_guarded',
]);

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function calibrationValue(value = null, { sampleSize = false } = {}) {
  return {
    value,
    ...(sampleSize ? { sample_size: null } : {}),
    source: null,
    updated_at: null,
  };
}

function buildDefaultProfile(account = {}) {
  return {
    profile_version: PROFILE_VERSION,
    account: {
      id: account.id || null,
      name: account.name || account.id || null,
      aavid: account.aavid == null ? null : String(account.aavid),
      anchor_id: account.anchorId || account.anchor_id || null,
      primary_ad_id: account.primaryAdId || account.primary_ad_id || null,
      timezone: 'Asia/Shanghai',
    },
    metrics: {
      roi_basis: 'unknown',
      break_even_roi: null,
      profit_roi: null,
      risk_floor_roi: null,
      avg_order_price: null,
    },
    funnel_baseline: {
      window_days: 14,
      stages: {
        paid_entry_rate: calibrationValue(null, { sampleSize: true }),
        stay_rate: calibrationValue(null, { sampleSize: true }),
        product_click_rate: calibrationValue(null, { sampleSize: true }),
        payment_rate: calibrationValue(null, { sampleSize: true }),
        settlement_rate: calibrationValue(null, { sampleSize: true }),
        refund_rate: calibrationValue(null, { sampleSize: true }),
      },
    },
    channel_baseline: {
      window_days: 14,
      // 动态 code 由真实接口给出；默认不预置、也不猜 Feed/自然流等标签。
      by_code: {},
    },
    flow: {
      unit: 'yuan_per_hour',
      window_days: 14,
      slots: {},
      sustainable_capacity: {
        basic: calibrationValue(null, { sampleSize: true }),
        assist: calibrationValue(null, { sampleSize: true }),
        total: calibrationValue(null, { sampleSize: true }),
      },
    },
    sample_thresholds: {
      min_spend_yuan: calibrationValue(),
      min_clicks: calibrationValue(),
      min_orders: calibrationValue(),
    },
    comparability: {
      anchor_ids: calibrationValue(),
      product_ids: calibrationValue(),
      price_mechanisms: calibrationValue(),
      time_slots: calibrationValue(),
    },
    bidding: { roi_lock_minutes: 30, max_single_change_ratio: 0.1 },
    safety: {
      mode: 'agent_decides',
      protected_object_ids: [],
      manual_disabled_object_ids: [],
    },
    calibration: {
      status: 'draft',
      account_specific: true,
      calibrated_at: null,
      confirmed_by: null,
      sources: ['runtime_config'],
      notes: '新账号草案：基线、保本线、排班和主计划待补充；由 Agent 结合用户指令与当前证据决策。',
    },
  };
}

function firstDefined(object, keys) {
  if (!object || typeof object !== 'object') return undefined;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(object, key) && object[key] != null) return object[key];
  }
  return undefined;
}

function normalizeCalibrationValue(value, { sampleSize = false } = {}) {
  if (value && typeof value === 'object' && !Array.isArray(value)
      && Object.prototype.hasOwnProperty.call(value, 'value')) {
    return {
      ...clone(value),
      value: value.value == null ? null : clone(value.value),
      ...(sampleSize ? { sample_size: value.sample_size == null ? null : value.sample_size } : {}),
      source: value.source == null ? null : String(value.source),
      updated_at: value.updated_at == null ? null : String(value.updated_at),
    };
  }
  if (value != null) {
    return {
      value: clone(value),
      ...(sampleSize ? { sample_size: null } : {}),
      source: 'legacy_profile',
      updated_at: null,
    };
  }
  return calibrationValue(null, { sampleSize });
}

function normalizeStage(stage, fallbackSampleSize) {
  const normalized = normalizeCalibrationValue(stage, { sampleSize: true });
  if (normalized.sample_size == null && fallbackSampleSize != null) {
    normalized.sample_size = fallbackSampleSize;
  }
  return normalized;
}

function normalizeChannelRecord(record) {
  const value = record && typeof record === 'object' && !Array.isArray(record) ? clone(record) : {};
  return {
    ...value,
    watch_share_pct: value.watch_share_pct == null ? null : value.watch_share_pct,
    pay_share_pct: value.pay_share_pct == null ? null : value.pay_share_pct,
    sample_size: value.sample_size == null ? null : value.sample_size,
    source: value.source == null ? null : String(value.source),
    updated_at: value.updated_at == null ? null : String(value.updated_at),
  };
}

function legacyRoiBasis(value) {
  const normalized = normalizeRoiBasis(value);
  if (normalized) return normalized;
  // 本项目旧版 settlement_net 实际读取的是平台 1h 净成交回流；迁移时明确收窄，
  // 绝不把它提升为 final_settlement。
  if (String(value || '').trim().toLowerCase() === 'settlement_net') return 'platform_net_1h';
  return 'unknown';
}

function normalizeAccountProfile(input, fallbackAccount = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? clone(input) : {};
  const defaults = buildDefaultProfile(fallbackAccount);
  const oldVersion = source.profile_version == null ? null : String(source.profile_version);

  const oldMetrics = source.metrics && typeof source.metrics === 'object' ? source.metrics : {};
  const oldFlow = source.flow && typeof source.flow === 'object' ? source.flow : {};
  const oldFunnel = source.funnel_baseline && typeof source.funnel_baseline === 'object'
    ? source.funnel_baseline
    : source.funnel && typeof source.funnel === 'object'
      ? (source.funnel.baseline || source.funnel)
      : {};
  const oldStages = oldFunnel.stages && typeof oldFunnel.stages === 'object' ? oldFunnel.stages : oldFunnel;
  const commonFunnelSample = firstDefined(oldFunnel, ['sample_size', 'samples', 'sample_count']);
  const oldChannelBaseline = source.channel_baseline && typeof source.channel_baseline === 'object'
    ? source.channel_baseline
    : source.channels && typeof source.channels === 'object' && source.channels.baseline && typeof source.channels.baseline === 'object'
      ? source.channels.baseline
      : {};
  const oldChannelCodes = oldChannelBaseline.by_code && typeof oldChannelBaseline.by_code === 'object'
    ? oldChannelBaseline.by_code
    : {};
  const oldCapacity = oldFlow.sustainable_capacity && typeof oldFlow.sustainable_capacity === 'object'
    ? oldFlow.sustainable_capacity
    : oldFlow.capacity && typeof oldFlow.capacity === 'object'
      ? oldFlow.capacity
      : {};
  const oldThresholds = source.sample_thresholds && typeof source.sample_thresholds === 'object'
    ? source.sample_thresholds
    : {};
  const oldComparability = source.comparability && typeof source.comparability === 'object'
    ? source.comparability
    : {};
  const oldSafety = source.safety && typeof source.safety === 'object' ? source.safety : {};
  const safeMode = 'agent_decides';
  const oldAccount = source.account && typeof source.account === 'object' ? source.account : {};

  const normalized = {
    ...defaults,
    ...source,
    profile_version: PROFILE_VERSION,
    account: {
      ...defaults.account,
      ...oldAccount,
      id: fallbackAccount.id || oldAccount.id || defaults.account.id,
      name: fallbackAccount.name || oldAccount.name || defaults.account.name,
      aavid: fallbackAccount.aavid != null && fallbackAccount.aavid !== ''
        ? String(fallbackAccount.aavid)
        : oldAccount.aavid == null ? defaults.account.aavid : String(oldAccount.aavid),
      anchor_id: fallbackAccount.anchorId || fallbackAccount.anchor_id || oldAccount.anchor_id || defaults.account.anchor_id,
      primary_ad_id: fallbackAccount.primaryAdId || fallbackAccount.primary_ad_id || oldAccount.primary_ad_id || defaults.account.primary_ad_id,
      timezone: oldAccount.timezone || defaults.account.timezone,
    },
    metrics: {
      ...defaults.metrics,
      ...oldMetrics,
      roi_basis: legacyRoiBasis(oldMetrics.roi_basis),
    },
    funnel_baseline: {
      ...defaults.funnel_baseline,
      ...oldFunnel,
      window_days: Number.isFinite(Number(oldFunnel.window_days)) && Number(oldFunnel.window_days) > 0
        ? Number(oldFunnel.window_days)
        : defaults.funnel_baseline.window_days,
      stages: {
        paid_entry_rate: normalizeStage(firstDefined(oldStages, ['paid_entry_rate', 'entry_rate', 'watch_entry_rate']), commonFunnelSample),
        stay_rate: normalizeStage(firstDefined(oldStages, ['stay_rate', 'retention_rate']), commonFunnelSample),
        product_click_rate: normalizeStage(firstDefined(oldStages, ['product_click_rate', 'click_rate']), commonFunnelSample),
        payment_rate: normalizeStage(firstDefined(oldStages, ['payment_rate', 'pay_rate']), commonFunnelSample),
        settlement_rate: normalizeStage(firstDefined(oldStages, ['settlement_rate', 'settle_rate']), commonFunnelSample),
        refund_rate: normalizeStage(firstDefined(oldStages, ['refund_rate']), commonFunnelSample),
      },
    },
    channel_baseline: {
      ...defaults.channel_baseline,
      ...oldChannelBaseline,
      window_days: Number.isFinite(Number(oldChannelBaseline.window_days)) && Number(oldChannelBaseline.window_days) > 0
        ? Number(oldChannelBaseline.window_days)
        : defaults.channel_baseline.window_days,
      by_code: Object.fromEntries(Object.entries(oldChannelCodes).map(([code, record]) => [
        String(code),
        normalizeChannelRecord(record),
      ])),
    },
    flow: {
      ...defaults.flow,
      ...oldFlow,
      unit: oldFlow.unit || defaults.flow.unit,
      window_days: Number.isFinite(Number(oldFlow.window_days)) && Number(oldFlow.window_days) > 0
        ? Number(oldFlow.window_days)
        : defaults.flow.window_days,
      slots: oldFlow.slots && typeof oldFlow.slots === 'object' ? oldFlow.slots : {},
      sustainable_capacity: {
        basic: normalizeCalibrationValue(firstDefined(oldCapacity, ['basic', 'base', 'primary', 'basic_flow', 'primary_flow']), { sampleSize: true }),
        assist: normalizeCalibrationValue(firstDefined(oldCapacity, ['assist', 'boost', 'assist_flow', 'boost_flow']), { sampleSize: true }),
        total: normalizeCalibrationValue(firstDefined(oldCapacity, ['total', 'total_flow']), { sampleSize: true }),
      },
    },
    sample_thresholds: {
      min_spend_yuan: normalizeCalibrationValue(firstDefined(oldThresholds, ['min_spend_yuan', 'min_spend', 'min_cost'])),
      min_clicks: normalizeCalibrationValue(firstDefined(oldThresholds, ['min_clicks', 'clicks'])),
      min_orders: normalizeCalibrationValue(firstDefined(oldThresholds, ['min_orders', 'orders'])),
    },
    comparability: {
      anchor_ids: normalizeCalibrationValue(firstDefined(oldComparability, ['anchor_ids', 'anchors', 'anchor'])),
      product_ids: normalizeCalibrationValue(firstDefined(oldComparability, ['product_ids', 'products', 'product'])),
      price_mechanisms: normalizeCalibrationValue(firstDefined(oldComparability, ['price_mechanisms', 'pricing', 'price'])),
      time_slots: normalizeCalibrationValue(firstDefined(oldComparability, ['time_slots', 'slots', 'dayparts'])),
    },
    bidding: { ...defaults.bidding, ...(source.bidding || {}) },
    safety: {
      ...defaults.safety,
      ...oldSafety,
      mode: safeMode,
      protected_object_ids: Array.isArray(oldSafety.protected_object_ids) ? oldSafety.protected_object_ids : [],
      manual_disabled_object_ids: Array.isArray(oldSafety.manual_disabled_object_ids) ? oldSafety.manual_disabled_object_ids : [],
    },
    calibration: { ...defaults.calibration, ...(source.calibration || {}) },
  };

  // 迁移记录只描述事实，不虚构校准时间或来源时间。
  if (oldVersion !== PROFILE_VERSION) {
    const existing = normalized.calibration.profile_migration && typeof normalized.calibration.profile_migration === 'object'
      ? normalized.calibration.profile_migration
      : {};
    normalized.calibration.profile_migration = {
      ...existing,
      from_version: oldVersion,
      to_version: PROFILE_VERSION,
      legacy_roi_basis: oldMetrics.roi_basis == null ? null : String(oldMetrics.roi_basis),
      note: '旧字段已结构化迁移；缺失校准值保持 null，未补零、未伪造来源或更新时间。',
    };
  }

  return normalized;
}

function loadAccountProfile(accountId, options = {}) {
  const id = String(accountId || '').trim();
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) return null;
  const runtimeConfig = options.profileDir ? null : require('./config');
  const profileDir = options.profileDir || runtimeConfig.ACCOUNT_PROFILES_DIR;
  const configuredAccount = options.fallbackAccount || (runtimeConfig && runtimeConfig.QIANCHUAN_ACCOUNTS || [])
    .find(account => account && account.id === id) || {};
  const profilePath = path.join(profileDir, `${id}.json`);
  try {
    const parsed = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    return normalizeAccountProfile(parsed, {
      id,
      name: configuredAccount.name,
      aavid: configuredAccount.aavid,
      anchorId: configuredAccount.anchorId,
      primaryAdId: configuredAccount.primary_ad_id,
    });
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    // 读取函数不暴露文件内容或 Cookie；解析错误由调用方决定降级方式。
    throw error;
  }
}

function safeCloneProfileValue(value) {
  if (value == null || typeof value !== 'object') return clone(value);
  if (Array.isArray(value)) return value.map(safeCloneProfileValue);
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/(?:cookie|token|secret|password|authorization|csrf|sessionid|aavid)/i.test(key))
    .map(([key, child]) => [key, safeCloneProfileValue(child)]));
}

function publicCalibrationValue(value, { sampleSize = false } = {}) {
  const normalized = normalizeCalibrationValue(value, { sampleSize });
  return {
    value: safeCloneProfileValue(normalized.value),
    ...(sampleSize ? { sample_size: normalized.sample_size == null ? null : normalized.sample_size } : {}),
    source: normalized.source,
    updated_at: normalized.updated_at,
  };
}

// MCP/决策盘面只应读取这一安全子集。Profile 可保留向后兼容扩展，但扩展字段、
// aavid 与任何疑似凭证键都不能穿过只读工具边界。
function toDecisionProfile(profile) {
  const normalized = normalizeAccountProfile(profile, profile && profile.account || {});
  const stages = normalized.funnel_baseline.stages || {};
  const channelCodes = normalized.channel_baseline.by_code || {};
  const capacity = normalized.flow.sustainable_capacity || {};
  const thresholds = normalized.sample_thresholds || {};
  const comparability = normalized.comparability || {};
  const preflight = normalized.preflight && typeof normalized.preflight === 'object'
    ? normalized.preflight
    : {};
  const capabilities = preflight.capabilities && typeof preflight.capabilities === 'object'
    ? preflight.capabilities
    : {};
  const discovered = preflight.discovered && typeof preflight.discovered === 'object'
    ? preflight.discovered
    : {};

  return {
    profile_version: normalized.profile_version,
    status: normalized.calibration && normalized.calibration.status || null,
    execution_mode: 'agent_decides',
    account: {
      id: normalized.account.id,
      name: normalized.account.name,
      anchor_id: normalized.account.anchor_id,
      primary_ad_id: normalized.account.primary_ad_id,
      timezone: normalized.account.timezone,
    },
    metrics: {
      roi_basis: normalized.metrics.roi_basis,
      break_even_roi: normalized.metrics.break_even_roi,
      break_even_roi_basis: normalized.metrics.break_even_roi_basis || normalized.metrics.roi_basis,
      profit_roi: normalized.metrics.profit_roi,
      risk_floor_roi: normalized.metrics.risk_floor_roi,
      avg_order_price: normalized.metrics.avg_order_price,
    },
    operating: {
      objective: normalized.operating?.objective ?? null,
      target_roi: normalized.operating?.target_roi ?? null,
      roi_basis: normalized.operating?.roi_basis || 'unknown',
      daily_budget_yuan: normalized.operating?.daily_budget_yuan ?? null,
      session_budget_yuan: normalized.operating?.session_budget_yuan ?? null,
      test_loss_limit_yuan: normalized.operating?.test_loss_limit_yuan ?? null,
      notifications: normalized.operating?.notifications || null,
      source: normalized.operating?.source || null,
      updated_at: normalized.operating?.updated_at || null,
    },
    onboarding: {
      state: normalized.onboarding?.state || null,
      requested_mode: normalized.onboarding?.authorization?.requested_mode || null,
      effective_mode: 'agent_decides',
      allowed_actions: normalized.onboarding?.authorization?.allowed_actions || [],
      forbidden_actions: normalized.onboarding?.authorization?.forbidden_actions || [],
      write_blockers: [],
    },
    funnel_baseline: {
      window_days: normalized.funnel_baseline.window_days,
      stages: Object.fromEntries([
        'paid_entry_rate', 'stay_rate', 'product_click_rate',
        'payment_rate', 'settlement_rate', 'refund_rate',
      ].map(key => [key, publicCalibrationValue(stages[key], { sampleSize: true })])),
    },
    channel_baseline: {
      window_days: normalized.channel_baseline.window_days,
      by_code: Object.fromEntries(Object.entries(channelCodes).map(([code, record]) => [
        code,
        {
          watch_share_pct: record.watch_share_pct == null ? null : record.watch_share_pct,
          pay_share_pct: record.pay_share_pct == null ? null : record.pay_share_pct,
          sample_size: record.sample_size == null ? null : record.sample_size,
          source: record.source == null ? null : String(record.source),
          updated_at: record.updated_at == null ? null : String(record.updated_at),
        },
      ])),
    },
    flow: {
      unit: normalized.flow.unit,
      window_days: normalized.flow.window_days,
      slots: safeCloneProfileValue(normalized.flow.slots || {}),
      sustainable_capacity: {
        basic: publicCalibrationValue(capacity.basic, { sampleSize: true }),
        assist: publicCalibrationValue(capacity.assist, { sampleSize: true }),
        total: publicCalibrationValue(capacity.total, { sampleSize: true }),
      },
    },
    sample_thresholds: {
      min_spend_yuan: publicCalibrationValue(thresholds.min_spend_yuan),
      min_clicks: publicCalibrationValue(thresholds.min_clicks),
      min_orders: publicCalibrationValue(thresholds.min_orders),
    },
    comparability: {
      anchor_ids: publicCalibrationValue(comparability.anchor_ids),
      product_ids: publicCalibrationValue(comparability.product_ids),
      price_mechanisms: publicCalibrationValue(comparability.price_mechanisms),
      time_slots: publicCalibrationValue(comparability.time_slots),
    },
    preflight: {
      checked_at: preflight.checked_at == null ? null : String(preflight.checked_at),
      capabilities: Object.fromEntries(Object.entries(capabilities).map(([name, value]) => {
        const capability = value && typeof value === 'object' ? value : {};
        return [name, {
          state: capability.state == null ? null : String(capability.state),
          reason: capability.reason == null ? null : String(capability.reason),
          code: capability.code == null ? null : String(capability.code),
        }];
      })),
      discovered: {
        anchorId: discovered.anchorId == null ? null : String(discovered.anchorId),
        primaryAdId: discovered.primaryAdId == null ? null : String(discovered.primaryAdId),
      },
    },
  };
}

module.exports = {
  EXECUTION_MODES,
  PROFILE_VERSION,
  buildDefaultProfile,
  loadAccountProfile,
  normalizeAccountProfile,
  toDecisionProfile,
};
