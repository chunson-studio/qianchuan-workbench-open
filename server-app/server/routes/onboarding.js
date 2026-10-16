'use strict';

const { readJsonBody, sendJSON } = require('../lib/utils');
const service = require('../lib/accountOnboarding');

function localAccess(req) {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress)) return false;
  try {
    const host = new URL('http://' + req.headers.host);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(host.hostname)) return false;
    if (req.headers.origin && new URL(req.headers.origin).origin !== host.origin) return false;
    if (req.headers['sec-fetch-site'] && !['none', 'same-origin'].includes(req.headers['sec-fetch-site'])) return false;
  } catch { return false; }
  return req.method === 'GET' || req.headers['x-qc-onboarding'] === '1';
}
async function handleOnboarding(req, res, url, options) {
  res.setHeader('Cache-Control', 'no-store');
  if (!localAccess(req)) return sendJSON(res, { ok: false, code: 'onboarding_local_only', error: '请从本机工作台访问接入配置，禁止跨站提交' }, 403);
  try {
    if (req.method === 'GET') return sendJSON(res, { ok: true, ...service.getStatus(url.searchParams.get('account_id') || null, options) });
    if (req.method !== 'POST') return sendJSON(res, { ok: false, code: 'method_not_allowed' }, 405);
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return sendJSON(res, { ok: false, code: 'json_required' }, 415);
    const parsed = await readJsonBody(req);
    if (parsed.error) return sendJSON(res, { ok: false, code: 'invalid_json', error: '请求不是有效 JSON' }, 400);
    const body = parsed.data;
    const allowed = {
      compass_import: ['action', 'account_id', 'cookie_json', 'room_id'],
      import: ['action', 'cookie_json', 'advertiser_id'], select: ['action', 'discovery_id', 'candidate_id', 'account_id'],
      draft: ['action', 'account_id', 'revision', 'answers', 'primary_ad_id'],
      rehearse: ['action', 'account_id'], save: ['action', 'account_id', 'revision', 'confirm'],
    }[body?.action];
    if (!allowed || Object.keys(body).some(key => !allowed.includes(key))) return sendJSON(res, { ok: false, code: 'invalid_onboarding_request', error: '请求包含不支持的操作或字段' }, 400);
    let result;
    if (body.action === 'import') result = await service.importCredential(body.cookie_json, { ...options, advertiser_id: body.advertiser_id });
    else if (body.action === 'compass_import') result = await service.importCompassCredential(body.account_id, body.cookie_json, { ...options, room_id: body.room_id });
    else if (body.action === 'select') result = await service.selectAccount(body, options);
    else if (body.action === 'draft') result = await service.updateDraft(body.account_id, body, options);
    else if (body.action === 'rehearse') result = await service.rehearse(body.account_id, options);
    else result = await service.save(body.account_id, body, options);
    return sendJSON(res, { ok: true, ...result });
  } catch (e) {
    const known = Number.isInteger(e.statusCode) && e.statusCode >= 400 && e.statusCode < 500;
    return sendJSON(res, { ok: false, code: known ? e.code : 'onboarding_failed',
      error: known ? e.message : '接入未完成，原配置已保留；请重试只读验证或检查本机配置权限' }, known ? e.statusCode : 503);
  }
}
module.exports = handleOnboarding;
module.exports.localAccess = localAccess;
