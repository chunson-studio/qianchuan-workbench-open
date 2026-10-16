/**
 * 本地 HTTP 直播摘要与追投任务数据投影。保留现有模块路径供调用方复用。
 * 输入为平台查询结果；输出保留来源、窗口、指标口径和缺失状态。
 *
 * 统一净化原则：
 *   1. data_scope 口径声明前置（agent 一眼看懂数据口径，杜绝支付/净成交混淆）
 *   2. 支付与平台1h净成交分列，并显式携带 roi_basis，禁止混用
 *   3. 追投展示、点击与平台两率保留在带窗口和来源的 funnel 内
 *   4. 占位伪素材（AIGC:: / __EMPTY__ / -）打 placeholder:true，防误当真实素材
 *   5. 剔调试/噪声字段（server_time/from_cache/from_fast_path/collecting/context 等）
 *   6. 结构统一（合并同场重复表达，如 dashboard 的 live_metrics 与 today）
 */

const { finiteNumber, buildDataMeta, buildSnapshotId } = require('./dataContract');
const { normalizeAlerts } = require('./productLanguage');
const { reconcileFinancial, componentMeta, contentVersion, snapshotEvidence } = require('./watchContract');
const { normalizeFunnel, normalizeChannels, buildLiveFinancialBasis } = require('./decisionContext');

// ── 噪声字段（agent 决策不需要的调试/元数据字段）──
const NOISE_KEYS = [
  'server_time', 'from_cache', 'from_fast_path', 'collecting', 'context',
  'account_info', 'today_sessions',
];

/** 只保留指定字段（白名单），未知字段自动剔除 */
function pick(obj, fields) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const f of fields) {
    if (f in obj) out[f] = obj[f];
  }
  return out;
}

/** 剔除顶层噪声字段 */
function stripNoise(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = { ...obj };
  for (const k of NOISE_KEYS) delete out[k];
  return out;
}

/** 占位伪素材打标：以 AIGC:: / __EMPTY__ 开头，或纯 - / 空，视为占位 */
function markPlaceholder(list, idKey = 'material_id') {
  if (!Array.isArray(list)) return list;
  const PH = /^(AIGC::|__EMPTY__)|^(-|)$/;
  return list.map(item => {
    const id = item && item[idKey] != null ? String(item[idKey]) : '';
    if (PH.test(id)) return { ...item, placeholder: true };
    return item;
  });
}

function normalizeMaterialEngagement(material) {
  const out = { ...material };
  const parse = value => {
    if (value == null || String(value).trim() === '') return null;
    return finiteNumber(String(value).trim().replace(/,/g, '').replace(/%$/, ''));
  };
  const clicks = parse(out.clicks ?? out.click_cnt ?? out.clickCount);
  const cpc = parse(out.cpc ?? out.cost_per_click);
  // Preserve the platform's displayed percent-unit (5% => 5). No guessing or scaling.
  const clickRate = parse(out.clickRate ?? out.click_rate ?? out.ctr);
  if (clicks != null) out.clicks = clicks;
  if (cpc != null) out.cpc = cpc;
  if (clickRate != null) out.clickRate = clickRate;
  return out;
}
/** 附加口径声明（前置，agent 一眼看懂） */
function scopeDecl(obj, scope) {
  if (!obj || typeof obj !== 'object') return obj;
  return { data_scope: scope, ...obj };
}

/**
 * 精简单条追投任务：保留决策核心字段和漏斗证据，剔除重复展示/权限位字段。
  * 历史账户专用说明已从试用包移除。
 * 兜底：原始字段不在白名单时按实际存在保留核心，未知字段剔除。
 */
