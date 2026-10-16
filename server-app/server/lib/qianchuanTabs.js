const { getLocalDateStr, getFileSafeTimestamp } = require('./utils');
/**
 * server/lib/qianchuanTabs.js — 千川素材分析页 3 个 tab 取数模块
 *
 * 抓包确认(REVERSE_API.md §10)：三 tab 共用 statQuery + DataSetKey=roi2_video_material_analysis，
 * 差异仅在 Dimensions/Metrics/reqFrom。本模块封装：
 *   - fetchRecommendData  素材生命周期列表(对齐抓包的 11 Dimensions + 8 Metrics + 分页)
 *   - fetchVideoFilterList 素材退款/结算细分口径(15 Metrics，含退款率/结算率)
 *   - fetchVideoFilterWithCost 退款率分析(关联消耗，输出退款率/结算率)
 *   - fetchProductSummary  商品维度汇总
 *   - fetchAwemeList      关联直播间列表
 *
 * 复用 server/lib/qianchuan.js:statQuery + enqueue(限频4s) + cookie/CSRF。
 * content-analyze / crowd-analyze 的"单素材详情"接口待补(见 REVERSE_API.md §10.4)。
 */
const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');
const { AAVID, CACHE_DIR, GFVERSION } = require('./config');
const { enqueue, statQuery, statQueryDirect, requestAPI, qcError } = require('./qianchuan');
const { resolveQcAccount, resolveAavid } = require('./cookie');
const { updateInsightClickDrop } = require('./db');
const creativeVideoLibrary = require('./creativeVideoLibrary');

const QC_TABS_CACHE_DIR = path.join(CACHE_DIR, 'qianchuan_tabs');
if (!fs.existsSync(QC_TABS_CACHE_DIR)) fs.mkdirSync(QC_TABS_CACHE_DIR, { recursive: true });

const MAX_PAGES = 25;

// 历史账户专用说明已从试用包移除。
function baseFilters(accountId) {
  const aavid = resolveAavid(accountId);
  return [
    { Field: 'advertiser_id', Operator: 7, Values: [aavid] },
    { Field: 'marketing_goal', Operator: 7, Values: ['2'] },     // 2=直播
    { Field: 'adlab_mode_fork', Operator: 7, Values: ['1'] },
    { Field: 'material_type', Operator: 7, Values: ['3'] },       // 3=视频
  ];
}

// recommend-data tab 的素材列表维度(对齐抓包)
const RECOMMEND_DIMENSIONS = [
  'material_type', 'material_name_v2', 'material_id', 'material_suggest_v2',
  'material_content_v2', 'material_image_mode_v2', 'material_suggest_reason_v2',
  'material_duration_v2', 'material_create_time_v2', 'material_source_v2', 'material_tag_list',
];
const RECOMMEND_METRICS = [
  'stat_cost_for_roi2', 'total_prepay_and_pay_order_roi2',
  'total_pay_order_gmv_include_coupon_for_roi2', 'total_pay_order_count_for_roi2',
  'total_cost_per_pay_order_for_roi2', 'total_pay_order_gmv_for_roi2',
  'total_pay_order_coupon_amount_for_roi2', 'total_ecom_platform_subsidy_amount_for_roi2',
];

// video-filter-list 的退款/结算细分口径(15 Metrics)
const FILTER_LIST_METRICS = [
  'stat_cost_for_overall_roi2', 'total_prepay_and_pay_settle_overall_roi2_1h',
  'total_cost_per_pay_order_settle_for_overall_roi2_1h', 'shop_estimated_comission_cost',
  'total_prepay_and_pay_settle_roi2_1h', 'total_order_settle_amount_for_roi2_1h',
  'total_order_settle_count_for_roi2_1h', 'total_cost_per_pay_order_settle_for_roi2_1h',
  'total_order_real_settle_amount_for_roi2_1h', 'no_refund_ecom_coupon_amount_for_roi2',
  'no_refund_ecom_platform_subsidy_amount_for_roi2', 'total_order_settle_amount_rate_for_roi2_1h',
  'total_order_settle_count_rate_for_roi2_1h', 'total_refund_order_count_for_roi2_1h',
  'total_refund_order_gmv_for_roi2_1h_all',
];

/**
 * 通用分页取数
 * @param {object} opts { reqFrom, dataSetKey, dimensions, metrics, startTime, endTime, pageSize, extraFilters, accountId }
 */
async function fetchPaged({ reqFrom, dataSetKey, dimensions, metrics, startTime, endTime, pageSize = 200, extraFilters = [], accountId }) {
  const body = {
    DataSetKey: dataSetKey,
    reqFrom,
    StartTime: startTime + ' 00:00:00',
    EndTime: endTime + ' 23:59:59',
    Dimensions: dimensions,
    Metrics: metrics,
    Filters: { ConditionRelationshipType: 1, Conditions: baseFilters(accountId).concat(extraFilters) },
    OrderBy: [{ Type: 2, Field: 'stat_cost_for_roi2' }],
  };
  const allRows = [];
  let truncated = false;
  let total = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    body.PageParams = { Offset: allRows.length, Limit: pageSize };
    const result = await statQuery(body, 3, accountId);
    if (!result) break;
    const sd = result.data && result.data.StatsData;
    const rows = (sd && sd.Rows) || [];
    total = parseInt(sd && sd.TotalCount) || rows.length;
    allRows.push(...rows);
    console.log(`  [${reqFrom}] 第${page + 1}页 ${rows.length}条 · 累计 ${allRows.length}/${total}`);
    if (allRows.length >= total || rows.length < pageSize) break;
  }
  if (allRows.length < total) truncated = true;
  return { rows: allRows, truncated };
}

async function asyncWriteFile(name, data) {
  const stamp = getFileSafeTimestamp();
  await fsPromises.writeFile(path.join(QC_TABS_CACHE_DIR, `${name}_${stamp}.json`), JSON.stringify(data, null, 2), 'utf8');
}

/** recommend-data tab：素材生命周期列表（11 Dimensions + 8 Metrics，含创建时间/来源/标签） */
async function fetchRecommendData(startDate, endDate, accountId) {
  const result = await fetchPaged({
    reqFrom: 'roi2_material_list',
    dataSetKey: 'roi2_video_material_analysis',
    dimensions: RECOMMEND_DIMENSIONS,
    metrics: RECOMMEND_METRICS,
    startTime: startDate, endTime: endDate, accountId,
  });
  await asyncWriteFile('recommend_data', { startDate, endDate, ...result });
  return result;
}

/** video-filter-list：素材退款/结算细分口径（含退款单数/退款GMV/结算率）
 *  注：该 reqFrom 不返回消耗(stat_cost_for_overall_roi2 恒 0)，需关联 fetchRecommendData 的消耗。
 *  用 fetchVideoFilterWithCost 可拿到带消耗+退款率的完整行。
 */
async function fetchVideoFilterList(startDate, endDate, accountId) {
  const result = await fetchPaged({
    reqFrom: 'video-filter-list',
    dataSetKey: 'roi2_video_material_analysis',
    dimensions: ['material_name_v2', 'material_content_v2', 'material_id'],
    metrics: FILTER_LIST_METRICS,
    startTime: startDate, endTime: endDate, accountId,
  });
  await asyncWriteFile('video_filter_list', { startDate, endDate, ...result });
  return result;
}

/** 退款率分析(带消耗)：video-filter-list × fetchRecommendData 关联，
 *  输出每条素材的消耗/成交/退款金额/退款单数/退款率/结算率。
 *  退款率 = 退款GMV / 成交GMV(含券)。千川看板"高退款"阈值 1h退款率≥10%。 */
async function fetchVideoFilterWithCost(startDate, endDate, accountId) {
  const [filterRes, listRes] = await Promise.all([
    fetchVideoFilterList(startDate, endDate, accountId),
    fetchRecommendData(startDate, endDate, accountId),
  ]);
  // 列表消耗/GMV 按 material_id 建索引
  const costMap = {};
  for (const row of (listRes.rows || [])) {
    const id = row.Dimensions?.material_id?.Value;
    if (!id || id === '-2' || id === '-1') continue;
    costMap[id] = {
      cost: row.Metrics?.stat_cost_for_roi2?.Value || 0,
      gmv: row.Metrics?.total_pay_order_gmv_include_coupon_for_roi2?.Value || 0,
    };
  }
  const rows = (filterRes.rows || []).map(row => {
    const id = row.Dimensions?.material_id?.Value;
    const m = row.Metrics || {};
    const cost = costMap[id]?.cost || 0;
    const gmv = costMap[id]?.gmv || 0;
    const refundGmv = m.total_refund_order_gmv_for_roi2_1h_all?.Value || 0;
    const refundCount = m.total_refund_order_count_for_roi2_1h?.Value || 0;
    const settleRate = m.total_order_settle_amount_rate_for_roi2_1h?.Value;
    return {
      material_id: id,
      name: row.Dimensions?.material_name_v2?.ValueStr || row.Dimensions?.material_name_v2?.Value || '',
      cost, gmv,
      refundGmv, refundCount,
      refundRate: gmv > 0 ? refundGmv / gmv : 0,        // 退款率 = 退款GMV / 成交GMV
      settleRate: settleRate != null ? settleRate / 100 : null, // 接口返回 0-100，归一到 0-1
    };
  }).filter(r => r.cost > 0 || r.refundGmv > 0) // 去掉既无消耗又无退款的死行
    .sort((a, b) => b.refundGmv - a.refundGmv); // 按退款金额降序
  const result = { startDate, endDate, count: rows.length, rows };
  await asyncWriteFile('video_filter_with_cost', result);
  return result;
}

/** 商品维度汇总（单行 Totals） */
async function fetchProductSummary(startDate, endDate, accountId) {
  const body = {
    DataSetKey: 'roi2_video_material_analysis',
    reqFrom: 'roi2_material_analysis_tab_product',
    StartTime: startDate + ' 00:00:00',
    EndTime: endDate + ' 23:59:59',
    Dimensions: [],
    Metrics: ['stat_cost_for_roi2'],
    Filters: { ConditionRelationshipType: 1, Conditions: baseFilters(accountId) },
  };
  const result = await statQuery(body, 3, accountId);
  await asyncWriteFile('product_summary', { startDate, endDate, result });
  return result;
}

/** 关联直播间列表 */
async function fetchAwemeList(startDate, endDate, accountId) {
  const result = await fetchPaged({
    reqFrom: 'awemelist_2',
    dataSetKey: 'overall_data_live_aweme_list',
    dimensions: ['anchor_show_id', 'anchor_name', 'anchor_icon', 'anchor_auth_type'],
    metrics: ['stat_cost_for_roi2'],
    startTime: startDate, endTime: endDate, accountId,
    extraFilters: [{ Field: 'anchor_name', Operator: 7, Values: [''] }],
  });
  await asyncWriteFile('aweme_list', { startDate, endDate, ...result });
  return result;
}

/**
 * 单素材详情(纯 API 版,无需浏览器点 DOM)。
 * 抓包自 tools/capture_material_detail.js,参数见 REVERSE_API.md §10.7。
 *
 * 一个素材返回:
 *   - dailyTrend   按天历史表现(消耗/ROI/GMV/转化/结算,27 metrics)
 *   - dailyTable   按天完整数据表(99 metrics,含播放/互动/退款/7-90d结算)
 *   - retention    观看人数秒级时序(找高光帧)
 *   - churn        流失人数秒级时序
 *   - churnRate    前5秒流失率
 *   - audience     {gender, age, city, province, crowd}(8大人群/年龄/性别/城市/省份 占比)
 */
