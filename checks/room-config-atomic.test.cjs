'use strict';
require('./setup-runtime.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const configPath = path.join(process.env.QC_RUNTIME_CONFIG_ROOT, 'config.json');
fs.writeFileSync(configPath, JSON.stringify({
  qianchuan_accounts: [{ id: 'room_config_a' }, { id: 'room_config_b' }],
  manual_config: { target_roi: 90 },
  account_config: {
    room_config_a: { target_roi: 80, rooms: {
      '111': { target_roi: 2, target_roi_basis: 'payment' },
      '222': { target_roi: 5, target_roi_basis: 'platform_net_1h' },
    } },
    room_config_b: { rooms: { '111': { target_roi: 8, target_roi_basis: 'payment' } } },
  },
}));
const route = require('../server-app/server/routes/config');
const helpers = require('../server-app/server/lib/api-helpers');
async function request(data, query = '') {
  let status, body;
  await route({ method: data ? 'POST' : 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' },
    _qcJsonBodyPromise: Promise.resolve({ data }) }, {
    writeHead(code) { status = code; }, end(value) { body = JSON.parse(value); },
  }, new URL('http://local/api/config' + query));
  return { status, body };
}
const payload = values => ({ account: 'room_config_a', room_id: '111', values });

test('房间目标与口径一次保存并回读，不改变其他房间、账号或全局参数', async () => {
  const result = await request(payload({ target_roi: 3.5, target_roi_basis: 'platform_net_1h' }));
  assert.equal(result.status, 200);
  assert.equal(result.body.account_params.target_roi, 3.5);
  const readback = await request(null, '?account=room_config_a&room_id=111');
  assert.equal(readback.body.account_params.target_roi, 3.5);
  assert.equal(readback.body.account_params.target_roi_basis, 'platform_net_1h');
  const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(saved.account_config.room_config_a.rooms['111'].target_roi, 3.5);
  assert.equal(saved.account_config.room_config_a.rooms['111'].target_roi_basis, 'platform_net_1h');
  assert.equal(saved.account_config.room_config_a.rooms['222'].target_roi, 5);
  assert.equal(saved.account_config.room_config_b.rooms['111'].target_roi, 8);
  assert.equal(saved.account_config.room_config_a.target_roi, 80);
  assert.equal(saved.manual_config.target_roi, 90);
});

test('目标或口径无效、混合旧参数或缺少房间时整组拒绝，磁盘与内存均不变', async () => {
  const before = fs.readFileSync(configPath, 'utf8');
  const badValues = [
    { target_roi: 4 }, { target_roi_basis: 'payment' },
    { target_roi: 4, target_roi_basis: 'made_up' },
    { target_roi: 4, target_roi_basis: 'unknown' },
    { target_roi: null, target_roi_basis: 'payment' },
    { target_roi: -1, target_roi_basis: 'payment' },
    { target_roi: true, target_roi_basis: 'payment' },
    { target_roi: 4, target_roi_basis: 'payment', avg_order_price: 30 },
  ];
  for (const values of badValues) assert.equal((await request(payload(values))).status, 400);
  const good = { target_roi: 4, target_roi_basis: 'payment' };
  assert.equal((await request({ account: 'room_config_a', values: good })).status, 400);
  assert.equal((await request({ ...payload(good), key: 'target_roi', value: 4 })).status, 400);
  assert.equal((await request({ ...payload(good), account: 'missing' })).status, 400);
  assert.equal(fs.readFileSync(configPath, 'utf8'), before);
  assert.equal(helpers.getAccountParams('room_config_a', { roomId: '111' }).target_roi, 3.5);
});

test('落盘失败时不发布半份目标到内存；清空目标不继承账号或全局数值', async () => {
  const before = fs.readFileSync(configPath, 'utf8');
  const originalWrite = helpers.writeJsonAtomic;
  try {
    helpers.writeJsonAtomic = () => { throw new Error('simulated disk failure'); };
    assert.equal((await request(payload({ target_roi: 6, target_roi_basis: 'payment' }))).status, 500);
  } finally { helpers.writeJsonAtomic = originalWrite; }
  assert.equal(fs.readFileSync(configPath, 'utf8'), before);
  assert.equal(helpers.getAccountParams('room_config_a', { roomId: '111' }).target_roi, 3.5);
  assert.equal(helpers.getAccountParams('room_config_a', { roomId: '111' }).target_roi_basis, 'platform_net_1h');
  assert.equal((await request(payload({ target_roi: null, target_roi_basis: 'unknown' }))).status, 200);
  const readback = await request(null, '?account=room_config_a&room_id=111');
  assert.equal(readback.body.account_params.target_roi, null);
  assert.equal(readback.body.account_params.target_roi_basis, 'unknown');
  assert.equal((await request(null, '?room_id=111')).status, 400);
});

test('旧单项参数保存入口继续可用', async () => {
  const result = await request({ account: 'room_config_a', room_id: '222', key: 'avg_order_price', value: 42 });
  assert.equal(result.status, 200);
  assert.equal(result.body.value, 42);
  assert.equal(result.body.account_params.target_roi, 5);
  assert.equal(result.body.account_params.avg_order_price, 42);
});
