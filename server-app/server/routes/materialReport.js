const { statQueryDirect } = require('../lib/qianchuan');
const { resolveQcAccount, resolveAavid } = require('../lib/cookie');
const { sendJSON, daysAgo, yesterday, resolveDateRange } = require('../lib/utils');


const { fetchMaterialDaily, fetchMaterialTimeseries, fetchMaterialAudience, fetchMaterialContent } = require('../lib/qianchuanTabs');


const PROMOTION_DS = 'roi2_video_material_analysis_promotion';
const INSIGHT_DS = 'roi2_video_material_analysis_insight';
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



function parseRetention(retention) {
  if (!retention || retention.length === 0) return null;
  const peak = retention.reduce((a, b) => a.viewers > b.viewers ? a : b);
  
  let maxDrop = { from: 0, to: 0, delta: 0 };
  for (let i = 1; i < retention.length; i++) {
    const delta = retention[i - 1].viewers - retention[i].viewers;
    if (delta > maxDrop.delta) {
      maxDrop = { from: i - 1, to: i, delta };
    }
  }
  const s0_3 = retention.slice(0, 4).reduce((s, r) => s + r.viewers, 0);
  const lastActive = [...retention].reverse().find(r => r.viewers > 0);
  return { peak, maxDrop, s0_3, lastActive, full: retention };
}

function buildDailyTable(dailyTable, limit = 30) {
  if (!dailyTable || dailyTable.length === 0) return '';
  const rows = dailyTable.slice(-limit).map(day => {
    const d = day.Dimensions.stat_time_day.ValueStr;
    const m = day.Metrics;
    const cost = (m.stat_cost_for_roi2 && m.stat_cost_for_roi2.Value) || 0;
    const orders = (m.total_pay_order_count_for_roi2 && m.total_pay_order_count_for_roi2.Value) || 0;
    const gmv = (m.total_pay_order_gmv_include_coupon_for_roi2 && m.total_pay_order_gmv_include_coupon_for_roi2.Value) || 0;
    const roi = (m.total_prepay_and_pay_order_roi2 && m.total_prepay_and_pay_order_roi2.Value) || 0;
    const plays = (m.video_play_count_for_roi2_v2 && m.video_play_count_for_roi2_v2.Value) || 0;
    
    const s3 = (m.video_play_duration_3s_rate_for_roi2 && m.video_play_duration_3s_rate_for_roi2.Value) || 0;
    const s5 = (m.video_play_duration_5s_rate_for_roi2 && m.video_play_duration_5s_rate_for_roi2.Value) || 0;
    const finish = (m.video_play_finish_rate_for_roi2_v2 && m.video_play_finish_rate_for_roi2_v2.Value) || 0;
    return `| ${d} | ${cost.toFixed(2)} | ${orders} | ${gmv.toFixed(2)} | ${roi.toFixed(2)} | ${plays} | ${s3.toFixed(1)}% | ${s5.toFixed(1)}% | ${finish.toFixed(1)}% |`;
  });
  return `| 日期 | 消耗 | 成交单 | GMV | ROI | 播放 | 3s率 | 5s率 | 完播 |
|------|------|--------|------|------|------|------|------|------|
${rows.join('\n')}`;
}

function buildCreativeTagsTable(creativeTags) {
  if (!creativeTags || creativeTags.length === 0) return '';
  const emojiMap = {
    '拍摄场景': '🎬', '呈现形式': '🎤', '产品功效': '✨', '适用人群': '👨‍👩‍👧',
    '适用场景': '🏕', '用户痛点': '😫', '优惠活动': '🎁', '产品卖点': '🏷'
  };
  return creativeTags.map(tag => {
    const label = tag.tag_label || '';
    const emoji = emojiMap[label] || '📌';
    const names = (tag.tag_name_list || []).map(t => t.text).join('、') || '（空）';
    return `| ${emoji} **${label}** | ${names} |`;
  }).join('\n');
}