const PROMOTION_DS = 'roi2_video_material_analysis_promotion';
const INSIGHT_DS = 'roi2_video_material_analysis_insight';
const CROWD_DS = 'roi2_video_material_analysis_crow';

const DAILY_TREND_METRICS = [
  'stat_cost_for_roi2', 'total_prepay_and_pay_order_roi2', 'total_pay_order_gmv_include_coupon_for_roi2',
  'total_prepay_and_pay_settle_roi2_1h', 'total_order_settle_count_for_roi2_1h',
  'live_cvr_rate_for_roi2_v2', 'live_convert_rate_for_roi2_v2', 'total_order_settle_amount_for_roi2_1h',
];
const DAILY_TABLE_METRICS = [
  'live_show_count_for_roi2_v2', 'live_watch_count_for_roi2_v2', 'live_cvr_rate_for_roi2_v2',
  'live_convert_rate_for_roi2_v2', 'stat_cost_for_roi2', 'total_prepay_and_pay_order_roi2',
  'total_pay_order_gmv_include_coupon_for_roi2', 'total_pay_order_count_for_roi2',
  'total_cost_per_pay_order_for_roi2', 'total_cpc_for_roi2', 'total_ecpm_for_roi2',
  'video_like_count_for_roi2', 'video_avg_watch_duration_for_roi2', 'video_play_count_for_roi2_v2',
  'video_play_finish_rate_for_roi2_v2', 'video_play_duration_3s_rate_for_roi2',
  'video_play_duration_5s_rate_for_roi2', 'total_refund_order_count_for_roi2_1h',
  'total_refund_order_gmv_for_roi2_1h_all', 'total_refund_order_gmv_for_roi2_1h_rate',
];

/** 按天历史表现 + 完整数据表（两请求并发） */
async function fetchMaterialDaily(materialId, startDate, endDate, accountId) {
  const aavid = resolveAavid(accountId);
  const matFilter = { Field: 'material_id', Operator: 7, Values: [materialId] };
  const filters = [
    { Field: 'advertiser_id', Operator: 7, Values: [aavid] },
    { Field: 'marketing_goal', Operator: 7, Values: ['2'] },
    { Field: 'material_type', Operator: 7, Values: ['3'] },
    { Field: 'fill_stat_time', Operator: 7, Values: ['on'] },
    matFilter,
  ];
  const baseBody = {
    DataSetKey: PROMOTION_DS,
    StartTime: startDate + ' 00:00:00',
    EndTime: endDate + ' 23:59:59',
    Dimensions: ['stat_time_day'],
    Filters: { ConditionRelationshipType: 1, Conditions: filters },
  };
  // 按天趋势(精简) + 按天完整数据表 并发拉取
  const [trend, table] = await Promise.all([
    statQuery({ ...baseBody, reqFrom: 'material-analysis-recomand-data', Metrics: DAILY_TREND_METRICS }, 3, accountId).catch(e => { if (e.message === 'cookie_expired') throw e; return null; }),
    statQuery({ ...baseBody, reqFrom: 'recommand_data_table', Metrics: DAILY_TABLE_METRICS }, 3, accountId).catch(e => { if (e.message === 'cookie_expired') throw e; return null; }),
  ]);
  return {
    dailyTrend: ((trend && trend.data && trend.data.StatsData && trend.data.StatsData.Rows) || []),
    dailyTable: ((table && table.data && table.data.StatsData && table.data.StatsData.Rows) || []),
  };
}

/** 秒级时序: 观看/流失/流失率（三请求并发） */
async function fetchMaterialTimeseries(materialId, startDate, endDate, accountId) {
  const aavid = resolveAavid(accountId);
  const filters = [
    { Field: 'advertiser_id', Operator: 7, Values: [aavid] },
    { Field: 'material_id', Operator: 7, Values: [materialId] },
    { Field: 'marketing_goal', Operator: 7, Values: ['2'] },
  ];
  const baseBody = {
    DataSetKey: INSIGHT_DS,
    StartTime: startDate + ' 00:00:00',
    EndTime: endDate + ' 23:59:59',
    Filters: { ConditionRelationshipType: 1, Conditions: filters },
  };
  // 点击次数必须走 promotion 数据集（roi2_video_material_analysis）取真实汇总；
  // insight 数据集按秒拆开，live_watch_count_for_roi2_v2 按秒累加会得到“观看·秒”而非真实点击总数。
  const clickBody = {
    DataSetKey: PROMOTION_DS,
    StartTime: startDate + ' 00:00:00',
    EndTime: endDate + ' 23:59:59',
    Dimensions: [],
    Filters: { ConditionRelationshipType: 1, Conditions: filters },
    Metrics: ['live_watch_count_for_roi2_v2'],
  };
  const [watch, lose, loseRate, dropTotal, clickTotal] = await Promise.all([
    statQuery({ ...baseBody, Dimensions: ['duration'], Metrics: ['live_watch_count_for_roi2_v2'] }, 3, accountId).catch(e => { if (e.message === 'cookie_expired') throw e; return null; }),
    statQuery({ ...baseBody, Dimensions: ['duration'], Metrics: ['video_lose_count_for_roi2'] }, 3, accountId).catch(e => { if (e.message === 'cookie_expired') throw e; return null; }),
    statQuery({
      ...baseBody, Dimensions: [], Metrics: ['video_user_lose_rate_for_roi2'],
      Filters: { ConditionRelationshipType: 1, Conditions: [...filters, { Field: 'duration', Operator: 9, Values: ['0', '5'] }] },
    }, 3, accountId).catch(e => { if (e.message === 'cookie_expired') throw e; return null; }),
    statQuery({ ...baseBody, Dimensions: [], Metrics: ['video_lose_count_for_roi2'] }, 3, accountId).catch(e => { if (e.message === 'cookie_expired') throw e; return null; }),
    statQuery(clickBody, 3, accountId).catch(e => { if (e.message === 'cookie_expired') throw e; return null; }),
  ]);
  const rows = (r) => ((r && r.data && r.data.StatsData && r.data.StatsData.Rows) || []);
  const dropRow = rows(dropTotal)[0];
  const clickRow = rows(clickTotal)[0];
  const clickCount = clickRow ? (clickRow.Metrics.live_watch_count_for_roi2_v2?.Value || 0) : 0;
  const dropCount = dropRow ? (dropRow.Metrics.video_lose_count_for_roi2?.Value || 0) : 0;
  return {
    retention: rows(watch).map(r => ({ second: parseInt(r.Dimensions.duration.Value), viewers: r.Metrics.live_watch_count_for_roi2_v2.Value })),
    churn: rows(lose).map(r => ({ second: parseInt(r.Dimensions.duration.Value), lost: r.Metrics.video_lose_count_for_roi2.Value })),
    churnRate5s: rows(loseRate)[0] ? rows(loseRate)[0].Metrics.video_user_lose_rate_for_roi2.Value : null,
    click_count: clickCount,
    drop_count: dropCount,
  };
}

/** 人群画像: 性别/年龄/城市/省份/8大人群
 *  5 个维度相互独立，并发发起 statQuery 请求。
 *  注意：statQuery 内部走 enqueue 限频队列，所以 5 个请求实际按 REQUEST_INTERVAL 间隔串行执行，
 *  保证不触发千川风控。单条约 4s，5 条约 20s。
 */
async function fetchMaterialAudience(materialId, startDate, endDate, accountId) {
  const aavid = resolveAavid(accountId);
  const filters = [
    { Field: 'advertiser_id', Operator: 7, Values: [aavid] },
    { Field: 'marketing_goal', Operator: 7, Values: ['2'] },
    { Field: 'material_type', Operator: 7, Values: ['3'] },
    { Field: 'material_id', Operator: 7, Values: [materialId] },
  ];
  const body = {
    DataSetKey: CROWD_DS,
    StartTime: startDate + ' 00:00:00',
    EndTime: endDate + ' 23:59:59',
    Metrics: ['live_show_count_for_roi2_v2'],
    Filters: { ConditionRelationshipType: 1, Conditions: filters },
  };
  const dims = { gender: '性别', age: '年龄', city_name: '城市', province_name: '省份', user_group_label_name: '8大人群' };
  const entries = Object.entries(dims);
  const responses = await Promise.all(entries.map(([dim]) =>
    statQuery({ ...body, reqFrom: dim, Dimensions: [dim] }, 3, accountId).catch(e => { if (e.message === 'cookie_expired') throw e; return null; })));
  const out = {};
  responses.forEach((r, i) => {
    const dim = entries[i][0];
    const rows = ((r && r.data && r.data.StatsData && r.data.StatsData.Rows) || []);
    const total = rows.reduce((s, x) => s + (x.Metrics.live_show_count_for_roi2_v2.Value || 0), 0);
    out[dim] = rows.map(x => ({
      label: x.Dimensions[dim].ValueStr || x.Dimensions[dim].Value,
      count: x.Metrics.live_show_count_for_roi2_v2.Value,
      rate: total > 0 ? x.Metrics.live_show_count_for_roi2_v2.Value / total : 0,
    })).sort((a, b) => b.count - a.count);
    out[dim + '_total'] = total;
  });
  return out;
}

/**
 * 素材内容分析(内容公式/脚本/创意元素) — 纯 API。
 * 抓包自 dataV2/roi2-material-analysis 详情抽屉「内容分析」Tab(探针
 *   cache/material_content_captures/material_content_capture.json):
 *   - getContentMaterialAnalysisInfo (POST): 创意元素 8 类标签 + cost_rank/ctr_rank + material_uri
 *   - getContentFormulaAndScript (GET ?vid=material_uri): 内容公式(结构化标签) + 脚本全文
 * 非 statQuery 端点, 走 requestAPI + enqueue 4s 节流。
 * @param {string} materialId
 * @param {string} [accountId]
 * @returns {Promise<object>} { material_uri, formula, script, creative_tags, cost_rank, ctr_rank, info }
 */
function assertMaterialContentResponse(response, component) {
  const statusCode = response && (response.status_code ?? response.code ?? 0);
  if (statusCode === 0) return response;
  if (statusCode === 2) {
    throw qcError('rate_limited', `千川${component}接口限流`, {
      statusCode: 429, retryable: true, component,
    });
  }
  if (statusCode === 401 || statusCode === 40001 || /登录/.test(String(response && response.message || ''))) {
    throw qcError('cookie_expired', 'cookie_expired', { statusCode: 401, component });
  }
  throw qcError('upstream_bad_response', `千川${component}接口异常 status_code=${statusCode} msg=${response && response.message || ''}`, {
    statusCode: 502, retryable: false, component,
  });
}

function contentError(error, component) {
  return {
    code: error && error.code || 'upstream_error',
    component,
    message: error && error.message || String(error),
    retryable: Boolean(error && error.retryable),
  };
}

