const { metricNumber } = require('./materialMetricFields');
const { AAVID, PAGE_SIZE, MAX_PAGES, CLASSIFICATION } = require('./config');
const { statQuery, statQueryDirect, requestAPI, enqueue, reportRateLimit } = require('./qianchuan');
const { resolveQcAccount, resolveAavid } = require('./cookie');
const { num, toVal } = require('./utils');

const DIMS = [
  { api: 'material_type',       label: '视频类型' },
  { api: 'material_name_v2',    label: '素材名称' },
  { api: 'material_id',         label: '素材ID' },
  { api: 'material_duration_v2',label: '视频时长' },
  { api: 'material_create_time_v2', label: '创建时间' },
  { api: 'material_source_v2',  label: '来源' },
  { api: 'material_tag_list',   label: '标签' },
  { api: 'roi2_material_status', label: '素材状态原始值' },
  { api: 'ad_id',               label: '计划ID' },
  { api: 'ad_name',             label: '计划名称' },
];



const ALL_METRICS = [
  
  { api: 'stat_cost_for_roi2',                          label: '整体消耗(元)' },
  { api: 'total_prepay_and_pay_order_roi2',             label: '整体支付ROI' },
  { api: 'total_pay_order_gmv_include_coupon_for_roi2', label: '整体成交金额(元)' },
  { api: 'total_pay_order_gmv_for_roi2',                label: '不含券支付金额(元)' },
  { api: 'total_pay_order_count_for_roi2',              label: '整体成交订单数' },
  { api: 'total_cost_per_pay_order_for_roi2',           label: '订单成本' },
  
  { api: 'stat_cost_for_roi2_assist',                                           label: '追投调控消耗(元)' },
  { api: 'additional_delivery_total_prepay_and_pay_order_roi2_assist',          label: '追投调控支付ROI' },
  { api: 'additional_delivery_total_pay_order_count_for_roi2_assist',           label: '追投调控成交订单数' },
  { api: 'additional_delivery_total_pay_order_gmv_include_coupon_for_roi2_assist', label: '追投调控成交金额(元)' },
  { api: 'additional_delivery_total_pay_order_gmv_for_roi2_assist',             label: '追投调控不含券支付金额(元)' },
  { api: 'additional_delivery_total_prepay_and_pay_settle_roi2_1h_assist',      label: '追投调控1h净ROI' },
  
  { api: 'total_prepay_and_pay_settle_roi2_1h',         label: '1h结算ROI' },
  { api: 'total_order_settle_amount_for_roi2_1h',       label: '1h结算金额' },
  { api: 'total_order_settle_count_for_roi2_1h',        label: '净成交订单数' },
  { api: 'total_refund_order_gmv_for_roi2_1h_rate',     label: '1h退款率' },
  { api: 'additional_delivery_total_refund_order_gmv_for_roi2_1h_rate_assist', label: '追投调控退款率' },
  
  { api: 'total_prepay_and_pay_settle_roi2_7d',         label: '7d结算ROI' },
  
  { api: 'live_show_count_for_roi2_v2',                   label: '整体展现次数' },
  { api: 'live_watch_count_for_roi2_v2',                  label: '进房点击次数' },
  { api: 'total_cpc_for_roi2',                            label: '点击单价(元)' },
  { api: 'live_convert_rate_for_roi2_v2',                 label: '整体转化率' },
  
  { api: 'video_play_count_for_roi2_v2',    label: '视频播放次数' },
  { api: 'video_avg_watch_duration_for_roi2', label: '视频平均观看时长(s)' },
  { api: 'video_play_finish_rate_for_roi2_v2', label: '视频完播率' },
  { api: 'video_play_duration_3s_rate_for_roi2', label: '3s播放占比' },
  { api: 'video_like_count_for_roi2',        label: '视频点赞数' },
  { api: 'video_comment_count_for_roi2_v2',  label: '视频评论数' },
];

ALL_METRICS.push(
  { api: 'video_play_duration_5s_rate_for_roi2', label: '5s播放占比' },
  { api: 'additional_delivery_total_order_settle_amount_for_roi2_1h_assist', label: '追投调控1h净成交金额(元)' }
);
const METRIC_KEYS = ALL_METRICS.map(m => m.api);
const DIM_API_KEYS = DIMS.map(d => d.api);

