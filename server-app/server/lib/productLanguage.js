'use strict';

const ALERTS = Object.freeze({
  MATERIAL_HIGH_SPEND_LOW_RETURN: Object.freeze({ label: '高消耗低回报', severity: 'action_needed' }),
  ROI_BELOW_TARGET: Object.freeze({ label: 'ROI持续低于目标', severity: 'action_needed' }),
  SPEND_WITHOUT_CONVERSION: Object.freeze({ label: '消耗增长但成交未增长', severity: 'attention' }),
  MATERIAL_DECLINING: Object.freeze({ label: '素材表现持续下降', severity: 'attention' }),
  DATA_STALE: Object.freeze({ label: '数据更新延迟', severity: 'attention' }),
  DATA_PARTIAL: Object.freeze({ label: '部分数据暂不可用', severity: 'attention' }),
  COOKIE_EXPIRED: Object.freeze({ label: '登录状态失效', severity: 'action_needed' }),
  UPSTREAM_RATE_LIMITED: Object.freeze({ label: '上游请求受限', severity: 'attention' }),
  DB_BUSY: Object.freeze({ label: '本地数据暂时繁忙', severity: 'attention' }),
});

const LEGACY_CODE_MAP = Object.freeze({
  material_bleeding_suggest: 'MATERIAL_HIGH_SPEND_LOW_RETURN',
  material_bleeding: 'MATERIAL_HIGH_SPEND_LOW_RETURN',
  bleeding: 'MATERIAL_HIGH_SPEND_LOW_RETURN',
  boost_stoploss_suggest: 'ROI_BELOW_TARGET',
  cookie_expired: 'COOKIE_EXPIRED',
  rate_limited: 'UPSTREAM_RATE_LIMITED',
  db_busy: 'DB_BUSY',
  data_stale: 'DATA_STALE',
  partial: 'DATA_PARTIAL',
});

const PUBLIC_TEXT_REPLACEMENTS = Object.freeze([
  [/持续出血候选/g, '持续高消耗低回报'],
  [/当日出血观察/g, '当日高消耗低回报观察'],
  [/素材出血建议/g, '素材低效建议'],
  [/出血评估/g, '低效评估'],
  [/连续出血升级/g, '连续低回报时升级关注'],
  [/出血口/g, '低效状态'],
  [/出血/g, '高消耗低回报'],
  [/判死/g, '判定停止'],
  [/烂穿线/g, '严重低效线'],
  [/劣质档/g, '低效档'],
]);

function normalizeAlertCode(code) {
  const raw = String(code || '').trim();
  if (!raw) return 'UNKNOWN_ALERT';
  if (ALERTS[raw]) return raw;
  return LEGACY_CODE_MAP[raw.toLowerCase()] || raw.toUpperCase();
}

function getAlertMeta(code) {
  const normalized = normalizeAlertCode(code);
  const meta = ALERTS[normalized] || { label: '需要关注', severity: 'attention' };
  return { code: normalized, label: meta.label, severity: meta.severity };
}

function toPublicText(text) {
  let out = text == null ? '' : String(text);
  for (const [pattern, replacement] of PUBLIC_TEXT_REPLACEMENTS) out = out.replace(pattern, replacement);
  return out;
}

function normalizeAlert(alert, options = {}) {
  const source = typeof alert === 'string' ? { message: alert } : (alert || {});
  const meta = getAlertMeta(source.code || source.type || source.action || source.action_type);
  const rawMessage = source.message || source.msg || source.error || source.reason || '';
  return {
    ...meta,
    ...Object.fromEntries(['target_id', 'target_type', 'task_id', 'material_id', 'assist_task_id', 'account_id', 'window', 'source_at', 'metric', 'value', 'threshold', 'evidence', 'level'].filter(key => source[key] != null).map(key => [key, source[key]])),
    ...(source.task_id && !source.target_id ? { target_id: String(source.task_id), target_type: 'boost_task' } : {}),
    ...(rawMessage ? { message: toPublicText(rawMessage) } : {}),
    ...(source.component ? { component: String(source.component) } : {}),
    ...(source.retryable === true ? { retryable: true } : {}),
    ...(options.includeRaw && rawMessage ? { raw_message: String(rawMessage) } : {}),
  };
}

function alertKey(alert) {
  const { contentVersion } = require('./watchContract');
  return contentVersion(alert);
}

function normalizeAlerts(alerts) {
  const unique = new Map();
  for (const raw of alerts || []) {
    const alert = normalizeAlert(raw);
    // Unstructured placeholders carry no actionable information.
    if (alert.code === 'UNKNOWN_ALERT' && !alert.message && !alert.evidence) continue;
    const id = alertKey(alert);
    unique.set(id, { ...alert, alert_id: id });
  }
  return [...unique.values()];
}

module.exports = {
  ALERTS,
  normalizeAlertCode,
  getAlertMeta,
  toPublicText,
  normalizeAlert,
  normalizeAlerts,
  alertKey,
};
