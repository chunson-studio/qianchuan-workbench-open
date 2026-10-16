const { addUniPromMaterials, checkAdMaterialUsage } = require('../lib/qianchuan');
const { fetchRawByMaterialId } = require('../lib/creativeVideoLibrary');
const { sendJSON, readJsonBody, requireWriteAuth, handleApiError, checkBodyKeys } = require('../lib/utils');
const { describeResult } = require('../lib/qcErrors');
const opLog = require('../lib/operationLog');

// 写操作熔断常量（对齐 AGENTS.md / campaignOps 规范）
const FREQUENCY_LIMIT_MS = 60 * 60 * 1000; // 1小时内
const FREQUENCY_LIMIT_COUNT = 3;            // 同一计划1小时内≥3次成功添加→拦截429
const MAX_MATERIALS_PER_CALL = 10;          // 单次最多添加10条（与删除对齐，防误批量）

// 写操作串行锁（与 campaignOps 同思路：防并发请求绕过熔断计数）
const writeLocks = new Map(); // adId -> Promise
function withWriteLock(targetId, fn) {
  const prev = writeLocks.get(targetId) || Promise.resolve();
  let release;
  const current = new Promise(r => { release = r; });
  writeLocks.set(targetId, current);
  return prev.then(() => fn()).finally(() => {
    release();
    if (writeLocks.get(targetId) === current) writeLocks.delete(targetId);
  });
}

/**
 * video-list 原始条目 → add-uni-prom-materials 的 videoMaterial 对象。
 * 字段映射 2026-08-02 探针实测（references/qianchuan-add-material-api.md）。
 */
