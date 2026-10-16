'use strict';
require('./setup-runtime.cjs');
const test = require('node:test'), assert = require('node:assert/strict');
const { verifyBoostScope, checkHttpWritePolicy } = require('../server-app/server/lib/onboardingGuard');
const { describeExecutionPolicy } = require('../server-app/server/lib/agentPolicy');
const start = new Date(Date.now() - 3600000).toISOString(), end = new Date(Date.now() - 60000).toISOString();
const binding = { primary_ad_id: '88', room_id: '222', session_started_at: start,
  allowed_actions: ['pause'], allow_post_live_pause: true, action_target_ids: { pause: ['77'] },
  action_expires_at: { pause: new Date(Date.now() + 600000).toISOString() } };
const data = { accountId: 'pause-fixture', primaryAdId: '88', assistTaskId: '77', status: 2 };
function config(scope = binding) {
  return { qianchuan_accounts: [{ id: data.accountId }], agent_policy: { account_policies: {
    [data.accountId]: { boost_write_scope: scope } } } };
}
const check = scope => checkHttpWritePolicy(config(scope), '/api/campaign/status', data);
function readers({ live = false, history = {}, task = {} } = {}) {
  return {
    fetchLiveStatus: async () => ({ isLive: live, rooms: live ? [{ roomId: '333', startTime: start }] : [] }),
    fetchLiveSessions: async () => ({ data_valid: true, sessions: [{ roomId: '222', startTime: start, endTime: end, status: '4' }], ...history }),
    fetchBoostList: async () => ({ code: 0, data: { adInfos: [{ id: '77', status: 1,
      createTime: Math.floor(Date.now() / 1000) - 1800, adDeliveryName: '关联直播间未开播',
      assistTaskInfoMap: { '2': { operation: { pause: { editable: true } } } }, ...task }] } }),
  };
}
test('下播暂停只接受精确本场与限时指定对象，包括同户另一房间仍直播', async () => {
  for (const live of [false, true]) {
    const verified = check(binding); assert.equal(verified.allowed, true);
    await verifyBoostScope(verified, data, readers({ live }));
  }
  const projected = describeExecutionPolicy(config().agent_policy, data.accountId);
  assert.equal(projected.boost_write_scope.allow_post_live_pause, true);
  assert.deepEqual(projected.boost_write_scope.action_target_ids.pause, ['77']);
});
test('缺标记、精确ID、期限或动作权限不能取得下播例外；不能恢复增投', async () => {
  for (const patch of [{ allow_post_live_pause: false }, { action_target_ids: undefined },
    { action_target_ids: { pause: [] } }, { action_expires_at: undefined },
    { action_expires_at: { pause: 'not-a-date' } },
    { action_expires_at: { pause: new Date(Date.now() - 1).toISOString() } }, { allowed_actions: [] }]) {
    const selected = check({ ...binding, ...patch });
    if (selected.allowed) await assert.rejects(verifyBoostScope(selected, data, readers()), { code: 'session_outside_authorization' });
    else assert.ok(['action_outside_authorization', 'target_outside_authorization', 'action_authorization_expired'].includes(selected.code));
  }
  for (const action of ['resume', 'create', 'update_budget', 'update_duration', 'delete'])
    await assert.rejects(verifyBoostScope({ ...check(binding), action, actions: [action] }, data, readers()), { code: 'session_outside_authorization' });
});
test('结束证据缺失、重复、错误、错房间/场次、未来结束时间或仍直播全部拒绝', async () => {
  const valid = { roomId: '222', startTime: start, endTime: end, status: '4' };
  for (const history of [{ sessions: [] }, { sessions: [valid, valid] }, { error: 'timeout' }, { data_valid: false },
    { sessions: [{ ...valid, roomId: '333' }] }, { sessions: [{ ...valid, startTime: new Date(Date.parse(start) - 3600000).toISOString() }] },
    { sessions: [{ ...valid, status: '2' }] }, { sessions: [{ ...valid, endTime: null }] },
    { sessions: [{ ...valid, endTime: start }] }, { sessions: [{ ...valid, endTime: new Date(Date.now() + 60000).toISOString() }] }])
    await assert.rejects(verifyBoostScope(check(binding), data, readers({ history })), { code: 'session_outside_authorization' });
});
test('下播例外仍拒绝旧场任务、错计划、缺目标和平台禁改；暂停不套删除淘汰闸', async () => {
  await assert.rejects(verifyBoostScope(check(binding), data, readers({ task: { createTime: Math.floor(Date.parse(start) / 1000) - 60 } })), { code: 'target_outside_session' });
  await assert.rejects(verifyBoostScope(check(binding), { ...data, primaryAdId: '99' }, readers()), { code: 'plan_outside_authorization' });
  await assert.rejects(verifyBoostScope(check(binding), { ...data, assistTaskId: 'other' }, readers()), { code: 'session_outside_authorization' });
  await assert.rejects(verifyBoostScope(check(binding), data, readers({ task: {
    assistTaskInfoMap: { '2': { operation: { pause: { editable: false } } } } } })), { code: 'upstream_action_blocked' });
  await verifyBoostScope(check({ ...binding, elimination: { zero_order_min_cost: 99999, order_roi_below: 0, require_paused: true } }), data, readers());
});
test('等待读取期间过期的收尾授权在提交前拒绝', async t => {
  const now = Date.now(); t.mock.timers.enable({ apis: ['Date'], now });
  const scope = { ...binding, action_expires_at: { pause: new Date(now + 10000).toISOString() } };
  const source = readers(), fetchList = source.fetchBoostList;
  source.fetchBoostList = async (...args) => { t.mock.timers.tick(11000); return fetchList(...args); };
  await assert.rejects(verifyBoostScope(check(scope), data, source), { code: 'action_authorization_expired' });
});