function slimBoostTask(t) {
  if (!t || typeof t !== 'object') return t;
  const KEEP = ['id', 'assist_aid', 'primary_ad_id', 'name', 'status', 'passive_stop',
    'budget', 'duration_seconds', 'duration_unit', 'duration_source', 'duration_reason', 'cost', 'roi_goal', 'ecp_roi2_goal', 'roi', 'gmv', 'net_roi', 'net_gmv',
    'orders', 'order_count', 'refund_rate_1h', 'protection', 'smart_bid_type', 'funnel',
    'roi_goal_basis', 'roi_basis_source', 'optimization', 'optimization_goal',
    'metric_roi_basis', 'settlement_window', 'payment_gmv_excluding_coupon', 'metric_sources', 'metrics_freshness', 'realtime_detail', 'realtime_detail_freshness',
    'create_time', 'cost_per_hour', 'board_group', 'start', 'end',
    'bid', 'bid_unit', 'bid_mode', 'status_code', 'pause_reason', 'action_limits', 'available_actions',
    'budget_progress_pct', 'budget_audit_required', 'budget_remaining',
    'source_at', 'parameters_source_at', 'metrics_source_at', 'window', 'daily_metrics', 'period_metrics', 'session_metrics', 'financial_checks',
    'material_id', 'material_name', 'material_ids', 'material_link_complete', 'material_link_source',
    'observed_period_budget_ratio_pct', 'stop_reason',
    'recent_changes', 'missing_fields', 'audit_ready', 'supplement'];
  return pick(t, KEEP);
}

// Compact output is opt-in and only removes unchanged task fields against a
// retained same-session snapshot. These current safety facts are never inherited.
const BOOST_DELTA_ABSOLUTE = new Set([
  'id', 'primary_ad_id', 'status', 'status_code', 'passive_stop', 'pause_reason', 'stop_reason',
  'source_at', 'parameters_source_at', 'metrics_source_at', 'metrics_freshness', 'realtime_detail_freshness',
  'action_limits', 'available_actions', 'audit_ready', 'missing_fields',
]);

/**
 * Lossless top-level field patches for the boosts array, after SnapshotRing has
 * retained the complete current summary. No HTTP response or ledger is changed.
 * Apply set then unset to the matching previous task; add full added rows, remove
 * removed_ids, and reorder by current_ids. Removal is not proof a task ended.
 */
function compactLiveDelta(payload, previous, current = payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const out = { ...payload };
  // SnapshotRing's legacy delta omits these fields. Carry their current values,
  // rather than recovering binding, missing-data or engagement facts from a base.
  if (payload.mode === 'delta') {
    for (const key of ['engagement', 'plan_binding', 'missing_components',
      'boost_data_valid', 'boost_source_at', 'boost_window', 'boost_truncated']) {
      if (Object.hasOwn(current, key)) out[key] = current[key];
    }
    out.meta = { ...payload.meta, missing: current.meta?.missing || [] };
  }
  const fallback = reason => ({ ...out, compact_unavailable_reason: reason });
  if (out.mode !== 'delta') return fallback(out.reset_reason || 'full_snapshot_required');
  const meta = out.meta || {}, oldMeta = previous?.meta || {};
  if (!previous || previous.snapshot_id !== out.previous_snapshot_id) return fallback('snapshot_not_found');
  if (!meta.account_id || !meta.session_key || meta.account_id !== oldMeta.account_id
    || meta.session_key !== oldMeta.session_key || meta.schema_version !== oldMeta.schema_version) {
    return fallback('snapshot_binding_mismatch');
  }
  const binding = out.plan_binding;
  if (binding?.data_valid !== true || binding.account_id !== meta.account_id
    || binding.session_key !== meta.session_key) return fallback('current_plan_binding_unverified');
  const quality = out.components?.boosts;
  if (out.ok === false || meta.data_valid !== true || meta.stale === true
    || quality?.data_valid !== true || quality.freshness !== 'fresh'
    || out.boost_coverage?.list_complete !== true || out.boost_coverage?.truncated === true
    || out.boost_data_valid === false || out.boost_truncated === true) {
    return fallback('current_boost_data_not_complete_and_fresh');
  }
  const index = rows => {
    if (!Array.isArray(rows)) return null;
    const map = new Map();
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)
        || typeof row.id !== 'string' || !row.id || map.has(row.id)) return null;
      map.set(row.id, row);
    }
    return map;
  };
  const before = index(previous.boosts), after = index(out.boosts);
  if (!before || !after) return fallback('task_identity_unverified');
  const patch = {
    schema_version: 'boost-fields/v1',
    base_snapshot_id: previous.snapshot_id,
    current_ids: [...after.keys()],
    added: [], updated: [], removed_ids: [...before.keys()].filter(id => !after.has(id)),
  };
  for (const [id, task] of after) {
    const old = before.get(id);
    if (!old) { patch.added.push(task); continue; }
    const set = {};
    for (const [key, value] of Object.entries(task)) {
      if (key !== 'id' && (BOOST_DELTA_ABSOLUTE.has(key) || !Object.hasOwn(old, key)
        || JSON.stringify(value) !== JSON.stringify(old[key]))) set[key] = value;
    }
    const unset = Object.keys(old).filter(key => !Object.hasOwn(task, key));
    patch.updated.push({ id, set, ...(unset.length ? { unset } : {}) });
  }
  const compact = { ...out, boosts_delta: patch };
  delete compact.boosts;
  // Tiny/changed lists may cost more as patches. Preserve the simpler full list.
  if (Buffer.byteLength(JSON.stringify(compact)) >= Buffer.byteLength(JSON.stringify(out))) {
    return fallback('compact_not_smaller');
  }
  return compact;
}