async function fetchMaterialContent(materialId, accountId, options = {}) {
  const aavid = resolveAavid(accountId);
  // p_date 用昨天(千川数据 T+1)
  const d = new Date(); d.setDate(d.getDate() - 1);
  const pDate = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  const basePath = '/ad/api/data/v1/material-analysis';

  // 官方页面的做法是：已知 vid 时脚本与内容分析并行请求，任一完成即可先渲染。
  // 这里把两次 HTTP 放进同一个高优先级队列任务，避免被账号队列间隔人为拉长；
  // 未知 vid 时先用内容分析拿 material_uri，再请求脚本，通常也只需两个亚秒级请求。
  const infoBody = { material_id: String(materialId), p_date: pDate, period_type: 30, assist_type: 3, assist_video_type: 2, aavid };
  const result = {
    material_id: String(materialId),
    p_date: pDate,
    material_uri: null,
    formula: null,
    formula_detail: null,
    script: null,
    creative_tags: null,
    cost_rank: null,
    ctr_rank: null,
    script_source: null,
    info: null,
    source_at: new Date().toISOString(),
    partial: false,
    errors: [],
  };

  const knownVid = options.knownVid ? String(options.knownVid) : null;
  const infoPath = `${basePath}/getContentMaterialAnalysisInfo?aavid=${aavid}`;
  const formulaPath = vid => `${basePath}/getContentFormulaAndScript?vid=${encodeURIComponent(vid)}&aavid=${aavid}`;
  const loadCore = async queueSignal => {
    const fetchInfo = async () => assertMaterialContentResponse(
      await requestAPI('POST', infoPath, infoBody, accountId, queueSignal),
      'material_content',
    );
    const fetchFormula = async vid => assertMaterialContentResponse(
      await requestAPI('GET', formulaPath(vid), null, accountId, queueSignal),
      'material_script',
    );

    if (knownVid) {
      const [infoSettled, formulaSettled] = await Promise.allSettled([fetchInfo(), fetchFormula(knownVid)]);
      return {
        info: infoSettled.status === 'fulfilled' ? infoSettled.value : null,
        formula: formulaSettled.status === 'fulfilled' ? formulaSettled.value : null,
        errors: [
          ...(infoSettled.status === 'rejected' ? [contentError(infoSettled.reason, 'material_content')] : []),
          ...(formulaSettled.status === 'rejected' ? [contentError(formulaSettled.reason, 'material_script')] : []),
        ],
        scriptVid: knownVid,
        scriptSource: 'cached_material_uri',
      };
    }

    try {
      const info = await fetchInfo();
      const vid = info && info.data && info.data.material_uri;
      if (!vid) return { info, formula: null, errors: [], scriptVid: null, scriptSource: null };
      try {
        const formula = await fetchFormula(vid);
        return { info, formula, errors: [], scriptVid: vid, scriptSource: 'material_analysis_uri' };
      } catch (error) {
        return { info, formula: null, errors: [contentError(error, 'material_script')], scriptVid: vid, scriptSource: 'material_analysis_uri' };
      }
    } catch (error) {
      return { info: null, formula: null, errors: [contentError(error, 'material_content')], scriptVid: null, scriptSource: null };
    }
  };

  let core;
  if (options.direct === true) {
    // 交互式素材抽屉走独立短期限通道。官方内容页本身也会并行发起这两次只读请求；
    // 若继续排在账号统计队列后面，材料列表的后台刷新会把一次点击拖到十几秒。
    // 该通道只用于单素材内容读取，仍由 requestAPI 的连接/响应期限和本地 single-flight 保护。
    const timeoutMs = options.timeoutMs || 10000;
    const controller = new AbortController();
    const timeoutError = qcError('material_content_timeout', `单素材内容读取超过 ${timeoutMs}ms`, {
      retryable: true,
      statusCode: 504,
      timeoutMs,
      component: 'material_content',
    });
    const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
    timer.unref?.();
    const onAbort = () => controller.abort(options.signal.reason || qcError('request_aborted', '调用方已取消素材读取', {
      retryable: true,
      statusCode: 499,
      component: 'material_content',
    }));
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      core = await loadCore(controller.signal);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
  } else {
    core = await enqueue(loadCore, accountId, {
      priority: 1,
      timeoutMs: options.timeoutMs || 10000,
      signal: options.signal,
      label: `material-content:${materialId}`,
    });
  }

  const info = core.info;
  if (info && info.data) {
    const infoData = info.data;
    result.material_uri = infoData.material_uri || core.scriptVid || null;
    result.cost_rank = infoData.cost_rank || null;
    result.ctr_rank = infoData.ctr_rank || null;
    result.creative_tags = infoData.my_tag_entry || null;
    result.info = infoData;
  }
  result.script_source = core.scriptSource;
  const formulaResp = core.formula;
  if (formulaResp && formulaResp.data) {
    result.formula = formulaResp.data.data || null;
    result.formula_detail = formulaResp.data.detail || null;
    result.script = formulaResp.data.text || null;
  }

  // 极少数素材内容分析不返回 material_uri，保留视频库兜底；该分支不阻塞正常素材快路径。
  if (!result.script && !core.scriptVid && !core.errors.length) {
    const rawMaterial = await creativeVideoLibrary.fetchRawByMaterialId(accountId, materialId).catch(error => {
      result.errors.push(contentError(error, 'video_library'));
      return null;
    });
    const fallbackVid = rawMaterial && ((rawMaterial.videoUrl && rawMaterial.videoUrl.uri) || rawMaterial.itemId);
    if (fallbackVid) {
      result.script_source = rawMaterial.videoUrl && rawMaterial.videoUrl.uri ? 'video_library_uri' : 'video_library_item_id';
      try {
        const fallbackFormula = await enqueue(
          signal => requestAPI('GET', formulaPath(fallbackVid), null, accountId, signal).then(r => assertMaterialContentResponse(r, 'material_script')),
          accountId,
          { priority: 1, timeoutMs: options.timeoutMs || 10000, signal: options.signal, label: `material-script:${materialId}` },
        );
        if (fallbackFormula && fallbackFormula.data) {
          result.formula = fallbackFormula.data.data || null;
          result.formula_detail = fallbackFormula.data.detail || null;
          result.script = fallbackFormula.data.text || null;
        }
      } catch (error) {
        result.errors.push(contentError(error, 'material_script'));
      }
    }
  } else {
    result.errors.push(...core.errors);
  }

  result.partial = result.errors.length > 0;
  if (!result.script && !result.creative_tags && result.errors.length) {
    const first = result.errors[0];
    throw qcError(first.code, first.message, {
      statusCode: first.code === 'cookie_expired' ? 401 : first.code === 'rate_limited' ? 429 : first.code && first.code.includes('timeout') ? 504 : 502,
      retryable: first.retryable,
      component: first.component,
      errors: result.errors,
    });
  }

  await asyncWriteFile('material_content_' + materialId, result);
  return result;
}

async function fetchMaterialDetail(materialId, startDate, endDate, accountId) {
  console.log(`[materialDetail] ${materialId} ${startDate}~${endDate} (${accountId || 'default'})`);
  const [daily, ts, audience, content] = await Promise.all([
    fetchMaterialDaily(materialId, startDate, endDate, accountId),
    fetchMaterialTimeseries(materialId, startDate, endDate, accountId),
    fetchMaterialAudience(materialId, startDate, endDate, accountId),
    fetchMaterialContent(materialId, accountId),
  ]);
  // 秒级时序已拆出整体点击次数 / 整体流失次数
  const result = {
    material_id: materialId, startDate, endDate, accountId: accountId || 'default',
    fetched_at: new Date().toISOString(),
    click_count: ts.click_count || 0,
    drop_count: ts.drop_count || 0,
    ...daily, ...ts, audience, content
  };
  await asyncWriteFile('material_detail_' + materialId, result);
  // 把实时获取到的点击/流失反写回本地 insight，下次 profile 快路径直接命中。
  // 口径闸（2026-07-30 方案A）：仅当查询区间恰为30天（与夜间"近30天累计"统一口径一致）才允许反写，
  // 单日/7天等其他区间跳过——否则小口径值会覆盖30天累计，前端整体流失数漂移
  const rangeDays = Math.round((new Date(endDate + 'T00:00:00') - new Date(startDate + 'T00:00:00')) / 864e5);
  if (rangeDays === 29) try {
    updateInsightClickDrop(accountId || 'default', materialId, result.click_count, result.drop_count);
    // 同时清掉该素材的 profile 日缓存，避免同一天内打开时快路径仍用旧数
    const profileCacheDir = path.join(CACHE_DIR, 'material_profile');
    const prefix = `profile_${accountId || 'default'}_${materialId}_`;
    if (fs.existsSync(profileCacheDir)) {
      fs.readdirSync(profileCacheDir)
        .filter(f => f.startsWith(prefix))
        .forEach(f => fs.unlinkSync(path.join(profileCacheDir, f)));
    }
  } catch (e) {
    console.log(`[materialDetail] 反写 insight 失败 ${materialId}: ${e.message}`);
  }
  return result;
}

/**
 * 实时直播状态(纯 API，直查千川)。
 * 抓包自 dataV2/roi2-live-analysis 页的 topLivingCardRoi2 请求:
 *   DataSetKey=roi2_live_analysis_update, Filter room_status=2(直播中)。
 * 返回当前日期在播直播间列表。历史查询必须显式传options.date，不能用旧调试配置覆盖实时日期。
 * 不进 statQuery 限频队列(状态查询要快，单请求不触发风控)。
 * @param {string} [accountId]
 * @returns {Promise<object>} { isLive, rooms:[{roomId,roomName,startTime,cost}], raw, error }
 */
async function fetchLiveStatus(accountId, options = {}) {
  const todayStr = options.date || getLocalDateStr();
  try {
    const res = await fetchLiveSessions(todayStr, { accountId, signal: options.signal, priority: options.priority });
    if (res.error && (!res.sessions || res.sessions.length === 0)) {
      return { isLive: false, rooms: [], error: res.error, code: res.code || 'upstream_error', retryable: res.retryable === true, statusCode: res.statusCode || null };
    }
    const liveSessions = (res.sessions || []).filter(s => String(s.status) === '2');
    const rooms = liveSessions.map(s => ({
      roomId: s.roomId,
      roomName: s.roomName,
      startTime: s.startTime,
      cost: s.cost || 0,
    }));
    return { isLive: rooms.length > 0, rooms, raw: res, error: null };
  } catch (e) {
    return {
      isLive: false,
      rooms: [],
      error: e.message,
      code: e.code || 'upstream_error',
      retryable: e.retryable === true,
      statusCode: e.statusCode || null,
    };
  }
}

/**
 * 查某天所有直播场次列表(纯 API)。
 * 同 fetchLiveStatus 的接口，但不带 room_status filter，拉全天所有场次(在播+已结束)。
 * room_status 值: 2=直播中, 4=已结束(实测)。
 * @param {string} [date] YYYY-MM-DD，默认今天
 * @param {object} [opts] { status: '2'|'4' 过滤某状态，不传=全部 }
 * @returns {Promise<object>} { date, count, sessions:[{roomId,roomName,startTime,endTime,status,cost}], error }
 */
