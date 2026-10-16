'use strict';
const { sendJSON } = require('../lib/utils');
const { queryReports } = require('../lib/offlineReports');
// HTTP/MCP仅查询；导入由本机显式CLI完成，不开放任意服务器文件读取。
async function handleOfflineReports(req, res, url) {
  if (req.method !== 'GET') return sendJSON(res, { ok: false, code: 'method_not_allowed' }, 405);
  try {
    const allowed = ['account', 'mode', 'report_id', 'scope', 'entity_id', 'start', 'end', 'limit', 'offset', 'include_raw'];
    if ([...url.searchParams.keys()].some(key => !allowed.includes(key))) return sendJSON(res, { ok: false, code: 'unknown_parameter' }, 400);
    const options = Object.fromEntries(url.searchParams);
    options.account_id = options.account;
    options.include_raw = options.include_raw === '1';
    return sendJSON(res, queryReports(options));
  } catch (error) {
    return sendJSON(res, { ok: false, code: error.code || 'offline_report_unavailable', component: 'offline_reports', retryable: false, error: error.message }, error.statusCode || 500);
  }
}
module.exports = handleOfflineReports;
