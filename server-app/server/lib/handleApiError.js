/**
 * 统一的 API 错误处理工具。
 *
 * 用于路由层统一处理 cookie_expired / cookie_not_found / 千川错误码等，
 * 避免各路由重复相同的 catch 逻辑。
 *
 * 用法:
 *   try { ... } catch (e) { return handleApiError(res, e); }
 *   或
 *   .catch(e => handleApiError(res, e))
 */

const { sendJSON } = require('./utils');

function handleApiError(res, e) {
  // headers 已发送则无法再返回错误状态码
  if (res.headersSent) return;
  const message = e && e.message ? e.message : 'internal_server_error';
  let code = e && e.code ? e.code : 'internal_server_error';
  if (/SQLITE_BUSY|database is locked/i.test(message)) code = 'db_busy';
  if (message === 'cookie_expired' || message === 'cookie_not_found') code = 'cookie_expired';
  if (message.startsWith('parse_error')) code = 'upstream_parse_error';
  const statusByCode = {
    cookie_expired: 401,
    upstream_bad_request: 400,
    upstream_locked: 423,
    rate_limited: 429,
    db_busy: 503,
    upstream_unavailable: 502,
    upstream_parse_error: 502,
    upstream_bad_response: 502,
    board_partial: 502,
    board_data_invalid: 502,
    upstream_timeout: 504,
    queue_timeout: 504,
    request_timeout: 504,
    collector_board_timeout: 504,
    collector_intraday_timeout: 504,
    request_cancelled: 504,
  };
  const status = statusByCode[code] || (e && e.statusCode) || 500;
  const exposeMessage = status < 500 || status === 502 || status === 503 || status === 504;
  const body = {
    ok: false,
    error: exposeMessage ? message : 'internal_server_error',
    code,
    component: (e && e.component) || (code === 'db_busy' ? 'sqlite' : 'http'),
    retryable: e && e.retryable != null
      ? e.retryable === true
      : ['db_busy', 'upstream_unavailable', 'upstream_timeout', 'queue_timeout', 'request_timeout'].includes(code),
    timeout_ms: (e && e.timeoutMs) || null,
    partial: false,
    errors: (e && e.errors) || [],
  };
  if (e && e.next_allowed_at) body.next_allowed_at = e.next_allowed_at;
  if (e && e.details) body.details = e.details;
  if (e?.advertising_writes === 0) { body.advertising_writes = 0; body.effect_status = 'rejected'; }
  if (status !== 500) return sendJSON(res, body, status);
  // 内部错误不暴露详细信息给客户端，仅在服务端日志记录
  console.error('[API Error]', e && e.stack ? e.stack : e);
  return sendJSON(res, body, 500);
}

module.exports = { handleApiError };
