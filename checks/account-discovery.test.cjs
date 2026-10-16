'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { discoverAccount, extractCandidates, requestAccountInfo } = require('../server-app/server/lib/accountDiscovery');

function fakeRequest(status, payload) {
  return (_options, callback) => {
    const req = new EventEmitter();
    req.destroy = () => req.emit('error', new Error('destroyed'));
    req.end = () => process.nextTick(() => {
      const res = new EventEmitter();
      res.statusCode = status;
      res.setEncoding = () => {};
      callback(res);
      res.emit('data', typeof payload === 'string' ? payload : JSON.stringify(payload));
      res.emit('end');
    });
    return req;
  };
}

test('账户发现遇到 997 时要求账户 ID，不误报 Cookie 失效', async () => {
  await assert.rejects(
    discoverAccount('sessionid=secret; csrftoken=c', { request: fakeRequest(200, { status_code: 997, message: '存在多个直客账户' }) }),
    error => error.code === 'account_selection_required' && error.statusCode === 409,
  );
});

test('账户 ID hint 编码为 aavid 查询参数并拒绝非法值', async () => {
  let seen;
  const request = (options, callback) => {
    seen = options;
    return fakeRequest(200, { status_code: 0, data: { accountInfo: { advId: '12345', advName: 'One' } } })(options, callback);
  };
  await requestAccountInfo('sessionid=x', { aavid: '12345', request });
  assert.equal(seen.path, '/ad/api/v1/account/user/info?aavid=12345');
  for (const aavid of ['12x45', '', 12345, ['12345']]) {
    await assert.rejects(requestAccountInfo('sessionid=x', { aavid, request }), error => error.code === 'invalid_account_id');
  }
});

test('账户发现只解析 data.accountInfo 的 advId/advName', () => {
  assert.deepEqual(extractCandidates({ data: { accountInfo: { advId: '12345', advName: 'One' }, nested: { advId: '67890', advName: 'Wrong' } } }), [
    { candidate_id: '12345', aavid: '12345', name: 'One' },
  ]);
});

test('账户 ID hint 只接受真实返回的匹配候选', async () => {
  const payload = { status_code: 0, data: { accountInfo: { advId: '12345', advName: 'One' } } };
  const found = await discoverAccount('sessionid=x; csrftoken=c', { aavid: '12345', request: fakeRequest(200, payload) });
  assert.equal(found.candidates[0].aavid, '12345');
  await assert.rejects(
    discoverAccount('sessionid=x; csrftoken=c', { aavid: '67890', request: fakeRequest(200, payload) }),
    error => error.code === 'account_identity_mismatch' && error.statusCode === 409,
  );
});

test('账户发现覆盖 0/1/N 候选且不回显 Cookie', async () => {
  assert.deepEqual(extractCandidates({ data: { advertiser_id: '12345', advertiser_name: 'One' } }), [{ candidate_id: '12345', aavid: '12345', name: 'One' }]);
  const many = extractCandidates({ data: [{ advertiser_id: '12345', advertiser_name: 'One' }, { advertiserId: '67890', advertiserName: 'Two' }] });
  assert.equal(many.length, 2);
  await assert.rejects(
    discoverAccount('sessionid=secret', { request: fakeRequest(200, { data: { no_account_here: true } }) }),
    error => error.code === 'schema_changed',
  );
  const one = await discoverAccount('sessionid=secret; csrftoken=c', { request: fakeRequest(200, { data: { advertiser_id: '12345', advertiser_name: 'One' } }) });
  assert.equal(one.candidates.length, 1);
  assert.doesNotMatch(JSON.stringify(one), /secret|csrftoken/);
});

test('账户发现区分 401/403/423/429 与结构变化', async () => {
  for (const [status, code] of [[401, 'cookie_expired'], [403, 'forbidden'], [423, 'rate_limited'], [429, 'rate_limited']]) {
    await assert.rejects(requestAccountInfo('sessionid=x', { request: fakeRequest(status, {}) }), error => error.code === code);
  }
  await assert.rejects(requestAccountInfo('sessionid=x', { request: fakeRequest(200, '<html>changed</html>') }), error => error.code === 'schema_changed');
});
