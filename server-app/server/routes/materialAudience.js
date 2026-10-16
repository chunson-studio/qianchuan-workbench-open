const { sendJSON, yesterday, daysAgo, daysAgoDate, resolveDateRange } = require('../lib/utils');
const { batchMaterialAudience, AUDIENCE_CACHE_DIR } = require('../lib/materialAudience');
const { isValidAccountId } = require('../lib/api-helpers');
const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');

/**
 * GET /api/material-audience?start=&end=&mode=lifetime&minCost=0&concurrency=8&refresh=0
 * 支持 dateRange 参数。
 *
 * 批量素材人群画像。
 *   mode=lifetime (默认): 每条素材用 [上传日, 昨天] 窗口，反映"这条素材一辈子吃谁"。
 *   mode=fixed:          每条素材用统一 [start, end] 窗口。
 * 默认 start=end-29天(近30天有消耗素材)、end=昨天。end 自动钳制昨天(人群 T+1)。
 * refresh=1 强制重跑；否则优先返回存盘。见 REVERSE_API.md §10.8。
 */
async function handleMaterialAudience(req, res, url) {
  const today = daysAgoDate(0);
  const yestStr = yesterday();

  let start = url.searchParams.get('start');
  let end = url.searchParams.get('end');
  const dateRange = url.searchParams.get('dateRange');

  if (dateRange) {
    const range = resolveDateRange(dateRange);
    if (range) {
      start = range.start;
      end = range.end;
    }
  }

  if (!end) end = yestStr;
  if (!start) start = daysAgo(30);
  if (end > yestStr) end = yestStr;

  // CLAUDE.md 强制要求：接口安全，防止目录穿越，做严格的正则白名单校验
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(start) || !dateRegex.test(end)) {
    return sendJSON(res, { error: 'Invalid date format. Must be YYYY-MM-DD' }, 400);
  }

  const mode = (url.searchParams.get('mode') || 'lifetime') === 'fixed' ? 'fixed' : 'lifetime';
  const minCost = parseFloat(url.searchParams.get('minCost') || '0') || 0;
  const concurrency = Math.min(parseInt(url.searchParams.get('concurrency') || '8') || 8, 16);
  const refresh = url.searchParams.get('refresh') === '1';
  const account = url.searchParams.get('account') || undefined;
  const accSuffix = (account && isValidAccountId(account)) ? '_' + account : '';

  const cacheFile = path.join(AUDIENCE_CACHE_DIR, `batch_${start}_${end}_${mode}${accSuffix}.json`);

  if (!refresh && await fsPromises.stat(cacheFile).then(()=>true).catch(()=>false)) {
    try {
      const cached = JSON.parse(await fsPromises.readFile(cacheFile, 'utf8'));
      return sendJSON(res, { ...cached, cached: true });
    } catch (_) { /* 损坏则重跑 */ }
  }

  try {
    const result = await batchMaterialAudience(start, end, { minCost, concurrency, mode, accountId: account });
    sendJSON(res, { ...result, cached: false });
  } catch (e) {
    if (e.message === 'cookie_expired') {
      return sendJSON(res, { ok: false, error: 'cookie_expired' }, 401);
    }
    sendJSON(res, { ok: false, error: e.message }, 500);
  }
}

module.exports = handleMaterialAudience;
