const fs = require('fs');
const path = require('path');
const { sendJSON, getLocalDateStr } = require('../lib/utils');
const { QIANCHUAN_ACCOUNTS } = require('../lib/config');
const { defaultAccountId } = require('../lib/api-helpers');

const CACHE_DIR = path.join(__dirname, '..', '..', 'cache');
// Older snapshots collapsed missing platform values into zero and must be fetched again.
const DATA_SCHEMA_VERSION = 2;

// 千川店铺成交三分口径：marketing_goal 1=推商品 2=推直播间，无过滤=全部（已用 07-20 终值逐字段核验）
const SPLIT_DEF = [
  { key: 'all', label: '全部', goal: null },
  { key: 'product', label: '推商品', goal: '1' },
  { key: 'live', label: '推直播间', goal: '2' },
];
const METRICS = [
  'stat_cost_for_roi2',                              // 整体消耗(元)
  'total_prepay_and_pay_settle_roi2_1h',             // 净成交ROI
  'total_order_settle_amount_for_roi2_1h',           // 净成交金额(元)
  'total_order_settle_count_for_roi2_1h',            // 净成交订单数
  'total_order_settle_amount_rate_for_roi2_1h',      // 净成交金额结算率
  'total_refund_order_gmv_for_roi2_1h_rate',         // 1小时内退款率
];

