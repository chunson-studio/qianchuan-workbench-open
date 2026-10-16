/**
 * server/lib/liveBoardDetail.js — 直播大屏增强数据（2026-08-02 探针逆向接入）
 *
 * 三组接口（references/qianchuan-live-board-api.md）：
 *   1. 分钟级大盘趋势 board_roi2_total_trend_next（stat_time_minute，全指标可换）
 *   2. 调控动作日志 /ad/api/data/v1/board/roi2Log（追投创建时间/任务/预算）
 *   3. 素材级 5 分钟趋势（video/live 两个 DataSetKey，stat_time_5_minute）
 *
 * 用途：复盘落盘增强（liveReplay 路由）+ MCP level=board 实盘分钟级研判。
 * 失败策略：任一路失败只缺对应段（partial:true），不抛——主看板不受影响；cookie_expired 上抛不吞。
 */
const { statQuery, requestAPI, enqueue } = require('./qianchuan');
const { resolveAavid } = require('./cookie');

// 分钟级趋势指标集（2026-08-02 实盘验证：千川按指标组校验，watch/show/net_roi_1h 与消耗成交组不同组，
// 组合即 3000"不在数据集配置中"——最终可用组=消耗成交组 5 指标；净ROI 由 net/cost 下游计算）
const TREND_METRICS = [
  'stat_real_cost_for_roi2',                          // 消耗（基础+追投）
  'total_pay_order_count_realtime_for_roi2',          // 成交单数
  'total_pay_order_gmv_realtime_for_roi2',            // 成交金额（支付口径）
  'total_order_settle_amount_realtime_for_roi2_1h',   // 1h净成交金额
  'stat_real_cost_for_overall_roi2',                  // 综合消耗
];

function baseFilters(aavid, roomId) {
  return {
    ConditionRelationshipType: 1,
    Conditions: [
      { Field: 'advertiser_id', Operator: 7, Values: [String(aavid)] },
      { Field: 'room_id', Operator: 7, Values: [String(roomId)] },
    ],
  };
}