function normalizeApiRows(rows) {
  return rows.map(r => {
    const dims = r.Dimensions || {};
    const metrics = r.Metrics || {};
    const row = {};
    DIMS.forEach(d => { row[d.label] = toVal(dims[d.api]); });
    const rawStatus = toVal(dims['roi2_material_status']);
    
    
    
    const STATUS_MAP = {
      '0': '投放中',
      '1': '投放中',
      '2': '已删除',
      '3': '已排除',
      '4': '不可投',
      'DELIVERY_OK': '投放中',
      'DELETED': '已删除',
      'EXCLUDE': '已排除',
      'DELIVERY_NOT': '不可投',
    };
    row['状态'] = STATUS_MAP[String(rawStatus)] || '未知';
    row['material_status_raw'] = rawStatus;
    row._metric_sources = {};
    ALL_METRICS.forEach(m => {
      row[m.label] = metricNumber(metrics[m.api]);
      row._metric_sources[m.label] = { field: m.api, data_valid: row[m.label] !== null };
    });
    row['净成交金额(元)'] = row['1h结算金额'];
    row['追投调控净成交金额(元)'] = row['追投调控1h净成交金额(元)'];
    row['追投净成交金额(元)'] = row['追投调控1h净成交金额(元)'];
    row['基础消耗(元)'] = row['整体消耗(元)'] != null && row['追投调控消耗(元)'] != null
      ? Math.max(0, row['整体消耗(元)'] - row['追投调控消耗(元)']) : null;
    row['基础成交金额(元)'] = row['整体成交金额(元)'] != null && row['追投调控成交金额(元)'] != null
      ? row['整体成交金额(元)'] - row['追投调控成交金额(元)'] : null;
    return row;
  });
}





function safeNum(v) { const n = num(v); return Number.isFinite(n) ? n : 0; }
function avg(arr, keyOrFn) {
  if (!arr.length) return 0;
  const vals = typeof keyOrFn === 'function' ? arr.map(keyOrFn) : arr.map(r => safeNum(r[keyOrFn]));
  const sum = vals.reduce((s, v) => s + v, 0);
  return sum / vals.length;
}



















function enrichRows(rows) { return (rows || []).map(row => ({...row,_stage:'unknown',_roiStatus:'not_evaluated',_isQuality:null,_netROI:metricNumber(row['1h结算ROI']),_action:null,_tags:[],strategy_status:'not_included'})); }

function processRows(rows, startDate, endDate) {
  const normalized = normalizeApiRows(rows);
  return enrichRows(normalized, startDate, endDate);
}

