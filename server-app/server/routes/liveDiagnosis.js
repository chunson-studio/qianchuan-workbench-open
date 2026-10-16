const { getLiveDiagnosis } = require('../lib/qianchuan');
const { sendJSON, readJsonBody, handleApiError } = require('../lib/utils');

/**
 * POST /api/live-diagnosis
 * 直播间投放诊断。
 *
 * Body（可选，不传则空对象）:
 *   - ad_id: 计划ID
 *   - room_id: 直播间ID
 *   - 其他千川诊断接口所需的参数
 *
 * 返回:
 *   - ok: 是否成功
 *   - diagnosis: 诊断结果
 *   - raw: 原始响应
 */
async function handleLiveDiagnosis(req, res, url) {
  if (req.method !== 'POST') return sendJSON(res, { error: 'Method Not Allowed' }, 405);

  const account = url ? url.searchParams.get('account') : null;

  const { data, error } = await readJsonBody(req);
  if (error) return sendJSON(res, { error: error.message }, error.status);

  try {
    const raw = await getLiveDiagnosis(data, account);
    const sc = raw && (raw.status_code ?? raw.code);
    if (sc != null && sc !== 0) {
      return sendJSON(res, { ok: false, error: `千川拒绝: code=${sc} msg=${raw.message || ''}`, raw }, 502);
    }
    return sendJSON(res, {
      ok: true,
      account: account || 'default',
      diagnosis: (raw && raw.data) || null,
      raw,
    });
  } catch (e) {
    return handleApiError(res, e);
  }
}

module.exports = handleLiveDiagnosis;
