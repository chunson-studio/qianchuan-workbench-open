'use strict';
require('./setup-runtime.cjs');
const test = require('node:test'), assert = require('node:assert/strict');
const { verifyBoostScope } = require('../server-app/server/lib/onboardingGuard');
const start = new Date(Date.now() - 3600000).toISOString();
const end = new Date(Date.now() - 60000).toISOString();
const binding = { primary_ad_id: '88', room_id: '222', session_started_at: start,
  allowed_actions: ['delete'], allow_post_live_delete: true, action_target_ids: { delete: ['77'] } };
const check = { accountId: 'cleanup-test', action: 'delete', actions: ['delete'], binding };
const data = { primaryAdId: '88', assistTaskId: '77' };
const readers = (history = {}, task = {}) => ({
  fetchLiveStatus: async () => ({ isLive: true, rooms: [{ roomId: '333', startTime: start }] }),
  fetchLiveSessions: async () => ({ data_valid: true, sessions: [{ roomId: '222', startTime: start, endTime: end, status: '4' }], ...history }),
  fetchBoostList: async () => ({ code: 0, data: { adInfos: [{ id: '77', createTime: Math.floor(Date.now() / 1000) - 1800,
    adDeliveryName: '关联直播间未开播', assistTaskInfoMap: { '2': { operation: { delete: { editable: true } } } }, ...task }] } }),
});
test('exact completed session permits explicitly scoped test cleanup while another room is live', async () => {
  await verifyBoostScope(check, data, readers());
});
test('missing post-live permission or exact task scope still blocks cleanup', async () => {
  for (const patch of [{ allow_post_live_delete: false }, { action_target_ids: { delete: ['99'] } }])
    await assert.rejects(verifyBoostScope({ ...check, binding: { ...binding, ...patch } }, data, readers()), e => e.code === 'session_outside_authorization');
});
test('missing, failed, partial, wrong-session and still-live history cannot prove the room has ended', async () => {
  const cases = [{ sessions: [] }, { error: 'upstream_timeout' }, { data_valid: false },
    { sessions: [{ roomId: '222', startTime: '2026-09-29 09:00:00', endTime: end, status: '4' }] },
    { sessions: [{ roomId: '222', startTime: start, endTime: end, status: '2' }] },
    { sessions: [{ roomId: '222', startTime: start, endTime: null, status: '4' }] }];
  for (const history of cases) await assert.rejects(verifyBoostScope(check, data, readers(history)), e => e.code === 'session_outside_authorization');
});
test('ended room does not allow deleting a task still reported as delivering', async () => {
  await assert.rejects(verifyBoostScope(check, data, readers({}, { adDeliveryName: '投放中' })), e => e.code === 'post_live_delete_status_invalid');
});
