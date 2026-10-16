/**
 * server/lib/creativeVideoLibrary.js
 * 千川「创意管理 → 视频库」video-list 接口封装。
 *
 * 特点：
 * - 纯 API 调用，无需浏览器/WebBridge/签名
 * - 一条素材返回全渠道累计（直播+商品卡+乘方）
 * - 支持按标题/materialId 搜索、支持分页拉全量
 * - 复用 server/lib/qianchuan.js 的 requestAPI + enqueue 限频队列
 */
const { requestAPI, enqueue } = require('./qianchuan');
const { resolveAavid } = require('./cookie');

const ENDPOINT = '/ad/api/creation/material/video-list';
const DEFAULT_METRICS = 'stat_cost,total_prepay_and_pay_order_roi2,total_cvr_rate_for_roi2,total_convert_rate_for_roi2,prepay_and_pay_order_roi,ctr,ecp_convert_rate';
const MAX_PAGES = 20; // 20 * 100 = 2000 条，两店素材量足够

function toQcDateTime(dateStr, timeStr) {
  return `${dateStr} ${timeStr}`;
}

function buildPath(accountId, opts = {}) {
  const aavid = resolveAavid(accountId);
  const params = new URLSearchParams();
  params.set('page', String(opts.page || 1));
  params.set('pageSize', String(opts.pageSize || 100));
  params.set('orderBy', String(opts.orderBy || 2)); // 2=desc
  params.set('field', opts.field || 'create_time');
  params.set('from', '2'); // 必须带 from=2 才会返回 stats
  params.set('metrics', opts.metrics || DEFAULT_METRICS);
  params.set('metricsStartTime', toQcDateTime(opts.startDate || opts.start || '2026-01-01', '00:00:00'));
  params.set('metricsEndTime', toQcDateTime(opts.endDate || opts.end || '2026-12-31', '23:59:59'));
  if (opts.queryString != null) params.set('queryString', String(opts.queryString));
  if (opts.source != null) params.set('source', String(opts.source));
  if (opts.tags != null) params.set('tags', String(opts.tags));
  if (opts.imageModes != null) params.set('imageModes', String(opts.imageModes));
  if (opts.analysisType != null) params.set('analysisType', String(opts.analysisType));
  if (opts.auditStatuses != null) params.set('auditStatuses', String(opts.auditStatuses));
  if (opts.materialDeliveryStatus != null) params.set('materialDeliveryStatus', String(opts.materialDeliveryStatus));
  params.set('aavid', aavid);
  return `${ENDPOINT}?${params.toString()}`;
}

function normalizeVideo(vid) {
  const stats = vid.materialStatsData || {};
  const metrics = stats.metrics || {};
  const normal = stats.normalStatsData || {};
  const roi2 = stats.roi2StatsData || {};

  const cost = metrics.statCost ? +metrics.statCost.value : 0;
  const roi2Value = roi2.totalPrepayAndPayOrderRoi2 ? +roi2.totalPrepayAndPayOrderRoi2.value : 0;
  const cvr = roi2.totalCvrRateForRoi2 ? +roi2.totalCvrRateForRoi2.value : 0;
  const ctr = normal.ctr ? parseFloat(normal.ctr.valueStr || '0') : 0;
  const ecpCvr = normal.ecpConvertRate ? parseFloat(normal.ecpConvertRate.valueStr || '0') : 0;

  return {
    material_id: vid.materialId,
    // 视频库把官方 video_id 放在 itemId（形如 v03...）；改名接口需要原样回传。
    video_id: vid.videoId || vid.video_id || (/^v[0-9a-z]+$/i.test(String(vid.itemId || '')) ? vid.itemId : null),
    item_id: vid.itemId,
    name: vid.title,
    create_time: vid.createTime,
    duration: vid.duration,
    width: vid.width,
    height: vid.height,
    ratio: vid.ratio,
    tags: vid.tags || [],
    source: vid.source,
    audit_status: vid.auditStatus,
    delivery_status: vid.materialDeliveryStatus,
    labels: {
      low_efficiency: vid.lowEfficiency,
      high_quality: vid.highQuality,
      aigc: vid.aigc,
      poor_quality: vid.poorQuality,
      improvable: vid.improvable,
      similar_risk: vid.similarRisk,
      first_publish: vid.firstPublish,
      owner_copy: vid.ownerCopy,
    },
    cost,
    roi2: roi2Value,
    cvr,
    ctr,
    ecp_cvr: ecpCvr,
    raw: stats,
  };
}