async function fetchLiveSessions(date, opts = {}) {
  const accountId = opts.accountId;
  const aavid = resolveAavid(accountId);
  if (!date) {
    const d = new Date();
    date = getLocalDateStr(d);
  }
  const body = {
    reqFrom: 'topLivingCardRoi2',
    DataSetKey: 'roi2_live_analysis_update',
    Metrics: ['stat_cost_for_roi2', 'total_prepay_and_pay_settle_roi2_1h', 'total_order_settle_amount_for_roi2_1h'],
    Dimensions: ['room_name', 'room_start_time', 'room_end_time', 'room_id', 'room_with_anchor_show_id', 'room_status'],
    OrderBy: [{ Field: 'room_start_time', Type: 1 }],
    Filters: { ConditionRelationshipType: 1, Conditions: [
      { Field: 'advertiser_id', Operator: 7, Values: [aavid] },
    ]},
    PageParams: { Offset: 0, Limit: 200 },
    StartTime: date + ' 00:00:00',
    EndTime: date + ' 23:59:59',
  };
  try {
    const r = await statQuery(body, 3, accountId, { signal: opts.signal, priority: opts.priority });
    if (!r || Number(r.status_code ?? r.code ?? 0) !== 0 || !Array.isArray(r.data?.StatsData?.Rows))
      return { date, count: null, sessions: [], data_valid: false, error: '场次列表未取得', code: 'live_sessions_unavailable' };
    let rows = r.data.StatsData.Rows;
    if (opts.status) rows = rows.filter(row => row.Dimensions?.room_status?.Value === opts.status);
    const platformTime = raw => {
      if(!raw || !/^\d+$/.test(String(raw)))return raw;
      const parts=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(Number(raw)*1000));
      const p=Object.fromEntries(parts.map(({type,value})=>[type,value]));
      return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
    };
    const sessions = rows.map(row => {
      const d = row.Dimensions || {};
      const sRaw = d.room_start_time?.Value;
      const startTime = platformTime(sRaw);
      const eRaw = d.room_end_time?.Value;
      let endTime = (eRaw && eRaw !== '-') ? eRaw : null;
      endTime = platformTime(endTime);
      const statusVal = d.room_status?.Value;
      const metric = key => {
        const cell = row.Metrics?.[key];
        return cell?.ControlType != null && Number(cell.ControlType) === 0 ? null : require('./dataContract').finiteNumber(cell?.Value);
      };
      const cost = metric('stat_cost_for_roi2');
      const netRoi = metric('total_prepay_and_pay_settle_roi2_1h');
      const netGmv = metric('total_order_settle_amount_for_roi2_1h');
      return {
        roomId: d.room_id?.Value,
        roomName: d.room_name?.ValueStr || d.room_name?.Value || '',
        startTime, endTime,
        status: statusVal,
        statusStr: statusVal === '2' ? '直播中' : (statusVal === '4' ? '已结束' : statusVal),
        cost,
        netRoi: netRoi != null ? +netRoi : null,
        netGmv: netGmv != null ? +netGmv : null,
      };
    });
    return { date, count: sessions.length, sessions, error: null, data_valid: true,
      source_at: new Date().toISOString(), timestamp_basis: 'read_completed' };
  } catch (e) {
    // cookie_expired 必须上抛（铁律：禁吞——此前 catch 一律转空 sessions，采集静默停摆且无任何告警，2026-08-02 四轮审计 P1 修复）
    if (e && (e.code === 'cookie_expired' || e.message === 'cookie_expired')) throw e;
    return { date, count: null, sessions: [], data_valid: false, error: e.message, code: e.code || 'upstream_error', retryable: e.retryable === true, statusCode: e.statusCode || null };
  }
}


/** 获取追投(全域推广)计划下的素材效果明细 */
async function fetchUniPromMaterials(adId, startDate, endDate, accountId) {
  const body = {
    _origin_ajax_: 1,
    mar_goal: 2,
    dataSetKey: "site_promotion_list",
    page: 1,
    page_size: 50,
    order_by_type: 2,
    order_by_field: "create_time",
    start_time: startDate + " 00:00:00",
    end_time: endDate + " 23:59:59",
    smartBidType: 0,
    adlabScene: 0,
    metrics: [
      "stat_cost",
      "stat_cost_for_roi2_primary",
      "total_prepay_and_pay_order_roi2",
      "total_prepay_and_pay_order_roi2_primary",
      "total_pay_order_gmv_include_coupon_for_roi2",
      "total_pay_order_gmv_include_coupon_for_roi2_primary",
      "total_pay_order_count_for_roi2",
      "total_pay_order_count_for_roi2_primary",
      "total_cost_per_pay_order_for_roi2",
      "total_cost_per_pay_order_for_roi2_primary",
      "total_pay_order_gmv_for_roi2",
      "total_pay_order_gmv_for_roi2_primary",
      "stat_cost_for_overall_roi2",
      "stat_cost_for_overall_roi2_primary",
      "total_prepay_and_pay_settle_overall_roi2_1h",
      "total_prepay_and_pay_settle_overall_roi2_1h_primary",
      "total_cost_per_pay_order_settle_for_overall_roi2_1h",
      "total_cost_per_pay_order_settle_for_overall_roi2_1h_primary",
      "total_prepay_and_pay_settle_roi2_1h",
      "total_prepay_and_pay_settle_roi2_1h_primary",
      "total_order_settle_amount_for_roi2_1h",
      "total_order_settle_amount_for_roi2_1h_primary",
      "total_order_settle_count_for_roi2_1h",
      "total_order_settle_count_for_roi2_1h_primary",
      "total_cost_per_pay_order_settle_for_roi2_1h",
      "total_cost_per_pay_order_settle_for_roi2_1h_primary",
      "total_order_real_settle_amount_for_roi2_1h",
      "total_order_real_settle_amount_for_roi2_1h_primary",
      "total_order_settle_amount_rate_for_roi2_1h",
      "total_order_settle_amount_rate_for_roi2_1h_primary",
      "total_refund_order_gmv_for_roi2_1h_rate",
      "total_refund_order_gmv_for_roi2_1h_rate_primary",
      "stat_cost_for_roi2"
    ],
    listModules: [10, 4, 20, 25, 254, 7],
    needRequestOptional: true,
    DiscardTotalNum: true,
    Filters: { ConditionRelationshipType: 1, Conditions: [ { Field: 'ad_id', Operator: 7, Values: [String(adId)] } ] }
  };

  const aavid = resolveAavid(accountId);
  body.aavid = aavid;

  const result = await enqueue(() => requestAPI('POST', '/ad/api/pmc/v1/uni-promotion/ad/list-required?aavid=' + aavid, body, accountId), accountId);
  
  await asyncWriteFile('uni_prom_materials_' + adId, { startDate, endDate, adId, ...result });
  return result;
}

/**
 * 拉取某账号全部在投(全域推广)广告计划列表，用于自动操盘定位 primaryAdId。
 * 不复用 fetchUniPromMaterials 的 ad_id 过滤，直接拿整页计划 + 消耗/ROI 指标。
 * 返回原始 result（含 data.list），字段解析交给调用方做容错。
 * opts.marGoal：2=推直播间（默认，既有行为）；1=推商品/全域商品计划（2026-07-30 商品卡双源卡新增）
 */
async function fetchUniPromAdList(startDate, endDate, accountId, opts = {}) {
  const aavid = resolveAavid(accountId);
  let allAdInfos = [];
  let firstResult = null;

  for (let page = 1; page <= 20; page++) {
    const body = {
      _origin_ajax_: 1,
      mar_goal: opts.marGoal || 2,
      dataSetKey: "site_promotion_list",
      page: page,
      page_size: 50,
      order_by_type: 2,
      order_by_field: "create_time",
      start_time: startDate + " 00:00:00",
      end_time: endDate + " 23:59:59",
      smartBidType: 0,
      adlabScene: 0,
      metrics: [
        "stat_cost_for_roi2", "total_prepay_and_pay_order_roi2",
        "total_pay_order_gmv_include_coupon_for_roi2", "total_pay_order_count_for_roi2",
        "total_pay_order_gmv_for_roi2", "stat_cost",
      ],
      // 24=平台每日 ROI 建议；29=一键控量任务状态。
      // 29 可直接随 required 响应返回，避免 list-optional 在无浏览器签名时返回空响应。
      listModules: [10, 4, 20, 24, 25, 29, 254, 7],
      needRequestOptional: true,
      DiscardTotalNum: true,
      Filters: { ConditionRelationshipType: 1, Conditions: [] },
      aavid: aavid
    };

    const result = await enqueue(() => requestAPI('POST', '/ad/api/pmc/v1/uni-promotion/ad/list-required?aavid=' + aavid, body, accountId), accountId);
    
    if (!firstResult) firstResult = result;
    
    if (result && result.data && Array.isArray(result.data.adInfos)) { // 字段=adInfos（落盘缓存实证，分身误写 adInfoList 会永远空合并）
      allAdInfos = allAdInfos.concat(result.data.adInfos);
      if (result.data.adInfos.length < 50) break;
    } else {
      break;
    }
  }

  if (firstResult && firstResult.data) {
    firstResult.data.adInfos = allAdInfos;
  }
  
  await asyncWriteFile('uni_prom_ad_list', { startDate, endDate, accountId: accountId || 'default', fetched_at: new Date().toISOString(), ...firstResult });
  return firstResult || { data: { adInfos: [] } };
}

/**
 * 拉取全域计划列表的可选字段。
 * 当前用于读取 suggestedRoi2GoalMap 中平台每日刷新的净成交 ROI 推荐值。
 * SessionID 必须来自同一轮 list-required，避免跨轮次或跨账号串数据。
 */
async function fetchUniPromPlanOptional(sessionId, accountId) {
  if (!sessionId) {
    const error = new Error('uni_prom_session_id_missing');
    error.code = 'session_id_missing';
    throw error;
  }
  const aavid = resolveAavid(accountId);
  const body = {
    _origin_ajax_: 1,
    SessionID: String(sessionId),
    ListAdsModules: [22, 29, 34, 50, 9, 17, 18, 25, 37, 38, 40, 42, 43, 24, 41, 54, 55, 52, 32, 35, 46, 30, 21, 36],
    aavid,
  };
  return enqueue(() => requestAPI(
    'POST',
    '/ad/api/pmc/v1/uni-promotion/ad/list-optional?aavid=' + aavid,
    body,
    accountId,
  ), accountId);
}

/**
 * 新版投放管理页的轻量计划查询。
 * 千川把 suggestedRoi2GoalMap 直接放在该响应中，不依赖二段 SessionID。
 */
async function fetchUniPromPlanRecommendations(startDate, endDate, accountId) {
  const aavid = resolveAavid(accountId);
  const body = {
    _origin_ajax_: 1,
    UseNewChain: true,
    Params: {
      SophonxDataSetKey: 'site_promotion_list',
      AdFilter: {
        MarGoal: 2,
        AdlabScene: 0,
        SmartBidType: 0,
        NotInEcpAdStatuses: ['delete', 'frozen', 'system_disable', 'time_done'],
        DataTimeRange: {
          StartTime: startDate + ' 00:00:00',
          EndTime: endDate + ' 23:59:59',
        },
      },
      OrderBy: { Field: 'stat_cost', Type: 2 },
      PageParams: { Page: 1, PageSize: 50 },
      Metrics: ['stat_cost'],
      ListAdsModules: [24, 7, 36, 37, 47, 46, 48],
    },
    aavid,
  };
  return enqueue(() => requestAPI(
    'POST',
    '/ad/api/pmc/v1/uni-promotion/ad/list-required?aavid=' + aavid,
    body,
    accountId,
  ), accountId);
}

/**
 * 读取千川官方“有效投放”当日完成度。
 * 返回净成交 ROI 推荐/加权目标、消耗、投放时长覆盖率及三项平台判定。
 */
