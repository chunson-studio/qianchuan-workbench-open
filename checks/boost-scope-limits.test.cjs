'use strict';
require('./setup-runtime.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const guard = require('../server-app/server/lib/onboardingGuard');
const { describeExecutionPolicy } = require('../server-app/server/lib/agentPolicy');
const start = new Date(Date.now() - 600000).toISOString();
const binding = { primary_ad_id: '111', room_id: '222', session_started_at: start,
  allowed_actions: ['create', 'pause', 'resume'], concurrency: { min_active_tasks: 0, max_active_tasks: 2 } };
const task = (id, status = 1) => ({ id, status, createTime: Math.floor(Date.now() / 1000) - 60 });
function readers(tasks = [task('a')]) {
  return { fetchLiveStatus: async () => ({ isLive: true, rooms: [{ roomId: '222', startTime: start }] }),
    fetchBoostList: async (plan, _start, _end, account) => {
      assert.equal(plan, '111'); assert.equal(account, 'test');
      return { code: 0, truncated: false, data: { adInfos: tasks } };
    }, getUnconfirmedBoostExposure: () => [] };
}
const check = (action, scope = binding) => ({ accountId: 'test', scope: 'boost', action, actions: [action], binding: scope });
const body = { accountId: 'test', primaryAdId: '111', assistTaskId: 'paused' };

test('数量上限约束 create 与 resume，已在投重复恢复不占新名额', async () => {
  await guard.verifyBoostScope(check('create'), body, readers());
  for (const action of ['create', 'resume']) await assert.rejects(
    guard.verifyBoostScope(check(action), body, readers([task('a'), task('b'), task('paused', 2)])), { code: 'concurrency_limit_exceeded' });
  await guard.verifyBoostScope(check('resume'), { ...body, assistTaskId: 'a' }, readers([task('a'), task('b')]));
  await guard.verifyBoostScope(check('pause'), { ...body, assistTaskId: 'a' }, readers([task('a'), task('b')]));
});

test('分页、未知状态、重复 ID 与无效上限不能按零在投放行', async () => {
  for (const tasks of [[task('a'), task('a')], [{ id: 'a', adDeliveryName: '未知' }]])
    await assert.rejects(guard.verifyBoostScope(check('create'), body, readers(tasks)), { code: 'boost_capacity_unavailable' });
  await assert.rejects(guard.verifyBoostScope(check('create'), body, { ...readers(), fetchBoostList: async () => ({ code: 0, truncated: true, data: { adInfos: [] } }) }), { code: 'boost_capacity_unavailable' });
  await assert.rejects(guard.verifyBoostScope(check('create', { ...binding, concurrency: { max_active_tasks: '2' } }), body, readers()), { code: 'invalid_concurrency_limit' });
});

test('同计划创建或恢复尚未回读时阻断加量；列表已观察到原对象则按当前状态计数', async () => {
  const r = { ...readers(), getUnconfirmedBoostExposure: () => [{ target_id: 'not-seen' }] };
  await assert.rejects(guard.verifyBoostScope(check('create'), body, r), { code: 'boost_exposure_unconfirmed' });
  r.getUnconfirmedBoostExposure = () => [{ target_id: 'a' }];
  await guard.verifyBoostScope(check('create'), body, r);
  r.getUnconfirmedBoostExposure = () => { throw Error('storage_unavailable'); };
  await assert.rejects(guard.verifyBoostScope(check('create'), body, r), /storage_unavailable/);
});

test('大盘底线绑定同户同房间开播时间及净 ROI，零值也能触发且不限制暂停', async () => {
  const scope = { ...binding, elimination: { room_floor_roi: 10 } };
  for (const [roi, code] of [[9.99, 'room_floor_roi_breached'], [0, 'room_floor_roi_breached'], [null, 'room_roi_unavailable']]) {
    const r = { ...readers(), fetchLiveSessions: async (_date, opts) => {
      assert.equal(opts.accountId, 'test'); return { sessions: [{ roomId: '222', startTime: start, status: '2', netRoi: roi }] };
    } };
    await assert.rejects(guard.verifyBoostScope(check('create', scope), body, r), { code });
    await guard.verifyBoostScope(check('pause', scope), { ...body, assistTaskId: 'a' }, r);
  }
  const r = { ...readers(), fetchLiveSessions: async () => ({ sessions: [{ roomId: 'other', startTime: start, status: '2', netRoi: 20 }] }) };
  await assert.rejects(guard.verifyBoostScope(check('create', scope), body, r), { code: 'room_roi_unavailable' });
});

test('同日重开默认不接管旧任务，仅明确 ID 可沿用且不会覆盖错场绑定', async () => {
  const date = new Date().toISOString().slice(0, 10);
  const startTime = date + 'T10:00:00+08:00';
  const scope = { ...binding, session_started_at: startTime };
  const old = { ...task('a', 2), createTime: Date.parse(date + 'T09:00:00+08:00') / 1000 };
  // 固定时间，避免测试取决于运行时的本地时区和上午/下午。
  const realNow = Date.now; Date.now = () => Date.parse(date + 'T11:00:00+08:00');
  try {
    const r = { ...readers([old]), fetchLiveStatus: async () => ({ isLive: true, rooms: [{ roomId: '222', startTime }] }) };
    const data = { ...body, assistTaskId: 'a' };
    await assert.rejects(guard.verifyBoostScope(check('pause', scope), data, r), { code: 'target_outside_session' });
    await guard.verifyBoostScope(check('pause', { ...scope, carryover_task_ids: ['a'] }), data, r);
    old.createTime -= 86400;
    await assert.rejects(guard.verifyBoostScope(check('pause', { ...scope, carryover_task_ids: ['a'] }), data, r), { code: 'target_outside_session' });
  } finally { Date.now = realNow; }
});

test('两个并发请求共享预检到提交的主计划锁，不能同时使用最后一个名额', async () => {
  const config = { qianchuan_accounts: [{ id: 'test' }], agent_policy: { account_policies: { test: { boost_write_scope: binding } } } };
  fs.writeFileSync(path.join(process.env.QC_RUNTIME_CONFIG_ROOT, 'config.json'), JSON.stringify(config));
  const tabs = require('../server-app/server/lib/qianchuanTabs'), tasks = [task('a')];
  const r = readers(tasks);
  tabs.fetchLiveStatus = r.fetchLiveStatus; tabs.fetchBoostList = r.fetchBoostList;
  let writes = 0;
  async function request() {
    const req = { method: 'POST', headers: {}, socket: { remoteAddress: '127.0.0.1' }, _qcJsonBodyPromise: Promise.resolve({ data: body }) };
    let payload;
    const res = { writeHead() {}, end(text) { payload = JSON.parse(text); } };
    await guard.runGuardedWrite(req, res, new URL('http://local/api/boost-create'), async () => {
      await new Promise(resolve => setTimeout(resolve, 10)); tasks.push(task('new')); writes++; payload = { ok: true };
    });
    return payload;
  }
  const results = await Promise.all([request(), request()]);
  assert.equal(writes, 1); assert.equal(results.filter(r => r.code === 'concurrency_limit_exceeded').length, 1);
});

test('对外投影保留执行参数并过滤配置中的自由文本及凭据', () => {
  const scope = { ...binding, elimination: { room_floor_roi: 10, secret: 'omit' },
    hysteresis_rules: { pause_active_below: 8, resume_paused_at_or_above: 10, notes: ['omit'] }, carryover_task_ids: ['a'] };
  const result = describeExecutionPolicy({ boost_write_scope: scope }, 'test').boost_write_scope;
  assert.equal(result.concurrency.max_active_tasks, 2); assert.equal(result.elimination.room_floor_roi, 10);
  assert.equal(result.hysteresis_rules.pause_active_below, 8); assert.deepEqual(result.carryover_task_ids, ['a']);
  assert.equal(JSON.stringify(result).includes('omit'), false);
});