// ═══════════════════════════════════════════════════════════
// dashboard 净化
// ═══════════════════════════════════════════════════════════

// 核心卡包含财务之外的经营指标；它们不能随重复的财务字段一起裁掉。
// 两个已知转化率不代表完整漏斗，不反推缺失的曝光、点击或成交人数。
function liveEngagement(data) {
  const live = data.live_metrics || {};
  const fields = { online: 'online', watch_uv: 'watchUcount', gpm: 'gpm',
    watch_to_pay_rate: 'watchToPayRate', show_to_watch_rate: 'showToWatchRate', net_order_cost: 'orderCost' };
  const values = Object.fromEntries(Object.entries(fields).map(([key, source]) => [key, finiteNumber(live[source])]));
  const missing = Object.keys(values).filter(key => values[key] == null);
  const core = data.component_times?.core;
  const sourceAt = core?.source_at || data.fetchedAt || null;
  return {
    ...values,
    units: { online: 'people', watch_uv: 'people', gpm: 'CNY/1000_views',
      watch_to_pay_rate: 'percent', show_to_watch_rate: 'percent', net_order_cost: 'CNY/order' },
    basis: { watch_to_pay_rate: 'people', show_to_watch_rate: 'events', net_order_cost: 'platform_net_1h' },
    window: data.session_key ? 'current_session' : 'unknown',
    source_at: sourceAt,
    data_valid: data.dataValid === true && !!sourceAt && missing.length < Object.keys(fields).length,
    missing,
  };
}

/**
 * 净化 /api/live-dashboard 返回（get_live_view dashboard/unified 的主数据段）。
 * - 财务保留在 today，非重复经营指标保留在 engagement
 * - 剔 today_sessions 多场全量 / account_info / server_time 等
 * - boost_tasks 逐项精简（剔恒空 show/click/refund）
 * - materials_top 精简 + 占位打标
 * - plan 精简
 */
