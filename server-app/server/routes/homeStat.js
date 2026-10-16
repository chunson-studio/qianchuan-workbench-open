const { getHomeStat } = require('../lib/qianchuan');
const { sendJSON } = require('../lib/utils');

/**
 * GET /api/home-stat?account=xxx
 * 返回千川首页最近统计数据（消耗/ROI/成交等汇总）。
 *
 * 返回:
 *   - ok: 是否成功
 *   - account: 账号ID
 *   - stat: 统计数据
 *   - raw: 原始响应
 */
async function handleHomeStat(req, res, url) {
  if (req.method !== 'GET') return sendJSON(res, { error: 'Method Not Allowed' }, 405);

  const account = url ? url.searchParams.get('account') : null;

  try {
    const raw = await getHomeStat(account);
    const sc = raw && (raw.status_code ?? raw.code);
    if (sc != null && sc !== 0) {
      return sendJSON(res, { ok: false, error: `千川拒绝: code=${sc} msg=${raw.message || ''}`, raw }, 502);
    }
    return sendJSON(res, {
      ok: true,
      account: account || 'default',
      stat: (raw && raw.data) || null,
      raw,
    });
  } catch (e) {
    if (e.message === 'cookie_expired') return sendJSON(res, { ok: false, error: 'cookie_expired' }, 401);
    return sendJSON(res, { ok: false, error: e.message }, 500);
  }
}

module.exports = handleHomeStat;
