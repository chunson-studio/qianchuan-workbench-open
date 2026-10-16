'use strict';

const crypto = require('node:crypto');
const { buildSnapshotId } = require('./dataContract');
const { snapshotEvidence } = require('./watchContract');

const MAX_BYTES = 256 * 1024;
const MAX_ROWS = 100;
const MAX_COLUMNS = 128;
const MAX_CELL = 4096;
const STALE_AFTER_MS = 90_000;
const BOARD_ORIGIN = 'https://qianchuan.jinritemai.com';
const PLAN_TYPE_BY_PATH = Object.freeze({ '/uni-prom/detail': 'quan_yu', '/overall-prom/detail': 'cheng_fang' });
const HOUR_DURATION_HEADERS = new Set(['投放时长(小时)', '投放时长（小时）', '调控时长(小时)', '调控时长（小时）']);
const SECOND_DURATION_HEADERS = new Set(['投放时长(秒)', '投放时长（秒）', '调控时长(秒)', '调控时长（秒）']);

function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function isString(value) { return typeof value === 'string' && value.length > 0; }
function dateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function iso(value, name) {
  if (!isString(value) || !/(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) fail('invalid_timestamp', `${name} 必须是带时区的有效时间字符串`);
  return new Date(value).toISOString();
}
function sameDateRange(value) {
  if (Array.isArray(value) && value.length === 2 && value.every(dateOnly)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed) && parsed.length === 2 && parsed.every(dateOnly)) return parsed;
    } catch { /* try separator form below */ }
    const parts = value.split(/[~,]/);
    if (parts.length === 2 && parts.every(dateOnly)) return parts;
  }
  return null;
}
function safeUrl(value, name) {
  if (!isString(value)) fail('invalid_url', `${name} 必须是 URL 字符串`);
  let url;
  try { url = new URL(value); } catch { fail('invalid_url', `${name} URL 无效`); }
  return url;
}
function requiredParam(url, name) {
  const values = url.searchParams.getAll(name);
  if (values.length > 1) fail('duplicate_url_parameter', `URL 参数重复：${name}`);
  const value = values[0];
  if (!value) fail('url_binding_mismatch', `URL 缺少 ${name}`);
  return value;
}
function colIndex(headers, aliases, required = true) {
  const hits = [];
  headers.forEach((header, i) => { if (aliases.includes(header.trim())) hits.push(i); });
  if (hits.length > 1) fail('duplicate_key_column', `关键列重复：${aliases[0]}`);
  if (!hits.length && required) fail('missing_key_column', `缺少关键列：${aliases[0]}`);
  return hits.length ? hits[0] : -1;
}
function cell(row, idx) { return idx < 0 ? null : row[idx].trim(); }
function nullableText(value) { return value == null || ['', '-', '--', '—'].includes(value.trim()) ? null : value.trim(); }
function metricRecord(value, unit, sourceLabel, status) {
  return { value, unit, status, source_label: sourceLabel || null };
}
function metricFromColumn(headers, row, idx, unit, label, options) {
  if (idx < 0) return metricRecord(null, unit, label, 'missing');
  const raw = cell(row, idx);
  if (nullableText(raw) == null) return metricRecord(null, unit, headers[idx], 'unknown');
  return metricRecord(numeric(raw, label, options), unit, headers[idx], 'available');
}
function durationMetric(headers, row, idx) {
  const label = idx < 0 ? '调控时长' : headers[idx];
  if (idx < 0) return metricRecord(null, 's', label, 'missing');
  const raw = cell(row, idx);
  if (nullableText(raw) == null) return metricRecord(null, 's', headers[idx], 'unknown');
  // Observed rows contain a numeric first line; 乘方 may append one exact ETA line.
  // Do not prefix-match values like "1小时30分钟", "2秒" or "2x".
  const match = raw.match(/^(\d+(?:\.\d+)?)(?:\r?\n预计 (\d{2})-(\d{2}) (\d{2}):(\d{2}) 结束)?$/);
  if (!match) return metricRecord(null, 's', headers[idx], 'unknown');
  const [, amountText, monthText, dayText, hourText, minuteText] = match;
  if (monthText != null) {
    const [month, day, hour, minute] = [monthText, dayText, hourText, minuteText].map(Number);
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) {
      return metricRecord(null, 's', headers[idx], 'unknown');
    }
  }
  const header = headers[idx].trim();
  const multiplier = HOUR_DURATION_HEADERS.has(header) ? 3600 : SECOND_DURATION_HEADERS.has(header) ? 1 : null;
  if (multiplier == null) return metricRecord(null, 's', headers[idx], 'unknown');
  const seconds = Number(amountText) * multiplier;
  if (!Number.isFinite(seconds) || seconds < 0) fail('invalid_duration_value', `时长数值非法：${raw}`);
  return metricRecord(seconds, 's', headers[idx], 'available');
}
function parseCreateTime(value) {
  const raw = nullableText(value);
  if (raw == null) return null;
  // Page values are local date/time text (sometimes split over two lines). Reject
  // timezone suffixes and trailing text rather than silently discarding them.
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:T|\s+)(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) fail('invalid_create_time', `创建时间格式无法识别：${raw}`);
  const [, year, month, day, hour, minute, second = '00'] = match;
  const [y, m, d, h, min, sec] = [year, month, day, hour, minute, second].map(Number);
  const check = new Date(Date.UTC(y, m - 1, d, h, min, sec));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d
    || h > 23 || min > 59 || sec > 59) fail('invalid_create_time', `创建时间非法：${raw}`);
  return `${year}-${month}-${day}T${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}+08:00`;
}
function numeric(value, field, { integer = false, nonnegative = false } = {}) {
  const v = nullableText(value);
  if (v == null) return null;
  const normalized = v.replace(/,/g, '');
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(v)) fail('invalid_numeric_value', `${field} 数值非法：${v}`);
  const n = Number(normalized);
  if (!Number.isFinite(n) || (integer && !Number.isInteger(n)) || (nonnegative && n < 0)) fail('invalid_numeric_value', `${field} 数值非法：${v}`);
  return n;
}
function extractTaskId(value) {
  if (!value) return null;
  const matches = [...value.matchAll(/(?:任务|追投)\s*(?:ID|编号)\s*[:：#]?\s*([A-Za-z0-9_-]+)|\bID\s*[:：#]\s*([A-Za-z0-9_-]+)/gi)];
  if (matches.length > 1) fail('duplicate_task_id', '任务单元格包含多个任务ID');
  return matches[0] ? (matches[0][1] || matches[0][2]) : null;
}
function taskName(value) {
  return value.trim().replace(/\s*(?:任务|追投)\s*(?:ID|编号)\s*[:：#]?\s*[A-Za-z0-9_-]+\s*$/i, '')
    .replace(/\s*\bID\s*[:：#]\s*[A-Za-z0-9_-]+\s*$/i, '') || null;
}
function parseBoardSession(session, binding) {
  if (session == null) return null;
  if (!session || typeof session !== 'object' || Array.isArray(session)) fail('invalid_session', 'session 必须是对象');
  for (const key of ['account_id', 'room_id', 'start_time', 'board_url', 'observed_at']) {
    if (!isString(session[key])) fail('invalid_session', `session.${key} 必须是字符串`);
  }
  if (session.account_id !== binding.account_id) fail('session_account_mismatch', '直播场次账号与绑定账号不一致');
  const url = safeUrl(session.board_url, 'session.board_url');
  if (url.origin !== BOARD_ORIGIN || url.username || url.password || url.pathname !== '/board-next') fail('invalid_session_url', 'session.board_url 必须是千川同域 /board-next 页面');
  const aavid = requiredParam(url, 'aavid');
  const roomId = requiredParam(url, 'live_room_id');
  if (aavid !== binding.advertiser_id) fail('session_account_mismatch', 'board-next URL 广告主ID不匹配');
  if (roomId !== session.room_id) fail('session_room_mismatch', 'board-next URL 场次不匹配');
  const observedAt = iso(session.observed_at, 'session.observed_at');
  let startText = session.start_time;
  if (!/(?:Z|[+-]\d\d:\d\d)$/.test(startText)) {
    try { startText = parseCreateTime(startText); } catch { fail('invalid_session', 'session.start_time 必须是有效的页面北京时间或带时区时间'); }
  }
  const startMs = Date.parse(startText);
  if (!Number.isFinite(startMs)) fail('invalid_session', 'session.start_time 必须是可解析时间');
  const normalizedStart = new Date(startMs).toISOString();
  return { room_id: session.room_id, start_time: normalizedStart, session_key: `${binding.account_id}|${session.room_id}|${normalizedStart}`, observed_at: observedAt };
}

function normalizeBrowserBoostCapture(capture, { now = new Date() } = {}) {
  if (!capture || typeof capture !== 'object' || Array.isArray(capture)) fail('invalid_capture', 'capture 必须是对象');
  let serialized;
  try { serialized = JSON.stringify(capture); } catch { fail('invalid_capture', 'capture 不能序列化为 JSON'); }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_BYTES) fail('capture_too_large', 'capture 超过 256KB');
  capture = JSON.parse(serialized);
  if (capture.schema_version !== '1.0') fail('unsupported_capture_version', 'schema_version 必须为 1.0');
  const { binding, page, timing } = capture;
  if (!binding || !page || !timing || typeof binding !== 'object' || typeof page !== 'object' || typeof timing !== 'object') fail('invalid_capture', 'capture 缺少 binding/page/timing');
  for (const key of ['account_id', 'advertiser_id', 'primary_ad_id']) if (!isString(binding[key])) fail('invalid_binding', `binding.${key} 必须是字符串`);
  if (binding.target_ids != null && (!Array.isArray(binding.target_ids) || binding.target_ids.some(id => !isString(id)))) fail('invalid_target_ids', 'binding.target_ids 必须是字符串数组');
  if (page.advertiser_id !== binding.advertiser_id || page.primary_ad_id !== binding.primary_ad_id) fail('page_binding_mismatch', 'page 与 binding 广告主或主计划不匹配');
  if (!Array.isArray(page.date_range) || page.date_range.length !== 2 || !page.date_range.every(dateOnly) || page.date_range[0] > page.date_range[1]) fail('invalid_date_range', 'page.date_range 必须是正序的两个 YYYY-MM-DD 字符串');
  for (const key of ['updated_at_label', 'status_filter']) {
    if (page[key] !== null && page[key] !== undefined && typeof page[key] !== 'string') fail('invalid_page_metadata', `page.${key} 必须是字符串或 null`);
  }
  const url = safeUrl(page.url, 'page.url');
  if (url.protocol !== 'https:' || url.origin !== BOARD_ORIGIN || url.username || url.password
    || !Object.hasOwn(PLAN_TYPE_BY_PATH, url.pathname)) fail('invalid_page_url', 'page.url 必须是已识别的千川追投详情页');
  if (capture.source != null && capture.source !== 'browser_dom') fail('invalid_source', 'capture.source 只能是 browser_dom');
  const planType = PLAN_TYPE_BY_PATH[url.pathname];
  if (page.plan_type != null && page.plan_type !== planType) fail('plan_type_mismatch', 'page.plan_type 与页面URL类型不一致');
  if (page.coverage != null && (!page.coverage || typeof page.coverage !== 'object' || Array.isArray(page.coverage)
    || page.coverage.scope !== 'current_page_only')) fail('invalid_page_coverage', '当前只支持 current_page_only 覆盖范围');
  if (page.coverage?.page_number != null && (!Number.isInteger(page.coverage.page_number) || page.coverage.page_number < 1)) fail('invalid_page_coverage', 'page.coverage.page_number 必须是正整数或 null');
  if (page.coverage?.page_size != null && (!Number.isInteger(page.coverage.page_size) || page.coverage.page_size < 1)) fail('invalid_page_coverage', 'page.coverage.page_size 必须是正整数或 null');
  const metricApplicability = { comprehensive_roi: planType === 'cheng_fang' ? 'applicable' : 'not_applicable' };
  if (page.metric_applicability != null) {
    if (!page.metric_applicability || typeof page.metric_applicability !== 'object' || Array.isArray(page.metric_applicability)
      || Object.keys(page.metric_applicability).some(key => key !== 'comprehensive_roi')
      || page.metric_applicability.comprehensive_roi !== metricApplicability.comprehensive_roi) {
      fail('metric_applicability_mismatch', '综合营销ROI适用性必须与页面URL类型一致');
    }
  }
  const aavid = requiredParam(url, 'aavid');
  const adId = requiredParam(url, 'adId');
  const expectedRangeParam = url.pathname === '/uni-prom/detail' ? 'dr' : 'dateRange';
  if (url.searchParams.getAll(url.pathname === '/uni-prom/detail' ? 'dateRange' : 'dr').length) fail('url_binding_mismatch', 'URL 日期参数与页面版本不匹配');
  const urlRange = sameDateRange(requiredParam(url, expectedRangeParam));
  if (aavid !== binding.advertiser_id || adId !== binding.primary_ad_id || !urlRange || urlRange[0] !== page.date_range[0] || urlRange[1] !== page.date_range[1]) fail('url_binding_mismatch', 'URL 的广告主、主计划或日期范围与 capture 不一致');
  if (!Array.isArray(page.headers) || !Array.isArray(page.rows)) fail('invalid_table', 'page.headers 和 page.rows 必须是数组');
  if (page.headers.length > MAX_COLUMNS || page.rows.length > MAX_ROWS) fail('table_limit_exceeded', '表格超过列数或行数限制');
  if (page.headers.some(h => typeof h !== 'string' || h.length > MAX_CELL) || page.rows.some(row => !Array.isArray(row) || row.length !== page.headers.length || row.some(v => typeof v !== 'string' || v.length > MAX_CELL))) fail('invalid_table_row', '表格行宽不匹配或单元格不是受限字符串');
  if (page.summary_rows != null && (!Array.isArray(page.summary_rows) || page.summary_rows.length > MAX_ROWS
    || page.summary_rows.some(row => !Array.isArray(row) || row.some(value => typeof value !== 'string' || value.length > MAX_CELL)))) {
    fail('invalid_table_row', 'page.summary_rows 必须是受限字符串数组');
  }
  const headers = page.headers;
  const idx = {
    task: colIndex(headers, ['调控任务', '任务名称', '追投任务']),
    status: colIndex(headers, ['调控状态', '状态'], false),
    budget: colIndex(headers, ['预算', '调控预算', '调控预算(元)', '调控预算（元）']),
    cost: colIndex(headers, ['调控消耗', '调控消耗(元)', '调控消耗（元）']),
    orders: colIndex(headers, ['调控成交订单数'], false),
    paymentOrders: colIndex(headers, ['调控成交订单数', '调控支付订单数', '支付订单数'], false),
    netOrders: colIndex(headers, ['调控净成交订单数', '净成交订单数'], false),
    roi: colIndex(headers, ['调控综合营销ROI'], false),
    comprehensiveCost: colIndex(headers, ['调控综合成本', '调控综合成本(元)', '调控综合成本（元）'], false),
    gmv: colIndex(headers, ['调控成交金额'], false),
    paymentRoi: colIndex(headers, ['调控支付ROI'], false),
    netRoi: colIndex(headers, ['调控净成交ROI', '净成交ROI'], false),
    netGmv: colIndex(headers, ['调控净成交金额'], false),
    duration: colIndex(headers, ['投放时长', '投放时长(小时)', '投放时长（小时）', '投放时长(秒)', '投放时长（秒）',
      '调控时长', '调控时长(小时)', '调控时长（小时）', '调控时长(秒)', '调控时长（秒）'], false),
    createTime: colIndex(headers, ['创建时间'], false),
  };
  const missingColumns = [
    ...(idx.paymentOrders < 0 ? ['调控成交订单数'] : []),
    ...(planType === 'cheng_fang' && idx.roi < 0 ? ['调控综合营销ROI'] : []),
  ];
  const rows = page.rows;
  if (rows.length === 0 && page.total_count !== 0) fail('empty_table_unconfirmed', '空表只有 total_count=0 时可接受');
  if (page.total_count != null && (!Number.isInteger(page.total_count) || page.total_count < 0)) fail('invalid_total_count', 'total_count 必须为非负整数或 null');
  if (page.total_count != null && page.total_count < rows.length) fail('invalid_total_count', 'total_count 不能小于当前行数');
  const ids = new Set();
  const boosts = rows.map(row => {
    const id = extractTaskId(row[idx.task]);
    if (!id) fail('missing_task_id', '追投任务单元格缺少可提取的任务ID');
    if (ids.has(id)) fail('duplicate_task_id', `任务ID重复：${id}`);
    ids.add(id);
    const numberOrNull = (column, label, options) => numeric(cell(row, column), label, options);
    return {
      id, assist_aid: id, primary_ad_id: binding.primary_ad_id,
      name: taskName(row[idx.task]),
      ...(idx.status >= 0 ? { status: nullableText(row[idx.status]) } : {}),
      budget: numberOrNull(idx.budget, '预算', { nonnegative: true }), cost: numberOrNull(idx.cost, '调控消耗', { nonnegative: true }),
      orders: numberOrNull(idx.orders, '调控成交订单数', { integer: true, nonnegative: true }),
      roi: numberOrNull(idx.roi, '调控综合营销ROI'),
      ...(idx.comprehensiveCost >= 0 ? { comprehensive_cost: numberOrNull(idx.comprehensiveCost, '调控综合成本', { nonnegative: true }) } : {}),
      ...(idx.gmv >= 0 ? { gmv: numberOrNull(idx.gmv, '调控成交金额') } : {}),
      ...(idx.paymentRoi >= 0 ? { payment_roi: numberOrNull(idx.paymentRoi, '调控支付ROI') } : {}),
      ...(idx.netRoi >= 0 ? { net_roi: numberOrNull(idx.netRoi, '调控净成交ROI') } : {}),
      ...(idx.netGmv >= 0 ? { net_gmv: numberOrNull(idx.netGmv, '调控净成交金额') } : {}),
      ...(idx.duration >= 0 ? { duration: nullableText(row[idx.duration]) } : {}),
      create_time: idx.createTime < 0 ? null : parseCreateTime(cell(row, idx.createTime)),
      metrics: {
        cost: metricFromColumn(headers, row, idx.cost, 'CNY', '调控消耗', { nonnegative: true }),
        comprehensive_cost: metricFromColumn(headers, row, idx.comprehensiveCost, 'CNY', '调控综合成本', { nonnegative: true }),
        payment_orders: metricFromColumn(headers, row, idx.paymentOrders, 'order', '支付订单', { integer: true, nonnegative: true }),
        net_orders: metricFromColumn(headers, row, idx.netOrders, 'order', '净成交订单', { integer: true, nonnegative: true }),
        payment_roi: metricFromColumn(headers, row, idx.paymentRoi, 'ratio', '调控支付ROI'),
        net_roi: metricFromColumn(headers, row, idx.netRoi, 'ratio', '调控净成交ROI'),
        comprehensive_roi: planType === 'quan_yu'
          ? metricRecord(null, 'ratio', '调控综合营销ROI', 'not_applicable')
          : metricFromColumn(headers, row, idx.roi, 'ratio', '调控综合营销ROI'),
        budget: metricFromColumn(headers, row, idx.budget, 'CNY', '预算', { nonnegative: true }),
        duration_seconds: durationMetric(headers, row, idx.duration),
      },
      budget_progress_pct: null, window: 'date_range', metrics_scope: 'date_range',
      metric_sources: { cost: 'browser_dom', orders: 'browser_dom', roi: 'browser_dom', budget: 'browser_dom' },
    };
  });
  if (planType === 'quan_yu' && idx.roi >= 0) fail('plan_metric_conflict', '全域页面出现仅适用于乘方的综合营销ROI列');
  const capturedAt = iso(timing.captured_at, 'timing.captured_at');
  const refreshStartedAt = iso(timing.refresh_started_at, 'timing.refresh_started_at');
  const refreshCompletedAt = iso(timing.refresh_completed_at, 'timing.refresh_completed_at');
  if (Date.parse(refreshStartedAt) > Date.parse(refreshCompletedAt) || Date.parse(refreshCompletedAt) > Date.parse(capturedAt)) fail('invalid_timing_order', '刷新时间必须满足 started_at ≤ completed_at ≤ captured_at');
  const nowIso = now instanceof Date ? now.toISOString() : iso(String(now), 'now');
  const age = Date.parse(nowIso) - Date.parse(capturedAt);
  const stale = age > STALE_AFTER_MS || age < -STALE_AFTER_MS;
  const session = parseBoardSession(capture.session, binding);
  const targetIds = Array.isArray(binding.target_ids) ? binding.target_ids : [];
  const absentTargets = targetIds.filter(id => !ids.has(id));
  const completePage = page.total_count != null && page.total_count === rows.length;
  const meta = {
    schema_version: '2.1', account_id: binding.account_id,
    session_key: session?.session_key || null, generated_at: nowIso,
    source_at: capturedAt, age_ms: Math.max(0, age), freshness: stale ? 'stale' : 'partial',
    data_valid: true, stale, partial: true,
    missing: ['full_campaign_context', 'all_boost_tasks', ...(session ? [] : ['live_session_binding']), ...missingColumns, ...(absentTargets.length ? ['target_ids_not_visible'] : [])],
    errors: [], source_type: 'browser_dom',
    source_at_basis: 'local browser capture time; observation time, not platform generated time',
  };
  const captureHash = crypto.createHash('sha256').update(serialized).digest('hex');
  const summary = {
    ok: true, readonly_only: true, meta,
    live: session ? { is_live: null, room_id: session.room_id, start_time: session.start_time } : { is_live: null, room_id: null, start_time: null },
    metrics: {}, metrics_scope: { type: 'date_range', start: page.date_range[0], end: page.date_range[1] },
    plan: { primary_ad_id: binding.primary_ad_id, plan_type: planType, metric_applicability: metricApplicability }, boosts,
    boost_coverage: {
      source: 'browser_dom_current_page', returned: boosts.length, total_count: page.total_count,
      list_complete: false, page_complete: completePage, status_filter: page.status_filter ?? null,
      missing_columns: missingColumns, needs_columns: missingColumns,
      target_missing: absentTargets, target_visibility: Object.fromEntries(targetIds.map(id => [id, ids.has(id) ? 'visible' : 'not_visible'])),
      live_recommendation_eligible: session !== null,
      live_recommendation_reason: session ? null : 'live_session_binding_missing',
      reason: 'current_page_only; absence does not prove deletion',
    },
    components: { browser_capture: { source: 'browser_dom', captured_at: capturedAt, readonly_only: true,
      refresh_started_at: refreshStartedAt,
      refresh_completed_at: refreshCompletedAt,
      platform_generated_at: null, capture_sha256: captureHash, capture, provenance: { readonly_only: true,
        page_url: page.url, advertiser_id: binding.advertiser_id, plan_type: planType,
        metric_applicability: metricApplicability, coverage: page.coverage ?? { scope: 'current_page_only' },
        headers: page.headers, date_range: page.date_range,
        status_filter: page.status_filter ?? null, updated_at_label: page.updated_at_label ?? null,
        timestamp_basis: 'captured_at is local observation time; page updated_at_label is not platform source time',
      } } },
  };
  const evidence = snapshotEvidence(summary);
  summary.snapshot_id = buildSnapshotId(meta, summary.metrics, evidence);
  return summary;
}

module.exports = { normalizeBrowserBoostCapture };
