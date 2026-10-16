'use strict';

const { sendJSON, requireLocalRecordAuth } = require('../lib/utils');
const { validateAccount, resolveAccountOrThrow } = require('../lib/api-helpers');
const { ingestBrowserSnapshot, getBrowserSnapshot } = require('../lib/browserSnapshotStore');

const MAX_BODY_BYTES = 256 * 1024;

function readBoundedJson(req) {
  return new Promise(resolve => {
    let size = 0;
    const chunks = [];
    let settled = false;
    const finish = value => { if (!settled) { settled = true; resolve(value); } };
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        finish({ error: { status: 413, code: 'body_too_large', message: '请求体超过256KB' } });
        req.resume();
      } else chunks.push(chunk);
    });
    req.on('error', error => finish({ error: { status: 400, code: 'request_error', message: error.message } }));
    req.on('end', () => {
      if (size > MAX_BODY_BYTES) return;
      if (!size) return finish({ error: { status: 400, code: 'invalid_json', message: '请求体不能为空' } });
      try { finish({ data: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
      catch { finish({ error: { status: 400, code: 'invalid_json', message: '请求体不是有效JSON' } }); }
    });
  });
}

function accountFrom(values) {
  const present = values.filter(value => value != null && value !== '');
  const account = validateAccount(present[0]);
  if (present.some(value => String(value) !== account)) {
    throw Object.assign(new Error('账户参数不一致'), { code: 'account_conflict', statusCode: 400 });
  }
  return account;
}

function assertCaptureAccountMapping(account, capture, resolveAccount = resolveAccountOrThrow) {
  if (!capture || typeof capture !== 'object' || Array.isArray(capture)) {
    throw Object.assign(new Error('capture必须是对象'), { code: 'invalid_browser_capture', statusCode: 400 });
  }
  const binding = capture.binding;
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)
    || String(binding.account_id || '') !== String(account)) {
    throw Object.assign(new Error('capture本机账户与请求账户不一致'), { code: 'account_conflict', statusCode: 400 });
  }
  const accountClaims = [
    binding.accountId, binding.account,
    capture.account_id, capture.accountId, capture.account,
    capture.metadata?.account_id, capture.metadata?.accountId,
    capture.page?.account_id, capture.page?.accountId, capture.page?.account,
  ].filter(value => value != null && value !== '');
  if (accountClaims.some(value => String(value) !== String(account))) {
    throw Object.assign(new Error('capture本机账户声明不一致'), { code: 'account_conflict', statusCode: 400 });
  }
  const advertiserId = String(binding.advertiser_id || '');
  if (!advertiserId) throw Object.assign(new Error('capture缺少平台账户advertiser_id'), { code: 'advertiser_required', statusCode: 400 });
  const registered = resolveAccount(account);
  if (!registered || !registered.aavid || String(registered.aavid) !== advertiserId) {
    throw Object.assign(new Error('capture平台账户与本机注册账户不一致'), { code: 'advertiser_mismatch', statusCode: 400 });
  }
  return advertiserId;
}

async function handleBrowserSnapshot(req, res, url) {
  try {
    if (req.method === 'POST') {
      if (!requireLocalRecordAuth(req, res)) return;
      const parsed = await readBoundedJson(req);
      if (parsed.error) return sendJSON(res, { ok: false, ...parsed.error }, parsed.error.status);
      const body = parsed.data;
      if (!body || typeof body !== 'object' || Array.isArray(body) || !body.capture || typeof body.capture !== 'object' || Array.isArray(body.capture)) {
        return sendJSON(res, { ok: false, code: 'invalid_browser_capture', error: '需要 {account_id,capture}' }, 400);
      }
      const account = accountFrom([
        ...url.searchParams.getAll('account'), ...url.searchParams.getAll('accountId'),
        body.account_id, body.accountId, body.capture.binding?.account_id,
        body.capture.binding?.accountId, body.capture.binding?.account,
        body.capture.account_id, body.capture.accountId, body.capture.account,
        body.capture.metadata?.account_id,
        body.capture.metadata?.accountId, body.capture.page?.account_id,
        body.capture.page?.accountId, body.capture.page?.account,
      ]);
      const advertiserId = assertCaptureAccountMapping(account, body.capture);
      const result = ingestBrowserSnapshot(body.capture, { expectedAccount: account, expectedAdvertiserId: advertiserId });
      const summary = getBrowserSnapshot(account, result.snapshot_id);
      if (!summary) throw Object.assign(new Error('浏览器快照登记后回读失败'), { code: 'snapshot_readback_failed', statusCode: 500 });
      return sendJSON(res, { ...result, summary }, result.duplicate ? 200 : 201);
    }
    if (req.method === 'GET') {
      const account = accountFrom([...url.searchParams.getAll('account'), ...url.searchParams.getAll('accountId')]);
      const snapshotId = url.searchParams.get('snapshot_id');
      if (!snapshotId) return sendJSON(res, { ok: false, code: 'snapshot_id_required', error: 'snapshot_id必填' }, 400);
      const summary = getBrowserSnapshot(account, snapshotId);
      if (!summary || summary.meta?.source_type !== 'browser_dom' || !summary.components?.browser_capture) {
        return sendJSON(res, { ok: false, code: 'snapshot_not_found', error: '未找到该账户的浏览器快照' }, 404);
      }
      assertCaptureAccountMapping(account, summary.components.browser_capture.capture);
      return sendJSON(res, { ok: true, snapshot: summary });
    }
    return sendJSON(res, { ok: false, code: 'method_not_allowed', error: '仅支持 GET 和 POST' }, 405);
  } catch (error) {
    const status = error.statusCode || 400;
    return sendJSON(res, { ok: false, code: error.code || 'browser_snapshot_error', error: status >= 500 ? '浏览器快照处理失败' : error.message }, status);
  }
}

module.exports = handleBrowserSnapshot;
module.exports._test = { readBoundedJson, accountFrom, assertCaptureAccountMapping, MAX_BODY_BYTES };
