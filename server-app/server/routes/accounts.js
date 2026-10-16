// 账号注册表接口：前端可安全地增删/恢复账号；绝不返回 Cookie 内容。
const { sendJSON, readJsonBody, checkBodyKeys } = require('../lib/utils');
const { QIANCHUAN_ACCOUNTS, account_config, UI_FEATURES } = require('../lib/config');
const {
  createAccount,
  restoreAccount,
  listArchivedAccounts,
  persistPreflight,
  persistDiscoveredFields,
} = require('../lib/accountRegistry');
const { deleteAccountPermanently } = require('../lib/accountDelete');
const { discoverAccount } = require('../lib/accountDiscovery');
const { preflightAccount } = require('../lib/accountPreflight');
const { cancelAccountQueue } = require('../lib/qianchuan');
const { evictAccountRuntime } = require('../lib/liveCollector');

function publicAccount(account) {
  const ownConfig = account_config && account_config[account.id];
  const breakEven = Number(ownConfig && ownConfig.break_even_roi);
  return {
    id: account.id,
    name: account.name,
    aavid: account.aavid,
    break_even_roi: Number.isFinite(breakEven) && breakEven > 0 ? breakEven : null,
    threshold_source: ownConfig && ownConfig.break_even_roi != null ? 'account_config' : 'unconfigured',
    video_library_url: `https://qianchuan.jinritemai.com/tools/creative-management/video-library?aavid=${account.aavid}&x_tt_random=${Date.now()}`,
  };
}

function sendRegistryError(res, error) {
  const status = Number.isInteger(error && error.statusCode) ? error.statusCode : 500;
  return sendJSON(res, {
    ok: false,
    error: error && error.message ? error.message : '账号管理失败',
    code: error && error.code ? error.code : 'account_registry_failed',
    component: 'account_registry',
    retryable: status >= 500,
  }, status);
}

function isLoopbackRequest(req) {
  const address = req && req.socket && req.socket.remoteAddress;
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/**
 * GET /api/accounts
 *   返回当前可切换的安全账号元数据及历史已移出账号摘要。
 * POST /api/accounts/discover
 *   只接受 Cookie，返回短时内存中的账户候选。
 * POST /api/accounts
 *   创建账号；兼容旧版本 action=restore 的恢复入口。
 * DELETE /api/accounts
 *   永久删除账号。必须由新 UI 显式传 action=delete + confirm=true；同时清理账号注册、Cookie、Profile、接入草稿和可识别的账号运行文件。
 */
async function handleAccountDiscover(req, res) {
  if (req.method !== 'POST') return sendJSON(res, { ok: false, error: 'Method Not Allowed', code: 'method_not_allowed' }, 405);
  if (!isLoopbackRequest(req)) return sendJSON(res, { ok: false, error: 'Cookie 仅允许从本机 127.0.0.1 提交', code: 'cookie_local_only' }, 403);
  const parsed = await readJsonBody(req);
  if (parsed.error) return sendJSON(res, { ok: false, error: parsed.error.message, code: 'invalid_json' }, parsed.error.status);
  const body = parsed.data || {};
  const keys = checkBodyKeys(body, ['cookie'], '/api/accounts/discover');
  if (!keys.ok) return sendJSON(res, { ok: false, error: keys.error, code: 'unknown_parameter' }, 400);
  try {
    return sendJSON(res, { ok: true, ...(await discoverAccount(body.cookie)) });
  } catch (error) {
    return sendRegistryError(res, error);
  }
}

async function handleAccountPreflight(req, res, accountId) {
  if (req.method !== 'POST') return sendJSON(res, { ok: false, error: 'Method Not Allowed', code: 'method_not_allowed' }, 405);
  if (!isLoopbackRequest(req)) return sendJSON(res, { ok: false, error: '账号预检仅允许从本机 127.0.0.1 访问', code: 'local_only' }, 403);
  const parsed = await readJsonBody(req);
  if (parsed.error) return sendJSON(res, { ok: false, error: parsed.error.message, code: 'invalid_json' }, parsed.error.status);
  const keys = checkBodyKeys(parsed.data || {}, [], `/api/accounts/${accountId}/preflight`);
  if (!keys.ok) return sendJSON(res, { ok: false, error: keys.error, code: 'unknown_parameter' }, 400);
  try {
    return sendJSON(res, { ok: true, ...(await preflightAccount(accountId, {
      persistDiscovered: persistDiscoveredFields,
      persistCapabilities: persistPreflight,
    })) });
  } catch (error) {
    return sendRegistryError(res, error);
  }
}

async function handleAccounts(req, res) {
  if (req.method === 'GET') {
    try {
      const accounts = (QIANCHUAN_ACCOUNTS || []).map(publicAccount);
      return sendJSON(res, { ok: true, accounts, archived_accounts: listArchivedAccounts(), ui_features: UI_FEATURES });
    } catch (error) {
      return sendRegistryError(res, error);
    }
  }

  if (!['POST', 'DELETE'].includes(req.method)) {
    return sendJSON(res, { ok: false, error: 'Method Not Allowed', code: 'method_not_allowed' }, 405);
  }
  if (!isLoopbackRequest(req)) return sendJSON(res, { ok: false, error: '账号管理仅允许从本机 127.0.0.1 访问', code: 'local_only' }, 403);

  const parsed = await readJsonBody(req);
  if (parsed.error) {
    return sendJSON(res, { ok: false, error: parsed.error.message, code: 'invalid_json' }, parsed.error.status);
  }
  const body = parsed.data || {};
  const allowed = req.method === 'DELETE'
    ? ['id', 'confirm', 'permanent', 'action']
    : ['action', 'discovery_id', 'candidate_id', 'id', 'confirm', 'permanent'];
  const keys = checkBodyKeys(body, allowed, '/api/accounts');
  if (!keys.ok) return sendJSON(res, { ok: false, error: keys.error, code: 'unknown_parameter' }, 400);

  try {
    let result;
    if (req.method === 'DELETE') {
      if (body.action !== 'delete') {
        return sendJSON(res, { ok: false, error: '请使用新版账号管理界面确认删除', code: 'delete_confirmation_ui_required' }, 409);
      }
      result = await deleteAccountPermanently({ ...body, confirm: body.confirm === true }, {
        beforeDelete: async id => {
          await evictAccountRuntime(id);
          cancelAccountQueue(id);
        },
      });
    } else if (body.action === 'restore') {
      result = await restoreAccount(body);
    } else if (!body.action || body.action === 'create') {
      result = await createAccount(body);
    } else {
      return sendJSON(res, { ok: false, error: '账号操作类型无效，仅支持创建账号或兼容恢复旧账号', code: 'invalid_action' }, 400);
    }

    return sendJSON(res, {
      ok: true,
      ...result,
      accounts: (QIANCHUAN_ACCOUNTS || []).map(publicAccount),
      archived_accounts: listArchivedAccounts(),
      ui_features: UI_FEATURES,
    });
  } catch (error) {
    return sendRegistryError(res, error);
  }
}

module.exports = handleAccounts;
module.exports.handleAccountDiscover = handleAccountDiscover;
module.exports.handleAccountPreflight = handleAccountPreflight;