async function fetchAllData(startDate, endDate, accountId, opts = {}) {
  const aavid = resolveAavid(accountId);
  const sq = opts.skipQueue ? statQueryDirect : statQuery;

  const filters = [
    { Field: "advertiser_id", Operator: 7, Values: [aavid] },
    { Field: "marketing_goal", Operator: 7, Values: ["2"] },
    { Field: "adlab_mode_fork", Operator: 7, Values: ["1"] },
    { Field: "material_type", Operator: 7, Values: ["3"] },
  ];
  const body = {
    DataSetKey: "roi2_video_material_analysis",
    reqFrom: "roi2_material_list",
    StartTime: startDate + " 00:00:00",
    EndTime: endDate + " 23:59:59",
    Metrics: METRIC_KEYS,
    Dimensions: DIM_API_KEYS,
    Filters: { ConditionRelationshipType: 1, Conditions: filters },
    OrderBy: [{ Type: 2, Field: "stat_cost_for_roi2" }],
  };

  let allRows = [];
  let truncated = false;
  let pageSize = PAGE_SIZE;

  
  body.PageParams = { Offset: 0, Limit: pageSize };
  const t0 = Date.now();
  const firstResult = await sq(body, 3, accountId);
  const elapsed0 = Date.now() - t0;
  if (!firstResult) return { rows: [], truncated };
  const firstSd = firstResult.data && firstResult.data.StatsData;
  const firstRows = (firstSd && firstSd.Rows) || [];
  const total = parseInt(firstSd && firstSd.TotalCount) || firstRows.length;
  allRows = allRows.concat(firstRows);
  const totalPages = Math.ceil(total / pageSize);
  const estMs = totalPages > 1 ? Math.round(elapsed0 * totalPages / Math.min(3, totalPages)) : 0;
  console.log(`  [分页] 共${total}条/${totalPages}页 · 第1页${firstRows.length}条 (${elapsed0}ms)${totalPages > 1 ? ` · 预计还需${Math.ceil(estMs/1000)}s` : ''}`);

  if (allRows.length >= total || firstRows.length < pageSize) {
    await appendAigcRows(allRows, startDate, endDate, accountId);
    return { rows: allRows, truncated };
  }

  
  
  const remainingPages = Math.min(MAX_PAGES - 1, Math.ceil((total - allRows.length) / pageSize));
  const BATCH = 3;
  for (let batchStart = 0; batchStart < remainingPages; batchStart += BATCH) {
    const batchEnd = Math.min(batchStart + BATCH, remainingPages);
    const promises = [];
    for (let i = batchStart; i < batchEnd; i++) {
      const offset = (i + 1) * pageSize;
      const pageBody = { ...body, PageParams: { Offset: offset, Limit: pageSize } };
      promises.push(sq(pageBody, 3, accountId).catch(e => {
        if (e.message === 'cookie_expired') throw e;
        console.log(`  [分页] 第${i+2}页失败: ${e.message}`);
        return null;
      }));
    }
    const results = await Promise.all(promises);
    let batchRows = 0;
    for (const result of results) {
      if (!result) continue;
      const sd = result.data && result.data.StatsData;
      const rows = (sd && sd.Rows) || [];
      allRows = allRows.concat(rows);
      batchRows += rows.length;
    }
    console.log(`  [分页] 批次 ${batchStart+2}~${batchEnd+1} 页，本批 ${batchRows}条 · 累计 ${allRows.length}/${total}`);
    if (allRows.length >= total) break;
  }

  
  
  
  await appendAigcRows(allRows, startDate, endDate, accountId);

  if (allRows.length < total) truncated = true;
  return { rows: allRows, truncated };
}


