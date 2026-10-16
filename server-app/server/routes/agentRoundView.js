/**
  * 历史账户专用说明已从试用包移除。
 *
 * GET /api/agent-round-view?account=xx
 *
  * 历史账户专用说明已从试用包移除。
 * 本接口一次返回盯盘所需全部核心数据，白名单裁剪，目标 ≤5KB：
 *   - 盘面：isLive/today/balance/plan(roi_goal/quota_left)/thresholds(含 flow_baseline)
 *   - flow_hint：当前时段 + 该时段基线 median/p25（枯竭判定 ×40%/×80% 直接可用）
 *   - boosts：追投精简列表（含 net_roi/roi_goal/budget/protection 保护期状态）
  * 历史账户专用说明已从试用包移除。
 */
const { sendJSON, getLocalDateStr } = require('../lib/utils');
const { validateAccount } = require('../lib/api-helpers');
const { PORT } = require('../lib/config');
const qcTabs = require('../lib/qianchuanTabs');
const boostGuard = require('../lib/boostGuard');
const { SLOTS } = require('../lib/flowBaseline');
const { buildDataMeta } = require('../lib/dataContract');
const { normalizeFunnel, normalizeChannels, buildLiveFinancialBasis } = require('../lib/decisionContext');

async function localFetch(path, deadlineMs) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { signal: AbortSignal.timeout(deadlineMs) });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || body.ok === false) {
    const error = new Error(body && (body.error || body.message) || `HTTP ${res.status}`);
    error.code = body && body.code || (res.status === 504 ? 'timeout' : 'subrequest_failed');
    error.status = res.status;
    throw error;
  }
  return body;
}

function withDeadline(task, deadlineMs, component) {
  const controller = new AbortController();
  let timer;
  const error = new Error(`${component} 超过 ${deadlineMs}ms`);
  error.code = 'timeout';
  error.timeout_ms = deadlineMs;
  timer = setTimeout(() => controller.abort(error), deadlineMs);
  timer.unref?.();
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(controller.signal.reason || error);
    controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([Promise.resolve().then(() => task(controller.signal)), aborted])
    .finally(() => {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', onAbort);
    });
}

function settledValue(result, component, errors, options = {}) {
  if (result && result.status === 'fulfilled') return result.value;
  if (!options.optional) {
    const reason = result && result.reason || {};
    errors.push({
      code: reason.code || 'subrequest_failed',
      component,
      retryable: reason.code === 'timeout' || reason.status >= 500,
      ...(reason.timeout_ms ? { timeout_ms: reason.timeout_ms } : {}),
      message: reason.message || `${component} 取数失败`,
    });
  }
  return null;
}

const num = v => { const n = +v; return Number.isFinite(n) ? n : null; };

/** 当前小时所属时段（flowBaseline SLOTS 同口径） */
function currentSlot(now = new Date()) {
  const h = now.getHours();
  for (const s of SLOTS) if (h >= s.from && h < s.to) return s.key;
  return null;
}

/**
 * 组装盯盘轮聚合视图（纯函数，可单测——IO 全部经参数注入）。
 * @param {object} input - { dash, boostTasks, protectionMap, trend, now }
 */
