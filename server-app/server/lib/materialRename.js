const { requestAPI, enqueue } = require('./qianchuan');
const { resolveAavid, resolveQcAccount } = require('./cookie');
const videoLibrary = require('./creativeVideoLibrary');
const { fetchLiveMaterials } = require('./qianchuanTabs');
const { getDB } = require('./db');

const ENDPOINT = '/ad/api/tool/v1/material/update-video-info';
const ROLES = Object.freeze(['种草', '收割', '承接', '探索', '待定']);
const ROLE_PREFIX_RE = /^\[(种草|收割|承接|探索|待定)\]\s*/;
const MAX_NAME_LENGTH = 50;

function fail(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function countChars(value) {
  return Array.from(String(value || '')).length;
}

function normalizeRole(role) {
  const value = String(role || '').trim();
  if (!ROLES.includes(value)) throw fail('material_role_invalid', `素材角色只允许：${ROLES.join('、')}`);
  return value;
}

function stripRolePrefix(name) {
  return String(name || '').replace(ROLE_PREFIX_RE, '').trim();
}

function buildRoleName(currentName, role) {
  const normalizedRole = normalizeRole(role);
  const base = stripRolePrefix(currentName);
  if (!base) throw fail('material_name_invalid', '素材当前名称为空，无法生成角色前缀');
  return `[${normalizedRole}]${base}`;
}

function normalizeName(name) {
  const value = String(name || '').trim();
  if (!value) throw fail('material_name_invalid', '素材名称不能为空');
  if (/[\r\n\t]/.test(value)) throw fail('material_name_invalid', '素材名称不能包含换行或制表符');
  if (countChars(value) > MAX_NAME_LENGTH) {
    throw fail('material_name_too_long', `素材名称最多 ${MAX_NAME_LENGTH} 个字符，当前 ${countChars(value)} 个`);
  }
  return value;
}

function normalizeMaterialId(materialId) {
  const value = String(materialId || '').trim();
  if (!/^\d{1,30}$/.test(value)) throw fail('material_id_invalid', 'materialId 必须为数字字符串');
  return value;
}

function rawVideoId(raw) {
  if (!raw) return null;
  const value = raw.videoId || raw.video_id || raw.itemId;
  return /^v[0-9a-z]+$/i.test(String(value || '')) ? String(value) : null;
}

function liveMaterialAsRaw(row, materialId) {
  const dimensions = row && row.dimensions || {};
  let playInfo = {};
  try {
    playInfo = typeof dimensions.roi2MaterialVideoPlayInfo === 'string'
      ? JSON.parse(dimensions.roi2MaterialVideoPlayInfo)
      : (dimensions.roi2MaterialVideoPlayInfo || {});
  } catch { /* 缺少播放信息时由下游给出 video_id_missing */ }
  const id = String(dimensions.materialId || dimensions.material_id || '');
  if (id !== String(materialId)) return null;
  return {
    materialId: id,
    title: dimensions.roi2MaterialVideoName || dimensions.material_name || '',
    videoId: playInfo.VideoId || playInfo.videoId || playInfo.video_id || '',
    source: 'live_materials',
  };
}

async function fetchRenameSource(accountId, materialId, deps = {}) {
  const fetchVideoLibraryRaw = deps.fetchVideoLibraryRaw || videoLibrary.fetchRawByMaterialId;
  const libraryRaw = await fetchVideoLibraryRaw(accountId, materialId);
  if (libraryRaw) return libraryRaw;

  const account = (deps.resolveQcAccount || resolveQcAccount)(accountId);
  if (!account || !account.anchorId) return null;
  const fetchLive = deps.fetchLiveMaterials || fetchLiveMaterials;
  const live = await fetchLive(account.anchorId, {
    accountId,
    status: 'all',
    pageSize: 500,
  });
  for (const row of (live && live.rows) || []) {
    const raw = liveMaterialAsRaw(row, materialId);
    if (raw) return raw;
  }
  return null;
}

async function inspectRename(accountId, input, deps = {}) {
  const materialId = normalizeMaterialId(input.materialId);
  const fetchRaw = deps.fetchRaw || ((targetAccountId, targetMaterialId) => fetchRenameSource(targetAccountId, targetMaterialId, deps));
  const raw = await fetchRaw(accountId, materialId);
  if (!raw) throw fail('material_not_found', `视频库和在投素材列表中均未找到素材 ${materialId}`, 404);

  const currentName = String(raw.title || '').trim();
  if (!currentName) throw fail('material_name_missing', '千川没有返回当前素材名称', 502);
  const role = input.role == null || input.role === '' ? null : normalizeRole(input.role);
  const proposedName = normalizeName(input.newName || (role ? buildRoleName(currentName, role) : ''));
  const videoId = rawVideoId(raw);
  if (!videoId) throw fail('video_id_missing', '千川没有返回改名所需的 video_id', 502);

  return {
    account_id: accountId,
    material_id: materialId,
    video_id: videoId,
    current_name: currentName,
    proposed_name: proposedName,
    role,
    changed: currentName !== proposedName,
  };
}

function syncLocalName(accountId, materialId, newName, role, deps = {}) {
  const db = deps.db || getDB();
  db.exec('BEGIN IMMEDIATE');
  try {
    const daily = role
      ? db.prepare('UPDATE material_daily SET material_name=?, role=? WHERE account_id=? AND material_id=?').run(newName, role, accountId, materialId)
      : db.prepare('UPDATE material_daily SET material_name=? WHERE account_id=? AND material_id=?').run(newName, accountId, materialId);
    const intraday = db.prepare('UPDATE material_intraday SET material_name=? WHERE account_id=? AND material_id=?').run(newName, accountId, materialId);
    db.exec('COMMIT');
    return { material_daily: daily.changes, material_intraday: intraday.changes };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* 保留原始错误 */ }
    throw error;
  }
}