async function fetchAllDataByMaterial(startDate, endDate, accountId) {
  const aavid = resolveAavid(accountId);

  
  const listFilters = [
    { Field: "advertiser_id", Operator: 7, Values: [aavid] },
    { Field: "marketing_goal", Operator: 7, Values: ["2"] },
    { Field: "adlab_mode_fork", Operator: 7, Values: ["1"] },
    { Field: "material_type", Operator: 7, Values: ["3"] },
  ];
  const listBody = {
    DataSetKey: "roi2_video_material_analysis",
    reqFrom: "roi2_material_list",
    StartTime: startDate + " 00:00:00",
    EndTime: endDate + " 23:59:59",
    Metrics: ["stat_cost_for_roi2"],
    Dimensions: ["material_id", "material_name_v2", "material_type", "material_create_time_v2", "material_source_v2", "material_tag_list", "material_duration_v2", "roi2_material_status"],
    Filters: { ConditionRelationshipType: 1, Conditions: listFilters },
    OrderBy: [{ Type: 2, Field: "stat_cost_for_roi2" }],
  };

  
  let materialList = [];
  let pageSize = PAGE_SIZE;
  listBody.PageParams = { Offset: 0, Limit: pageSize };
  const t0 = Date.now();
  const firstListResult = await statQuery(listBody, 3, accountId);
  if (!firstListResult) return { rows: [], truncated: false };
  const firstListSd = firstListResult.data && firstListResult.data.StatsData;
  const firstListRows = (firstListSd && firstListSd.Rows) || [];
  const totalMaterials = parseInt(firstListSd && firstListSd.TotalCount) || firstListRows.length;
  materialList = materialList.concat(firstListRows);
  console.log(`  [素材列表] 共${totalMaterials}个素材 · 第1页${firstListRows.length}条 (${Date.now()-t0}ms)`);

  
  while (materialList.length < totalMaterials) {
    const offset = materialList.length;
    const pageBody = { ...listBody, PageParams: { Offset: offset, Limit: pageSize } };
    const result = await statQuery(pageBody, 3, accountId);
    if (!result) break;
    const sd = result.data && result.data.StatsData;
    const rows = (sd && sd.Rows) || [];
    if (rows.length === 0) break;
    materialList = materialList.concat(rows);
    console.log(`  [素材列表] 累计 ${materialList.length}/${totalMaterials}`);
  }

  if (materialList.length === 0) return { rows: [], truncated: false };

  
  const aigcInfos = [];
  const aigcSeenNames = new Set();
  for (const mat of materialList) {
    const rid = mat.Dimensions?.material_id?.ValueStr || mat.Dimensions?.material_id?.Value;
    const isAigcMat = !rid || rid === '-' || rid === '-2';
    if (!isAigcMat) continue;
    const name = mat.Dimensions?.material_name_v2?.ValueStr || mat.Dimensions?.material_name_v2?.Value || '';
    if (aigcSeenNames.has(name)) continue;
    aigcSeenNames.add(name);
    aigcInfos.push({ name, dims: mat.Dimensions || {} });
  }

  
  console.log(`  [每日明细] 开始拉取 ${materialList.length} 个素材的每日数据 (${startDate}~${endDate})`);
  const detailFilters = [
    { Field: "advertiser_id", Operator: 7, Values: [aavid] },
    { Field: "marketing_goal", Operator: 7, Values: ["2"] },
    { Field: "material_type", Operator: 7, Values: ["3"] },
    { Field: "fill_stat_time", Operator: 7, Values: ["on"] },
  ];

  let allRows = [];
  let totalDays = 0;
  const t1 = Date.now();

  for (let i = 0; i < materialList.length; i++) {
    const mat = materialList[i];
    const rawMaterialId = mat.Dimensions?.material_id?.ValueStr || mat.Dimensions?.material_id?.Value;
    
    
    
    
    const isAigc = !rawMaterialId || rawMaterialId === '-' || rawMaterialId === '-2';
    if (isAigc) {
      const pct = Math.round(((i + 1) / materialList.length) * 100);
      process.stdout.write(`\r  [每日明细] ${pct}% (${i+1}/${materialList.length}) · 跳过AIGC占位(走聚合)   `);
      continue;
    }
    const materialId = rawMaterialId;

    
    const createTime = mat.Dimensions?.material_create_time_v2?.ValueStr || '';
    let matStartDate = startDate;
    if (createTime) {
      
      const m = createTime.match(/(\d{4}-\d{2}-\d{2})/);
      if (m && m[1] > startDate) matStartDate = m[1];
    }
    
    
    if (matStartDate > endDate) continue;
    
    const d0 = new Date(matStartDate), d1 = new Date(endDate);
    const expectedDays = Math.max(1, Math.round((d1 - d0) / 86400000) + 1);

    const detailBody = {
      DataSetKey: "roi2_video_material_analysis_promotion",
      StartTime: matStartDate + " 00:00:00",
      EndTime: endDate + " 23:59:59",
      Metrics: METRIC_KEYS,
      Dimensions: ["stat_time_day"],
      Filters: {
        ConditionRelationshipType: 1,
        Conditions: [...detailFilters, { Field: "material_id", Operator: 7, Values: [materialId] }],
      },
      OrderBy: [{ Type: 2, Field: "stat_time_day" }],
    };

    
    let offset = 0;
    let matTotal = 0;
    let matRows = [];
    let aigcSuspicious = false;
    while (true) {
      detailBody.PageParams = { Offset: offset, Limit: 200 };
      const result = await statQuery(detailBody, 3, accountId);
      if (!result) break;
      const sd = result.data && result.data.StatsData;
      const rows = (sd && sd.Rows) || [];
      if (rows.length === 0) break;
      matTotal = parseInt(sd && sd.TotalCount) || rows.length;

      
      
      if (isAigc && matTotal > expectedDays * 3) aigcSuspicious = true;

      
      const matDims = mat.Dimensions || {};
      rows.forEach(r => {
        r.Dimensions = r.Dimensions || {};
        
        ['material_id', 'material_name_v2', 'material_type', 'material_create_time_v2', 'material_source_v2', 'material_tag_list', 'material_duration_v2', 'roi2_material_status'].forEach(k => {
          if (k === 'material_id') { r.Dimensions[k] = { ValueStr: materialId, Value: materialId }; return; }
          if (!r.Dimensions[k] && matDims[k]) r.Dimensions[k] = matDims[k];
        });
      });

      matRows = matRows.concat(rows);
      offset += rows.length;
      if (offset >= matTotal || rows.length < 200) break;
    }


    
    if (aigcSuspicious) {
      console.log(`\n  [AIGC护栏] 素材 ${materialId} 返回 ${matTotal} 天，疑似账户级脏数据，已丢弃`);
    } else {
      allRows = allRows.concat(matRows);
    }
    totalDays += matTotal;
    const pct = Math.round((i + 1) / materialList.length * 100);
    const elapsed = Date.now() - t1;
    const avg = elapsed / (i + 1);
    const remaining = Math.round(avg * (materialList.length - i - 1) / 1000);
    process.stdout.write(`\r  [每日明细] ${pct}% (${i+1}/${materialList.length}) · ${materialId} ${matTotal}天 · 累计${allRows.length}行 · 剩余${remaining}s   `);
  }

  console.log(`\n  [每日明细] 完成 · 共${allRows.length}行/${totalDays}天 · 耗时${Math.round((Date.now()-t1)/1000)}s`);

  
  
  if (aigcInfos.length > 0) {
    const aigcRows = await fetchAigcRows(startDate, endDate, accountId, aigcInfos);
    allRows = allRows.concat(aigcRows);
    console.log(`  [AIGC聚合] 并入 ${aigcRows.length} 条 · 共${allRows.length}行`);
  }

  return { rows: allRows, truncated: false, materialList };
}



