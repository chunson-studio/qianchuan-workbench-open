'use strict';
const crypto = require('node:crypto');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])])) : value;
class BrowserBoostRequests {
  constructor(db) {
    this.db = db;
    db.exec('CREATE TABLE IF NOT EXISTS browser_boost_requests (account_id TEXT NOT NULL, request_id TEXT NOT NULL, primary_ad_id TEXT NOT NULL, target_id TEXT, fingerprint TEXT NOT NULL, stage TEXT NOT NULL, response TEXT, created_at TEXT NOT NULL, PRIMARY KEY(account_id,request_id))');
  }
  lookup(r, payload=r) {
    if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='boost_create_requests'").get()
      && this.db.prepare('SELECT 1 FROM boost_create_requests WHERE account_id=? AND request_id=?').get(r.account_id,r.request_id))return {ok:false,code:'request_id_channel_conflict',advertising_writes:0,effect_status:'rejected',retry_write:false};
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify(canonical(payload))).digest('hex');
    const row = this.db.prepare('SELECT * FROM browser_boost_requests WHERE account_id=? AND request_id=?').get(r.account_id,r.request_id);
    if (row) {
      if (row.fingerprint !== fingerprint) return { ok: false, code: 'request_id_conflict', advertising_writes: 0, effect_status: 'rejected', retry_write: false };
      if (row.response) return { ...JSON.parse(row.response), replayed: true };
      return { ok: false, code: 'browser_result_unconfirmed', request_id: r.request_id, effect_status: 'unconfirmed', retry_write: false, replayed: true };
    }
    return null;
  }
  reserve(r, payload=r) {
    const prior=this.lookup(r,payload);if(prior)return prior;
    const fingerprint=crypto.createHash('sha256').update(JSON.stringify(canonical(payload))).digest('hex');
    this.db.prepare('INSERT INTO browser_boost_requests(account_id,request_id,primary_ad_id,target_id,fingerprint,stage,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(r.account_id,r.request_id,r.primary_ad_id,r.target_id || null,fingerprint,'prepared',new Date().toISOString());
    return null;
  }
  dispatched(r) { this.db.prepare("UPDATE browser_boost_requests SET stage='submitted' WHERE account_id=? AND request_id=?").run(r.account_id,r.request_id); }
  finish(r, result) { this.db.prepare('UPDATE browser_boost_requests SET response=?,stage=? WHERE account_id=? AND request_id=?')
    .run(JSON.stringify(result),result.effect_status === 'unconfirmed' ? 'unconfirmed' : 'finished',r.account_id,r.request_id); }
}
function assertBrowserRequestIdUnused(account,requestId,db=require('./db').getDB()) {
  if(!requestId||!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='browser_boost_requests'").get())return;
  if(db.prepare('SELECT 1 FROM browser_boost_requests WHERE account_id=? AND request_id=?').get(account,requestId))throw Object.assign(new Error('该编号属于浏览器通道；请回查原结果，不能改用API提交'),{code:'request_id_channel_conflict',advertising_writes:0,statusCode:409,retry_write:false});
}
function assertNoUnknownBrowserRequest(account, plan, excludeRequestId, db = require('./db').getDB()) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='browser_boost_requests'").get()) return;
  const pending = db.prepare("SELECT request_id FROM browser_boost_requests WHERE account_id=? AND primary_ad_id=? AND stage IN ('submitted','unconfirmed') AND request_id != ? LIMIT 1").get(account,String(plan),excludeRequestId || '');
  if (pending) throw Object.assign(new Error('该主计划有结果未知的浏览器请求；先查证原对象，不能换通道重发'), {
    code: 'browser_write_pending', statusCode: 409, advertising_writes: 0, retry_write: false, request_id: pending.request_id,
  });
}
module.exports = { BrowserBoostRequests, assertNoUnknownBrowserRequest,assertBrowserRequestIdUnused };