function cleanLiveDashboard(data) {
  if (!data || typeof data !== 'object') return data;
  const decisionContext = data.decision_context || null;
  const out = {
    ok: data.ok,
    account: data.account,
    server_time: data.server_time,
    session_key: data.session_key,
    fetchedAt: data.fetchedAt,
    component_times: data.component_times || null,
    liveCheckedAt: data.liveCheckedAt,
    age_ms: data.age_ms,
    stale: data.stale === true,
    dataValid: data.dataValid === true,
    partial: data.partial === true,
    missing_components: data.missing_components || [],
    errors: data.errors || [],
    source: data.source_type || data.today_source || null,
    live: data.live,
    // 支付与平台1h净成交分列，口径由 financial_basis 显式声明。
    today: pick(data.today || {}, [
      'cost', 'gmv', 'roi', 'netGmv', 'netRoi', 'orderCount', 'orderCountPay',
      'roi_basis', 'settlement_window',
    ]),
    financial_basis: data.financial_basis || buildLiveFinancialBasis(),
    engagement: liveEngagement(data),
    funnel: normalizeFunnel(data.funnel, {
      sourceAt: data.fetchedAt || null,
      window: 'current_session',
      baseline: decisionContext && decisionContext.funnel_baseline,
    }),
    channels: normalizeChannels(data.channels || (Array.isArray(data.source) ? data.source : []), {
      sourceAt: data.fetchedAt || null,
      window: 'current_session',
      baseline: decisionContext && decisionContext.channel_baseline,
    }),
    decision_context: decisionContext,
    balance: data.balance,
    break_even_roi: data.break_even_roi || data.thresholds && data.thresholds.break_even_roi,
    riskAlerts: data.riskAlerts,
    suggestions: data.suggestions,
    decisions: data.decisions,
    boost_summary: data.boost_summary,
    boost_data_valid: data.boost_data_valid === true,
    boost_source_at: data.boost_source_at || null,
    boost_window: data.boost_window || null,
    boost_truncated: data.boost_truncated === true,
    boost_coverage: data.boost_coverage || { list_complete: data.boost_data_valid === true && data.boost_truncated !== true,
      reason: data.boost_data_valid === true ? null : 'boost_collection_unavailable' },
    plan_binding: data.plan_binding || null,
    boost_tasks: (data.boost_tasks || []).map(slimBoostTask),
    materials_top: markPlaceholder((data.materials_top || []).map(m => normalizeMaterialEngagement(pick(m, ['material_id', 'name', 'cost', 'roiSettle', 'orders', 'heatStatus', 'clicks', 'click_cnt', 'clickCount', 'cpc', 'cost_per_click', 'clickRate', 'click_rate', 'ctr'])))),
    plan: data.plan && pick(data.plan, ['id', 'name', 'status', 'plan_type', 'source_at', 'roi_goal', 'roi_goal_basis', 'roi_basis_source', 'platform_recommendation', 'effective_delivery', 'flow_control', 'budget', 'budget_scope', 'boost_count', 'boost_max', 'quota_left', 'quota_exceeded', 'quota_detail', 'primary_ad_id']),
    today_source: data.today_source, // 今日数据来源（live_board/sessions），口径已由 data_scope 声明
  };
  return scopeDecl(out, '净成交1h');
}

/**
 * Agent 默认盯盘摘要（v2）。
 * 与 cleanLiveDashboard 的 legacy 兼容输出分开：这里不重复旧字段、不返回整块阈值/建议原文，
 * 只提供一轮判断所需的事实、可信状态与可按需展开的引用。
 */