function normalizeAigcName(name) {
  return (name || '').replace(/视频/g, '').replace(/\s+/g, '').trim() || 'DYNAMIC';
}




async function fetchAigcRows(startDate, endDate, accountId, aigcInfos) {
  const aavid = resolveAavid(accountId);
  const adv = [
    { Field: "advertiser_id", Operator: 7, Values: [aavid] },
    { Field: "marketing_goal", Operator: 7, Values: ["2"] },
    { Field: "material_type", Operator: 7, Values: ["3"] },
    { Field: "fill_stat_time", Operator: 7, Values: ["on"] },
  ];
  const dailyBody = {
    DataSetKey: "roi2_video_material_analysis",
    StartTime: startDate + " 00:00:00",
    EndTime: endDate + " 23:59:59",
    Metrics: METRIC_KEYS,
    Dimensions: ["stat_time_day", ...DIM_API_KEYS],
    Filters: { ConditionRelationshipType: 1, Conditions: adv },
    OrderBy: [{ Type: 2, Field: "stat_time_day" }],
  };
  let rows = [];
  let offset = 0;
  while (true) {
    dailyBody.PageParams = { Offset: offset, Limit: 200 };
    const r = await statQuery(dailyBody, 3, accountId);
    if (!r) break;
    const sd = r.data && r.data.StatsData;
    const pageRows = (sd && sd.Rows) || [];
    if (pageRows.length === 0) break;
    for (const row of pageRows) {
      const mid = row.Dimensions?.material_id?.ValueStr ?? row.Dimensions?.material_id?.Value;
      const isNull = !mid || mid === '-' || mid === '-2' || mid === 'null';
      if (!isNull) continue; 
      const name = row.Dimensions?.material_name_v2?.ValueStr || row.Dimensions?.material_name_v2?.Value || 'DYNAMIC';
      const synthId = 'AIGC::' + normalizeAigcName(name);
      row.Dimensions = row.Dimensions || {};
      row.Dimensions['material_id'] = { ValueStr: synthId, Value: synthId };
      rows.push(row);
    }
    const total = parseInt(sd && sd.TotalCount) || 0;
    if (offset + pageRows.length >= total || pageRows.length < 200) break;
    offset += pageRows.length;
  }
  return rows;
}