function buildRoundView({ account, dash, boostTasks, errors = [], protectionMap, trend, marginal, now }) {
  const d = dash || {};
  const t = d.today || {};
  const bal = d.balance || {};
  const plan = d.plan || {};
  const th = d.thresholds || {};

  // 实时流速：trend 末 3 个 5 分钟点求和 = 近 15 分钟实际速率（未直播/无数据为 null）
  let currentRate = null;
  const pts = (trend || []).filter(p => Number.isFinite(+p.cost));
  if (pts.length >= 1) {
    currentRate = +pts.slice(-3).reduce((s, p) => s + (+p.cost || 0), 0).toFixed(2);
  }

  // 历史账户专用说明已从试用包移除。
  const slotKey = currentSlot(now);
  const fb = th.flow_baseline || null;
  const slotInfo = fb && fb.slots && slotKey ? fb.slots[slotKey] : null;
  const median = slotInfo ? slotInfo.median : null;
  const flow_hint = {
    slot: slotKey,
    slot_label: slotInfo ? slotInfo.label : null,
    median,
    p25: slotInfo ? slotInfo.p25 : null,
    samples: slotInfo ? slotInfo.samples : null,
    current_rate: currentRate,
    ratio_to_baseline: (currentRate != null && median > 0) ? +(currentRate / median).toFixed(2) : null,
    baseline_stale: fb ? !!fb.stale : null,
    unit: fb ? fb.unit : '元/15分钟',
    hourly: marginal ? {
      window_minutes: 15,
      total: (marginal.total_spend_rate_hour != null || marginal.spend_rate_hour != null)
        ? num(marginal.total_spend_rate_hour != null ? marginal.total_spend_rate_hour : marginal.spend_rate_hour)
        : null,
      basic: marginal.basic_spend_rate_hour != null ? num(marginal.basic_spend_rate_hour) : null,
      assist: marginal.assist_spend_rate_hour != null ? num(marginal.assist_spend_rate_hour) : null,
      assist_share_pct: marginal.assist_share_pct != null ? num(marginal.assist_share_pct) : null,
      data_quality: marginal.data_quality || null,
      split_quality: marginal.flow_split_quality || null,
      unit: '元/小时',
    } : null,
  };

  // passive_stop 映射：boost-task-report 状态粒度太粗（投放中/已结束/调控中），无"计划组超出预算"等系统强停文案——
  // 从 dash.boost_tasks（metricsService 用 adDeliveryName 细粒度判定）按 id 映射补齐
  //（2026-07-31 审计 P0 实锤：此前直接读 bt.passive_stop，btr 数据源没这字段，盯盘轮看到的标记永远 false）
  const passiveMap = {};
  for (const dt of (d.boost_tasks || [])) passiveMap[String(dt.id)] = !!dt.passive_stop;
  const boosts = (boostTasks || []).map(bt => ({
    id: bt.assistAid || bt.id || null,
    name: bt.name || null,
    status: bt.statusStr || bt.status || null,
    passive_stop: !!passiveMap[String(bt.assistAid || bt.id)], // 系统强停标记（盯盘轮识别"想跑但跑不了"的任务）
    smart_bid_type: bt.smartBidType != null ? bt.smartBidType : null,
    cost: bt.cost != null ? num(bt.cost) : null,
    net_roi: bt.netRoi != null ? num(bt.netRoi) : null,
    metric_roi_basis: { net_roi: 'platform_net_1h' },
    settlement_window: { net_roi: '1h' },
    roi_goal: bt.roiGoal != null ? num(bt.roiGoal) : null,
    roi_goal_basis: bt.roiGoalBasis || bt.roi_goal_basis || 'unknown',
    roi_basis_source: bt.roiBasisSource || bt.roi_basis_source || null,
    budget: num(bt.budget),
    refund_rate_1h: bt.refundRate1h != null ? num(bt.refundRate1h) : null, // 百分数口径（9.98=9.98%），哨兵退款告警用
    protection: (protectionMap && protectionMap[String(bt.assistAid || bt.id)]) || null,
  }));

  const generatedAt = (now || new Date()).toISOString();
  const sourceAt = d.fetchedAt || t.fetchedAt || d.liveCheckedAt || null;
  const meta = buildDataMeta({
    accountId: account,
    sessionKey: d.session_key,
    generatedAt,
    sourceAt,
    staleAfterMs: 90000,
    dataValid: d.dataValid === true,
    partial: errors.length > 0 || d.partial === true,
    stale: d.stale === true,
    errors,
    sourceType: d.source_type || d.today_source || 'agent_round_aggregate',
  });

  return {
    ok: true,
    account,
    meta,
    generated_at: generatedAt,
    fetched_at: sourceAt,
    session_key: d.session_key || null,
    partial: meta.partial,
    isLive: !!(d.live && d.live.isLive),
    today: {
      cost: num(t.cost), netRoi: num(t.netRoi), netGmv: num(t.netGmv),
      orders: num(t.orderCount != null ? t.orderCount : t.orders),
      payRoi: num(t.roi != null ? t.roi : t.payRoi),
      roi_basis: { payRoi: 'payment', netRoi: 'platform_net_1h' },
      settlement_window: '1h',
    },
    financial_basis: d.financial_basis || buildLiveFinancialBasis(),
    funnel: normalizeFunnel(d.funnel, {
      sourceAt,
      window: 'current_session',
      baseline: d.decision_context && d.decision_context.funnel_baseline,
    }),
    channels: normalizeChannels(d.channels || (Array.isArray(d.source) ? d.source : []), {
      sourceAt,
      window: 'current_session',
      baseline: d.decision_context && d.decision_context.channel_baseline,
    }),
    decision_context: d.decision_context || null,
    balance: { total_yuan: num(bal.total_yuan), days_left: num(bal.days_left) },
    plan: {
      roi_goal: num(plan.roi_goal), quota_left: num(plan.quota_left),
      roi_goal_basis: plan.roi_goal_basis || 'unknown',
      roi_basis_source: plan.roi_basis_source || null,
      quota_source: plan.quota_source || null, spent_pct: num(plan.spent_pct),
      boost_count: plan.boost_count != null ? plan.boost_count : null,
      boost_max: plan.boost_max != null ? plan.boost_max : null,
    },
    thresholds: {
      break_even_roi: num(th.break_even_roi),
      stop_loss_roi: num(th.stop_loss_roi),
      explore_line: num(th.explore_line),
      avg_order_price: num(th.avg_order_price),
      flow_baseline: fb,
    },
    flow_hint,
    boosts,
    boost_totals: {
      count: boosts.length,
      running: boosts.filter(b => b.status === '投放中').length,
    },
    errors: meta.errors,
  };
}