function buildVideoMaterial(raw, productId) {
  const coverWebUrl = raw.imageUrl && ((raw.imageUrl.urlList && raw.imageUrl.urlList[0]) || raw.imageUrl.url);
  const coverWebUri = raw.imageUrl && raw.imageUrl.uri;
  let teaUri = raw.videoUrl && ((raw.videoUrl.urlList && raw.videoUrl.urlList[0]) || raw.videoUrl.uri);
  if (teaUri) {
    teaUri = teaUri.replace(/^https?:\/\//, '');
  }
  return {
    coverImage: { webUrl: coverWebUrl || '', webUri: coverWebUri || '', width: raw.width, height: raw.height },
    videoId: raw.itemId,
    imageMode: raw.imageMode,
    materialID: String(raw.materialId),
    productId: String(productId),
    teaParams: { uri: teaUri || '' },
  };
}

/**
 * POST /api/material/add
 *
 * 给全域计划从视频库添加素材（逆向自千川创意管理"从视频库添加"，2026-08-02 探针）。
 * 可逆操作（加错可删），单步执行；全程 op-log + 频率熔断 + 在投去重预检。
 *
 * Body:
 *   {
  * 历史账户专用说明已从试用包移除。
 *     adId: "EXAMPLE_ID",           // 全域计划ID（必填）
 *     productId: "EXAMPLE_ID",   // 商品ID（必填）
 *     materialIds: ["EXAMPLE_ID"]// 素材ID列表（必填，≤10）
 *   }
 *
 * 安全边界：
 *   - 账号白名单 validateAccount，拼错账号 400
 *   - 素材ID逐条现查 video-list（签名 URL 现拉现用），查不到→400 invalid_mids 不执行
 *   - check-ad-material-usage 预检：已在计划里的素材跳过（skipped_in_use），不重复添加
 *   - 同一计划1小时内≥3次成功添加→429（带 next_allowed_at）
 *   - 每次调用写 op-log（含失败）
 */
async function handleMaterialAdd(req, res, url) {
  if (req.method !== 'POST') return sendJSON(res, { ok: false, error: 'Method Not Allowed' }, 405);
  if (!requireWriteAuth(req, res)) return;

  const { data, error } = await readJsonBody(req);
  if (error) return sendJSON(res, { ok: false, error: error.message }, error.status);
  // body 参数白名单（2026-08-11 backlog 检修）
  const bodyCheck = checkBodyKeys(data, ['accountId', 'adId', 'productId', 'materialIds', 'source'], '/api/material/add');
  if (!bodyCheck.ok) return sendJSON(res, { ok: false, error: bodyCheck.error }, 400);

  const { adId, productId, materialIds, accountId: accountIdCamel, account_id: accountIdSnake } = data;
  const accountId = accountIdCamel || accountIdSnake; // MCP 工具面参数名 account_id（下划线），双收兼容（2026-08-11 修复）

  // 参数校验
  if (!accountId) return sendJSON(res, { ok: false, error: 'Missing accountId' }, 400);
  try { require('../lib/api-helpers').validateAccount(accountId); } catch (e) {
    return sendJSON(res, { ok: false, error: e.message + '（合法账号见 config.qianchuan_accounts）' }, 400);
  }
  if (!adId || !/^\d{1,30}$/.test(String(adId))) {
    return sendJSON(res, { ok: false, error: 'Missing/非法 adId (全域计划ID，数字字符串)' }, 400);
  }
  const targetProductId = productId;
  if (!targetProductId || targetProductId === '0') {
    return sendJSON(res, { ok: false, error: 'Missing productId；私有试用包不提供任何账户商品兜底值' }, 400);
  }
  if (!targetProductId || !/^\d{1,30}$/.test(String(targetProductId))) {
    return sendJSON(res, { ok: false, error: 'Missing/非法 productId (商品ID，数字字符串)' }, 400);
  }
  if (!Array.isArray(materialIds) || materialIds.length === 0) {
    return sendJSON(res, { ok: false, error: 'Missing materialIds (素材ID列表)' }, 400);
  }
  if (materialIds.length > MAX_MATERIALS_PER_CALL) {
    return sendJSON(res, { ok: false, error: `单次最多添加${MAX_MATERIALS_PER_CALL}条素材（安全限制）` }, 400);
  }
  if (!materialIds.every(id => /^\d{1,30}$/.test(String(id)))) {
    return sendJSON(res, { ok: false, error: 'materialIds 元素必须为数字字符串' }, 400);
  }

  try {
    const outcome = await withWriteLock(String(adId), async () => {
      // ===== 频率熔断：同一计划1小时内≥3次成功添加 → 拦截429 =====
      const recentLogs = opLog.query({ adId: String(adId), accountId, limit: 50 });
      const now = Date.now();
      const recentOps = recentLogs.filter(l =>
        l.action === 'add_material' && l.success && (now - new Date(l.ts).getTime()) < FREQUENCY_LIMIT_MS
      );
      if (recentOps.length >= FREQUENCY_LIMIT_COUNT) {
        const err = new Error(`操作频率过高：计划 ${adId} 1小时内已添加 ${recentOps.length} 次（上次：${recentOps[0].ts}）。请等待后再试`);
        err.statusCode = 429;
        err.next_allowed_at = new Date(new Date(recentOps[recentOps.length - 1].ts).getTime() + FREQUENCY_LIMIT_MS).toISOString();
        err.skipOpLog = true;
        throw err;
      }

      // ===== 素材逐条现查 video-list（签名 URL 现拉现用）=====
      const raws = [];
      const invalidMids = [];
      for (const mid of materialIds) {
        const raw = await fetchRawByMaterialId(accountId, mid).catch(() => null);
        if (raw) raws.push(raw); else invalidMids.push(String(mid));
      }
      if (invalidMids.length > 0) {
        const err = new Error(`素材ID在视频库查不到（幻觉ID或不属于本账号）：${invalidMids.join(', ')}`);
        err.statusCode = 400;
        err.invalidMids = invalidMids;
        err.opLogMsg = `预检不存在 ${invalidMids.join(',')}`;
        throw err;
      }

      // ===== 在投去重预检：已在计划里的素材跳过 =====
      const videoIds = raws.map(r => String(r.itemId));
      const usage = await checkAdMaterialUsage(adId, targetProductId, videoIds, accountId);
      const inUseMap = (usage && usage.data && usage.data.inUseMaterialMap) || {};
      const toAdd = raws.filter(r => !inUseMap[String(r.itemId)]);
      const skippedInUse = raws.filter(r => inUseMap[String(r.itemId)]).map(r => String(r.materialId));

      if (toAdd.length === 0) {
        return { addedMids: [], skippedInUse, result: null, allInUse: true };
      }

      const videoMaterials = toAdd.map(r => buildVideoMaterial(r, targetProductId));
      const bad = videoMaterials.filter(v => !v.coverImage.webUrl || !v.coverImage.webUri || !v.teaParams.uri);
      if (bad.length > 0) {
        const err = new Error(`素材对象缺签名 URL（video-list 未返回 imageUrl/videoUrl）：${bad.map(v => v.materialID).join(', ')}`);
        err.statusCode = 502;
        throw err;
      }

      const result = await addUniPromMaterials(adId, productId, videoMaterials, accountId);
      return { addedMids: toAdd.map(r => String(r.materialId)), skippedInUse, result, allInUse: false };
    });

    const { addedMids, skippedInUse, result, allInUse } = outcome;

    if (allInUse) {
      opLog.log({
        action: 'add_material',
        account_id: accountId,
        primary_ad_id: String(adId),
        target_type: 'material',
        target_id: materialIds.join(','),
        params: { adId, productId, materialIds },
        success: true,
        result_msg: '全部素材已在计划里，跳过添加',
        source: opLog.normalizeSource(data.source),
      });
      return sendJSON(res, { ok: true, added_mids: [], skipped_in_use: skippedInUse, message: '全部素材已在计划里，跳过添加' });
    }

    const sc = result && (result.status_code ?? result.code);
    const success = sc == null || sc === 0;

    opLog.log({
      action: 'add_material',
      account_id: accountId,
      primary_ad_id: String(adId),
      target_type: 'material',
      target_id: addedMids.join(','),
      params: { adId, productId, materialIds, skipped_in_use: skippedInUse },
      result_code: sc,
      result_msg: success ? null : describeResult(result),
      success,
      source: opLog.normalizeSource(data.source),
    });

    if (!success) {
      return sendJSON(res, { ok: false, error: describeResult(result) || `千川拒绝 code=${sc}`, result }, 502);
    }

    return sendJSON(res, {
      ok: true,
      message: `已添加 ${addedMids.length} 条素材` + (skippedInUse.length ? `，${skippedInUse.length} 条已在计划中跳过` : ''),
      ad_id: String(adId),
      added_mids: addedMids,
      skipped_in_use: skippedInUse,
    });
  } catch (e) {
    if (!e.skipOpLog) {
      opLog.log({
        action: 'add_material',
        account_id: accountId,
        primary_ad_id: String(adId),
        target_type: 'material',
        target_id: (materialIds || []).join(','),
        params: { adId, productId, materialIds },
        success: false,
        result_msg: e.opLogMsg || e.message,
        source: opLog.normalizeSource(data.source),
      });
    }
    if (e.invalidMids) {
      return sendJSON(res, { ok: false, error: e.message, invalid_mids: e.invalidMids, rule: 'add_mid_precheck' }, 400);
    }
    return handleApiError(res, e);
  }
}

module.exports = handleMaterialAdd;
