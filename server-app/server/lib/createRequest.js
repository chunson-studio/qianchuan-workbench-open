'use strict';
const crypto = require('node:crypto');
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => [k, canonical(value[k])]));
  return value;
}
// 请求编号区分主动新建与网络重试；提交前持久化，进程中断也不会重复投放。
async function runCreateRequest(db, account, requestId, payload, execute) {
  if (!account || typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(requestId)) {
    return { status: 400, body: { ok: false, code: 'invalid_request_id', error: 'requestId须为8~100位字母、数字、下划线或连字符，且须指定账户' } };
  }
  db.exec('CREATE TABLE IF NOT EXISTS boost_create_requests (account_id TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, response TEXT, created_at TEXT NOT NULL, PRIMARY KEY(account_id, request_id))');
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(canonical(payload))).digest('hex');
  const insert = db.prepare('INSERT OR IGNORE INTO boost_create_requests (account_id, request_id, fingerprint, created_at) VALUES (?, ?, ?, ?)').run(account, requestId, fingerprint, new Date().toISOString());
  if (!insert.changes) {
    const previous = db.prepare('SELECT fingerprint, response FROM boost_create_requests WHERE account_id=? AND request_id=?').get(account, requestId);
    if (previous.fingerprint !== fingerprint) return { status: 409, body: { ok: false, code: 'request_id_conflict', error: '同一requestId不能更改创建参数' } };
    if (previous.response) {
      const result = JSON.parse(previous.response);
      return { ...result, body: { ...result.body, replayed: true, request_id: requestId } };
    }
    return { status: 409, body: { ok: false, code: 'create_result_unconfirmed', request_id: requestId, retryable: false, error: '该请求正在执行或结果未确认，请查询任务和操作日志，不要换编号重复创建' } };
  }
  // 异常时保留 pending；未确认上游结果前禁止自动重发。
  const result = await execute();
  const response = { ...result, body: { ...result.body, request_id: requestId } };
  db.prepare('UPDATE boost_create_requests SET response=? WHERE account_id=? AND request_id=?').run(JSON.stringify(response), account, requestId);
  return response;
}
module.exports = { runCreateRequest };