async function fetchEffectiveDeliveryInfo(adId, anchorId, accountId) {
  const aavid = resolveAavid(accountId);
  const account = resolveQcAccount(accountId);
  const resolvedAnchorId = anchorId || (account && account.anchorId);
  if (!adId || !resolvedAnchorId || !aavid) {
    const error = new Error('effective_delivery_identity_missing');
    error.code = 'identity_missing';
    throw error;
  }
  const query = new URLSearchParams({
    adId: String(adId),
    anchorId: String(resolvedAnchorId),
    aavid: String(aavid),
  });
  return enqueue(() => requestAPI(
    'GET',
    '/ad/api/pmc/v1/uni-promotion/ad/get_live_roi2_tc_effective_delivery_info_by_date?' + query.toString(),
    null,
    accountId,
  ), accountId);
}

/**
 * 拉取某计划的追投(调控)任务列表。
 * 返回每个追投任务的状态、权限、消耗/ROI效果。
 * @param {string} adId - 主计划ID
 * @param {string} startDate
 * @param {string} endDate
 * @param {string} [accountId]
 * @returns {Promise<object>} 原始 result（含 data.adInfos + data.adStatsMap）
 */
async function fetchBoostList(adId, startDate, endDate, accountId, opts = {}) {
  const pageSize = opts.pageSize ?? 50;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw Object.assign(new Error('invalid_boost_page_size'), { code: 'invalid_boost_page_size' });
  const pool = opts.pool ?? (opts.includeAllStatus ? 'all' : 'active');
  if (!['active','manual_paused','all'].includes(pool) || opts.taskId !== undefined && (typeof opts.taskId !== 'string' || !/^\d+$/.test(opts.taskId)))
    throw Object.assign(new Error('invalid_boost_query_scope'), { code: 'invalid_boost_query_scope' });
  const started = Date.now();
  const aavid = resolveAavid(accountId);
  // opts.includeAllStatus: 写操作场景设为 true，去掉 AdStatusFilterType 过滤（避免暂停状态任务找不到）
  // opts.marGoal: 2=直播间(默认) 1=商品卡（2026-08-03 商品卡追投监测启用：门票任务挂在 mar_goal=1 计划，默认 2 看不到）
  const adFilter = {
    MarGoal: opts.marGoal || 2,
    DataTimeRange: { StartTime: startDate + ' 00:00:00', EndTime: endDate + ' 23:59:59' },
    AssistTaskFilter: { PrimaryAID: String(adId), AssistTaskScene: 2 },
  };
  if (pool !== 'all') adFilter.AdStatusFilterType = pool === 'active' ? 28 : 4;
  const body = {
    _origin_ajax_: 1,
    UseNewChain: true,
    Params: {
      SophonxDataSetKey: 'site_promotion_live_combine_heat',
      AdFilter: adFilter,
      OrderBy: { Type: 2, Field: 'create_time' },
      PageParams: { Page: 1, PageSize: pageSize },
      Metrics: [
        'show_cnt_for_roi2_assist', 'click_cnt_for_roi2_assist', 'ctr_for_roi2_assist',
        'convert_rate_for_roi2_assist', 'stat_cost_for_roi2_assist',
        'total_pay_order_count_for_roi2_assist',
        'total_pay_order_gmv_include_coupon_for_roi2_assist',
        'total_prepay_and_pay_order_roi2_assist',
        'total_cost_per_pay_order_for_roi2_assist',
        'total_pay_order_gmv_for_roi2_assist',
        'total_pay_order_coupon_amount_for_roi2_assist',
        'pay_convert_cost_for_roi2_assist',
        'pay_convert_cnt_for_roi2_assist',
        'total_order_settle_amount_for_roi2_1h_assist',
        'total_prepay_and_pay_settle_roi2_1h_assist',
        'total_refund_order_gmv_for_roi2_1h_rate_assist',
      ],
      ListAdsModules: [10, 31, 9, 30, 7, 36, 44],
    },
    aavid,
  };
  if (opts.taskId) body.Params.SearchFilter = { Type: 1, Keyword: opts.taskId };
  // 分页拉全（2026-07-31 审计 P0：原 PageSize=50 单页不翻页——includeAllStatus 放开全状态后，
  // 历史已暂停/已删除任务填满 50 个坑位，把时间更早但仍在跑量的活跃任务静默挤出看板）
  const allAdInfos = [];
  const mergedStatsMap = {};
  const seen = new Set();
  let firstResult = null;
  let complete = false;
  let total = null, reason = 'pagination_incomplete', pagesRead = 0, upstreamMs = 0, upstreamKnown = true;
  for (let page = 1; page <= 20; page++) {
    body.Params.PageParams.Page = page;
    const result = await enqueue(signal => requestAPI('POST', '/ad/api/pmc/v1/uni-promotion/ad/list-required?aavid=' + aavid, body, accountId, signal), accountId,
      { signal: opts.signal, label: 'boost_task_list' });
    if (!firstResult) firstResult = result;
    pagesRead++;
    if (Number.isFinite(result?.request_timings?.upstream_ms)) upstreamMs += result.request_timings.upstream_ms;
    else upstreamKnown = false;
    const code = result && (result.status_code ?? result.code);
    if (code !== 0 || !Array.isArray(result?.data?.adInfos)) break;
    if (Object.keys(result.data.moduleErrors || {}).length) { reason = 'page_module_error'; break; }
    const pagination = result.data.pagination;
    const currentTotal = pagination?.totalNum == null ? NaN : Number(pagination.totalNum);
    if (!Number.isSafeInteger(currentTotal) || currentTotal < 0) { reason = 'pagination_total_missing'; break; }
    if (total !== null && currentTotal !== total) { reason = 'pagination_changed'; break; }
    total = currentTotal;
    if (pagination.page != null && Number(pagination.page) !== page) { reason = 'pagination_page_mismatch'; break; }
    const infos = result.data.adInfos;
    if (infos.some(info => typeof info.id !== 'string' || !/^\d+$/.test(info.id) || seen.has(info.id))
        || new Set(infos.map(info => info.id)).size !== infos.length) { reason = 'pagination_duplicate_or_invalid_id'; break; }
    infos.forEach(info => seen.add(info.id));
    allAdInfos.push(...infos);
    if (result && result.data && result.data.adStatsMap) Object.assign(mergedStatsMap, result.data.adStatsMap);
    if (allAdInfos.length === total) { complete = true; break; }
    if (allAdInfos.length > total || infos.length === 0) { reason = 'pagination_count_mismatch'; break; }
  }
  if (firstResult && firstResult.data) {
    firstResult.data.adInfos = allAdInfos;
    if (Object.keys(mergedStatsMap).length) firstResult.data.adStatsMap = mergedStatsMap;
  }
  if (firstResult) {
    firstResult.truncated = !complete;
    firstResult.source_at = new Date().toISOString();
    firstResult.coverage_reason = complete ? null : reason;
    firstResult.task_pool = pool;
    if (opts.taskId) firstResult.requested_task_id = opts.taskId;
    const totalMs = Date.now() - started;
    firstResult.read_timings = { total_ms: totalMs, upstream_ms: upstreamKnown ? upstreamMs : null,
      queue_and_other_ms: upstreamKnown ? Math.max(0, totalMs - upstreamMs) : null,
      page_count: pagesRead, requested_page_size: pageSize };
  }
  return firstResult;
}

/**
 * 拉取某计划的追投汇总数据。
 * @param {string} adId - 主计划ID
 * @param {string} startDate
 * @param {string} endDate
 * @param {string} [accountId]
 * @returns {Promise<object>} 原始 result（含 data.totalNum + data.totalMetrics）
 */
async function fetchBoostSummary(adId, startDate, endDate, accountId, opts = {}) {
  const aavid = resolveAavid(accountId);
  const body = {
    SophonxDataSetKey: 'site_promotion_live_combine_heat',
    AdFilter: {
      MarGoal: opts.marGoal || 2, // 2=直播间(默认) 1=商品卡（2026-08-03 商品卡追投监测）
      AdlabMode: 1,
      AssistTaskFilter: { PrimaryAID: String(adId), AssistTaskScene: 2 },
      StartTime: startDate + ' 00:00:00',
      EndTime: endDate + ' 23:59:59',
    },
    Metrics: [
      'stat_cost_for_roi2_assist', 'total_pay_order_gmv_for_roi2_assist',
      'total_prepay_and_pay_order_roi2_assist', 'total_pay_order_count_for_roi2_assist',
    ],
  };
  const result = await enqueue(() => requestAPI('POST', '/ad/api/pmc/v1/uni-promotion/ad/list-summary?aavid=' + aavid, body, accountId), accountId);
  return result;
}

/**
 * 追投效果概览（单追投任务的汇总指标 + 昨日环比）。
 * DataSetKey: live_roi2_assist_analysis_overview
 * reqFrom: overview_uni_assist_task_data_modal
 *
 * @param {string} assistAid - 追投任务ID（assist_aid）
 * @param {string} anchorId - 主播ID
 * @param {string} startDate - YYYY-MM-DD
 * @param {string} endDate - YYYY-MM-DD
 * @param {string} [accountId]
 * @returns {Promise<object>} 概览指标（消耗/成交/ROI/展现/点击/订单/转化率/净成交/退款率）
 */
async function fetchBoostOverview(assistAid, anchorId, startDate, endDate, accountId) {
  const aavid = resolveAavid(accountId);
  const body = {
    reqFrom: 'overview_uni_assist_task_data_modal',
    DataSetKey: 'live_roi2_assist_analysis_overview',
    Metrics: [
      'stat_cost_for_roi2_assist', 'total_pay_order_gmv_include_coupon_for_roi2_assist',
      'total_prepay_and_pay_order_roi2_assist', 'show_cnt_for_roi2_assist',
      'click_cnt_for_roi2_assist', 'ctr_for_roi2_assist', 'total_pay_order_count_for_roi2_assist',
      'convert_rate_for_roi2_assist', 'total_pay_order_gmv_for_roi2_assist',
      'total_order_settle_amount_for_roi2_1h_assist', 'total_prepay_and_pay_settle_roi2_1h_assist',
      'total_refund_order_gmv_for_roi2_1h_rate_assist',
    ],
    Dimensions: ['is_overall_roi'],
    StartTime: startDate + ' 00:00:00',
    EndTime: endDate + ' 23:59:59',
    ComparisonParams: {
      RatioStartTime: (() => { const d = new Date(startDate); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10); })() + ' 00:00:00',
      RatioEndTime: (() => { const d = new Date(endDate); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10); })() + ' 23:59:59',
    },
    Filters: { ConditionRelationshipType: 1, Conditions: [
      { Field: 'assist_aid', Operator: 7, Values: [String(assistAid)] },
      { Field: 'marketing_goal', Operator: 7, Values: ['2'] },
      { Field: 'assist_task_scene', Operator: 7, Values: ['2'] },
      { Field: 'advertiser_id', Operator: 7, Values: [aavid] },
      { Field: 'anchor_id', Operator: 7, Values: [String(anchorId)] },
      { Field: 'adlab_mode_fork', Operator: 7, Values: ['1'] },
      { Field: 'smart_bid_type', Operator: 7, Values: ['0'] },
    ]},
    refer: 'ecp',
  };
  return statQuery(body, 3, accountId);
}

/**
 * 追投效果趋势（按小时）。
 * DataSetKey: live_roi2_assist_analysis_overview
 * reqFrom: trend_uni_assist_task_data_modal
 *
 * @param {string} assistAid - 追投任务ID
 * @param {string} anchorId - 主播ID
 * @param {string} startDate
 * @param {string} endDate
 * @param {string} [accountId]
 * @returns {Promise<object>} 按小时趋势（stat_time_hour维度）
 */