async function handleAgentRoundView(req, res, url) {
  if (req.method !== 'GET') return sendJSON(res, { ok: false, error: 'Method Not Allowed' }, 405);
  // 缺 account 显式 400（2026-07-30 审计修复：对齐 liveDashboard 严格度——
  // 静默回落默认账号会让盯盘轮在漏传账号时拿到错店数据）
  if (!url.searchParams.get('account')) return sendJSON(res, { ok: false, error: 'account 必填' }, 400);
  let account;
  try {
    account = validateAccount(url.searchParams.get('account'));
  } catch (e) {
    return sendJSON(res, { ok: false, error: e.message }, 400);
  }

  const q = encodeURIComponent(account);
  const today = getLocalDateStr();
  try {
    const settled = await Promise.allSettled([
      localFetch(`/api/live-dashboard?account=${q}&full=1`, 50000),
      withDeadline(signal => qcTabs.fetchBoostTaskReport(today, today, account, { signal }), 40000, 'boosts'),
    ]);
    const errors = [];
    const dash = settledValue(settled[0], 'dashboard', errors);
    const btr = settledValue(settled[1], 'boosts', errors);

    const tasks = (btr && btr.tasks) || [];

    // 人工 1h 保护期状态（boostGuard 同口径；store 读盘，op-log 查询走保护函数内部）
    const protectionMap = {};
    try {
      const store = boostGuard.loadRunningStore();
      const now = Date.now();
      for (const t of tasks) {
        const key = String(t.assistAid || t.id || '');
        if (!key) continue;
        const prot = boostGuard.protectionFor(t, account, store, now);
        if (prot && prot.protected) protectionMap[key] = { until: prot.until, source: prot.source };
      }
    } catch { /* 保护期计算失败不阻断主视图 */ }

    // 实时流速：直播日内存态 trend（与作战室趋势线同源，未直播为空数组）
    let trend = [];
    let marginal = null;
    try {
      const lt = require('../lib/liveCollector').getLatestTrend(account);
      trend = (lt && lt.trend) || [];
      marginal = require('./liveCockpit').getMarginalSliceFromDB(account, 15);
    } catch { /* 无内存态不阻断 */ }

    const payload = buildRoundView({ account, dash, boostTasks: tasks, errors, protectionMap, trend, marginal, now: new Date() });
    return sendJSON(res, payload);
  } catch (e) {
    console.error('[agent-round-view] 异常:', e.message);
    return sendJSON(res, { ok: false, error: e.message }, 500);
  }
}

module.exports = handleAgentRoundView;
module.exports.buildRoundView = buildRoundView;
module.exports._test = { buildRoundView, currentSlot, withDeadline };
