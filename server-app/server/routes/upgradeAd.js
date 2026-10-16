const { getUpgradeAd } = require('../lib/qianchuan');
const { sendJSON } = require('../lib/utils');

/**
 * GET /api/upgrade-ad?account=xxx
 * 查询当前账号是否有全域计划可升级为乘方计划。
 *
 * 返回:
 *   - ok: 是否成功
 *   - account: 账号ID
 *   - upgrade_info: 升级乘方信息
 *   - raw: 原始响应
 */
async function handleUpgradeAd(req, res, url) {
  if (req.method !== 'GET') return sendJSON(res, { error: 'Method Not Allowed' }, 405);

  const account = url ? url.searchParams.get('account') : null;

  try {
    const raw = await getUpgradeAd(account);
    const sc = raw && (raw.status_code ?? raw.code);
    if (sc != null && sc !== 0) {
      return sendJSON(res, { ok: false, error: `千川拒绝: code=${sc} msg=${raw.message || ''}`, raw }, 502);
    }
    return sendJSON(res, {
      ok: true,
      account: account || 'default',
      upgrade_info: (raw && raw.data) || null,
      raw,
    });
  } catch (e) {
    if (e.message === 'cookie_expired') return sendJSON(res, { ok: false, error: 'cookie_expired' }, 401);
    return sendJSON(res, { ok: false, error: e.message }, 500);
  }
}

module.exports = handleUpgradeAd;