async function fetchBoostTrend(assistAid, anchorId, startDate, endDate, accountId) {
  const aavid = resolveAavid(accountId);
  const body = {
    DataSetKey: 'live_roi2_assist_analysis_overview',
    reqFrom: 'trend_uni_assist_task_data_modal',
    Metrics: [
      'stat_cost_for_roi2_assist', 'total_pay_order_gmv_include_coupon_for_roi2_assist',
      'total_prepay_and_pay_order_roi2_assist', 'show_cnt_for_roi2_assist',
      'click_cnt_for_roi2_assist', 'ctr_for_roi2_assist', 'total_pay_order_count_for_roi2_assist',
      'convert_rate_for_roi2_assist', 'total_pay_order_gmv_for_roi2_assist',
      'total_order_settle_amount_for_roi2_1h_assist', 'total_prepay_and_pay_settle_roi2_1h_assist',
      'total_refund_order_gmv_for_roi2_1h_rate_assist',
    ],
    Dimensions: ['stat_time_hour'],
    StartTime: startDate + ' 00:00:00',
    EndTime: endDate + ' 23:59:59',
    Filters: { ConditionRelationshipType: 1, Conditions: [
      { Field: 'assist_aid', Operator: 7, Values: [String(assistAid)] },
      { Field: 'marketing_goal', Operator: 7, Values: ['2'] },
      { Field: 'assist_task_scene', Operator: 7, Values: ['2'] },
      { Field: 'advertiser_id', Operator: 7, Values: [aavid] },
      { Field: 'anchor_id', Operator: 7, Values: [String(anchorId)] },
      { Field: 'adlab_mode_fork', Operator: 7, Values: ['1'] },
      { Field: 'smart_bid_type', Operator: 7, Values: ['0'] },
    ]},
    OrderBy: [{ Type: 1, Field: 'stat_time_hour' }],
    refer: 'ecp',
  };
  return statQuery(body, 3, accountId);
}

/**
 * 追投素材明细（追投任务里每个素材的效果）。
 * DataSetKey: live_roi2_assist_analysis_video_detail
 *
 * @param {string} assistAid - 追投任务ID
 * @param {string} startDate
 * @param {string} endDate
 * @param {string} [accountId]
 * @returns {Promise<object>} 素材明细列表（含 material_id/name + 消耗/ROI/展现/点击/转化等16指标）
 */
async function fetchBoostMaterialDetail(assistAid, startDate, endDate, accountId) {
  const aavid = resolveAavid(accountId);
  const body = {
    DataSetKey: 'live_roi2_assist_analysis_video_detail',
    DrillDimensions: [['stat_time_day'], ['range_stat_time_hour']],
    OrderBy: [{ Type: 2, Field: 'show_cnt_for_roi2_assist' }],
    Metrics: [
      'show_cnt_for_roi2_assist', 'click_cnt_for_roi2_assist', 'ctr_for_roi2_assist',
      'convert_rate_for_roi2_assist', 'stat_cost_for_roi2_assist', 'total_pay_order_count_for_roi2_assist',
      'total_pay_order_gmv_include_coupon_for_roi2_assist', 'total_prepay_and_pay_order_roi2_assist',
      'total_cost_per_pay_order_for_roi2_assist', 'total_pay_order_gmv_for_roi2_assist',
      'total_pay_order_coupon_amount_for_roi2_assist', 'pay_convert_cost_for_roi2_assist',
      'pay_convert_cnt_for_roi2_assist', 'total_order_settle_amount_for_roi2_1h_assist',
      'total_prepay_and_pay_settle_roi2_1h_assist', 'total_refund_order_gmv_for_roi2_1h_rate_assist',
    ],
    Dimensions: ['material_id', 'assist_material_name', 'assist_material_coverImage', 'assist_material_videoId'],
    StartTime: startDate + ' 00:00:00',
    EndTime: endDate + ' 23:59:59',
    PageParams: { Offset: 0, Limit: 50 },
    Filters: { ConditionRelationshipType: 1, Conditions: [
      { Field: 'assist_aid', Operator: 7, Values: [String(assistAid)] },
      { Field: 'marketing_goal', Operator: 7, Values: ['2'] },
      { Field: 'assist_task_scene', Operator: 7, Values: ['2'] },
      { Field: 'advertiser_id', Operator: 7, Values: [aavid] },
      { Field: 'adlab_mode_fork', Operator: 7, Values: ['1'] },
      { Field: 'assist_material_type', Operator: 7, Values: ['3'] },
      { Field: 'material_type', Operator: 7, Values: ['3'] },
      // 历史账户专用说明已从试用包移除。
      // 千川返回 'adInfo with id xxx not found'；assist_aid 已唯一锁定任务，无需该条件
    ]},
    refer: 'ecp,7418840420156702758,7451625382798917682,7451625382798934066',
  };
  return statQuery(body, 3, accountId);
}

/**
 * 追投流量扶持数据（累计 + 增量）。
 * DataSetKey: roi2_boost_show
 *
 * @param {string} adId - 全域计划ID
 * @param {string} startDate
 * @param {string} endDate
 * @param {string} [accountId]
 * @returns {Promise<object>} { accumulated: 累计数据, incremental: 增量数据 }
 */
async function fetchBoostSupport(adId, startDate, endDate, accountId) {
  const aavid = resolveAavid(accountId);
  const baseFilters = [
    { Field: 'advertiser_id', Operator: 7, Values: [aavid] },
    { Field: 'ad_id', Operator: 7, Values: [String(adId)] },
    { Field: 'marketing_goal', Operator: 7, Values: ['2'] },
  ];

  const [accResult, incResult] = await Promise.all([
    statQuery({
      DataSetKey: 'roi2_boost_show',
      Dimensions: ['advertiser_id'],
      Filters: { ConditionRelationshipType: 1, Conditions: baseFilters },
      Metrics: ['boost_support_total_show_cnt', 'boost_support_total_click_cnt', 'roi2_boost_support_total_pay_order_count', 'roi2_boost_support_total_order_pay_gmv'],
      refer: 'ecp',
    }, 3, accountId).catch(e => { if (e.message === 'cookie_expired') throw e; return null; }),

    statQuery({
      DataSetKey: 'roi2_boost_show',
      Dimensions: ['advertiser_id'],
      DrillDimensions: [['roi2_boost']],
      Filters: { ConditionRelationshipType: 1, Conditions: baseFilters },
      Metrics: ['boost_support_inc_show_cnt', 'boost_support_inc_click_cnt', 'roi2_boost_support_inc_pay_order_count', 'roi2_boost_support_inc_order_pay_gmv'],
      StartTime: startDate + ' 00:00:00',
      EndTime: endDate + ' 23:59:59',
      refer: 'ecp',
    }, 3, accountId).catch(e => { if (e.message === 'cookie_expired') throw e; return null; }),
  ]);

  return { accumulated: accResult, incremental: incResult };
}

/**
 * 追投ROI操作日志（千川后台的ROI修改历史）。
 * 路径: POST /ad/api/pmc/v1/get_uni_prom_roi_opt_log
 *
 * @param {string} aggAid - 聚合广告ID（全域计划ID）
 * @param {string} startDate
 * @param {string} endDate
 * @param {string} [accountId]
 * @returns {Promise<object>} 操作日志列表（含修改前后ROI/深度目标/成本项等）
 */
async function fetchBoostOptLog(aggAid, startDate, endDate, accountId) {
  const aavid = resolveAavid(accountId);
  const body = {
    AggAID: String(aggAid),
    SearchTimeRange: { StartTime: startDate + ' 00:00:00', EndTime: endDate + ' 23:59:59' },
    SearchOptType: 1,
    NeedForwardFillWithSearchType: true,
    NeedBasicOverviewChecked: true,
    DeepExternalActionOpt: 1,
  };
  return enqueue(() => requestAPI('POST', `/ad/api/pmc/v1/get_uni_prom_roi_opt_log?aavid=${aavid}`, body, accountId), accountId);
}

/**
 * 追投建议ROI目标（千川根据历史数据推荐ROI）。
 * 路径: POST /ad/api/pmc/v1/roi2-goal/batch-get-suggestion
 *
 * @param {string} adId - 追投任务ID（assistTaskId）
 * @param {string} primaryAdId - 全域计划ID
 * @param {string} anchorId - 主播ID
 * @param {string} [accountId]
 * @returns {Promise<object>} 建议ROI（ecpRoi2Goal + 上下限 + 预估消耗/成交）
 */
async function fetchSuggestedRoi(adId, primaryAdId, anchorId, accountId) {
  const aavid = resolveAavid(accountId);
  const { GFVERSION } = require('./config');
  const body = {
    getSuggestedRoiGoalInputs: [
      { AdId: String(adId), PrimaryAID: String(primaryAdId), AssistTaskScene: 2, AuthorId: String(anchorId), MarGoal: 2, DeepExternalAction: 326 },
      { AdId: String(adId), PrimaryAID: String(primaryAdId), AssistTaskScene: 2, AuthorId: String(anchorId), MarGoal: 2, DeepExternalAction: 576 },
    ]
  };
  return enqueue(() => requestAPI('POST', `/ad/api/pmc/v1/roi2-goal/batch-get-suggestion?aavid=${aavid}&gfversion=${GFVERSION}`, body, accountId), accountId);
}

/** 秒级时序 Fast版：绕过限频队列，真正并发 */
async function fetchMaterialTimeseriesFast(materialId, startDate, endDate, accountId) {
  const aavid = resolveAavid(accountId);
  const filters = [
    { Field: 'advertiser_id', Operator: 7, Values: [aavid] },
    { Field: 'material_id', Operator: 7, Values: [materialId] },
    { Field: 'marketing_goal', Operator: 7, Values: ['2'] },
  ];
  const baseBody = {
    DataSetKey: 'roi2_video_material_analysis_insight',
    StartTime: startDate + ' 00:00:00',
    EndTime: endDate + ' 23:59:59',
    Filters: { ConditionRelationshipType: 1, Conditions: filters },
  };
  const catchErr = e => { if (e.message === 'cookie_expired') throw e; return null; };
  const clickBody = {
    DataSetKey: PROMOTION_DS,
    StartTime: startDate + ' 00:00:00',
    EndTime: endDate + ' 23:59:59',
    Dimensions: [],
    Filters: { ConditionRelationshipType: 1, Conditions: filters },
    Metrics: ['live_watch_count_for_roi2_v2'],
  };
  const [watch, lose, loseRate, dropTotal, clickTotal] = await Promise.all([
    statQueryDirect({ ...baseBody, Dimensions: ['duration'], Metrics: ['live_watch_count_for_roi2_v2'] }, 3, accountId).catch(catchErr),
    statQueryDirect({ ...baseBody, Dimensions: ['duration'], Metrics: ['video_lose_count_for_roi2'] }, 3, accountId).catch(catchErr),
    statQueryDirect({ ...baseBody, Dimensions: [], Metrics: ['video_user_lose_rate_for_roi2'], Filters: { ConditionRelationshipType: 1, Conditions: [...filters, { Field: 'duration', Operator: 9, Values: ['0', '5'] }] } }, 3, accountId).catch(catchErr),
    statQueryDirect({ ...baseBody, Dimensions: [], Metrics: ['video_lose_count_for_roi2'] }, 3, accountId).catch(catchErr),
    statQueryDirect(clickBody, 3, accountId).catch(catchErr),
  ]);
  const rows = (r) => ((r && r.data && r.data.StatsData && r.data.StatsData.Rows) || []);
  const dropRow = rows(dropTotal)[0];
  const clickRow = rows(clickTotal)[0];
  const clickCount = clickRow ? (clickRow.Metrics.live_watch_count_for_roi2_v2?.Value || 0) : 0;
  const dropCount = dropRow ? (dropRow.Metrics.video_lose_count_for_roi2?.Value || 0) : 0;
  return {
    retention: rows(watch).map(r => ({ second: parseInt(r.Dimensions.duration.Value), viewers: r.Metrics.live_watch_count_for_roi2_v2.Value })),
    churn: rows(lose).map(r => ({ second: parseInt(r.Dimensions.duration.Value), lost: r.Metrics.video_lose_count_for_roi2.Value })),
    churnRate5s: rows(loseRate)[0] ? rows(loseRate)[0].Metrics.video_user_lose_rate_for_roi2.Value : null,
    click_count: clickCount,
    drop_count: dropCount,
  };
}