function parseNum(v, unit = 'number') {
  if (v == null || !['string', 'number'].includes(typeof v)) return null;
  const s = String(v).trim();
  const suffix = unit === 'percent' ? '%?' : '';
  if (!new RegExp('^[+-]?(?:\\d+|\\d{1,3}(?:,\\d{3})+)(?:\\.\\d+)?' + suffix + '$').test(s)) return null;
  const n = Number(s.replace(/[,%]/g, ''));
  return Number.isFinite(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER
    && (unit !== 'orders' || Number.isSafeInteger(n)) ? n : null;
}

async function querySplit(date, accountId, goal, trendDim, signal) {
  const { statQuery } = require('../lib/qianchuan');
  const aavid = (QIANCHUAN_ACCOUNTS.find(a => a.id === accountId) || {}).aavid;
  const conds = [
    { Field: 'ignore_zero_dimension', Operator: 7, Values: ['on'] },
    { Field: 'advertiser_id', Operator: 7, Values: [aavid] },
    { Field: 'fill_stat_time', Operator: 7, Values: ['on'] },
    { Field: 'adlab_mode_fork', Operator: 7, Values: ['1'] },
    { Field: 'query_self_data', Operator: 7, Values: ['off'] },
  ];
  if (goal) conds.push({ Field: 'marketing_goal', Operator: 7, Values: [goal] });
  const body = {
    reqFrom: 'content_uni_data',
    DataSetKey: 'home_cost_uni_prom',
    Filters: { ConditionRelationshipType: 1, Conditions: conds },
    // 与官方 tab 一致：推商品/推直播间页用 stat_time_hour 维度，可返回逐点序列而不只是 Totals
    Dimensions: [trendDim || 'stat_time_hour'],
    StartTime: date + ' 00:00:00',
    EndTime: date + ' 23:59:59',
    Metrics: METRICS,
    Extra: { refer: 'ecp,7345401917394190374,7345401917394141222,home_cost_uni_prom' },
  };
  const r = await statQuery(body, 3, accountId, { signal });
  const sd = r && r.data && r.data.StatsData;
  // 查询失败（限频/网络/异常）必须与"真零"区分：失败标记 unavailable，前端显示获取失败而非 ¥0
  if (!sd || !sd.Totals || typeof sd.Totals !== 'object' || Array.isArray(sd.Totals)
      || !Object.keys(sd.Totals).length) return { unavailable: true };
  const pick = m => ({
    cost: parseNum(m['stat_cost_for_roi2'] && m['stat_cost_for_roi2'].ValueStr),
    roi: parseNum(m['total_prepay_and_pay_settle_roi2_1h'] && m['total_prepay_and_pay_settle_roi2_1h'].ValueStr),
    gmv: parseNum(m['total_order_settle_amount_for_roi2_1h'] && m['total_order_settle_amount_for_roi2_1h'].ValueStr),
    orders: parseNum(m['total_order_settle_count_for_roi2_1h'] && m['total_order_settle_count_for_roi2_1h'].ValueStr, 'orders'),
    settle_rate: parseNum(m['total_order_settle_amount_rate_for_roi2_1h'] && m['total_order_settle_amount_rate_for_roi2_1h'].ValueStr, 'percent'),
    refund_rate: parseNum(m['total_refund_order_gmv_for_roi2_1h_rate'] && m['total_refund_order_gmv_for_roi2_1h_rate'].ValueStr, 'percent'),
  });
  const totals = pick(sd.Totals);
  if (!trendDim) return totals;
  const rows = ((sd && sd.Rows) || []).map(row => {
    const dv = row.Dimensions && row.Dimensions[trendDim];
    return { time: String((dv && (dv.ValueStr || dv.Value)) || ''), ...pick(row.Metrics || {}) };
  });
  return { ...totals, trend: rows };
}

// ═══ 乘方商品卡（2026-07-22 探针抓包发现）═══
// 历史账户专用说明已从试用包移除。
// 独立数据集 overall_roi_promotion_post_overview_for_product，过滤条件为乘方页面原生组合。
// 历史账户专用说明已从试用包移除。
const CHENGFANG_METRICS = [
  'stat_cost_for_roi2',                              // 消耗
  'total_prepay_and_pay_settle_overall_roi2_1h',     // 净ROI（乘方口径）
  'total_order_settle_amount_for_roi2_1h',           // 净成交金额
  'total_order_settle_count_for_roi2_1h',            // 净成交订单数
  'total_order_settle_amount_rate_for_roi2_1h',      // 结算率
  'total_refund_order_gmv_for_roi2_1h_rate',         // 退款率
];

async function queryChengfangProduct(date, accountId, trendDim, signal) {
  const { statQuery } = require('../lib/qianchuan');
  const aavid = (QIANCHUAN_ACCOUNTS.find(a => a.id === accountId) || {}).aavid;
  const body = {
    DataSetKey: 'overall_roi_promotion_post_overview_for_product',
    Dimensions: [trendDim || 'stat_time_hour'],
    StartTime: date + ' 00:00:00',
    EndTime: date + ' 23:59:59',
    Metrics: CHENGFANG_METRICS,
    Filters: {
      ConditionRelationshipType: 1,
      Conditions: [
        { Field: 'advertiser_id', Operator: 7, Values: [aavid] },
        { Field: 'pricing_category', Operator: 7, Values: ['2'] },
        { Field: 'marketing_goal', Operator: 7, Values: ['1'] },
        { Field: 'ecp_app_id', Operator: 7, Values: ['1'] },
        { Field: 'campaign_type', Operator: 7, Values: ['1'] },
        { Field: 'adlab_mode', Operator: 7, Values: ['1'] },
        { Field: 'adlab_scene_fork', Operator: 7, Values: ['1'] },
        { Field: 'is_overall_roi', Operator: 7, Values: ['1'] },
      ],
    },
    FilterParams: { promotion_overview: ['1'] },
  };
  const r = await statQuery(body, 3, accountId, { signal });
  const sd = r && r.data && r.data.StatsData;
  if (!sd || !sd.Totals || typeof sd.Totals !== 'object' || Array.isArray(sd.Totals)
      || !Object.keys(sd.Totals).length) return { unavailable: true };
  const pick = m => ({
    cost: parseNum(m['stat_cost_for_roi2'] && m['stat_cost_for_roi2'].ValueStr),
    roi: parseNum(m['total_prepay_and_pay_settle_overall_roi2_1h'] && m['total_prepay_and_pay_settle_overall_roi2_1h'].ValueStr),
    gmv: parseNum(m['total_order_settle_amount_for_roi2_1h'] && m['total_order_settle_amount_for_roi2_1h'].ValueStr),
    orders: parseNum(m['total_order_settle_count_for_roi2_1h'] && m['total_order_settle_count_for_roi2_1h'].ValueStr, 'orders'),
    settle_rate: parseNum(m['total_order_settle_amount_rate_for_roi2_1h'] && m['total_order_settle_amount_rate_for_roi2_1h'].ValueStr, 'percent'),
    refund_rate: parseNum(m['total_refund_order_gmv_for_roi2_1h_rate'] && m['total_refund_order_gmv_for_roi2_1h_rate'].ValueStr, 'percent'),
  });
  const totals = pick(sd.Totals);
  if (!trendDim) return totals;
  const rows = ((sd && sd.Rows) || []).map(row => {
    const dv = row.Dimensions && row.Dimensions[trendDim];
    return { time: String((dv && (dv.ValueStr || dv.Value)) || ''), ...pick(row.Metrics || {}) };
  });
  return { ...totals, trend: rows };
}

// Only known amounts can be added. Preserve each upstream ratio separately:
// a combined refund/settlement rate needs denominators not returned by this query.
function mergeSplit(base, extra) {
  const flags = {};
  const b = (base && !base.unavailable) ? base : {};
  const e = (extra && !extra.unavailable) ? extra : {};
  if (!base || base.unavailable) flags.base_unavailable = true;
  if (!extra || extra.unavailable) flags.cf_unavailable = true;
  const finite = Number.isFinite;
  const sum = key => finite(b[key]) && finite(e[key]) ? +(b[key] + e[key]).toFixed(2) : null;
  const cost = sum('cost'), gmv = sum('gmv');
  const ratios = row => Object.fromEntries(['roi', 'settle_rate', 'refund_rate']
    .map(key => [key, finite(row[key]) ? row[key] : null]));
  const derivedRoi = finite(cost) && cost > 0 && finite(gmv) ? +(gmv / cost).toFixed(2) : null;
  return {
    cost,
    gmv,
    orders: sum('orders'),
    roi: derivedRoi,
    roi_source: 'derived_net_gmv_div_cost',
    source_ratios: { uni: ratios(b), chengfang: ratios(e) },
    settle_rate: null,
    refund_rate: null,
    rate_status: 'missing_combined_denominators',
    ...flags,
  };
}

// 逐点趋势合并（按 time 对齐加总，roi 重算）
function mergeTrend(baseRows, extraRows) {
  if (!Array.isArray(baseRows) && !Array.isArray(extraRows)) return undefined;
  const group = rows => {
    const out = new Map();
    for (const row of rows || []) {
      if (!row?.time) continue;
      // Duplicate points are ambiguous, not evidence that they should be summed twice.
      out.set(row.time, out.has(row.time) ? { unavailable: true } : row);
    }
    return out;
  };
  const base = group(baseRows), extra = group(extraRows);
  return [...new Set([...base.keys(), ...extra.keys()])].sort((a, b) => String(a).localeCompare(String(b)))
    .map(time => ({ time, ...mergeSplit(base.get(time), extra.get(time)) }));
}

// 终值性判定：千川日数据 T+1，需等到次日晚上 22:30 后才出全（与 server.js 每日 23:00 昨日终值重写同口径）。
// 抓取本地时刻 ≥ date 次日 23:00 才算终值；此前抓的昨日数据未结算全，落盘会把残缺口径永久固化。
function isFetchedFinal(date, fetchedAt) {
  const t = fetchedAt ? new Date(fetchedAt) : new Date();
  if (isNaN(t.getTime())) return false;
  const finalFrom = new Date(date + 'T00:00:00'); // 本地时区解析
  finalFrom.setDate(finalFrom.getDate() + 1);
  finalFrom.setHours(23, 0, 0, 0);
  return t.getTime() >= finalFrom.getTime();
}

/**
 * GET /api/home-split?account=&date=YYYY-MM-DD
 *
 * 店铺成交三分口径（全部/推商品/推直播间），千川 home_cost_uni_prom 按 marketing_goal 拆分。
 * 今日与历史共用快照；今日一分钟更新一次，历史终值直接复用。
 * 返回：{ ok, account, date, all, product, live, cached, fetched_at }
 *   每个口径：{ label, cost, roi, gmv, orders, settle_rate, refund_rate }
 */
async function readHomeSplitSource(req, res, url) {
  if (req.method !== 'GET') return sendJSON(res, { ok: false, error: 'Method Not Allowed' }, 405);
  try {
    const account = url.searchParams.get('account') || url.searchParams.get('accountId') || defaultAccountId();
    const today = getLocalDateStr();
    const yesterday = getLocalDateStr(new Date(Date.now() - 86400000));
    const date = url.searchParams.get('date') || yesterday;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return sendJSON(res, { ok: false, error: 'date 格式非法' }, 400);
    if (date > today) return sendJSON(res, { ok: false, error: 'date 不能晚于今天' }, 400);
    // 账号必须在已知列表内：否则 querySplit 里 aavid=undefined 会序列化成 [null] 发往千川
    if (!QIANCHUAN_ACCOUNTS.some(a => a.id === account)) return sendJSON(res, { ok: false, error: `未知账号: ${account}` }, 400);
    // trend=hour|day：附带回口径逐点序列（与官方 tab 的 stat_time_hour 维度一致）；day 用于多日对比
    const trendArg = url.searchParams.get('trend');
    const trendDim = trendArg === 'day' ? 'stat_time_day' : trendArg === 'hour' ? 'stat_time_hour' : null;

    // 历史日期：读落盘缓存（trend 请求不走缓存，序列体积大且调用少）
    const cacheFile = path.join(CACHE_DIR, `home_split_${date}_${account}.json`);
    if (!trendDim && date < today && fs.existsSync(cacheFile)) {
      try {
        const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
        // 非终值缓存（次日 23:00 前抓的未结算数据）不认，穿透重拉并在终值后重写——历史已固化的残缺缓存借此自愈
        if (cached.data_schema_version === DATA_SCHEMA_VERSION && cached.account === account
            && cached.date === date && complete(cached) && isFetchedFinal(date, cached.fetched_at)) {
          cached.cached = true;
          return sendJSON(res, cached);
        }
      } catch (e) { /* 缓存损坏则重拉 */ }
    }

    const [uniAll, uniProduct, live, cfProduct] = await Promise.all([
      querySplit(date, account, null, trendDim, req.signal),
      querySplit(date, account, '1', trendDim, req.signal),
      querySplit(date, account, '2', trendDim, req.signal),
      queryChengfangProduct(date, account, trendDim, req.signal),
    ]);
    // 历史账户专用说明已从试用包移除。
    const all = mergeSplit(uniAll, cfProduct);
    const product = mergeSplit(uniProduct, cfProduct);
    if (trendDim) {
      all.trend = mergeTrend(uniAll.trend, cfProduct.trend);
      product.trend = mergeTrend(uniProduct.trend, cfProduct.trend);
    }
    const payload = {
      ok: true, account, date, data_schema_version: DATA_SCHEMA_VERSION,
      all: { label: '全部', ...all },
      product: { label: '推商品', ...product },
      live: { label: '推直播间', ...live },
      cached: false,
      finalized: date < today && isFetchedFinal(date),
      fetched_at: new Date().toISOString(),
    };
    if (trendDim) payload.trend_dim = trendDim;
    // 历史日期且确有数据：写缓存（全零可能是异常日不写；任一口径获取失败也不写——失败态被永久固化会再也刷不掉；
    // 非终值不写——昨日数据须等次日 23:00 结算全后才允许固化，否则残缺口径永久留存）
    if (!trendDim && date < today && isFetchedFinal(date) && !uniAll.unavailable && !uniProduct.unavailable && !live.unavailable && !cfProduct.unavailable && (all.cost > 0 || all.gmv > 0)) {
      try { fs.writeFileSync(cacheFile, JSON.stringify(payload, null, 2), 'utf-8'); } catch (e) { /* 非关键 */ }
    }
    return sendJSON(res, payload);
  } catch (e) {
    console.error('[home-split] 异常:', e.message);
    return sendJSON(res, { ok: false, error: 'internal_server_error' }, 500);
  }
}

const snapshots = new Map();
const snapshotDir = path.join(require('../lib/config').CACHE_DIR, 'home-split');
const complete = data => data?.ok === true && ['all', 'product', 'live'].every(key => {
  const row = data[key];
  return row && !row.unavailable && !row.base_unavailable && !row.cf_unavailable;
});

async function handleHomeSplit(req, res, url) {
  const account = url.searchParams.get('account') || url.searchParams.get('accountId') || defaultAccountId();
  const today = getLocalDateStr();
  const date = url.searchParams.get('date') || getLocalDateStr(new Date(Date.now() - 86400000));
  if (req.method !== 'GET' || !QIANCHUAN_ACCOUNTS.some(a => a.id === account)
      || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date > today) return readHomeSplitSource(req, res, url);
  const trend = ['hour', 'day'].includes(url.searchParams.get('trend')) ? url.searchParams.get('trend') : '';
  const key = JSON.stringify([account, date, trend]);
  const file = path.join(snapshotDir, `${account}_${date}.json`);
  let state = snapshots.get(key);
  if (!state) {
    state = { value: null, flight: null, retryAt: 0, failure: null };
    if (!trend) {
      for (const source of [file, path.join(CACHE_DIR, `home_split_${date}_${account}.json`)]) {
        try {
          const saved = JSON.parse(fs.readFileSync(source, 'utf8'));
          if (saved.data_schema_version === DATA_SCHEMA_VERSION && saved.account === account
              && saved.date === date && complete(saved)) { state.value = saved; break; }
        } catch {}
      }
    }
    snapshots.set(key, state);
    if (snapshots.size > 100) {
      for (const [oldKey, old] of snapshots) {
        if (oldKey !== key && !old.flight) { snapshots.delete(oldKey); break; }
      }
    }
  }
  const age = state.value ? Date.now() - Date.parse(state.value.fetched_at) : Infinity;
  const stable = date < today && state.value && isFetchedFinal(date, state.value.fetched_at);
  const stale = !stable && (!Number.isFinite(age) || age >= 60000);
  if ((!state.value || stale) && !state.flight && Date.now() >= state.retryAt) {
    state.flight = (async () => {
      let status = 200, payload;
      await readHomeSplitSource({ method: 'GET', signal: AbortSignal.timeout(45000) }, {
        writeHead(code) { status = code; }, end(text) { payload = JSON.parse(text); },
      }, url);
      if (complete(payload)) {
        state.value = payload; state.failure = null;
        if (!trend) {
          try { fs.mkdirSync(snapshotDir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(payload)); } catch {}
        }
      } else {
        state.failure = { status: status >= 400 ? status : 502, payload: { ok: false,
          error: payload?.error || '千川首页部分数据暂不可用', code: 'home_split_unavailable', retryable: true } };
        state.retryAt = Date.now() + 30000;
      }
      return state.failure || { status, payload };
    })().catch(() => {
      state.retryAt = Date.now() + 30000;
      return (state.failure = { status: 502, payload: { ok: false, code: 'home_split_unavailable', retryable: true, error: '成交汇总更新失败' } });
    }).finally(() => { state.flight = null; });
  }
  if (state.value) return sendJSON(res, { ...state.value, cached: true, stale, finalized: !!stable,
    refreshing: !!state.flight, refresh_error: state.failure?.payload.error || null });
  // 页面先显示“读取中”，正常 API 调用仍可等待同一轮结果。
  if (url.searchParams.get('quick') === '1' && state.flight) {
    return sendJSON(res, { ok: true, account, date, pending: true, refreshing: true,
      all: null, product: null, live: null, fetched_at: null }, 202);
  }
  const result = state.flight ? await state.flight : state.failure;
  return sendJSON(res, result.payload, result.status);
}

module.exports = handleHomeSplit;