function buildRetentionAnalysis(retentionData) {
  if (!retentionData) return '';
  const { peak, maxDrop, s0_3, lastActive } = retentionData;
  let lines = [];
  lines.push(`- 🔥 **观看峰值**：第 ${peak.second} 秒（${peak.viewers} 人）`);
  lines.push(`- 📈 **前3秒累计留存**：${s0_3} 人次`);
  if (lastActive) lines.push(`- 🏁 **最后有效观看**：第 ${lastActive.second} 秒（${lastActive.viewers} 人）`);
  if (maxDrop.delta > 0) {
    lines.push(`- 🚨 **最大断崖**：第 ${maxDrop.from}→${maxDrop.to} 秒，流失 ${maxDrop.delta} 人`);
  }
  return lines.join('\n');
}

function buildScriptStructure(script, duration) {
  if (!script) return '';
  const totalLen = script.length;
  const totalSec = duration || 99;
  if (totalLen === 0) return '';

  
  const categories = [
    { name: '🔥 开场钩子',  keywords: [['家人们',3],['老铁',2],['谁想吃',3],['看过来',2],['姐妹们',2]] },
    { name: '📦 产品展示',  keywords: [['包装',3],['真空',3],['分量',2],['加热',2],['丢到水',3],['热个十分钟',3],['独立',2]] },
    { name: '🍔 创意吃法',  keywords: [['搞里头',3],['配点',2],['小配菜',2],['黄瓜',2],['胡萝卜',2],['DIY',3],['夹',1]] },
    { name: '😋 口感描述',  keywords: [['软糯',3],['不塞牙',3],['不肥腻',3],['增香',2],['油脂',2],['五花肉',2],['梅干菜',2],['瘦肉',2],['精品',1]] },
    { name: '🛒 转化收口',  keywords: [['囤',3],['活动',3],['下单',3],['直播间',2],['赶紧',2],['多囤几单',4],['趁现在',3]] },
  ];

  const classify = (text) => {
    let best = { name: '💬 过渡', score: 0 };
    for (const cat of categories) {
      let score = 0;
      for (const [kw, w] of cat.keywords) {
        if (text.includes(kw)) score += w;
      }
      if (score > best.score) best = { name: cat.name, score };
    }
    return best.score >= 3 ? best.name : '💬 过渡';
  };

  
  const sentences = script.split(/(?<=[。！？])/).filter(s => s.trim().length > 2);
  const charPerSec = totalLen / Math.max(totalSec, 1);
  let segments = [];
  let cur = { startChar: 0, label: classify(sentences[0] || ''), senLen: 0 };

  for (const sent of sentences) {
    const lbl = classify(sent);
    if (lbl !== cur.label && lbl !== '💬 过渡' && cur.senLen > 0) {
      segments.push({ start: cur.startChar, end: cur.startChar + cur.senLen, label: cur.label });
      cur = { startChar: cur.startChar + cur.senLen, label: lbl, senLen: 0 };
    }
    cur.senLen += sent.length;
  }
  segments.push({ start: cur.startChar, end: cur.startChar + cur.senLen, label: cur.label });

  return segments.filter(s => s.end > s.start).map(s => {
    const ss = Math.floor(s.start / charPerSec);
    const se = Math.min(Math.floor(s.end / charPerSec), Math.floor(totalSec));
    return `| ${ss}-${se}s | ${s.label} |`;
  }).join('\n');
}

function diagnose() { return {strengths:[],problems:[],suggestions:['本版不包含投放策略判断。'],available:false}; }


const reportCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_SIZE = 50; 

function cacheSet(key, val) {
  
  if (reportCache.size >= CACHE_MAX_SIZE) {
    const now = Date.now();
    for (const [k, v] of reportCache) {
      if (now - v.time >= CACHE_TTL_MS) reportCache.delete(k);
    }
    
    if (reportCache.size >= CACHE_MAX_SIZE) {
      let oldest = null;
      for (const [k, v] of reportCache) {
        if (!oldest || v.time < oldest.time) oldest = { key: k, time: v.time };
      }
      if (oldest) reportCache.delete(oldest.key);
    }
  }
  reportCache.set(key, val);
}