/** 人群画像 Fast版：绕过限频队列，5个维度真正并发 */
async function fetchMaterialAudienceFast(materialId, startDate, endDate, accountId) {
  const aavid = resolveAavid(accountId);
  const filters = [
    { Field: 'advertiser_id', Operator: 7, Values: [aavid] },
    { Field: 'marketing_goal', Operator: 7, Values: ['2'] },
    { Field: 'material_type', Operator: 7, Values: ['3'] },
    { Field: 'material_id', Operator: 7, Values: [materialId] },
  ];
  const body = {
    DataSetKey: 'roi2_video_material_analysis_crow',
    StartTime: startDate + ' 00:00:00',
    EndTime: endDate + ' 23:59:59',
    Metrics: ['live_show_count_for_roi2_v2'],
    Filters: { ConditionRelationshipType: 1, Conditions: filters },
  };
  const dims = ['gender', 'age', 'city_name', 'province_name', 'user_group_label_name'];
  const catchErr = e => { if (e.message === 'cookie_expired') throw e; return null; };
  const responses = await Promise.all(dims.map(dim =>
    statQueryDirect({ ...body, reqFrom: dim, Dimensions: [dim] }, 3, accountId).catch(catchErr)
  ));
  const out = {};
  const labels = { gender: '性别', age: '年龄', city_name: '城市', province_name: '省份', user_group_label_name: '8大人群' };
  dims.forEach((dim, i) => {
    const label = labels[dim];
    const rows = ((responses[i] && responses[i].data && responses[i].data.StatsData && responses[i].data.StatsData.Rows) || []);
    out[label] = rows.map(r => ({
      value: r.Dimensions[dim] ? r.Dimensions[dim].Value : '',
      count: r.Metrics.live_show_count_for_roi2_v2 ? r.Metrics.live_show_count_for_roi2_v2.Value : 0,
    }));
  });
  return out;
}

/**
 * 实时素材列表（投放管理页 → 素材tab）
 *
 * 2026-07-16 抓包确认：
 *   API: POST /ad/api/pmc/v1/uni-promotion/material/list-required
 *   特点：实时数据（延迟几分钟），可自定义日期区间，可筛选投放中素材
 *   与 materials/now 的区别：按 anchor_id（抖音号）维度，实时非T+1，跨场次整合
 *
 * @param {string} anchorId - 抖音号ID（从目标账户配置读取）
 * @param {object} [opts]
 * @param {string} [opts.startDate] - YYYY-MM-DD，默认今天
 * @param {string} [opts.endDate] - YYYY-MM-DD，默认等于 startDate
 * @param {string} [opts.accountId] - 千川账号ID
  * 历史账户专用说明已从试用包移除。
 * @param {number} [opts.offset=0] - 偏移量（配合 pageSize 翻全量；2026-08-15 修复：此前写死 Offset:0 只回前 N 条，无流量素材会漏查——历史素材 EXAMPLE_MATERIAL_ID 曾因此被误判不在计划内）
 * @param {string} [opts.status='1'] - 素材状态：1=投放中，不传=全部
 * @param {string} [opts.videoType='11'] - 视频类型：11=全部视频
 * @param {string} [opts.orderBy='live_show_count_for_roi2_v2'] - 排序字段
 * @returns {Promise<object>} { rows, totalCount, startDate, endDate }
 */
async function fetchLiveMaterials(anchorId, opts = {}) {
  const aavid = resolveAavid(opts.accountId);
  const today = getLocalDateStr();
  const startDate = opts.startDate || today;
  const endDate = opts.endDate || startDate;
  const pageSize = opts.pageSize || 10;
  // status：'1'=投放中（默认）；显式传 '' 或 'all' = 全部状态（2026-07-31 审计 P0：pendingOps 回升作废护栏需要含当日已暂停素材，
  // 此前 `opts.status || '1'` 使"不传"也强制过滤投放中，与注释"不传=全部"矛盾）
  const status = (opts.status === '' || opts.status === 'all') ? '' : (opts.status || '1');
  const videoType = opts.videoType || '11';

  const conditions = [
    { Field: 'query_type', Operator: 7, Values: ['all'] },
    { Field: 'roi2_material_type_v3', Operator: 7, Values: ['1001'] },
    { Field: 'marketing_goal', Operator: 7, Values: ['2'] },
    { Field: 'aggregate_smart_bid_type', Operator: 7, Values: ['0'] },
    { Field: 'anchor_id', Operator: 7, Values: [String(anchorId)] },
    { Field: 'roi2_material_video_type', Operator: 7, Values: [videoType] },
  ];
  if (status) {
    conditions.push({ Field: 'roi2_material_status', Operator: 7, Values: [status] });
  }

  const body = {
    DataSetKey: 'site_promotion_post_data_video',
    Metrics: [
      'live_show_count_for_roi2_v2',
      'live_watch_count_for_roi2_v2',
      'live_cvr_rate_for_roi2_v2',
      'live_convert_rate_for_roi2_v2',
      'total_pay_order_count_for_roi2',
      'total_pay_order_gmv_include_coupon_for_roi2',
      'total_pay_order_gmv_rate_for_roi2',
      'stat_cost_for_roi2',
      'cost_rate_for_roi2',
      'basic_stat_cost_for_roi2_v2',
      'total_prepay_and_pay_order_roi2',
      'total_cost_per_pay_order_for_roi2',
      'total_pay_order_gmv_for_roi2',
      'total_ecpm_for_roi2',
      'total_cpc_for_roi2',
      'total_pay_order_coupon_amount_for_roi2',
      'total_ecom_platform_subsidy_amount_for_roi2',
      'total_prepay_order_count_for_roi2',
      'total_prepay_order_gmv_for_roi2',
      'total_unfinished_estimate_order_gmv_for_roi2',
      'stat_cost_for_overall_roi2',
      'total_prepay_and_pay_settle_overall_roi2_1h',
      'total_cost_per_pay_order_settle_for_overall_roi2_1h',
      'total_prepay_and_pay_settle_roi2_1h',
      'total_order_settle_amount_for_roi2_1h',
      'total_order_settle_count_for_roi2_1h',
      'total_cost_per_pay_order_settle_for_roi2_1h',
      'total_order_settle_amount_rate_for_roi2_1h',
      'total_refund_order_gmv_for_roi2_1h_rate',
      // 追投调控字段
      'additional_delivery_stat_cost_for_roi2_assist',
      'additional_delivery_total_pay_order_count_for_roi2_assist',
      'additional_delivery_total_pay_order_gmv_include_coupon_for_roi2_assist',
      'additional_delivery_total_prepay_and_pay_order_roi2_assist',
      'additional_delivery_total_pay_order_gmv_for_roi2_assist',
      'additional_delivery_total_pay_order_coupon_amount_for_roi2_assist',
      'additional_delivery_pay_convert_cost_for_roi2_assist_v2',
      'additional_delivery_pay_convert_cnt_for_roi2_assist_v2',
      'additional_delivery_total_order_settle_amount_for_roi2_1h_assist',
      'additional_delivery_total_prepay_and_pay_settle_roi2_1h_assist',
      'additional_delivery_total_refund_order_gmv_for_roi2_1h_rate_assist',
    ],
    Filters: { ConditionRelationshipType: 1, Conditions: conditions },
    StartTime: `${startDate} 00:00:00`,
    EndTime: `${endDate} 23:59:59`,
    PageParams: { Limit: pageSize, Offset: opts.offset || 0 },
    OrderBy: [{ Type: 2, Field: opts.orderBy || 'live_show_count_for_roi2_v2' }],
    Dimensions: [
      'material_id',
      'roi2_material_status',
      'roi2_material_video_type',
      'roi2_material_video_name',
      'roi2_material_video_play_info',
      'material_tag_list',
      'roi2_material_show_status',
      'roi2_material_show_status_reason',
      'roi2_material_upload_time',
    ],
    reqFrom: 'uni-prom-creative-tab-list',
  };

  const result = await enqueue(
    signal => requestAPI('POST', `/ad/api/pmc/v1/uni-promotion/material/list-required?aavid=${aavid}`, body, opts.accountId, signal),
    opts.accountId,
    { signal: opts.signal, label: 'live-materials' },
  );

  const sd = result && result.data && result.data.statsData || {};
  const rows = (sd.rows || []).map(r => {
    const dv = {};
    if (r.dimensions) {
      for (const [k, v] of Object.entries(r.dimensions)) {
        dv[k] = v.valueStr != null ? v.valueStr : v.value;
      }
    }
    const mv = {};
    if (r.metrics) {
      for (const [k, v] of Object.entries(r.metrics)) {
        mv[k] = v.value != null ? v.value : null;
        mv[k + '_str'] = v.valueStr != null ? v.valueStr : '';
      }
    }
    return { dimensions: dv, metrics: mv };
  });

  const totalCountReliable = sd.totalCount != null && sd.totalCount !== '';
  return {
    rows,
    totalCount: totalCountReliable ? sd.totalCount : rows.length,
    totalCountReliable,
    startDate,
    endDate,
  };
}

/**
 * 实时素材列表 - 补充信息（审核状态/素材建议/追投状态等）
 *
 * API: POST /ad/api/pmc/v1/uni-promotion/material/list-optional
 *
 * @param {string} anchorId - 抖音号ID
 * @param {string[]} materialIds - 素材ID列表
 * @param {string} [accountId]
 * @returns {Promise<object>} materialId -> { materialAuditStatus, isFrozen, hasAuditSuggest, ... }
 */
async function fetchLiveMaterialsOptional(anchorId, materialIds, accountId) {
  const aavid = resolveAavid(accountId);
  const body = {
    ObjectType: 1,
    ObjectID: String(anchorId),
    LegoMidList: materialIds.map(String),
    DataSetKey: 'site_promotion_post_data_video',
    Metrics: [],
    Filters: { ConditionRelationshipType: 1, Conditions: [] },
    Dimensions: [],
    reqFrom: 'uni-prom-creative-tab-list',
  };

  const result = await enqueue(() => requestAPI('POST', `/ad/api/pmc/v1/uni-promotion/material/list-optional?aavid=${aavid}`, body, accountId), accountId);
  const map = (result && result.data && result.data.materialInfoMap) || {};
  return map;
}