function buildLiveSummary(data, options = {}) {
  if (!data || typeof data !== 'object') return data;
  const decisionContext = data.decision_context || null;
  const today = data.today || {};
  const rawMetrics = {
    spend: finiteNumber(today.cost),
    payment_gmv: finiteNumber(today.gmv),
    payment_roi: finiteNumber(today.roi != null ? today.roi : today.payRoi),
    payment_orders: finiteNumber(today.orderCountPay),
    net_gmv: finiteNumber(today.netGmv),
    net_roi: finiteNumber(today.netRoi),
    orders: finiteNumber(today.orderCount != null ? today.orderCount : today.orders),
  };
  const metricsScope = data.today_source === 'sessions' ? 'daily_sessions' : data.session_key ? 'current_session' : 'unknown';
  const financial = reconcileFinancial(rawMetrics, data.financial_basis, metricsScope);
  const metrics = financial.values;
  const requiredMetrics = ['spend', 'net_gmv', 'net_roi', 'orders'];
  const missing = requiredMetrics.filter(key => metrics[key] == null);
  const sourceAt = data.fetchedAt || today.fetchedAt || null;
  const errors = data.errors || [];
  const meta = buildDataMeta({
    accountId: data.account || options.accountId,
    sessionKey: data.session_key,
    generatedAt: options.generatedAt || data.server_time,
    sourceAt,
    staleAfterMs: options.staleAfterMs == null ? 90000 : options.staleAfterMs,
    dataValid: data.dataValid === true,
    partial: data.partial === true,
    stale: data.stale === true,
    missing,
    errors,
    sourceType: data.source_type || data.today_source,
  });
  const rawAlerts = [
    ...(Array.isArray(data.riskAlerts) ? data.riskAlerts : []),
    ...(Array.isArray(data.suggestions) ? data.suggestions : []),
  ];
  const boosts = (data.boost_tasks || []).map(slimBoostTask);
  const materials = markPlaceholder((data.materials_top || [])
    .slice(0, options.materialLimit || 5)
    .map(material => normalizeMaterialEngagement(pick(material, ['material_id', 'name', 'cost', 'roiSettle', 'orders', 'heatStatus', 'clicks', 'click_cnt', 'clickCount', 'cpc', 'cost_per_click', 'clickRate', 'click_rate', 'ctr']))));
  const summary = {
    ok: data.ok !== false,
    meta,
    live: {
      is_live: typeof (data.live && data.live.isLive) === 'boolean' ? data.live.isLive
        : typeof (data.live && data.live.is_live) === 'boolean' ? data.live.is_live : null,
      live_checked_at: data.liveCheckedAt || null,
      room_id: data.live && (data.live.roomId || data.live.room_id || data.live.rooms?.[0]?.roomId) || null,
      start_time: data.live && (data.live.startTime || data.live.start_time || data.live.rooms?.[0]?.startTime) || null,
    },
    metrics,
    metrics_scope: metricsScope,
    financial_checks: financial.checks,
    financial_basis: data.financial_basis || buildLiveFinancialBasis(),
    engagement: liveEngagement(data),
    missing_components: data.missing_components || [],
    plan_binding: data.plan_binding || null,
    funnel: normalizeFunnel(data.funnel, {
      sourceAt: null,
      window: 'current_session',
      baseline: decisionContext && decisionContext.funnel_baseline,
    }),
    channels: normalizeChannels(data.channels || (Array.isArray(data.source) ? data.source : []), {
      sourceAt: null,
      window: 'current_session',
      baseline: decisionContext && decisionContext.channel_baseline,
    }),
    decision_context: decisionContext,
    threshold: {
      target_roi: finiteNumber(data.target_roi ?? data.thresholds?.target_roi),
      target_roi_basis: data.target_roi_basis ?? data.thresholds?.target_roi_basis ?? 'unknown',
      break_even_roi: finiteNumber(data.break_even_roi != null
        ? data.break_even_roi
        : data.thresholds && data.thresholds.break_even_roi),
    },
    alerts: normalizeAlerts(rawAlerts),
    plan: data.plan ? pick(data.plan, [
      'primary_ad_id', 'name', 'status', 'plan_type', 'roi_goal', 'roi_goal_basis', 'roi_basis_source', 'platform_recommendation', 'effective_delivery', 'flow_control', 'budget', 'budget_scope',
      'boost_count', 'boost_max', 'quota_left', 'quota_exceeded', 'source_at', 'action_limits',
    ]) : null,
    boosts,
    boost_data_valid: data.boost_data_valid === true,
    boost_source_at: data.boost_source_at || null,
    boost_window: data.boost_window || null,
    boost_truncated: data.boost_truncated === true,
    boost_coverage: data.boost_coverage || { returned: boosts.length, truncated: data.boost_truncated === true,
      list_complete: data.boost_data_valid === true && data.boost_truncated !== true,
      reason: data.boost_data_valid === true ? null : 'boost_collection_unavailable' },
    materials,
    ...(data.material_changes ? { material_changes: data.material_changes } : {}),
  };
  // Keep baseline text only once; consumers resolve the reference in decision_context.
  const context = { ...(decisionContext || {}) };
  for (const [key, baselineKey] of [['funnel', 'funnel_baseline'], ['channels', 'channel_baseline']]) {
    if (summary[key].baseline != null) context[baselineKey] = summary[key].baseline;
    delete summary[key].baseline;
    summary[key].baseline_ref = `decision_context.${baselineKey}`;
  }
  summary.decision_context = context;
  summary.context_version = contentVersion(context);
  const at = meta.generated_at;
  const opts = { staleAfterMs: options.staleAfterMs ?? 90000 };
  summary.components = {
    financial: componentMeta(sourceAt, data.dataValid === true, metricsScope, at, { ...opts, stale: data.stale,
      partial: Object.values(financial.checks).some(c => !c.data_valid) }),
    engagement: componentMeta(summary.engagement.source_at, summary.engagement.data_valid, summary.engagement.window, at,
      { ...opts, stale: data.stale, partial: summary.engagement.missing.length > 0 }),
    live: componentMeta(data.liveCheckedAt, summary.live.is_live != null, 'live_status', at, opts),
    boosts: componentMeta(data.boost_source_at, data.boost_data_valid === true, data.boost_window || 'daily', at, opts),
    funnel: componentMeta(summary.funnel.source_at, summary.funnel.data_valid, summary.funnel.window, at, opts),
    channels: componentMeta(summary.channels.source_at, summary.channels.data_valid, summary.channels.window, at, opts),
    short_term_tools: componentMeta(data.plan?.source_at, data.plan?.flow_control?.available === true, 'task_state', at, opts),
  };
  // 保留核心独立采集证据；请求起点是保守的数据时间，不冒充平台内部更新时间。
  if (data.component_times?.core) {
    summary.components.financial.collected_at = data.component_times.core.collected_at || null;
    summary.components.financial.timestamp_basis = data.component_times.core.timestamp_basis || 'unknown';
    summary.components.financial.query_window = data.component_times.core.window || null;
  }
  const liveConflict = summary.live.is_live === true && boosts.some(t => /未开播/.test(t.status || ''));
  if (summary.material_changes) {
    summary.components.materials = componentMeta(summary.material_changes.source_at,
      !summary.material_changes.missing_components?.length, 'collector_material_query', at, opts);
    // New consumers use material_changes; the legacy top-five field stays on detail only.
    delete summary.materials;
  }
  if (liveConflict) summary.components.live.conflict = 'boost_reports_offline';
  if (Object.values(summary.components).some(c => !c.data_valid) || liveConflict) {
    meta.partial = true;
    if (meta.freshness === 'fresh') meta.freshness = 'partial';
  }
  meta.schema_version = '2.1';
  summary.evidence = snapshotEvidence(summary);
  summary.snapshot_id = buildSnapshotId(meta, metrics, summary.evidence);
  // Evidence is persisted by the ledger, not repeated over the wire.
  delete summary.evidence;
  return summary;
}