async function appendAigcRows(allRows, startDate, endDate, accountId) {
  
  
  for (const r of allRows) {
    const dims = r.Dimensions || {};
    const mid = dims.material_id?.ValueStr ?? dims.material_id?.Value;
    if (!mid || mid === '-' || mid === '-2' || mid === 'null') {
      const name = dims.material_name_v2?.ValueStr || dims.material_name_v2?.Value || 'DYNAMIC';
      const synthId = 'AIGC::' + normalizeAigcName(name);
      dims.material_id = { ValueStr: synthId, Value: synthId };
    }
  }
  try {
    const aigcRows = await fetchAigcRows(startDate, endDate, accountId);
    console.log(`  [AIGC] fetchAigcRows 返回 ${aigcRows.length} 条`);
    if (aigcRows.length > 0) {
      allRows.push(...aigcRows);
      console.log(`  [AIGC] 补充 ${aigcRows.length} 条`);
    }
  } catch (e) {
    if (e.message.includes('cookie_expired')) throw e;
    console.log(`  [AIGC] 补充拉取失败(忽略): ${e.message}`);
  }
}

async function doFetchAndProcess(startDate, endDate, accountId, opts = {}) {
  const fetchResult = await fetchAllData(startDate, endDate, accountId, opts);
  const rows = fetchResult.rows;
  if (!rows || rows.length === 0) return null;
  const processed = processRows(rows, startDate, endDate);
  const activeCount = processed.filter(r => r['状态'] === '投放中').length;
  const deletedCount = processed.filter(r => r['状态'] === '已删除').length;
  return {
    rows: processed.length,
    meta: {
      total: processed.length,
      active: activeCount,
      deleted: deletedCount,
      truncated: fetchResult.truncated
    },
    data: processed,
  };
}






async function fetchInsight(materialId, startDate, endDate, accountId) {
  const aavid = resolveAavid(accountId);
  const baseFilters = {
    ConditionRelationshipType: 1,
    Conditions: [
      { Field: 'advertiser_id', Operator: 7, Values: [aavid] },
      { Field: 'material_id', Operator: 7, Values: [materialId] },
      { Field: 'marketing_goal', Operator: 7, Values: ['2'] },
    ],
  };
  const baseBody = {
    DataSetKey: 'roi2_video_material_analysis_insight',
    StartTime: startDate + ' 00:00:00',
    EndTime: endDate + ' 23:59:59',
    Dimensions: ['duration'],
    Filters: baseFilters,
  };

  
  const result = await statQuery({ ...baseBody, Metrics: ['video_lose_count_for_roi2', 'live_watch_count_for_roi2_v2'] }, 3, accountId);
  const rows = result?.data?.StatsData?.Rows || [];

  
  let clickCount = 0;
  try {
    const aavid = resolveAavid(accountId);
    const clickResult = await statQuery({
      DataSetKey: 'roi2_video_material_analysis',
      StartTime: startDate + ' 00:00:00',
      EndTime: endDate + ' 23:59:59',
      Dimensions: [],
      Metrics: ['live_watch_count_for_roi2_v2'],
      Filters: { ConditionRelationshipType: 1, Conditions: [
        { Field: 'advertiser_id', Operator: 7, Values: [aavid] },
        { Field: 'material_id', Operator: 7, Values: [materialId] },
        { Field: 'marketing_goal', Operator: 7, Values: ['2'] },
      ]},
    }, 3, accountId);
    clickCount = clickResult?.data?.StatsData?.Rows?.[0]?.Metrics?.live_watch_count_for_roi2_v2?.Value || 0;
  } catch {}

  
  let dropCount = 0;
  try {
    const dropResult = await statQuery({ ...baseBody, Dimensions: [], Metrics: ['video_lose_count_for_roi2'] }, 3, accountId);
    dropCount = dropResult?.data?.StatsData?.Rows?.[0]?.Metrics?.video_lose_count_for_roi2?.Value || 0;
  } catch {}

  
  const rateBody = { ...baseBody, Dimensions: [], Metrics: ['video_user_lose_rate_for_roi2'],
    Filters: { ...baseFilters, Conditions: [...baseFilters.Conditions, { Field: 'duration', Values: ['0', '5'], Operator: 9 }] } };
  let loseRate5s = 0;
  try {
    const rateResult = await statQuery(rateBody, 3, accountId);
    loseRate5s = rateResult?.data?.StatsData?.Rows?.[0]?.Metrics?.video_user_lose_rate_for_roi2?.Value || 0;
  } catch {}

  
  const bySecond = {};
  rows.forEach(r => {
    const s = r.Dimensions?.duration?.ValueStr;
    if (s != null) {
      bySecond[s] = {
        second: parseInt(s),
        loseCount: r.Metrics?.video_lose_count_for_roi2?.Value || 0,
        watchCount: r.Metrics?.live_watch_count_for_roi2_v2?.Value || 0,
      };
    }
  });

  return {
    totalSeconds: Object.keys(bySecond).length,
    loseRate5s,
    clickCount,
    dropCount,
    seconds: Object.values(bySecond).sort((a, b) => a.second - b.second),
  };
}


