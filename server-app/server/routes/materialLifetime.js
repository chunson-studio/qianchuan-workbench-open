const { getMaterialLifetime } = require('../lib/lifetime');
const { readCookie, isCookieProbablyValid } = require('../lib/cookie');
const { sendJSON, resolveDateRange } = require('../lib/utils');

function handleMaterialLifetime(req, res, url) {
  const materialId = url.searchParams.get('id') || '';
  const createTime = url.searchParams.get('createTime') || '';
  let startDate = url.searchParams.get('start') || '';
  let endDate = url.searchParams.get('end') || '';
  const dateRange = url.searchParams.get('dateRange');

  if (dateRange) {
    const range = resolveDateRange(dateRange);
    if (range) {
      startDate = range.start;
      endDate = range.end;
    }
  }
  const account = url.searchParams.get('account') || undefined;
  if (!materialId) return sendJSON(res, { error: 'missing material id' }, 400);
  console.log(`[lifetime] 查询素材 ${materialId} 生命周期 (${account || 'default'})...`);
  (async () => {
    try {
      // 历史账户专用说明已从试用包移除。
      if (!account && !isCookieProbablyValid(readCookie())) {
        console.log('[lifetime] Cookie 无效，尝试刷新...');
        return sendJSON(res, { ok: false, error: 'cookie_expired' }, 401);
      }
      const start = startDate || createTime;
      const result = await getMaterialLifetime(materialId, start, endDate, account);
      console.log(`[lifetime] ✓ ${result.days} 天`);
      sendJSON(res, { ok: true, material_id: materialId, ...result });
    } catch (e) {
      console.log('[lifetime] ✗', e.message);
      if (e.message === 'cookie_expired') return sendJSON(res, { ok: false, error: 'cookie_expired' }, 401);
      sendJSON(res, { error: e.message }, 500);
    }
  })().catch(err => {
    console.error(`[materialLifetime] 未捕获异常: ${err.message}`, err);
    if (!res.headersSent) sendJSON(res, { error: 'internal_server_error', message: err.message }, 500);
  });
}

module.exports = handleMaterialLifetime;