// ═══════════════════════════════════════════════════════════
// compass 净化
// ═══════════════════════════════════════════════════════════

/** 净化罗盘快照：剔 extra 原始透出，只留画像/人群/首页指标结论 */
function cleanCompass(data) {
  if (!data || typeof data !== 'object') return data;
  const out = { ...data };
  // extra/changes/date_type 实际嵌套在 snapshot 内层（顶层无），剔内层噪音
  if (out.snapshot && typeof out.snapshot === 'object') {
    out.snapshot = { ...out.snapshot };
    delete out.snapshot.extra;   // 原始透出数据（噪音，uv_value/order_ratio/trend 原始序列）
    delete out.snapshot.changes; // 变化明细（agent 只要结论，指标环比可自行算）
    delete out.snapshot.date_type;
  }
  delete out.extra;
  delete out.changes;
  delete out.date_type;
  // 保留：metrics(核心指标)/profile(画像)/home(首页) 等已结构化的部分
  return scopeDecl(out, '罗盘快照');
}

function cleanCompassScreen(data, view = 'summary') {
  if (!data || typeof data !== 'object') return data;
  const out = { ...data, view };
  // 默认保留窗口、口径和各渠道最新值；完整分钟序列可用 detail 读取。
  if (view !== 'detail' && data.traffic_trend) {
    const { points = [], available_channels, ...trend } = data.traffic_trend;
    const latest = new Map();
    for (const p of points) if (!latest.has(p.channel) || String(p.timestamp) > String(latest.get(p.channel).timestamp)) latest.set(p.channel, p);
    out.traffic_trend = { ...trend, point_count: points.length, points_omitted: true, latest_by_channel: [...latest.values()] };
  }
  return out;
}

