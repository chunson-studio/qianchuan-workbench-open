const { deleteMaterial, checkMaterialDeleteNotice } = require('../lib/qianchuan');
const { sendJSON, readJsonBody, requireWriteAuth, handleApiError, checkBodyKeys } = require('../lib/utils');
const { describeResult } = require('../lib/qcErrors');
const opLog = require('../lib/operationLog');
const config = require('../lib/config');

/**
 * POST /api/material/delete
 *
 * 删除全域投放计划下的素材。
 *
 * ⚠️ 不可逆操作！必须二次确认！
 *
 * 两步操作模式：
 *   1. 不传 confirm=true → 只做预检查，返回素材信息供确认
 *   2. 传 confirm=true → 执行实际删除
 *
 * Body:
 *   {
 *     adId: "<PRIMARY_AD_ID>",           // 全域计划ID
 *     objectId: "<ANCHOR_ID>",            // 主播ID（anchor_id，预检查需要）
 *     legoMids: ["<MATERIAL_ID>"],        // 素材ID列表
 *     vids: ["<VIDEO_ID>"],               // 视频ID列表（可选，与legoMids对应）
 *     accountId: "<ACCOUNT_ID>",          // 账号
 *     confirm: true                       // ⚠️ 二次确认，true才执行删除
 *   }
 *
 * 安全边界：
 *   - confirm 不传或不为 true → 只返回预检查结果，不删除
 *   - 每次调用都写操作日志（包括预检查）
 *   - 单次最多删除10个素材（防止误批量删）
 */
