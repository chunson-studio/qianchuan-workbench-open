const { sendJSON, readJsonBody, requireWriteAuth, handleApiError, checkBodyKeys } = require('../lib/utils');
const { validateAccount } = require('../lib/api-helpers');
const { inspectRename, executeRename } = require('../lib/materialRename');
const opLog = require('../lib/operationLog');

async function handleMaterialRename(req, res) {
  if (req.method !== 'POST') return sendJSON(res, { ok: false, error: 'Method Not Allowed' }, 405);
  if (!requireWriteAuth(req, res)) return;

  const { data, error } = await readJsonBody(req);
  if (error) return sendJSON(res, { ok: false, error: error.message }, error.status);
  const checked = checkBodyKeys(data, [
    'accountId', 'account_id', 'materialId', 'material_id', 'role', 'newName', 'new_name',
    'expectedCurrentName', 'expected_current_name', 'confirm', 'source',
  ], '/api/material/rename');
  if (!checked.ok) return sendJSON(res, { ok: false, error: checked.error }, 400);

  let accountId;
  try {
    accountId = validateAccount(data.accountId || data.account_id);
    const input = {
      materialId: data.materialId || data.material_id,
      role: data.role,
      newName: data.newName || data.new_name,
      expectedCurrentName: data.expectedCurrentName || data.expected_current_name,
    };
    if (data.confirm !== true) {
      const preview = await inspectRename(accountId, input);
      return sendJSON(res, {
        ok: true,
        confirmed: false,
        message: '改名预检完成；确认当前名称与新名称后，传 confirm=true 执行',
        ...preview,
      });
    }

    const result = await executeRename(accountId, input);
    opLog.log({
      action: 'rename_material',
      account_id: accountId,
      target_type: 'material',
      target_id: result.material_id,
      params: { from: result.current_name, to: result.proposed_name, role: result.role },
      result_code: 0,
      result_msg: result.verified ? '改名成功并回读确认' : '千川已受理，回读暂未更新',
      success: true,
      source: opLog.normalizeSource(data.source),
    });
    const partial = !result.verified || Boolean(result.local_sync_error);
    return sendJSON(res, {
      ok: true,
      message: result.local_sync_error
        ? '千川素材名称已修改，但本地历史名称同步失败；下一轮可重试同步'
        : result.verified ? '素材改名成功' : '素材改名已受理，千川列表可能短暂延迟',
      partial,
      ...result,
    });
  } catch (e) {
    if (data && data.confirm === true) {
      opLog.log({
        action: 'rename_material', account_id: accountId || null, target_type: 'material',
        target_id: String(data.materialId || data.material_id || ''),
        params: { to: data.newName || data.new_name || null, role: data.role || null },
        result_msg: e.message, success: false, source: opLog.normalizeSource(data.source),
      });
    }
    if (e && e.statusCode && e.statusCode < 500) {
      return sendJSON(res, { ok: false, error: e.message, code: e.code || 'material_rename_error' }, e.statusCode);
    }
    return handleApiError(res, e);
  }
}

module.exports = handleMaterialRename;