/** 账户概览净化：只留中文可读指标(kpi_raw)，剔 data.row 原始 API 结构与顶层噪声 */
function cleanOverview(data) {
  if (!data || typeof data !== 'object') return data;
  const out = stripNoise({ ...data });
  if (out.data && typeof out.data === 'object') {
    out.data = { ...out.data };
    delete out.data.row;       // 原始 Dimensions/Metrics 结构（agent 只要可读指标）
    delete out.data.fetched_at; // 调试时间戳
  }
  return scopeDecl(out, '净成交1h');
}

// ═══════════════════════════════════════════════════════════
// 其余只读工具通用净化（轻量：stripNoise + 口径声明 + 占位打标）
// 对结构复杂/不常改的接口用通用策略，避免过度裁剪破坏结构。
// ═══════════════════════════════════════════════════════════

/** 素材深度透视净化：剔顶层噪声 + 占位打标 + 口径声明（内部结构不过度裁剪） */
function cleanMaterialInsight(data) {
  if (!data || typeof data !== 'object') return data;
  const out = stripNoise({ ...data });
  // detail 段含 material_id 时占位打标
  if (out.detail && Array.isArray(out.detail)) out.detail = markPlaceholder(out.detail);
  return scopeDecl(out, '净成交1h');
}

/** 罗盘商品榜净化：剔调试字段，附加口径 */
function cleanCompassGoods(data) {
  if (!data || typeof data !== 'object') return data;
  const out = stripNoise({ ...data });
  return scopeDecl(out, '罗盘30d');
}

/** 素材累计摘要 / 搜索净化：通用降噪 + 占位打标 + 口径声明 */
function cleanMaterialSummary(data, scope = 'video-library全渠道') {
  if (!data || typeof data !== 'object') return data;
  const out = stripNoise({ ...data });
  if (out.data && Array.isArray(out.data)) out.data = markPlaceholder(out.data);
  if (out.materials && Array.isArray(out.materials)) out.materials = markPlaceholder(out.materials);
  return scopeDecl(out, scope);
}

/** 编导简报净化：json 模式通用降噪 + 口径声明 */
function cleanCreatorBrief(data) {
  if (!data || typeof data !== 'object') return data;
  return scopeDecl(stripNoise({ ...data }), '近7天素材');
}

/** 追投列表净化：adInfos 逐项 slim（剔恒空字段）+ 口径声明 */
function cleanBoostList(data, scope = '支付与平台1h净成交分列') {
  if (!data || typeof data !== 'object') return data;
  const out = { ...data };
  // 2026-08-06 修复：boost-list 接口实际返回 tasks 数组（此前只处理 data.adInfos/adInfos 路径，
  // 净化从未生效——盯盘轮每轮必拉，11 任务 5.6KB→2.8KB 省 51%）
  const infos = out.tasks || (out.data && out.data.adInfos) || out.adInfos;
  if (Array.isArray(infos)) {
    const slimmed = infos.map(slimBoostTask);
    if (out.tasks) out.tasks = slimmed;
    else if (out.data) out.data.adInfos = slimmed;
    else out.adInfos = slimmed;
  }
  return scopeDecl(stripNoise(out), scope);
}

/** 经验库净化：附加口径声明 */
function cleanLessons(data) {
  if (!data || typeof data !== 'object') return data;
  return scopeDecl({ ...data }, '已记录的账户经验（需核对证据与适用条件）');
}

module.exports = {
  pick,
  stripNoise,
  markPlaceholder,
  scopeDecl,
  slimBoostTask,
  compactLiveDelta,
  cleanLiveDashboard,
  buildLiveSummary,
  cleanCompass,
  cleanCompassScreen,
  cleanCompassGoods,
  cleanMaterialInsight,
  cleanMaterialSummary,
  cleanCreatorBrief,
  cleanBoostList,
  cleanLessons,
  cleanOverview,
};