module.exports = {
  fetchMaterialTimeseriesFast,
  fetchMaterialAudienceFast,
  fetchUniPromMaterials,
  fetchUniPromAdList,
  fetchUniPromPlanOptional,
  fetchUniPromPlanRecommendations,
  fetchEffectiveDeliveryInfo,
  fetchRecommendData,
  fetchVideoFilterList,
  fetchVideoFilterWithCost,
  fetchProductSummary,
  fetchAwemeList,
  fetchPaged,
  fetchLiveStatus,
  fetchLiveSessions,
  fetchMaterialDetail,
  fetchMaterialDaily,
  fetchMaterialTimeseries,
  fetchMaterialAudience,
  fetchMaterialContent,
  fetchBoostList,
  fetchBoostSummary,
  fetchBoostOverview,
  fetchBoostTrend,
  fetchBoostMaterialDetail,
  fetchBoostSupport,
  fetchBoostOptLog,
  fetchSuggestedRoi,
  fetchLiveMaterials,
  fetchLiveMaterialsOptional,
  fetchBoostTaskReport,
};

/**
 * 调控任务信息表（site-promotion 页 live-data-dimensions=task 默认视图）
 * 抓包确认：POST /ad/api/data/v1/common/statQuery?reqFrom=promotion-unitable
 *   DataSetKey: site_promotion_post_detail_list_assist_task_scene
 *   Dimensions: 7 个 assist_* + smart_bid_type
 *   Metrics: 15 个全 _assist 后缀（含调控消耗/支付ROI/净成交ROI/1h退款率）
 *   DrillDimensions: [["stat_time_day"]]  → 每个任务下钻逐日行
 *   Filters: advertiser_id + marketing_goal=2 + assist_task_scene=2 + adlab_mode_fork=1 + anchor_id
 * 响应结构：Rows[].Rows[]（任务级 + 逐日级），Totals（汇总）
 *
 * @param {string} startDate YYYY-MM-DD
 * @param {string} endDate YYYY-MM-DD
 * @param {string} [accountId] 账号ID，不传走默认
 * @returns {Promise<object>} { tasks: [...], totals: {...}, totalCount, truncated }
 */
async function fetchBoostTaskReport(startDate, endDate, accountId, options = {}) {
  const acc = accountId ? resolveQcAccount(accountId) : null;
  const aavid = acc ? acc.aavid : AAVID;
  const anchorId = acc ? acc.anchorId : resolveAnchorId(accountId);

  const METRICS = [
    'show_cnt_for_roi2_assist', 'click_cnt_for_roi2_assist', 'ctr_for_roi2_assist',
    'convert_rate_for_roi2_assist', 'stat_cost_for_roi2_assist',
    'total_pay_order_count_for_roi2_assist', 'total_pay_order_gmv_include_coupon_for_roi2_assist',
    'total_pay_order_gmv_for_roi2_assist', 'total_prepay_and_pay_order_roi2_assist',
    'total_cost_per_pay_order_for_roi2_assist', 'total_order_settle_amount_for_roi2_1h_assist',
    'total_prepay_and_pay_settle_roi2_1h_assist', 'total_refund_order_gmv_for_roi2_1h_rate_assist',
    'pay_convert_cnt_for_roi2_assist', 'pay_convert_cost_for_roi2_assist',
  ];
  const DIMENSIONS = [
    'assist_aid', 'assist_name', 'assist_status', 'assist_start_time',
    'assist_material_infos', 'smart_bid_type', 'assist_task_scene',
  ];

  const body = {
    reqFrom: 'promotion-unitable',
    DataSetKey: 'site_promotion_post_detail_list_assist_task_scene',
    Metrics: METRICS,
    Dimensions: DIMENSIONS,
    StartTime: startDate + ' 00:00:00',
    EndTime: endDate + ' 23:59:59',
    Filters: { ConditionRelationshipType: 1, Conditions: [
      { Field: 'advertiser_id', Operator: 7, Values: [aavid] },
      { Field: 'marketing_goal', Operator: 7, Values: ['2'] },
      { Field: 'assist_task_scene', Operator: 7, Values: ['2'] },
      { Field: 'adlab_mode_fork', Operator: 7, Values: ['1'] },
      { Field: 'anchor_id', Operator: 7, Values: [String(anchorId)] },
    ]},
    DrillDimensions: [['stat_time_day']],
    OrderBy: [{ Type: 2, Field: 'stat_cost_for_roi2_assist' }],
    PageParams: { Offset: 0, Limit: 200 },
    refer: 'ecp',
  };

  const pageSize = 200;
  const allTasks = [];
  let totalCount = 0;
  let truncated = false;
  let lastResult = null;
  let complete = false;

  for (let page = 0; page < MAX_PAGES; page++) {
    body.PageParams = { Offset: allTasks.length, Limit: pageSize };
    const result = await statQuery(body, 3, accountId, { signal: options.signal });
    if (!result || !Array.isArray(result.data?.StatsData?.Rows)) break;
    lastResult = result;
    const sd = result.data.StatsData;
    const rows = sd.Rows || [];
    const declaredTotal = Number(sd.TotalCount);
    const hasTotal = sd.TotalCount != null && Number.isFinite(declaredTotal) && declaredTotal >= 0;
    totalCount = hasTotal ? declaredTotal : allTasks.length + rows.length;
    allTasks.push(...rows);
    console.log(`  [boostTaskReport] 第${page + 1}页 ${rows.length}条 · 累计 ${allTasks.length}/${totalCount}`);
    if ((hasTotal && allTasks.length >= totalCount) || rows.length < pageSize) { complete = true; break; }
  }
  if (!complete || allTasks.length < totalCount) truncated = true;

  // 本接口缺失指标必须为 null，不沿用通用 num 的补零逻辑。
  const metric = cell => require('./dataContract').finiteNumber(cell?.Value ?? cell?.value ?? cell?.ValueStr ?? (typeof cell === 'object' ? null : cell));
  // 提取汇总
  const totals = (lastResult && lastResult.data && lastResult.data.StatsData && lastResult.data.StatsData.Totals) || null;

  // 解析每个任务的素材标题（assist_material_infos 是 JSON 字符串）
  const tasks = allTasks.map(t => {
    const dims = t.Dimensions || {};
    const metrics = t.Metrics || {};
    let materialTitle = '';
    try {
      const mi = JSON.parse(dims.assist_material_infos?.Value || '[]');
      if (mi.length && mi[0].VideoMaterial) materialTitle = mi[0].VideoMaterial.Title || '';
    } catch (e) {}

    // 逐日明细
    const daily = (t.Rows || []).map(d => {
      const dd = d.Dimensions || {};
      const dm = d.Metrics || {};
      return {
        date: dd.stat_time_day?.ValueStr || '',
        cost: metric(dm.stat_cost_for_roi2_assist),
        payRoi: metric(dm.total_prepay_and_pay_order_roi2_assist),
        netRoi: metric(dm.total_prepay_and_pay_settle_roi2_1h_assist),
        refundRate1h: metric(dm.total_refund_order_gmv_for_roi2_1h_rate_assist),
        orderCount: metric(dm.total_pay_order_count_for_roi2_assist),
        gmv: metric(dm.total_pay_order_gmv_include_coupon_for_roi2_assist),
        showCnt: metric(dm.show_cnt_for_roi2_assist),
        clickCnt: metric(dm.click_cnt_for_roi2_assist),
        ctr: metric(dm.ctr_for_roi2_assist),
        convertRate: metric(dm.convert_rate_for_roi2_assist),
      };
    });

    // 追投任务状态映射（assist_status 数字 → 中文文案）
    // 探针对照千川页面 type4_table.json 确认：
    //   0 = 调控中（正在追投）
    //   4 = 已删除
    //   5 = 已暂停 手动暂停
    const ASSIST_STATUS_MAP = {
      '0': '调控中',
      '1': '调控中',
      '2': '已删除',
      '3': '已暂停',
      '4': '已删除',
      '5': '已暂停',
      '10': '已结束',
      '11': '已结束',
      '12': '已结束',
      '13': '已结束',
      '14': '已结束',
      '15': '已结束',
      '114': '调控中',
    };
    const rawStatus = String(dims.assist_status?.Value || '');
    const statusStr = ASSIST_STATUS_MAP[rawStatus] || `未知(${rawStatus})`;
    const isRunning = rawStatus === '0' || rawStatus === '1' || rawStatus === '114';

    return {
      assistAid: dims.assist_aid?.Value || '',
      name: dims.assist_name?.Value || '',
      status: rawStatus,
      statusStr,
      isRunning,
      startTime: dims.assist_start_time?.Value || '',
      materialTitle,
      ...require('./boostObservation').materialLinks(dims.assist_material_infos?.Value),
      cost: metric(metrics.stat_cost_for_roi2_assist),
      payRoi: metric(metrics.total_prepay_and_pay_order_roi2_assist),
      netRoi: metric(metrics.total_prepay_and_pay_settle_roi2_1h_assist),
      refundRate1h: metric(metrics.total_refund_order_gmv_for_roi2_1h_rate_assist),
      orderCount: metric(metrics.total_pay_order_count_for_roi2_assist),
      gmv: metric(metrics.total_pay_order_gmv_include_coupon_for_roi2_assist),
      paymentGmv: metric(metrics.total_pay_order_gmv_for_roi2_assist),
      netGmv: metric(metrics.total_order_settle_amount_for_roi2_1h_assist),
      settleAmount: metric(metrics.total_order_settle_amount_for_roi2_1h_assist),
      costPerOrder: metric(metrics.total_cost_per_pay_order_for_roi2_assist),
      showCnt: metric(metrics.show_cnt_for_roi2_assist),
      clickCnt: metric(metrics.click_cnt_for_roi2_assist),
      ctr: metric(metrics.ctr_for_roi2_assist),
      convertRate: metric(metrics.convert_rate_for_roi2_assist),
      daily,
    };
  });

  // 汇总提取
  const totalsParsed = totals ? {
    cost: metric(totals.stat_cost_for_roi2_assist),
    payRoi: metric(totals.total_prepay_and_pay_order_roi2_assist),
    netRoi: metric(totals.total_prepay_and_pay_settle_roi2_1h_assist),
    refundRate1h: metric(totals.total_refund_order_gmv_for_roi2_1h_rate_assist),
    orderCount: metric(totals.total_pay_order_count_for_roi2_assist),
    gmv: metric(totals.total_pay_order_gmv_include_coupon_for_roi2_assist),
    paymentGmv: metric(totals.total_pay_order_gmv_for_roi2_assist),
    netGmv: metric(totals.total_order_settle_amount_for_roi2_1h_assist),
    settleAmount: metric(totals.total_order_settle_amount_for_roi2_1h_assist),
    costPerOrder: metric(totals.total_cost_per_pay_order_for_roi2_assist),
    showCnt: metric(totals.show_cnt_for_roi2_assist),
    clickCnt: metric(totals.click_cnt_for_roi2_assist),
    ctr: metric(totals.ctr_for_roi2_assist),
    convertRate: metric(totals.convert_rate_for_roi2_assist),
  } : null;

  return { tasks, totals: totalsParsed, totalCount, truncated,
    source_at: new Date().toISOString(), window: { start: startDate, end: endDate, scope: 'date_range' },
    metric_sources: { gmv: 'total_pay_order_gmv_include_coupon_for_roi2_assist', paymentGmv: 'total_pay_order_gmv_for_roi2_assist',
      netGmv: 'total_order_settle_amount_for_roi2_1h_assist', netRoi: 'total_prepay_and_pay_settle_roi2_1h_assist' } };
}

function num(m) {
  if (!m) return 0;
  const v = typeof m === 'object' ? m.Value : m;
  if (v === '-' || v === null || v === undefined || v === '') return 0;
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}
