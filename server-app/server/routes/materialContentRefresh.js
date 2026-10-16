'use strict';

const { sendJSON } = require('../lib/utils');
const { isValidAccountId, defaultAccountId } = require('../lib/api-helpers');
const { getDB, storeContent } = require('../lib/db');
const { fetchMaterialContent } = require('../lib/qianchuanTabs');
const { invalidateMaterialProfileCache } = require('../lib/materialProfile');
const { handleApiError } = require('../lib/handleApiError');

const inFlight = new Map();

function contentDate(pDate) {
  const value = String(pDate || '');
  return /^\d{8}$/.test(value)
    ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
    : new Date().toISOString().slice(0, 10);
}

function parseJson(value) {
  try { return value ? JSON.parse(value) : null; } catch { return null; }
}

function findKnownVid(accountId, materialId, db = getDB()) {
  const rows = db.prepare(`
    SELECT creative_json
    FROM material_content
    WHERE account_id = ? AND material_id = ? AND creative_json IS NOT NULL
    ORDER BY stat_date DESC, fetched_at DESC
    LIMIT 10
  `).all(accountId, materialId);
  for (const row of rows) {
    const creative = parseJson(row.creative_json);
    const vid = creative && (
      creative.materialUri || creative.material_uri ||
      (creative.info && creative.info.material_uri)
    );
    if (vid) return String(vid);
  }
  return null;
}

function normalizeScript(content) {
  if (!content || !content.script) return null;
  return {
    text: content.script,
    formula: content.formula || [],
    details: content.formula_detail || {},
    source: content.script_source || null,
  };
}

function normalizeCreative(content) {
  if (!content || (!content.info && !content.creative_tags)) return null;
  const info = content.info || {};
  return {
    materialUri: content.material_uri || info.material_uri || null,
    title: info.title || '',
    cost: info.cost ?? null,
    ctr: info.ctr ?? null,
    roi: info.roi ?? null,
    gmv: info.gmv ?? null,
    playOverRate: info.play_over_rate ?? null,
    myTags: (content.creative_tags || []).map(group => ({
      type: group.material_tag_type || null,
      label: group.tag_label || '',
      tags: (group.tag_name_list || []).map(tag => tag && (tag.text || tag.name || tag.label || tag)).filter(Boolean),
    })),
  };
}

function cleanResponse(content) {
  const creative = normalizeCreative(content);
  const tags = [];
  for (const group of (creative && creative.myTags) || []) {
    for (const tag of group.tags || []) {
      if (!tags.includes(tag)) tags.push(tag);
    }
  }
  return {
    material_id: content.material_id,
    script: content.script || null,
    formula: content.formula || null,
    formula_detail: content.formula_detail || null,
    creative_tags: tags.slice(0, 12),
    metrics: content.info ? {
      cost: content.info.cost ?? null,
      gmv: content.info.gmv ?? null,
      roi: content.info.roi ?? null,
      ctr: content.info.ctr ?? null,
      finish_rate: content.info.play_over_rate ?? null,
      cost_rank: content.cost_rank ?? null,
      ctr_rank: content.ctr_rank ?? null,
      window: 'upstream_material_analysis_30d',
      roi_basis: 'payment',
    } : null,
    source_at: content.source_at || new Date().toISOString(),
    source: 'qianchuan_material_content_api',
    partial: Boolean(content.partial),
    errors: content.errors || [],
  };
}

/**
 * GET /api/material-content-refresh?material_id=&account=
 *
 * 素材抽屉的轻量补齐通道：只请求官方“内容”页的脚本与内容分析接口，
 * 不等待人群、秒级时序、同行视频或完整 material-detail 聚合。
 */
async function handleMaterialContentRefresh(req, res, url, deps = {}) {
  const account = url.searchParams.get('account') || defaultAccountId();
  const materialId = url.searchParams.get('material_id') || '';
  if (!isValidAccountId(account)) {
    return sendJSON(res, { ok: false, error: '无效的账号ID', code: 'invalid_account' }, 400);
  }
  if (!/^\d{11,}$/.test(materialId)) {
    return sendJSON(res, { ok: false, error: '缺少或非法的 material_id 参数', code: 'invalid_material_id' }, 400);
  }

  const fetchContent = deps.fetchContent || fetchMaterialContent;
  const saveContent = deps.saveContent || storeContent;
  const invalidateCache = deps.invalidateCache || invalidateMaterialProfileCache;
  const resolveKnownVid = deps.findKnownVid || findKnownVid;
  const key = `${account}|${materialId}`;

  try {
    let pending = inFlight.get(key);
    if (!pending) {
      const knownVid = resolveKnownVid(account, materialId);
      pending = fetchContent(materialId, account, {
        knownVid,
        direct: true,
        signal: req.signal,
        timeoutMs: 10000,
      }).finally(() => inFlight.delete(key));
      inFlight.set(key, pending);
    }
    const content = await pending;
    const script = normalizeScript(content);
    const creative = normalizeCreative(content);
    if (script || creative) {
      saveContent(account, materialId, contentDate(content.p_date), script, creative);
      invalidateCache(account, materialId);
    }
    return sendJSON(res, { ok: true, content: cleanResponse(content) });
  } catch (error) {
    return handleApiError(res, error);
  }
}

module.exports = handleMaterialContentRefresh;
module.exports._test = {
  cleanResponse,
  contentDate,
  findKnownVid,
  normalizeCreative,
  normalizeScript,
};
