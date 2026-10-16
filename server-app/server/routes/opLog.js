const opLog = require('../lib/operationLog');
const { sendJSON } = require('../lib/utils');
const { getDB } = require('../lib/db');

/**
 * 批量解析素材名称（material_daily 最新名，2026-07-29 操作记录完整展示用）
 * @param {string} accountId
 * @param {string[]} ids
 * @returns {Object<string,string>} material_id → name
 */
function resolveMaterialNames(accountId, ids) {
  if (!ids.length) return {};
  try {
    const db = getDB();
    const ph = ids.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT material_id, MAX(material_name) AS name FROM material_daily
       WHERE account_id = ? AND material_id IN (${ph}) AND material_name != '' GROUP BY material_id`
    ).all(accountId, ...ids);
    const map = {};
    for (const r of rows) map[String(r.material_id)] = r.name;
    return map;
  } catch { return {}; }
}

/** 从一条日志里提取涉及的素材ID（target_id 逗号串 + params.mids/legoMids） */
function extractMaterialIds(row) {
  const ids = [];
  if (row.target_type === 'material' && row.target_id) {
    ids.push(...String(row.target_id).split(',').map(s => s.trim()).filter(Boolean));
  }
  const p = row.params || {};
  for (const k of ['mids', 'legoMids', 'lego_mids']) {
    if (Array.isArray(p[k])) ids.push(...p[k].map(String));
  }
  return [...new Set(ids)];
}

/**
 * GET /api/op-log?startDate=&endDate=&action=&accountId=&adId=&limit=&offset=
 * 查询操作日志（审计追踪）。
 *
 * GET /api/op-log?stats=1&startDate=&endDate=
 * 查询操作统计（按 action 分组）。
 */
async function handleOpLog(req, res, url) {
  if (req.method !== 'GET') return sendJSON(res, { ok: false, error: 'Method Not Allowed' }, 405);

  try {
    const effectStatuses = new Set(['confirmed', 'unconfirmed', 'rejected']);
    const hasEffectStatus = url.searchParams.has('effectStatus');
    const effectStatus = url.searchParams.get('effectStatus');
    if (hasEffectStatus && !effectStatuses.has(effectStatus)) {
      return sendJSON(res, { ok: false, code: 'invalid_effect_status',
        error: 'effectStatus 必须是 confirmed、unconfirmed 或 rejected' }, 400);
    }
    if (hasEffectStatus && url.searchParams.get('stats') === '1') {
      return sendJSON(res, { ok: false, code: 'effect_status_stats_unsupported',
        error: 'stats=1 不支持 effectStatus；请使用日志查询模式' }, 400);
    }
    // 统计模式
    if (url.searchParams.get('stats') === '1') {
      const startDate = url.searchParams.get('start') || url.searchParams.get('startDate') || undefined;
      const endDate = url.searchParams.get('end') || url.searchParams.get('endDate') || undefined;
      const result = opLog.stats(startDate, endDate);
      return sendJSON(res, { ok: true, stats: result });
    }

    // 查询模式
    const rawLimit = parseInt(url.searchParams.get('limit'), 10);
    const rawOffset = parseInt(url.searchParams.get('offset'), 10);
    const opts = {
      startDate: url.searchParams.get('start') || url.searchParams.get('startDate') || undefined,
      endDate: url.searchParams.get('end') || url.searchParams.get('endDate') || undefined,
      action: url.searchParams.get('action') || undefined,
      accountId: url.searchParams.get('accountId') || undefined,
      adId: url.searchParams.get('adId') || undefined,
      effectStatus: effectStatus || undefined,
      limit: Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 100,
      offset: Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0,
    };

    const rows = opLog.query(opts);
    // 补素材名称：按账号批量解析，附上 materials: [{id, name}]
    const byAcct = new Map();
    for (const r of rows) {
      const ids = extractMaterialIds(r);
      if (!ids.length) { r.materials = []; continue; }
      const acct = r.account_id || '';
      if (!byAcct.has(acct)) byAcct.set(acct, resolveMaterialNames(acct, [...new Set(rows.flatMap(x => x.account_id === acct ? extractMaterialIds(x) : []))]));
      const names = byAcct.get(acct);
      r.materials = ids.map(id => ({ id, name: names[id] || null }));
    }
    const outputRows = rows.map(row => {
      const params = row.params && typeof row.params === 'object' ? row.params : {};
      const receipt = params.receipt && typeof params.receipt === 'object' ? params.receipt : {};
      return {
        ...row,
        // Do not infer confirmation from legacy success=1; that field tracks accepted writes for cooldowns.
        effect_status: receipt.effect_status || params.effect_status || 'unknown',
        upstream_accepted: typeof receipt.upstream_accepted === 'boolean' ? receipt.upstream_accepted
          : typeof params.upstream_accepted === 'boolean' ? params.upstream_accepted : null,
        success_basis: 'upstream_accepted',
      };
    });
    return sendJSON(res, {
      ok: true,
      count: outputRows.length,
      filters: opts,
      logs: outputRows,
    });
  } catch (e) {
    return sendJSON(res, { ok: false, error: e.message }, 500);
  }
}

module.exports = handleOpLog;