async function handleMaterialReport(req, res, url) {
  const materialId = url.searchParams.get('id');
  if (!materialId) {
    return sendJSON(res, { error: 'missing material id (id=xxx is required)' }, 400);
  }

  let start = url.searchParams.get('start');
  let end = url.searchParams.get('end');
  const dateRange = url.searchParams.get('dateRange');
  const format = url.searchParams.get('format') || 'json'; 

  if (dateRange) {
    const range = resolveDateRange(dateRange);
    if (range) { start = range.start; end = range.end; }
  }

  const yestStr = yesterday();
  if (!end) end = yestStr;
  if (!start) start = daysAgo(30);
  if (end > yestStr) end = yestStr;

  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(start) || !dateRegex.test(end)) {
    return sendJSON(res, { error: 'Invalid date format. Must be YYYY-MM-DD' }, 400);
  }

  const account = url.searchParams.get('account') || undefined;

  
  const cacheKey = `${materialId}|${account || 'default'}|${start}|${end}`;
  const cached = reportCache.get(cacheKey);
  if (cached && (Date.now() - cached.time < CACHE_TTL_MS)) {
    console.log(`[material-report] 缓存命中: ${cacheKey} (${Math.round((Date.now()-cached.time)/1000)}秒前)`);
    if (cached.format === 'json') {
      return sendJSON(res, { ok: true, data: cached.data, _cached: true });
    } else {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(cached.data);
    }
  }

  try {
    
    const aavid = resolveAavid(account);
    const matFilter = { Field: 'material_id', Operator: 7, Values: [materialId] };
    const baseFilters = [
      { Field: 'advertiser_id', Operator: 7, Values: [aavid] },
      { Field: 'marketing_goal', Operator: 7, Values: ['2'] },
      { Field: 'material_type', Operator: 7, Values: ['3'] },
      { Field: 'fill_stat_time', Operator: 7, Values: ['on'] },
      matFilter,
    ];
    const baseBody = {
      StartTime: start + ' 00:00:00',
      EndTime: end + ' 23:59:59',
      Dimensions: ['stat_time_day'],
      Filters: { ConditionRelationshipType: 1, Conditions: baseFilters },
    };

    console.log(`[material-report] 并发拉取 ${materialId}...`);
    const [trend, table, tsResult, audienceResult, contentResult] = await Promise.all([
      statQueryDirect({ ...baseBody, DataSetKey: PROMOTION_DS, reqFrom: 'material-analysis-recomand-data', Metrics: DAILY_TREND_METRICS }, 3, account).catch(e => { if (e.message === 'cookie_expired') throw e; return null; }),
      statQueryDirect({ ...baseBody, DataSetKey: PROMOTION_DS, reqFrom: 'recommand_data_table', Metrics: DAILY_TABLE_METRICS }, 3, account).catch(e => { if (e.message === 'cookie_expired') throw e; return null; }),
      (async () => {
        const { fetchMaterialTimeseriesFast } = require('../lib/qianchuanTabs');
        return fetchMaterialTimeseriesFast(materialId, start, end, account).catch(e => { if (e.message === 'cookie_expired') throw e; return null; });
      })(),
      (async () => {
        const { fetchMaterialAudienceFast } = require('../lib/qianchuanTabs');
        return fetchMaterialAudienceFast(materialId, start, end, account).catch(e => { if (e.message === 'cookie_expired') throw e; return null; });
      })(),
      (async () => {
        const { fetchMaterialContent } = require('../lib/qianchuanTabs');
        return fetchMaterialContent(materialId, account).catch(e => { if (e.message === 'cookie_expired') throw e; return null; });
      })(),
    ]);
    console.log(`[material-report] 并发完成`);

    const daily = {
      dailyTrend: ((trend && trend.data && trend.data.StatsData && trend.data.StatsData.Rows) || []),
      dailyTable: ((table && table.data && table.data.StatsData && table.data.StatsData.Rows) || []),
    };
    const detail = { material_id: materialId, startDate: start, endDate: end, accountId: account || 'default', fetched_at: new Date().toISOString(), ...daily, ...tsResult, audience: audienceResult, content: contentResult };
    const info = (detail.content && detail.content.info) || {};
    const script = (detail.content && detail.content.script) || '';
    const creativeTags = (detail.content && detail.content.creative_tags) || [];
    const retentionData = parseRetention(detail.retention);

    const diag = diagnose(detail);

    
    const report = [
      `# 素材分析报告`,
      ``,
      `> 素材ID：**${materialId}** | 账号：${account || 'default'} | 数据范围：${start} ~ ${end}`,
      ``,
      `---`,
      ``,
      `## 一、基本信息`,
      ``,
      `| 项目 | 数值 |`,
      `|------|------|`,
      `| 标题 | ${info.title || '—'} |`,
      `| 视频时长 | ${info.video_duration || '—'} 秒 |`,
      `| 首发日期 | ${info.material_create_time || '—'} |`,
      `| 行业分类 | ${(info.industry_id_list || []).join(' / ') || '—'} |`,
      `| 当前状态 | lifetime=${info.status_lifetime || '—'}, identity=${JSON.stringify(info.status_identity || [])} |`,
      ``,
      `---`,
      ``,
      `## 二、核心数据`,
      ``,
      `| 指标 | 数值 | 评价 |`,
      `|------|------|------|`,
      `| 💰 累计消耗 | **${(info.cost || 0).toFixed(2)} 元** | 消耗排名 ${info.cost_rank || '—'} |`,
      `| 🛒 累计GMV | **${(info.gmv || 0).toFixed(2)} 元** | — |`,
      `| 📊 累计ROI | **${(info.roi || 0).toFixed(2)}** | 未作策略判断 |`,
      `| 👁 CTR | **${((info.ctr || 0) * 100).toFixed(2)}%** | CTR排名 ${info.ctr_rank || '—'} |`,
      `| 🎬 完播率 | **${((info.play_over_rate || 0) * 100).toFixed(2)}%** | — |`,
      `| ⚡ 5秒流失率 | ${detail.churnRate5s != null ? Number(detail.churnRate5s).toFixed(1) + '%' : '—'} | — |`,
      ``,
      `---`,
      ``,
      `## 三、AI 脚本分析`,
      ``,
      script ? `> ${script.replace(/\n/g, '\n> ')}` : '（无脚本数据）',
      ``,
      `### 脚本结构`,
      ``,
      `| 进度 | 时间段 | 功能 |`,
      `|------|--------|------|`,
      buildScriptStructure(script, info.video_duration),
      ``,
      `---`,
      ``,
      `## 四、千川创意标签`,
      ``,
      `| 维度 | 标签 |`,
      `|------|------|`,
      buildCreativeTagsTable(creativeTags),
      ``,
      `---`,
      ``,
      `## 五、留存曲线分析`,
      ``,
      retentionData ? buildRetentionAnalysis(retentionData) : '（无留存数据）',
      ``,
      `---`,
      ``,
      `## 六、每日趋势`,
      ``,
      buildDailyTable(detail.dailyTable, 30),
      ``,
      `---`,
      ``,
      `## 七、综合诊断`,
      ``,
      `### ✅ 优势`,
      diag.strengths.length > 0 ? diag.strengths.map(s => `- ${s}`).join('\n') : '（本版不提供策略诊断）',
      ``,
      `### ❌ 问题`,
      diag.problems.length > 0 ? diag.problems.map(s => `- ${s}`).join('\n') : '（本版不提供策略诊断）',
      ``,
      `### 💡 建议`,
      diag.suggestions.length > 0 ? diag.suggestions.map(s => `- ${s}`).join('\n') : '（暂无优化建议）',
      ``,
    ].join('\n');

    
    cacheSet(cacheKey, {
      time: Date.now(),
      format,
      data: format === 'markdown' ? report : { material_id: materialId, account: account || 'default', dateRange: `${start} ~ ${end}`, report, _diagnosis: diag }
    });

    if (format === 'markdown') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(report);
    }

    return sendJSON(res, {
      ok: true,
      data: {
        material_id: materialId,
        account: account || 'default',
        dateRange: `${start} ~ ${end}`,
        report,
        _diagnosis: diag,
      }
    });
  } catch (e) {
    if (e.message === 'cookie_expired') {
      return sendJSON(res, { ok: false, error: 'cookie_expired' }, 401);
    }
    console.error(`[material-report] 素材 ${materialId} 报告生成失败: ${e.message}`);
    return sendJSON(res, { ok: false, error: e.message }, 500);
  }
}

module.exports = handleMaterialReport;
