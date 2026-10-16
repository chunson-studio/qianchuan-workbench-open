'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(require('./test-output.cjs').testOutputRoot(), 'http-status-test-'));
process.env.QC_RUNTIME_CONFIG_ROOT = root;
process.env.QC_RUNTIME_DATA_ROOT = root;
const cookie = require('../server-app/server/lib/cookie');
cookie.readQcCookie = () => 'sessionid=test-only';
const qc = require('../server-app/server/lib/qianchuan');

test('真实 HTTP 403 作为拒绝访问返回，不误报 Cookie 过期；401 保留登录失效语义', async t => {
  let status = 403;
  t.mock.method(require('node:https'), 'request', (options, callback) => {
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.end = () => queueMicrotask(() => {
      const res = new EventEmitter();
      res.statusCode = status;
      res.setEncoding = () => {};
      callback(res);
      res.emit('data', 'Forbidden');
      res.emit('end');
    });
    req.destroy = () => {};
    return req;
  });
  await assert.rejects(qc.requestAPI('GET', '/test', null, 'fake'), error => error.code === 'upstream_forbidden' && error.statusCode === 403);
  status = 401;
  await assert.rejects(qc.requestAPI('GET', '/test', null, 'fake'), error => error.code === 'cookie_expired' && error.statusCode === 401);
});