function trySyncLocal(sync, accountId, inspection, deps) {
  try {
    return {
      local_sync: sync(accountId, inspection.material_id, inspection.proposed_name, inspection.role, deps),
      local_sync_error: null,
    };
  } catch (error) {
    return {
      local_sync: null,
      local_sync_error: error.code || error.message || 'local_sync_failed',
    };
  }
}

async function executeRename(accountId, input, deps = {}) {
  const inspection = await inspectRename(accountId, input, deps);
  const expected = String(input.expectedCurrentName || '').trim();
  if (!expected) throw fail('expected_current_name_required', '确认改名必须携带预检得到的 expectedCurrentName');
  if (expected !== inspection.current_name) {
    throw fail('material_name_conflict', `素材名称已变化：预期“${expected}”，当前“${inspection.current_name}”`, 409);
  }

  const sync = deps.syncLocal || syncLocalName;
  if (!inspection.changed) {
    const localResult = trySyncLocal(sync, accountId, inspection, deps);
    return { ...inspection, confirmed: true, upstream_changed: false, verified: true, ...localResult };
  }

  const aavid = String((deps.resolveAavid || resolveAavid)(accountId));
  const body = {
    video_update_list: [{
      video_id: inspection.video_id,
      file_name: inspection.proposed_name,
      skip_empty_tags: false,
    }],
    aavid,
  };
  const call = deps.request || ((path, payload) => enqueue(
    signal => requestAPI('POST', path, payload, accountId, signal),
    accountId,
    { label: 'rename_material', timeoutMs: 45000 },
  ));
  const result = await call(`${ENDPOINT}?aavid=${encodeURIComponent(aavid)}`, body);
  const statusCode = result && (result.status_code ?? result.code);
  const item = result && result.data && Array.isArray(result.data.results) ? result.data.results[0] : null;
  if (statusCode !== 0 || !item) {
    throw fail('material_rename_rejected', (result && result.message) || '千川未确认素材改名成功', 502);
  }
  if (Number(item.statusCode) !== 0 || String(item.materialId) !== inspection.material_id) {
    const unsupported = Number(item.statusCode) === 1 && String(item.materialId) === '0';
    throw fail(
      unsupported ? 'material_rename_unsupported' : 'material_rename_rejected',
      unsupported
        ? '该素材属于自选投放视频，千川改名接口不支持修改其官方标题；可保留本地角色分类'
        : `千川未确认素材改名成功（statusCode=${item.statusCode}）`,
      unsupported ? 409 : 502,
    );
  }

  let readbackName = null;
  const fetchRaw = deps.fetchRaw || videoLibrary.fetchRawByMaterialId;
  try {
    const raw = await fetchRaw(accountId, inspection.material_id);
    readbackName = raw && raw.title ? String(raw.title).trim() : null;
  } catch { /* 上游已受理时，回读失败不回滚官方改名 */ }
  const verified = readbackName === inspection.proposed_name;
  const localResult = trySyncLocal(sync, accountId, inspection, deps);
  return {
    ...inspection,
    confirmed: true,
    upstream_changed: true,
    verified,
    readback_name: readbackName,
    ...localResult,
  };
}

module.exports = {
  ROLES,
  MAX_NAME_LENGTH,
  stripRolePrefix,
  buildRoleName,
  fetchRenameSource,
  liveMaterialAsRaw,
  inspectRename,
  executeRename,
  syncLocalName,
};