async function fetchCrowd(materialId, startDate, endDate, accountId) {
  const aavid = resolveAavid(accountId);
  const dims = ['gender', 'age', 'province_name', 'city_name', 'user_group_label_name'];
  const metrics = ['live_show_count_for_roi2_v2', 'live_watch_count_for_roi2_v2', 'total_pay_order_gmv_include_coupon_for_roi2'];
  const result = {};

  for (const dim of dims) {
    result[dim] = {};
    metrics.forEach(m => { result[dim][m] = []; });
    
    const body = {
      DataSetKey: 'roi2_video_material_analysis_crow',
      StartTime: startDate + ' 00:00:00',
      EndTime: endDate + ' 23:59:59',
      Dimensions: [dim],
      Metrics: metrics,
      Filters: { ConditionRelationshipType: 1, Conditions: [
        { Field: 'advertiser_id', Operator: 7, Values: [aavid] },
        { Field: 'material_id', Operator: 7, Values: [materialId] },
        { Field: 'marketing_goal', Operator: 7, Values: ['2'] },
      ]},
      OrderBy: [{ Type: 2, Field: metrics[0] }],
      PageParams: { Offset: 0, Limit: 500 },
    };
    try {
      const r = await statQuery(body, 3, accountId);
      const rows = r?.data?.StatsData?.Rows || [];
      for (const row of rows) {
        const label = row.Dimensions?.[dim]?.ValueStr || '';
        for (const met of metrics) {
          result[dim][met].push({ label, value: row.Metrics?.[met]?.Value || 0 });
        }
      }
    } catch {
      
    }
  }

  return result;
}


async function fetchBoostTasks(materialId, startDate, endDate, accountId) {
  const aavid = resolveAavid(accountId);
  const metrics = [
    'additional_delivery_stat_cost_for_roi2_assist',
    'additional_delivery_total_prepay_and_pay_order_roi2_assist',
    'additional_delivery_total_pay_order_gmv_for_roi2_assist',
    'additional_delivery_total_pay_order_count_for_roi2_assist',
    'additional_delivery_show_cnt_for_roi2_assist',
    'additional_delivery_click_cnt_for_roi2_assist',
    'additional_delivery_total_prepay_and_pay_settle_roi2_1h_assist',
    'additional_delivery_total_refund_order_gmv_for_roi2_1h_rate_assist',
  ];
  const body = {
    DataSetKey: 'roi2_video_material_task_analysis_detail',
    StartTime: startDate + ' 00:00:00',
    EndTime: endDate + ' 23:59:59',
    Dimensions: ['assist_aid', 'assist_name', 'assist_start_time'],
    Metrics: metrics,
    Filters: { ConditionRelationshipType: 1, Conditions: [
      { Field: 'advertiser_id', Operator: 7, Values: [aavid] },
      { Field: 'material_id', Operator: 7, Values: [materialId] },
      { Field: 'marketing_goal', Operator: 7, Values: ['2'] },
      { Field: 'material_type', Operator: 7, Values: ['3'] },
      { Field: 'assist_task_scene', Operator: 7, Values: ['2'] },
      { Field: 'roi2_project_scene', Operator: 7, Values: ['2'] },
    ]},
    OrderBy: [{ Type: 2, Field: 'additional_delivery_stat_cost_for_roi2_assist' }],
    PageParams: { Offset: 0, Limit: 200 },
  };
  try {
    const r = await statQuery(body, 3, accountId);
    const rows = r?.data?.StatsData?.Rows || [];
    return rows.map(row => ({
      assistAid: row.Dimensions?.assist_aid?.ValueStr || '',
      assistName: row.Dimensions?.assist_name?.ValueStr || '',
      assistStartTime: row.Dimensions?.assist_start_time?.ValueStr || '',
      cost: row.Metrics?.additional_delivery_stat_cost_for_roi2_assist?.Value || 0,
      roi: row.Metrics?.additional_delivery_total_prepay_and_pay_order_roi2_assist?.Value || 0,
      gmv: row.Metrics?.additional_delivery_total_pay_order_gmv_for_roi2_assist?.Value || 0,
      orders: row.Metrics?.additional_delivery_total_pay_order_count_for_roi2_assist?.Value || 0,
      shows: row.Metrics?.additional_delivery_show_cnt_for_roi2_assist?.Value || 0,
      clicks: row.Metrics?.additional_delivery_click_cnt_for_roi2_assist?.Value || 0,
      settleRoi: row.Metrics?.additional_delivery_total_prepay_and_pay_settle_roi2_1h_assist?.Value || 0,
      refundRate: row.Metrics?.additional_delivery_total_refund_order_gmv_for_roi2_1h_rate_assist?.Value || 0,
    }));
  } catch {
    return [];
  }
}


