/**
 * server/routes/materialVideoLibrary.js
 *
 * 千川视频库接口 HTTP 路由：
 *   GET /api/materials/video-library?account=xxx&start=YYYY-MM-DD&end=YYYY-MM-DD&query=xxx&pageSize=100
 *   GET /api/materials/summary?account=xxx&id=MATERIAL_ID&start=...&end=...
 */
const { sendJSON } = require('../lib/utils');
const { defaultAccountId, isValidAccountId } = require('../lib/api-helpers');
const cv = require('../lib/creativeVideoLibrary');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseAccount(url) {
  const account = url.searchParams.get('account') || url.searchParams.get('accountId') || defaultAccountId();
  if (!isValidAccountId(account)) {
    return { error: `账号 ${account} 不在白名单` };
  }
  return { account };
}

function parseDateRange(url) {
  const today = new Date().toISOString().slice(0, 10);
  const start = url.searchParams.get('start') || url.searchParams.get('startDate') || today;
  const end = url.searchParams.get('end') || url.searchParams.get('endDate') || today;
  if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
    return { error: 'start/end 格式须为 YYYY-MM-DD' };
  }
  if (start > end) {
    return { error: 'start 不能晚于 end' };
  }
  return { start, end };
}

/**
 * GET /api/materials/video-library
 *
 * 参数：
 *   account / accountId
 *   start / startDate   默认今天
 *   end / endDate       默认今天
 *   query / q / queryString   可选：标题/materialId 搜索
 *   pageSize            默认 100，最大 100
 *   page                默认 1
 */
async function handleVideoLibrary(req, res, url) {
  if (req.method !== 'GET') return sendJSON(res, { ok: false, error: 'Method Not Allowed' }, 405);

  const acct = parseAccount(url);
  if (acct.error) return sendJSON(res, { ok: false, error: acct.error }, 400);
  const dr = parseDateRange(url);
  if (dr.error) return sendJSON(res, { ok: false, error: dr.error }, 400);

  const query = url.searchParams.get('query') || url.searchParams.get('q') || url.searchParams.get('queryString') || '';
  const page = parseInt(url.searchParams.get('page') || '1', 10);
  let pageSize = parseInt(url.searchParams.get('pageSize') || '100', 10);
  if (pageSize > 100) pageSize = 100;
  if (pageSize < 1) pageSize = 20;

  try {
    const opts = { startDate: dr.start, endDate: dr.end, page, pageSize };
    if (query.trim()) opts.queryString = query.trim();

    const result = await cv.fetchPage(acct.account, opts);
    return sendJSON(res, {
      ok: true,
      account: acct.account,
      start: dr.start,
      end: dr.end,
      query: query.trim() || undefined,
      total: result.total,
      hasMore: result.hasMore,
      count: result.videos.length,
      videos: result.videos,
    });
  } catch (e) {
    console.error('[materialVideoLibrary] error:', e.message);
    return sendJSON(res, { ok: false, error: e.message }, 500);
  }
}

/**
 * GET /api/materials/summary
 *
 * 参数：
 *   account / accountId
 *   id / material_id / materialId
 *   start / startDate
 *   end / endDate
 */
async function handleSummary(req, res, url) {
  if (req.method !== 'GET') return sendJSON(res, { ok: false, error: 'Method Not Allowed' }, 405);

  const acct = parseAccount(url);
  if (acct.error) return sendJSON(res, { ok: false, error: acct.error }, 400);
  const dr = parseDateRange(url);
  if (dr.error) return sendJSON(res, { ok: false, error: dr.error }, 400);

  const materialId = url.searchParams.get('id') || url.searchParams.get('material_id') || url.searchParams.get('materialId');
  if (!materialId) {
    return sendJSON(res, { ok: false, error: '缺少 id / material_id 参数' }, 400);
  }

  try {
    const video = await cv.getByMaterialId(acct.account, materialId, { startDate: dr.start, endDate: dr.end });
    if (!video) {
      return sendJSON(res, { ok: false, error: `未找到素材 ${materialId}` }, 404);
    }
    return sendJSON(res, {
      ok: true,
      account: acct.account,
      start: dr.start,
      end: dr.end,
      material_id: video.material_id,
      name: video.name,
      cost: video.cost,
      roi2: video.roi2,
      cvr: video.cvr,
      ctr: video.ctr,
      create_time: video.create_time,
      delivery_status: video.delivery_status,
      audit_status: video.audit_status,
      raw: video.raw,
    });
  } catch (e) {
    console.error('[materialVideoLibrary summary] error:', e.message);
    return sendJSON(res, { ok: false, error: e.message }, 500);
  }
}

module.exports = { handleVideoLibrary, handleSummary };
