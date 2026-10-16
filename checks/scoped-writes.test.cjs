'use strict';
require('./setup-runtime.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkHttpWritePolicy, verifyBoostScope, enforceOnboardingGuard, checkBoostElimination } = require('../server-app/server/lib/onboardingGuard');
const { normalizedTarget } = require('../server-app/server/lib/writeReceipt');
const { launch, entryIdentity } = require('../server-app/scripts/start-workbench');
const path = require('node:path');
const binding = { primary_ad_id: '111', room_id: '222', session_started_at: new Date(Date.now() - 600000).toISOString(),
  allowed_actions: ['create', 'pause', 'stop', 'delete', 'update_budget'] };
const config = { qianchuan_accounts: [{ id: 'operator' }, { id: 'reader' }, { id: 'unknown' }], agent_policy: {
  mode: 'auto_guarded', allow_plan_write: true, allow_boost_write: true,
  account_policies: {
    operator: { mode: 'auto_guarded', allow_boost_write: true, allow_plan_write: false, allow_material_write: false, boost_write_scope: binding },
    reader: { mode: 'recommendation_only', allow_boost_write: false, onboarding_managed: true },
  },
} };
const body = { accountId: 'operator', primaryAdId: '111', assistTaskId: '333', status: 2 };
const evaluate = (route, data = body) => checkHttpWritePolicy(config, route, data);
const readers = {
  fetchLiveStatus: async () => ({ isLive: true, rooms: [{ roomId: '222', startTime:binding.session_started_at }] }),
  fetchBoostList: async (parent, _start, _end, account) => {
    assert.equal(parent, '111'); assert.equal(account, 'operator');
    return { code: 0, data: { adInfos: [{ id: '333', createTime: Math.floor(Date.now() / 1000) - 60 }] } };
  },
};
test('HTTP 操作由 Agent 决定，旧模式不限制能力，显式任务绑定仍核验', () => {
  assert.equal(evaluate('/api/campaign/status').allowed, true);
  assert.equal(evaluate('/api/campaign/budget', { ...body, budget: 130 }).allowed, true);
  for (const data of [{ ...body, assistTaskId: undefined }, { ...body, accountId: 'reader' }, { ...body, accountId: 'unknown' }]) {
    assert.equal(evaluate('/api/campaign/status', data).allowed, true);
  }
  assert.equal(evaluate('/api/material/delete').allowed, true);
  assert.equal(evaluate('/api/campaign/status', {...body, accountId: 'unconfigured'}).allowed, false);
  assert.equal(evaluate('/api/campaign/status', { ...body, account_id: 'reader' }).code, 'account_conflict');
  assert.equal(evaluate('/api/campaign/status', { ...body, primaryAdId: '999' }).code, 'plan_outside_authorization');
  assert.equal(evaluate('/api/campaign/status', { ...body, status: 1 }).code, 'action_outside_authorization');
  assert.equal(evaluate('/api/campaign/budget', { ...body, budget: 130, roiGoal: 5 }).code, 'action_outside_authorization');
});
test('授权场次与主计划下真实子任务通过；换场、未知目标、旧任务拒绝', async () => {
  const check = evaluate('/api/campaign/status');
  await verifyBoostScope(check, body, readers);
  for (const value of [{ isLive: false, rooms: [] }, { isLive: true, rooms: [{ roomId: '999' }] }, { error: '403' }]) {
    await assert.rejects(verifyBoostScope(check, body, { ...readers, fetchLiveStatus: async () => value }));
  }
  await assert.rejects(verifyBoostScope(check, { ...body, assistTaskId: '999' }, readers), { code: 'target_not_in_list' });
  await assert.rejects(verifyBoostScope(check, body, { ...readers, fetchBoostList: async () => ({ code: 0, data: { adInfos: [{ id: '333', createTime: 1 }] } }) }), { code: 'target_outside_session' });
});
test('ROI、出价和定向分别核验动作、目标及时效，组合修改逐项核验', async () => {
  for (const [field, value, action] of [['roiGoal', 4.2, 'update_roi'], ['bid', 8, 'update_bid'], ['audienceTemplate', 'full_region', 'update_audience']]) {
    const local = structuredClone(config);
    const scope = local.agent_policy.account_policies.operator.boost_write_scope;
    scope.allowed_actions = [action];
    scope.action_target_ids = { [action]: ['333'] };
    const data = { ...body, [field]: value };
    const check = () => checkHttpWritePolicy(local, '/api/campaign/budget', data);
    assert.equal(check().allowed, true);
    assert.equal(check().action, action);
    await verifyBoostScope(check(), data, readers);
    await assert.rejects(verifyBoostScope(check(), data, { ...readers,
      fetchBoostList: async () => ({ code: 0, data: { adInfos: [{ id: '333', createTime: Math.floor(Date.now() / 1000), assistTaskInfoMap: { 2: { operation: { edit: { editable: false } } } } }] } }) }),
      { code: 'upstream_action_blocked' });
    scope.action_target_ids[action] = ['444'];
    assert.equal(check().code, 'target_outside_authorization');
    scope.action_target_ids[action] = ['333'];
    scope.action_expires_at = { [action]: new Date(Date.now() - 1000).toISOString() };
    assert.equal(check().code, 'action_authorization_expired');
  }
  const local = structuredClone(config);
  const scope = local.agent_policy.account_policies.operator.boost_write_scope;
  const mixed = () => checkHttpWritePolicy(local, '/api/campaign/budget', { ...body, budget: 130, roiGoal: 4.2 });
  assert.equal(mixed().allowed, false);
  scope.allowed_actions.push('update_roi');
  assert.equal(mixed().allowed, true);
  scope.action_target_ids = { update_roi: ['444'] };
  assert.equal(mixed().code, 'target_outside_authorization');
});
test('多账号直播间使用各自 ROI 策略，核验结果不受调用顺序影响', async () => {
  const local = { qianchuan_accounts: [{ id: 'room_a' }, { id: 'room_b' }], agent_policy: { account_policies: {} } };
  const cases = [
    { account: 'room_a', plan: '111', room: '222', task: '333', goal: 2, floor: 1.5 },
    { account: 'room_b', plan: '444', room: '555', task: '666', goal: 5, floor: 4 },
  ];
  for (const c of cases) local.agent_policy.account_policies[c.account] = { boost_write_scope: {
    ...binding, primary_ad_id: c.plan, room_id: c.room, allowed_actions: ['update_roi', 'delete'],
    elimination: { zero_order_min_cost: 20, order_roi_below: c.floor },
  } };
  for (const c of [...cases, cases[0]]) {
    const data = { accountId: c.account, primaryAdId: c.plan, assistTaskId: c.task, roiGoal: c.goal };
    const check = checkHttpWritePolicy(local, '/api/campaign/budget', data);
    assert.equal(check.allowed, true);
    assert.equal(data.roiGoal, c.goal);
    const read = {
      fetchLiveStatus: async account => { assert.equal(account, c.account); return { isLive: true, rooms: [{ roomId: c.room, startTime: binding.session_started_at }] }; },
      fetchBoostList: async (parent, _start, _end, account) => {
        assert.equal(parent, c.plan); assert.equal(account, c.account);
        return { code: 0, data: { adInfos: [{ id: c.task, createTime: Math.floor(Date.now() / 1000) - 60 }] } };
      },
    };
    await verifyBoostScope(check, data, read);
    assert.equal(checkHttpWritePolicy(local, '/api/campaign/budget', { ...data, accountId: cases.find(other => other !== c).account }).code, 'plan_outside_authorization');
    const metrics = { statCostForRoi2Assist: 30, totalPayOrderCountForRoi2Assist: 1, totalPrepayAndPayOrderRoi2Assist: 3 };
    assert.equal(checkBoostElimination(metrics, check.binding.elimination).allowed, c.account === 'room_b');
  }
});
test('旧 MCP 删除请求省略父计划时仍核验授权父计划和任务', async () => {
  const data = { accountId: 'operator', assistTaskId: '333' };
  const check = evaluate('/api/boost-delete', data);
  assert.equal(check.allowed, true);
  await verifyBoostScope(check, data, readers);
});
test('上游禁用动作时不放行', async () => {
  await assert.rejects(verifyBoostScope(evaluate('/api/campaign/status'), body, { ...readers,
    fetchBoostList: async () => ({ code: 0, data: { adInfos: [{ id: '333', createTime: Math.floor(Date.now() / 1000), assistTaskInfoMap: { 2: { operation: { pause: { editable: false } } } } }] } }) }), { code: 'upstream_action_blocked' });
});
test('同房间重开与开播时间缺失不能沿用旧场次授权',async()=>{
  for (const startTime of [undefined,new Date(Date.parse(binding.session_started_at)+60000).toISOString()]) {
    await assert.rejects(verifyBoostScope(evaluate('/api/campaign/status'),body,{...readers,
      fetchLiveStatus:async()=>({isLive:true,rooms:[{roomId:'222',startTime}]})}),{code:'session_outside_authorization'});
  }
});
test('旧只读环境变量不限制本机能力，远端请求仍需传输鉴权', () => {
  const { requireWriteAuth } = require('../server-app/server/lib/utils');
  const res = { writeHead(status) { this.status = status; }, end() {} };
  assert.equal(requireWriteAuth({socket:{remoteAddress:'127.0.0.1'},headers:{}},res),true);
  assert.equal(requireWriteAuth({socket:{remoteAddress:'192.0.2.10'},headers:{}},res),false);
});
test('真实投放状态可回读，未知状态不冒充暂停', () => {
  assert.equal(normalizedTarget({ adDeliveryName: '投放中', budget: '10000000' }).status, 1);
  assert.equal(normalizedTarget({ adDeliveryName: '已暂停' }).status, 2);
  assert.equal(normalizedTarget({ adDeliveryName: '系统暂停（风控）' }).status, null);
  assert.equal(normalizedTarget({ adDeliveryName: '已完成' }).status, null);
});
test('删除前保护有成交且 ROI 达标的追投，未知值不按零处理', () => {
  const rule = { zero_order_min_cost: 10, order_roi_below: 1 };
  const metrics = (cost, orders, roi) => ({ statCostForRoi2Assist: { value: cost }, totalPayOrderCountForRoi2Assist: { value: orders }, totalPrepayAndPayOrderRoi2Assist: { value: roi } });
  for (const data of [metrics(14.81, 1, 5.33), metrics(100, 2, 1), metrics(9.99, 0, 0), metrics(10, null, 0), metrics(30, 1, null)]) {
    assert.equal(checkBoostElimination(data, rule).allowed, false);
  }
  assert.equal(checkBoostElimination(metrics(10, 0, null), rule).allowed, true);
  assert.equal(checkBoostElimination(metrics(30, 1, 0.9), rule).allowed, true);
  const hidden = metrics(30, 0, null); hidden.totalPayOrderCountForRoi2Assist.controlType = 0;
  assert.equal(checkBoostElimination(hidden, rule).code, 'elimination_data_unavailable');
});
test('启动不传播退役的只读开关，后台采集默认关闭', async () => {
  for (const value of [undefined, '0', '1']) {
    let called = false, spawnEnv;
    const entry = path.resolve(__dirname, '../server-app/server.js');
    const config = { entry, root: path.dirname(entry), logs: path.join(process.env.QC_RUNTIME_DATA_ROOT, 'launch'), url: 'http://127.0.0.1:23456', port: 23456 };
    await launch(config, { env: value === undefined ? {} : { QC_TRIAL_READ_ONLY: value },
      read: async () => { if (!called) throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' }); return { ok: true, component: 'http_process', entrypoint_id: entryIdentity(entry), pid: 123 }; },
      start: (_command, _args, options) => { called = true; spawnEnv = options.env; return { pid: 123, on() {}, unref() {} }; },
    });
    assert.equal(spawnEnv.QC_TRIAL_READ_ONLY, undefined);
    assert.equal(spawnEnv.QC_DISABLE_BACKGROUND, '1');
  }
});