async function handleMaterialDelete(req, res, url) {
  if (req.method !== 'POST') return sendJSON(res, { ok: false, error: 'Method Not Allowed' }, 405);
  if (!requireWriteAuth(req, res)) return;

  const { data, error } = await readJsonBody(req);
  if (error) return sendJSON(res, { ok: false, error: error.message }, error.status);
  // body 参数白名单（2026-08-11 backlog 检修）
  const bodyCheck = checkBodyKeys(data, ['accountId', 'adId', 'objectId', 'legoMids', 'vids', 'confirm', 'source'], '/api/material/delete');
  if (!bodyCheck.ok) return sendJSON(res, { ok: false, error: bodyCheck.error }, 400);
  const { adId, objectId, legoMids, vids, accountId: accountIdCamel, account_id: accountIdSnake, confirm } = data;
  const accountId = accountIdCamel || accountIdSnake; // MCP 工具面参数名 account_id（下划线），双收兼容（2026-08-11 修复）

  // 参数校验
  if (!accountId) return sendJSON(res, { ok: false, error: 'Missing accountId' }, 400);
  // 账号白名单：拼错账号绝不落到默认 cookie 执行不可逆删除（2026-07-29 审计修复漏网写路由）
  const { validateAccount } = require('../lib/api-helpers');
  try { validateAccount(accountId); } catch (e) {
    return sendJSON(res, { ok: false, error: e.message + '（合法账号见 config.qianchuan_accounts）' }, 400);
  }
  if (!adId) return sendJSON(res, { ok: false, error: 'Missing adId (全域计划ID)' }, 400);
  if (!legoMids || !Array.isArray(legoMids) || legoMids.length === 0) {
    return sendJSON(res, { ok: false, error: 'Missing legoMids (素材ID列表)' }, 400);
  }
  if (legoMids.length > 10) {
    return sendJSON(res, { ok: false, error: '单次最多删除10个素材（安全限制）' }, 400);
  }
  if (!legoMids.every(id => /^\d{1,30}$/.test(String(id)))) {
    return sendJSON(res, { ok: false, error: 'legoMids 元素必须为数字字符串' }, 400);
  }

  try {
    // Step 1: 预检查（仅 confirm=false 时做；confirm=true 时跳过，agent 已带数据支撑，2026-07-28 用户确认）
    let noticeResult = null;
    if (confirm !== true && objectId) {
      noticeResult = await checkMaterialDeleteNotice(objectId, legoMids, accountId).catch(e => {
        console.log(`[material-delete] 预检查失败: ${e.message}`);
        return null;
      });
    }

    // Step 2: 如果没有 confirm=true，只返回预检查结果
    if (confirm !== true) {
      return sendJSON(res, {
        ok: true,
        confirmed: false,
        message: '预检查完成，请确认后传 confirm=true 执行删除',
        ad_id: adId,
        lego_mids: legoMids,
        notice: noticeResult && noticeResult.data ? noticeResult.data.uniPormMaterialDeleteNoticeInfos : null,
      });
    }

    // Step 3: 执行实际删除（confirm=true 时跳过预检查，直接删除）
    // 频率熔断（2026-08-11 审查修复：删除类操作对齐 AGENTS.md"改/删同纪律"——同账号 1h 成功删除 ≥3 次 → 429）
    const recentLogs = opLog.query({ accountId, action: 'delete_material', limit: 50 });
    const now = Date.now();
    const recentOps = recentLogs.filter(l => (now - new Date(l.ts).getTime()) < 3600000 && l.success);
    if (recentOps.length >= 3) {
      const nextAllowed = new Date(new Date(recentOps[recentOps.length - 1].ts).getTime() + 3600000).toISOString();
      opLog.log({ action: 'delete_material_blocked', account_id: accountId, primary_ad_id: adId, target_type: 'material', target_id: legoMids.join(','), params: { legoMids, vids, confirm: true }, result_msg: '1h 删除频率熔断拦截', success: false, source: opLog.normalizeSource(data.source) });
      return sendJSON(res, { ok: false, error: `操作频率过高：账号 ${accountId} 1小时内已删除素材 ${recentOps.length} 次（上次：${recentOps[0].ts}）。请等待后再试`, blocked: true, rule: 'material_delete_rate_limit', next_allowed_at: nextAllowed }, 429);
    }
    // 幂等（2026-08-17 升级，对齐 create 幂等）：5 分钟内同 legoMids 组合已成功删除 → 409
    // 8-11 事故：同素材 13 分钟连删 3 次（agent 重复执行），1h 熔断只挡第 4 次，补素材级幂等闸
    const dupDelete = recentLogs.find(l => l.success && (now - new Date(l.ts).getTime()) < 300000 && String(l.target_id || '') === legoMids.join(','));
    if (dupDelete) {
      opLog.log({ action: 'delete_material_blocked', account_id: accountId, primary_ad_id: adId, target_type: 'material', target_id: legoMids.join(','), params: { legoMids, vids, confirm: true, rule: 'material_delete_idempotent' }, result_msg: '5min 同素材重复删除幂等拦截', success: false, source: opLog.normalizeSource(data.source) });
      return sendJSON(res, { ok: false, error: `重复删除拦截：5 分钟内已成功删除相同素材组合（${dupDelete.ts}）。删除幂等，素材已在删除流程，请勿重复操作`, blocked: true, rule: 'material_delete_idempotent' }, 409);
    }
    const result = await deleteMaterial(adId, legoMids, vids, accountId);
    const sc = result && (result.status_code ?? result.code);
    const success = sc == null || sc === 0;

    // 写删除日志
    opLog.log({
      action: 'delete_material',
      account_id: accountId,
      primary_ad_id: adId,
      target_type: 'material',
      target_id: legoMids.join(','),
      params: { legoMids, vids, confirm: true },
      result_code: sc,
      result_msg: success ? null : describeResult(result),
      success,
      source: opLog.normalizeSource(data.source), // 决策来源归因：K3/回环带 'agent'，其余视为投手
    });

    if (!success) {
      return sendJSON(res, { ok: false, error: describeResult(result) || `千川拒绝 code=${sc}`, result }, 502);
    }

    // 历史账户专用说明已从试用包移除。
    // 复核口径 = 移出在投列表（status=1）即删除生效；视频库文件/暂停历史记录属存储层残留，不算失败。
    let verified = null;
    try {
      await new Promise(r => setTimeout(r, 10000));
      const today = new Date().toISOString().slice(0, 10);
      const todayCST = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
      // 2026-08-11 修复：config.port 不存在（正确字段是 config.PORT），且复核需强制刷新 + 覆盖全部在投素材
      const checkRes = await fetch(`http://127.0.0.1:${config.PORT}/api/materials/live?account=${encodeURIComponent(accountId)}&startDate=${todayCST}&endDate=${todayCST}&status=1&pageSize=200&refresh=1`);
      const checkJson = await checkRes.json().catch(() => ({}));
      const stillLive = (checkJson.rows || []).filter(m => legoMids.includes(String(m.material_id))).map(m => String(m.material_id));
      verified = stillLive.length ? { ok: false, still: stillLive } : { ok: true };
    } catch (e) {
      verified = { ok: false, error: `复核异常: ${e.message}` };
    }

    const verifiedMsg = verified && verified.ok === true
      ? '已移出在投列表'
      : `复核未确认（${(verified && (verified.still || verified.error)) || '未知'}），千川可能延迟`;

    return sendJSON(res, {
      ok: true,
      confirmed: true,
      message: `已移除 ${legoMids.length} 个素材（${verifiedMsg}）`,
      ad_id: adId,
      deleted_mids: legoMids,
    });
  } catch (e) {
    opLog.log({
      action: 'delete_material',
      account_id: accountId,
      primary_ad_id: adId,
      target_type: 'material',
      target_id: legoMids.join(','),
      params: { legoMids, vids },
      success: false,
      source: opLog.normalizeSource(data.source),
      result_msg: e.message,
    });
    return handleApiError(res, e);
  }
}

module.exports = handleMaterialDelete;