const num = m => {
  const v = m && (m.Value != null ? m.Value : m.value);
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

/** 分钟级趋势（Limit=-1 一次拉全；行数明显不足时调用方自行按小时分段） */
async function fetchMinuteTrend(roomId, startTime, endTime, accountId) {
  const aavid = resolveAavid(accountId);
  const body = {
    DataSetKey: 'board_roi2_total_trend_next',
    StartTime: startTime,
    EndTime: endTime,
    Metrics: TREND_METRICS,
    Dimensions: ['stat_time_minute'],
    PageParams: { Offset: 0, Limit: -1 },
    Filters: baseFilters(aavid, roomId),
    OrderBy: [{ Field: 'stat_time_minute', Type: 1 }],
  };
  const r = await statQuery(body, 3, accountId);
  const rows = (r && r.data && r.data.StatsData && r.data.StatsData.Rows) || [];
  return rows.map(row => {
    const d = row.Dimensions || {}, m = row.Metrics || {};
    const cost = num(m.stat_real_cost_for_roi2);
    const net = num(m.total_order_settle_amount_realtime_for_roi2_1h);
    return {
      t: (d.stat_time_minute && (d.stat_time_minute.ValueStr || d.stat_time_minute.ValueStr === '' ? d.stat_time_minute.ValueStr : d.stat_time_minute.Value)) || null,
      cost,
      orders: num(m.total_pay_order_count_realtime_for_roi2),
      gmv: num(m.total_pay_order_gmv_realtime_for_roi2),
      net_1h: net,
      net_roi_1h: cost > 0 ? +(net / cost).toFixed(3) : 0,   // 衍生口径：1h净成交/消耗（标注）
      cost_all: num(m.stat_real_cost_for_overall_roi2),
    };
  });
}

/** 调控动作日志 */
async function fetchRoi2Log(roomId, anchorId, startTime, endTime, accountId, strict = false) {
  const aavid = resolveAavid(accountId);
  const body = {
    AnchorId: String(anchorId || '0'),
    RoomId: String(roomId),
    StartTime: startTime,
    EndTime: endTime,
    timeDimension: 4,
    IsNew: true,
  };
  const r = await enqueue(() => requestAPI('POST', `/ad/api/data/v1/board/roi2Log?aavid=${aavid}`, body, accountId), accountId);
  if (strict) {
    const codes = [r?.status_code, r?.code].filter(code => code != null);
    if (codes.some(code => String(code) === '401' || String(code) === '40001')) {
      throw Object.assign(new Error('cookie_expired'), { code: 'cookie_expired' });
    }
    if (r?.ok === false || !codes.length || codes.some(code => String(code) !== '0') || !Array.isArray(r?.data?.Roi2LogItemsList)) {
      throw Object.assign(new Error('平台调控日志未返回有效成功响应'), { code: 'upstream_bad_response', component: 'roi2_log' });
    }
    for (const item of r.data.Roi2LogItemsList) {
      if (!item || typeof item !== 'object' || Array.isArray(item) ||
          ['Roi2RegulateLogItems', 'Roi2PutLogItems'].every(key => item[key] == null) ||
          ['Roi2RegulateLogItems', 'Roi2PutLogItems'].some(key =>
            item[key] != null && (!Array.isArray(item[key]) || item[key].some(row => !row || typeof row !== 'object' || Array.isArray(row))))) {
        throw Object.assign(new Error('平台调控日志分组结构无效'), { code: 'upstream_bad_response', component: 'roi2_log' });
      }
    }
  }
  const list = (r && r.data && r.data.Roi2LogItemsList) || [];
  const readTime = value => {
    if (!strict) return parseInt(value, 10) || null;
    const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  };
  const out = [];
  for (const item of list) {
    for (const reg of (item.Roi2RegulateLogItems || [])) {
      out.push({
        ts: readTime(reg.Roi2ActionTime),
        type: strict ? reg.Roi2ActionType ?? null : reg.Roi2ActionType || null,
        text: strict ? reg.Roi2ActionShow ?? null : reg.Roi2ActionShow || null,
        kind: 'regulate',
      });
    }
    for (const put of (item.Roi2PutLogItems || [])) {
      out.push({
        ts: readTime(put.Roi2ActionTime),
        type: strict ? put.Roi2ActionType ?? null : put.Roi2ActionType || null,
        text: strict ? put.Roi2ActionShow ?? null : put.Roi2ActionShow || null,
        kind: 'put',
      });
    }
  }
  out.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  return out;
}

/** 仅读取平台日志；返回条数限制不代表上游历史完整。 */
async function fetchBoardActions(roomId, anchorId, startTime, endTime, accountId, limit = 30) {
  if (![roomId, startTime, accountId].every(value => typeof value === 'string' && value.trim())) {
    throw Object.assign(new Error('日志读取必须显式绑定账户、房间与开播时间'), { code: 'session_binding_required', statusCode: 400 });
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw Object.assign(new Error('limit 必须为 1 至 100 的整数'), { code: 'invalid_limit', statusCode: 400 });
  }
  const fetchedAt = new Date().toISOString();
  const rows = await fetchRoi2Log(roomId, anchorId, startTime, endTime, accountId, true);
  const selected = rows.slice(-limit);
  return {
    roi2_log: selected,
    fetched_at: fetchedAt,
    source_type: 'qianchuan_roi2_log',
    session_binding: 'request_window',
    action_coverage: { total: rows.length, returned: selected.length, limit,
      truncated: selected.length < rows.length, upstream_complete: null,
      selection: 'timestamp_tail', time_order_valid: rows.every(row => row.ts !== null) },
  };
}

/** 素材级 5 分钟趋势（video/live） */
async function fetchMaterialTrend(roomId, anchorId, startTime, endTime, accountId, kind) {
  const aavid = resolveAavid(accountId);
  const isVideo = kind === 'video';
  const filters = baseFilters(aavid, roomId);
  filters.Conditions.push({ Field: 'anchor_id', Operator: 7, Values: [String(anchorId)] });
  if (!isVideo) filters.Conditions.push({ Field: 'roi2_material_type_v3', Operator: 7, Values: ['4'] });
  const body = {
    DataSetKey: isVideo ? 'board_roi2_material_performance_video' : 'board_roi2_material_performance',
    Dimensions: ['stat_time_5_minute'],
    Metrics: isVideo
      ? ['total_order_settle_amount_realtime_for_roi2_1h', 'stat_real_cost_for_roi2']
      : ['stat_real_cost_for_roi2'],
    StartTime: startTime,
    EndTime: endTime,
    Filters: filters,
    OrderBy: [{ Field: 'stat_time_5_minute', Type: 1 }],
    PageParams: { Offset: 0, Limit: -1 },
  };
  const r = await statQuery(body, 3, accountId);
  const rows = (r && r.data && r.data.StatsData && r.data.StatsData.Rows) || [];
  return rows.map(row => {
    const d = row.Dimensions || {}, m = row.Metrics || {};
    const o = {
      t: (d.stat_time_5_minute && (d.stat_time_5_minute.ValueStr || d.stat_time_5_minute.Value)) || null,
      cost: num(m.stat_real_cost_for_roi2),
    };
    if (isVideo) o.net_1h = num(m.total_order_settle_amount_realtime_for_roi2_1h);
    return o;
  });
}

/**
 * 大屏增强数据（分钟趋势+调控日志+素材趋势）。
 * @returns {Promise<{trend_minute?, roi2_log?, material_trends?, partial:boolean, errors:Array<{component:string,code:string,error:string}>}>}
 */
async function fetchBoardDetail(roomId, anchorId, startTime, endTime, accountId) {
  const out = { partial: false, errors: [] };
  const parts = [
    { component: 'trend_minute', key: 'trend_minute', run: () => fetchMinuteTrend(roomId, startTime, endTime, accountId) },
    { component: 'roi2_log', key: 'roi2_log', run: () => fetchRoi2Log(roomId, anchorId, startTime, endTime, accountId) },
    { component: 'material_trend_video', key: 'video', run: () => fetchMaterialTrend(roomId, anchorId, startTime, endTime, accountId, 'video') },
    { component: 'material_trend_live', key: 'live', run: () => fetchMaterialTrend(roomId, anchorId, startTime, endTime, accountId, 'live') },
  ];
  // allSettled keeps independent read modules available. A complete cookie failure is
  // deliberately rethrown after every bounded upstream task has settled, rather than
  // being disguised as an empty/partial dashboard.
  const settled = await Promise.allSettled(parts.map(part => part.run()));
  let cookieError = null;
  const materialTrends = {};
  for (let i = 0; i < settled.length; i++) {
    const part = parts[i];
    const result = settled[i];
    if (result.status === 'fulfilled') {
      if (part.key === 'trend_minute' || part.key === 'roi2_log') out[part.key] = result.value;
      else materialTrends[part.key] = result.value;
      continue;
    }
    const error = result.reason || new Error('unknown upstream error');
    if (error.message === 'cookie_expired' || error.code === 'cookie_expired') {
      cookieError = cookieError || error;
      continue;
    }
    out.partial = true;
    out.errors.push({
      component: part.component,
      code: error.code || 'upstream_error',
      error: error.message || 'unknown upstream error',
    });
  }
  if (cookieError) throw cookieError;

  const mt = {};
  if (Object.prototype.hasOwnProperty.call(materialTrends, 'video')) mt.video = materialTrends.video;
  if (Object.prototype.hasOwnProperty.call(materialTrends, 'live')) mt.live = materialTrends.live;
  if (Object.keys(mt).length) out.material_trends = mt;
  return out;
}

module.exports = { fetchBoardDetail, fetchBoardActions, TREND_METRICS };

// ═══════════════════════════════════════════════════════════
// 历史账户专用说明已从试用包移除。
// 输入原始分钟数据，输出 ≤20 行判断材料：分段/动作-效果/异常/当前状态
// ═══════════════════════════════════════════════════════════

/** 分钟点 → N 分钟桶聚合（默认 5 分钟） */
function bucketize(trend, bucketMin = 5) {
  const buckets = [];
  let cur = null;
  for (const p of trend || []) {
    const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})/.exec(String(p.t || ''));
    if (!m) continue;
    const minute = +m[2] * 60 + Math.floor(+m[3] / bucketMin) * bucketMin;
    const key = `${m[1]} ${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
    if (!cur || cur.t !== key) {
      cur = { t: key, cost: 0, orders: 0, net_1h: 0, cost_all: 0 };
      buckets.push(cur);
    }
    cur.cost += p.cost || 0;
    cur.orders += p.orders || 0;
    cur.net_1h += p.net_1h || 0;
    cur.cost_all += p.cost_all || 0;
  }
  return buckets;
}

const parseT = s => new Date(String(s).replace(' ', 'T')).getTime();
const hm = s => String(s).slice(11, 16);

/**
 * 场次消化摘要（LLM 判断材料，确定性计算）
 * @param {object} detail - fetchBoardDetail 输出
 * @param {object} [opts] - { bucketMin=5, breakEven }
 * @returns {object} { lines, segments, action_effects, anomalies, current }
 */
function buildSessionDigest(detail, opts = {}) {
  const bucketMin = opts.bucketMin || 5;
  const breakEven = opts.breakEven || null;
  const buckets = bucketize(detail.trend_minute, bucketMin);
  const lines = [];
  const anomalies = [];

  if (!buckets.length) {
    return { lines: ['分钟趋势无数据'], segments: [], action_effects: [], anomalies: ['无分钟趋势数据'], current: null };
  }

  // ── 分段：消耗速率峰值为界，前=起量段，后按衰减速率再切 ──
  const rates = buckets.map(b => b.cost);
  const peakI = rates.indexOf(Math.max(...rates));
  const segRamp = { from: hm(buckets[0].t), to: hm(buckets[Math.max(0, peakI - 1)].t), kind: '起量段' };
  const post = buckets.slice(peakI);
  const segments = [segRamp];

  // 衰减段判定：峰值后速率 < 峰值 40%（连续 2 桶确认；已是末桶则单桶确认）
  let decayI = -1;
  for (let i = peakI + 1; i < buckets.length; i++) {
    if (rates[i] >= rates[peakI] * 0.4) continue;
    const confirmed = (i === buckets.length - 1) || (rates[i + 1] < rates[peakI] * 0.4);
    if (confirmed) { decayI = i; break; }
  }
  if (decayI > peakI) {
    segments.push({ from: hm(buckets[peakI].t), to: hm(buckets[decayI - 1].t), kind: '高峰平台段' });
    segments.push({ from: hm(buckets[decayI].t), to: hm(buckets[buckets.length - 1].t), kind: '衰减段' });
  } else {
    segments.push({ from: hm(buckets[peakI].t), to: hm(buckets[buckets.length - 1].t), kind: '高峰延续段' });
  }

  // ── 异常：断流（分钟级连续零消耗 ≥ stallMin，默认 30 分钟）/突刺（单桶 > 中位数 4 倍）──
  const stallMin = opts.stallMin != null ? opts.stallMin : 30;
  const sorted = [...rates].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 0;
  let zeroRun = null;
  for (const p of detail.trend_minute || []) {
    if ((p.cost || 0) <= 0) {
      if (!zeroRun) zeroRun = { from: p.t, to: p.t, n: 0 };
      zeroRun.to = p.t; zeroRun.n++;
    } else if (zeroRun) {
      if (zeroRun.n >= stallMin) anomalies.push(`${hm(zeroRun.from)}~${hm(zeroRun.to)} 断流（连续${zeroRun.n}分钟零消耗）`);
      zeroRun = null;
    }
  }
  if (zeroRun && zeroRun.n >= stallMin) anomalies.push(`${hm(zeroRun.from)}~${hm(zeroRun.to)} 断流（连续${zeroRun.n}分钟零消耗）`);
  buckets.forEach((b, i) => {
    if (median > 0 && b.cost > median * 4 && b.cost > 30) anomalies.push(`${hm(b.t)} 突刺（耗 ${b.cost.toFixed(0)} = 中位 ${(b.cost / median).toFixed(1)}×）`);
  });

  // ── 动作-效果对照：每条调控动作 → 其后 15 分钟消耗/单数变化 ──
  const effects = [];
  for (const log of detail.roi2_log || []) {
    if (!log.ts) continue;
    const t15 = log.ts * 1000 + 15 * 60000;
    const after = buckets.filter(b => { const bt = parseT(b.t); return bt >= log.ts * 1000 && bt < t15; });
    const before = buckets.filter(b => { const bt = parseT(b.t); return bt >= log.ts * 1000 - 15 * 60000 && bt < log.ts * 1000; });
    const sum = (arr, k) => arr.reduce((s, b) => s + b[k], 0);
    const clean = String(log.text || '').replace(/\$\$\{|\}\$/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
    effects.push({
      ts: log.ts, time: new Date(log.ts * 1000).toTimeString().slice(0, 5),
      type: log.type, text: clean,
      cost_before: +sum(before, 'cost').toFixed(1), cost_after: +sum(after, 'cost').toFixed(1),
      orders_after: sum(after, 'orders'),
      verdict: sum(after, 'cost') > sum(before, 'cost') * 1.2 ? '起量' : (sum(after, 'cost') < sum(before, 'cost') * 0.8 ? '缩量' : '持平'),
    });
  }

  // ── 当前状态（最近 3 桶）──
  const tail = buckets.slice(-3);
  const tailCost = tail.reduce((s, b) => s + b.cost, 0);
  const tailNet = tail.reduce((s, b) => s + b.net_1h, 0);
  const current = {
    last_bucket: hm(buckets[buckets.length - 1].t),
    cost_15m: +tailCost.toFixed(1),
    orders_15m: tail.reduce((s, b) => s + b.orders, 0),
    net_roi_15m: tailCost > 0 ? +(tailNet / tailCost).toFixed(2) : null,
    session_cost: +buckets.reduce((s, b) => s + b.cost, 0).toFixed(1),
    session_orders: buckets.reduce((s, b) => s + b.orders, 0),
    session_net_roi: (() => { const c = buckets.reduce((s, b) => s + b.cost, 0); return c > 0 ? +(buckets.reduce((s, b) => s + b.net_1h, 0) / c).toFixed(2) : null; })(),
  };

  // ── 组行 ──
  lines.push(`全场：耗 ${current.session_cost} / 单 ${current.session_orders} / 净ROI ${current.session_net_roi ?? '-'}${breakEven ? `（保本 ${breakEven}）` : ''}`);
  lines.push(`分段：${segments.map(s => `${s.kind} ${s.from}~${s.to}`).join(' → ')}`);
  if (anomalies.length) lines.push(`异常：${anomalies.slice(0, 4).join('；')}`);
  for (const e of effects.slice(-5)) {
    lines.push(`动作 ${e.time} [${e.type}] ${e.text} → 后15分钟 耗${e.cost_before}→${e.cost_after}（${e.verdict}）单${e.orders_after}`);
  }
  lines.push(`当前(${current.last_bucket})：近15分钟 耗 ${current.cost_15m} / 单 ${current.orders_15m} / 净ROI ${current.net_roi_15m ?? '-'}`);

  return { lines, segments, action_effects: effects, anomalies, current };
}

module.exports.buildSessionDigest = buildSessionDigest;
module.exports.bucketize = bucketize;
