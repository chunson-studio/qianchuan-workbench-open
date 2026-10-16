const path = require('path');
const { sendJSON, daysAgo } = require('../lib/utils');
const { isValidAccountId, defaultAccountId } = require('../lib/api-helpers');
const { buildMaterialProfile, buildAudienceInsight, PROFILE_CACHE_DIR, readDayCache, writeDayCache } = require('../lib/materialProfile');


async function handleMaterialProfile(req, res, url) {
  const account = url.searchParams.get('account') || defaultAccountId();
  if (!isValidAccountId(account)) {
    return sendJSON(res, { ok: false, error: '无效的账号ID' }, 400);
  }
  try {
    if (url.pathname === '/api/audience-insight') {
      let days = parseInt(url.searchParams.get('days') || '30', 10);
      if (!Number.isFinite(days) || days < 1) days = 30;
      days = Math.min(days, 180);
      const cacheFile = path.join(PROFILE_CACHE_DIR, `audience_${account}_${days}_${daysAgo(0)}.json`);
      const cached = readDayCache(cacheFile);
      if (cached) return sendJSON(res, { ...cached, cached: true });
      const result = buildAudienceInsight(account, days);
      writeDayCache(cacheFile, result);
      return sendJSON(res, { ...result, cached: false });
    }

    
    const materialId = url.searchParams.get('material_id') || '';
    if (!/^[0-9A-Za-z:_-]{1,64}$/.test(materialId)) {
      return sendJSON(res, { ok: false, error: '缺少或非法的 material_id 参数' }, 400);
    }
    
    const cacheFile = path.join(PROFILE_CACHE_DIR, `profile_v2_${account}_${materialId}_${daysAgo(0)}.json`);
    const cached = readDayCache(cacheFile);
    if (cached) return sendJSON(res, { ...cached, cached: true });
    const profile = buildMaterialProfile(materialId, account);
    if (!profile) {
      return sendJSON(res, { ok: false, error: '素材不存在或无本地数据' }, 404);
    }
    const result = { ok: true, profile };
    writeDayCache(cacheFile, result);
    return sendJSON(res, { ...result, cached: false });
  } catch (e) {
    return sendJSON(res, { ok: false, error: e.message }, 500);
  }
}

module.exports = handleMaterialProfile;