async function fetchScript(vid, accountId) {
  const aavid = resolveAavid(accountId);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await enqueue(() => requestAPI('GET', `/ad/api/data/v1/material-analysis/getContentFormulaAndScript?vid=${vid}&aavid=${aavid}`, null, accountId), accountId);
      if (r && r.status_code === 0 && r.data && r.data.text) {
        const d = r.data;
        return {
          text: d.text || '',
          formula: (d.data || []).map(f => ({
            category: f.level_1_label?.label || '',
            tags: (f.level_2_labels || []).map(t => t.label),
          })),
          details: Object.entries(d.detail || {}).map(([k, v]) => ({
            tagId: k,
            label: v.label,
            segments: v.list || [],
          })),
        };
      }
      if (r && r.status_code === 2) { reportRateLimit(accountId); console.log('  [脚本] 限频，等15s重试'); await new Promise(res => setTimeout(res, 15000)); continue; }
      if (r && r.status_code === 0 && (!r.data || !r.data.text)) {
        return null;
      }
    } catch (e) {
      console.log('  [脚本] 异常:', e.message);
    }
  }
  return null;
}


async function fetchCreativeAnalysis(materialId, accountId) {
  const aavid = resolveAavid(accountId);
  const body = {
    material_id: materialId,
    p_date: new Date().toISOString().slice(0, 10).replace(/-/g, ''),
    period_type: 30,
    assist_type: 3,
    assist_video_type: 2,
    aavid,
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await enqueue(() => requestAPI('POST', `/ad/api/data/v1/material-analysis/getContentMaterialAnalysisInfo?aavid=${aavid}`, body, accountId), accountId);
      if (r && r.status_code === 0) {
        const d = r.data || {};
        return {
          materialUri: d.material_uri || '',
          title: d.title || '',
          cost: d.cost || 0,
          ctr: d.ctr || 0,
          roi: d.roi || 0,
          gmv: d.gmv || 0,
          playOverRate: d.play_over_rate || 0,
          statusLifetime: d.status_lifetime || 0,
          myTags: (d.my_tag_entry || []).map(t => ({
            type: t.material_tag_type,
            label: t.tag_label,
            tags: (t.tag_name_list || []).map(x => x.text || x),
          })),
          benchTags: (d.bench_tag_entry || []).map(t => ({
            type: t.material_tag_type,
            label: t.tag_label,
            tags: (t.tag_name_list || []).map(x => x.text || x),
          })),
        };
      }
      if (r && r.status_code === 2) { reportRateLimit(accountId); console.log('  [创意] 限频，等15s重试'); await new Promise(r => setTimeout(r, 15000)); continue; }
    } catch (e) {
      console.log('  [创意] 异常:', e.message);
    }
  }
  return null;
}

module.exports = {
  DIMS,
  ALL_METRICS,
  METRIC_KEYS,
  DIM_API_KEYS,
  processRows,
  normalizeApiRows,
  enrichRows,
  fetchAllData,
  fetchAllDataByMaterial,
  doFetchAndProcess,
  fetchInsight,
  fetchCrowd,
  fetchBoostTasks,
  fetchScript,
  fetchCreativeAnalysis,
};
