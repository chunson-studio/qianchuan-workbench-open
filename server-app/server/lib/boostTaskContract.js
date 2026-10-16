'use strict';
const { finiteNumber: n } = require('./dataContract');
const { safeActionLimits, resumeProtection } = require('./actionLimits');
const { reconcileFinancial } = require('./watchContract');
const { readBoostDuration } = require('./boostDuration');
const { boostListFunnel } = require('./boostFunnel');

function requestedSessionStart(sessionKey, sessionStartTime) {
  const raw = sessionStartTime ?? (typeof sessionKey === 'string' ? sessionKey.split('|').at(-1) : null);
  const at = Date.parse(raw || '');
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

function boostTaskContract(raw, task, { accountId, sourceAt = null, start = null, end = null, sessionKey = null, sessionStartTime = null } = {}) {
  const bid = n(raw.bid);
  const operations = raw.assistTaskInfoMap && raw.assistTaskInfoMap['2'] && raw.assistTaskInfoMap['2'].operation || {};
  const permission = key => operations[key] && typeof operations[key].editable === 'boolean' ? operations[key].editable : null;
  const window = { start, end, scope: 'date_range' };
  const financial = reconcileFinancial({ spend: n(task.cost), payment_gmv: n(task.gmv), payment_roi: n(task.roi),
    net_gmv: n(task.net_gmv), net_roi: n(task.net_roi), orders: n(task.order_count) }, {}, window);
  const actionLimits = safeActionLimits(accountId, task.id);
  const actions = {};
  for (const [action, upstream] of Object.entries({ pause: operations.pause ? 'pause' : 'stop', resume: 'start', update_budget: 'edit', update_duration: 'edit', update_bid: 'edit', update_roi: 'edit', update_audience: 'edit', delete: 'delete' })) {
    const local = actionLimits[action];
    const upstreamAllowed = permission(upstream);
    const resume = action === 'resume' ? resumeProtection(accountId, task.id, task.status || raw.status, task.passive_stop) : null;
    const protection = resume?.allowed === false;
    actions[action] = { allowed: protection || upstreamAllowed === false || local && !local.allowed ? false : null,
      upstream_allowed: upstreamAllowed, local_allowed: local ? local.allowed : null,
      reason: protection ? resume.reason : upstreamAllowed === false
        ? (operations[upstream].reason || operations[upstream].message || 'upstream_action_blocked')
        : local && !local.allowed ? local.reason : 'write_precheck_required' };
  }
  // Numeric budgetMode enums have not been verified as daily/lifetime. Do not guess.
  const budgetScope = ['daily', 'lifetime'].includes(raw.budgetScope) ? raw.budgetScope : 'unknown';
  const matchedSpend = budgetScope === 'daily' && start && start === end ? n(task.cost)
    : budgetScope === 'lifetime' ? n(raw.lifetimeCostCny) : null;
  const progress = n(task.budget) > 0 && matchedSpend != null ? +(matchedSpend / task.budget * 100).toFixed(2) : null;
  // The task/detail APIs expose daily windows, not native per-session financial
  // totals. A matching-looking key or create time is not sufficient evidence.
  const sessionMetrics = { session_key: sessionKey, data_valid: false,
    reason: 'native_session_metrics_unavailable',
    request_session_key: sessionKey || null,
    requested_start_time: requestedSessionStart(sessionKey, sessionStartTime),
    task_start_time: task.start_time || raw.startTime || raw.createTime || null,
    spend: null, payment_gmv: null, payment_roi: null, net_gmv: null, net_roi: null, orders: null };
  return { bid: bid == null ? null : bid / 100000, bid_unit: 'CNY/order',
    // Preserve the list parser's explicit unit/provenance. Unknown remains null; never
    // infer actual duration from a create request or from a field with an unknown unit.
    duration_seconds: task.duration_seconds ?? null,
    duration_unit: task.duration_unit || 'unknown',
    duration_source: task.duration_source || null,
    bid_mode: bid > 0 && Number(raw.smartBidType) === 0 ? 'manual_bid' : task.roi_goal > 0 ? 'roi' : 'unknown',
    status_code: n(raw.status), pause_reason: task.passive_stop || /暂停|未开播|预算不足/.test(task.status || '') ? task.status : null,
    source_at: sourceAt, window, action_limits: actionLimits, available_actions: actions,
    // 不向调用方暴露无法解释的预算枚举；只保留可直接使用的进度与预算结果。
    budget_progress_pct: progress,
    observed_period_budget_ratio_pct: n(task.budget) > 0 && n(task.cost) != null ? +(task.cost / task.budget * 100).toFixed(2) : null,
    budget_audit_required: progress == null || progress >= 85,
    budget_remaining: matchedSpend != null && n(task.budget) != null ? Math.max(0, +(task.budget - matchedSpend).toFixed(2)) : null,
    roi: financial.values.payment_roi, net_roi: financial.values.net_roi, financial_checks: financial.checks,
    period_metrics: financial.values,
    session_metrics: sessionMetrics,
  };
}
const { isPassiveStop } = require('./utils');
const { attachRoiGoalContract } = require('./roiBasis');
const BOOST_EFFECT_ROI_BASIS = Object.freeze({ roi: 'payment', net_roi: 'platform_net_1h' });
function metricValueOrNull(cell) {
  if (cell == null) return null;
  if (typeof cell === 'object' && cell.controlType != null && Number(cell.controlType) === 0) return null;
  const value = typeof cell === 'object'
    ? (cell.value != null ? cell.value : cell.Value != null ? cell.Value : cell.ValueStr)
    : cell;
  if (value == null || value === '') return null;
  const number = Number(String(value).replace(/,/g, '').replace(/%$/, ''));
  return Number.isFinite(number) ? number : null;
}


// 解析单个追投任务，提取投手需要的字段（含 assistAid/anchorId 供下游接口使用）
function parseTask(ad, planInfo, listResult, context = {}) {
  const stats = (listResult.data.adStatsMap && listResult.data.adStatsMap[ad.id] && listResult.data.adStatsMap[ad.id].metrics) || {};
  const assistInfo = ad.assistTaskInfoMap || {};
  const scene2 = assistInfo['2'] || {};
  const op = scene2.operation || {};
  const duration = readBoostDuration(ad);

  // 历史账户专用说明已从试用包移除。
  // cost_per_hour = 累计消耗 / 已运行小时数（create_time 起算）；无 create_time 或运行 <3 分钟时 null
  let costPerHour = null;
  const ct = ad.createTime ? new Date(String(ad.createTime).replace(' ', 'T')).getTime() : 0;
  if (ct > 0 && stats) {
    const hours = (Date.now() - ct) / 3600000;
    if (hours >= 0.05) {
      const c = metricValueOrNull(stats.statCostForRoi2Assist);
      costPerHour = c == null ? null : (c > 0 ? +(c / hours).toFixed(2) : 0);
    }
  }

  const task = {
    id: ad.id,
    assist_aid: String(ad.id),          // 供 /api/boost-overview 等接口的 assistAid 参数使用
    primary_ad_id: String(planInfo.id),  // 全域计划ID
    anchor_id: ad.anchorId || ad.authorId || (ad.audience && ad.audience.AuthorId) || null, // 主播ID
    name: ad.name,
    status: ad.adDeliveryName,
    passive_stop: isPassiveStop(ad.adDeliveryName), // 系统强停标记（任务预算不足/计划组超出预算/未开播——非手动暂停）
    create_time: ad.createTime,
    smart_bid_type: ad.smartBidType,
    budget: metricValueOrNull(ad.budget) == null ? null : metricValueOrNull(ad.budget) / 100000, // 微转元
    ...duration,
    roi_goal: metricValueOrNull(ad.ecpRoi2Goal),
    // ROI 目标口径只来自真实任务/计划元数据；识别不了就明确 unknown。
    // planInfo 只补充任务返回中可能缺失的计划级优化字段，不覆盖任务真值。
    ...attachRoiGoalContract({ ...(planInfo || {}), ...(ad || {}) }),
    // 历史账户专用说明已从试用包移除。
    cost_per_hour: costPerHour,
    // 消耗效果（adStatsMap metrics 用驼峰格式，值是 {value:xxx} 对象）
    cost: metricValueOrNull(stats.statCostForRoi2Assist),
    gmv: metricValueOrNull(stats.totalPayOrderGmvForRoi2Assist),
    roi: metricValueOrNull(stats.totalPrepayAndPayOrderRoi2Assist),
    // 历史账户专用说明已从试用包移除。
    // 注意键名大小写：1h 的 H 大写（Roi21HAssist，实测 adStatsMap 键表）
    net_roi: metricValueOrNull(stats.totalPrepayAndPaySettleRoi21HAssist),
    net_gmv: metricValueOrNull(stats.totalOrderSettleAmountForRoi21HAssist),
    // roi_goal_basis 描述“目标值按什么优化”；这里单独描述实际效果字段，二者禁止混用。
    metric_roi_basis: BOOST_EFFECT_ROI_BASIS,
    settlement_window: { net_roi: '1h' },
    refund_rate_1h: metricValueOrNull(stats.totalRefundOrderGmvForRoi21HRateAssist),
    order_count: metricValueOrNull(stats.totalPayOrderCountForRoi2Assist),
    show_cnt: metricValueOrNull(stats.showCntForRoi2Assist),
    click_cnt: metricValueOrNull(stats.clickCntForRoi2Assist),
    funnel: boostListFunnel(stats, context),
    // 操作权限
    can_start: !!(op.start && op.start.editable),
    can_edit: !!(op.edit && op.edit.editable),
    can_delete: !!(op.delete && op.delete.editable),
    can_view_stats: !!(op.statistics && op.statistics.editable),
  };
  return { ...task, ...boostTaskContract(ad, task, context) };
}


module.exports = { boostTaskContract, parseTask, metricValueOrNull };
