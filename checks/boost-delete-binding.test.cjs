'use strict';
require('./setup-runtime.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.QC_RUNTIME_CONFIG_ROOT;
fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
  qianchuan_accounts: [{ id: 'room_a' }, { id: 'room_b' }],
  agent_policy: { account_policies: { room_a: {}, room_b: {} } },
}));
const tabs = require('../server-app/server/lib/qianchuanTabs');
const qc = require('../server-app/server/lib/qianchuan');
let listReader, writes;
tabs.fetchBoostList = (...args) => listReader(...args);
qc.deleteBoostTask = async (task, account) => { writes.push({ task, account }); return { status_code: 0 }; };
const handleBoostData = require('../server-app/server/routes/boostData');
const { enforceOnboardingGuard } = require('../server-app/server/lib/onboardingGuard');
async function request(data) {
  writes = [];
  const req = { method: 'POST', headers: {}, socket: { remoteAddress: '127.0.0.1' },
    _qcJsonBodyPromise: Promise.resolve({ data }) };
  let status, payload;
  const res = { writeHead(code) { status = code; }, end(text) { payload = JSON.parse(text); } };
  const url = new URL('http://local/api/boost-delete');
  if (await enforceOnboardingGuard(req, res, url)) await handleBoostData(req, res, url);
  return { status, payload };
}
const body = { accountId: 'room_a', primaryAdId: '111', assistTaskId: '999', source: 'agent' };

test('无额外 scope 时也不能伪造父计划绕过另一直播间的执行归属', async () => {
  const dir = path.join(root, 'boost-runner', 'room_a', '222');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ status: 'active', owner: 'other-session', session_key: 'room_a|22|2026-09-27 10:00:00' }));
  listReader = async parent => ({ status_code: 0, data: { adInfos: parent === '222' ? [{ id: '999' }] : [] } });
  const direct = await request({ ...body, primaryAdId: '222' });
  assert.equal(direct.payload.code, 'execution_owner_conflict');
  const forged = await request(body);
  assert.equal(forged.payload.code, 'target_not_in_list');
  assert.equal(forged.payload.advertising_writes, 0);
  assert.equal(writes.length, 0);
});

test('删除前列表失败、结构缺失或读取异常均返回零写入', async () => {
  for (const list of [{ status_code: 1, data: { adInfos: [{ id: '999' }] } }, { status_code: 0 }, new Error('offline')]) {
    listReader = async () => { if (list instanceof Error) throw list; return list; };
    const result = await request(body);
    assert.equal(result.payload.effect_status, 'rejected');
    assert.equal(result.payload.advertising_writes, 0);
    assert.equal(writes.length, 0);
  }
});

test('按请求账号和父计划核验，另一账号的任务不能代替本账号目标', async () => {
  listReader = async (parent, _start, _end, account) => {
    assert.equal(parent, '111');
    return { status_code: 0, data: { adInfos: account === 'room_b'
      ? [{ id: '999', budget: 10000000, adDeliveryName: writes.length ? '已删除' : '已暂停' }] : [] } };
  };
  const denied = await request(body);
  assert.equal(denied.payload.code, 'target_not_in_list');
  assert.equal(writes.length, 0);
  const accepted = await request({ ...body, accountId: 'room_b' });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.payload.effect_status, 'confirmed');
  assert.deepEqual(writes, [{ task: '999', account: 'room_b' }]);
});