/**
 * 拉取单页
 * @param {string} accountId
 * @param {object} opts { page, pageSize, startDate, endDate, queryString, ... }
 */
async function fetchPage(accountId, opts = {}) {
  const path = buildPath(accountId, opts);
  const data = await enqueue(() => requestAPI('GET', path, null, accountId), accountId);
  if (!data || data.status_code !== 0) {
    throw new Error(data && data.message ? `video-list error: ${data.message}` : 'video-list unknown error');
  }
  const d = data.data || {};
  return {
    total: parseInt(d.total, 10) || 0,
    hasMore: !!d.hasMore,
    isHitWhiteList: !!d.isHitWhiteList,
    videos: (d.personalVideos || []).map(normalizeVideo),
  };
}

/**
 * 分页拉取全量
 * @param {string} accountId
 * @param {object} opts { startDate, endDate, pageSize, queryString, ... }
 */
async function fetchAll(accountId, opts = {}) {
  const pageSize = opts.pageSize || 100;
  const all = [];
  let page = 1;
  let hasMore = true;
  let total = null;
  while (hasMore && page <= MAX_PAGES) {
    const batch = await fetchPage(accountId, { ...opts, page, pageSize });
    all.push(...batch.videos);
    total = batch.total;
    hasMore = batch.hasMore;
    if (all.length >= total) break;
    page++;
  }
  return {
    total: total || all.length,
    truncated: hasMore && page > MAX_PAGES,
    count: all.length,
    videos: all,
  };
}

/**
 * 按标题或 materialId 搜索
 * @param {string} accountId
 * @param {string} query - 标题片段或 materialId
 * @param {object} opts { startDate, endDate }
 */
async function search(accountId, query, opts = {}) {
  if (!query || String(query).trim().length === 0) {
    throw new Error('search query 不能为空');
  }
  const result = await fetchPage(accountId, { ...opts, queryString: String(query).trim(), pageSize: 20 });
  return result.videos;
}

/**
 * 按 materialId 查单条累计数据
 * @param {string} accountId
 * @param {string} materialId
 * @param {object} opts { startDate, endDate }
 */
async function getByMaterialId(accountId, materialId, opts = {}) {
  const hits = await search(accountId, materialId, opts);
  return hits.find(v => v.material_id === materialId) || null;
}

/**
 * 按标题模糊搜索（video-library 返回的是前缀/包含匹配，这里只做透传）
 * @param {string} accountId
 * @param {string} title
 * @param {object} opts { startDate, endDate }
 */
async function searchByTitle(accountId, title, opts = {}) {
  return search(accountId, title, opts);
}

/**
 * 按 materialId 查原始条目（含 imageUrl/videoUrl 签名 URL——添加素材拼 payload 专用，2026-08-02）。
 * 签名 URL 有时效（x-orig-expires 约 12h），必须现拉现用，禁止缓存落库。
 * @param {string} accountId
 * @param {string} materialId
 * @returns {Promise<object|null>} video-list personalVideos 原始条目，查不到返回 null
 */
async function fetchRawByMaterialId(accountId, materialId) {
  const path = buildPath(accountId, { queryString: String(materialId), pageSize: 20 });
  const data = await enqueue(() => requestAPI('GET', path, null, accountId), accountId);
  if (!data || data.status_code !== 0) {
    throw new Error(data && data.message ? `video-list error: ${data.message}` : 'video-list unknown error');
  }
  const list = (data.data && data.data.personalVideos) || [];
  return list.find(v => String(v.materialId) === String(materialId)) || null;
}

module.exports = {
  fetchPage,
  fetchAll,
  search,
  searchByTitle,
  getByMaterialId,
  fetchRawByMaterialId,
  normalizeVideo,
  DEFAULT_METRICS,
};
