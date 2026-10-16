'use strict';
require('./setup-runtime.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const opLog = require('../server-app/server/lib/operationLog');
const actionLimits = require('../server-app/server/lib/actionLimits');
const original = { log: opLog.log, attachReceipt: opLog.attachReceipt, getById: opLog.getById,
  safeActionLimits: actionLimits.safeActionLimits };
const limits = { update_budget: { next_allowed_at: null }, update_roi: { next_allowed_at: null },
  update_bid: { next_allowed_at: null }, update_audience: { next_allowed_at: null } };
actionLimits.safeActionLimits = () => limits;
const { executeWithReceipt, normalizedTarget, compareReadback } = require('../server-app/server/lib/writeReceipt');

function fakeAudit({ attach = () => {}, row = id => ({ id, params: { receipt: {} } }) } = {}) {
  let entry;
  opLog.log = value => { entry = value; return 41; };
  opLog.attachReceipt = attach;
  opLog.getById = row;
  return { get entry() { return entry; } };
}
function restoreAudit() {
  opLog.log = original.log; opLog.attachReceipt = original.attachReceipt;
  opLog.getById = original.getById; actionLimits.safeActionLimits = original.safeActionLimits;
}
const common = { before: { budget: 50 }, requested: { budget: 100 },
  logEntry: { action: 'update_budget', account_id: 'receipt-test', target_id: 'plan-1', params: {} } };

test('明确写前拒绝返回 rejected 和零广告写入，不做回读', async () => {
  const audit = fakeAudit();
  try {
    let reads = 0;
    const error = Object.assign(new Error('scope_denied'), { code: 'scope_denied', statusCode: 403, advertising_writes: 0 });
    const result = await executeWithReceipt({ ...common, write: async () => { throw error; }, read: async () => { reads++; } });
    assert.equal(result.ok, false);
    assert.equal(result.effect_status, 'rejected');
    assert.equal(result.advertising_writes, 0);
    assert.equal(result.http_status, 403);
    assert.equal(reads, 0);
    assert.equal(audit.entry.success, false);
    assert.equal(audit.entry.params.upstream_accepted, false);
  } finally { restoreAudit(); }
});

test('没有写前拒绝标记的传输异常保持 unconfirmed，且禁止自动重发', async () => {
  const audit = fakeAudit();
  try {
    let reads = 0;
    const result = await executeWithReceipt({ ...common,
      write: async () => { throw Object.assign(new Error('socket_timeout'), { code: 'upstream_timeout', statusCode: 504 }); },
      read: async () => { reads++; } });
    assert.equal(result.effect_status, 'unconfirmed');
    assert.equal(result.retry_write, false);
    assert.equal(result.readback.verified, false);
    assert.equal(reads, 0);
    assert.equal(audit.entry.success, false);
  } finally { restoreAudit(); }
});

test('上游接受且读回一致时须有持久化回执才返回 confirmed', async () => {
  const audit = fakeAudit();
  try {
    opLog.getById = id => ({ id, params: { receipt: { effect_status: 'confirmed' } } });
    const result = await executeWithReceipt({ ...common, write: async () => ({ status_code: 0 }),
      read: async () => ({ budget: 100 }) });
    assert.equal(result.upstream_accepted, true);
    assert.equal(result.effect_status, 'confirmed');
    assert.equal(result.readback.verified, true);
    assert.equal(audit.entry.success, true);
    assert.equal(audit.entry.params.effect_status, 'unconfirmed');
  } finally { restoreAudit(); }
});

test('创建时长回执只把有明确秒单位来源的列表字段作为 actual', () => {
  const request = { duration_seconds: 1800 };
  const ambiguous = normalizedTarget({ id: 'task-a', Duration: 1800 });
  assert.equal(ambiguous.duration_seconds, null);
  assert.equal(ambiguous.duration_unit, 'unknown');
  assert.equal(ambiguous.duration_source, null);
  assert.equal(compareReadback(ambiguous, request).verified, false);

  const observed = normalizedTarget({ id: 'task-b', duration_seconds: 1800 });
  assert.equal(observed.duration_seconds, 1800);
  assert.equal(observed.duration_unit, 'seconds');
  assert.equal(observed.duration_source, 'upstream.duration_seconds');
  assert.equal(compareReadback(observed, request).verified, true);
});

test('写后回读异常或不匹配不确认、不重发，也不需要模型另发回读命令', async () => {
  const cases = [
    { name: '任务暂不可见', read: async () => null },
    { name: '参数不一致', read: async () => ({ budget: 99 }) },
    { name: '读取失败', read: async () => { throw new Error('test_read_failed'); } },
    { name: '读取超时', read: () => new Promise(() => {}), timeout: 10 },
  ];
  for (const scenario of cases) {
    fakeAudit();
    let writes = 0, reads = 0;
    try {
      const result = await executeWithReceipt({ ...common,
        write: async () => { writes++; return { status_code: 0 }; },
        read: async () => { reads++; return scenario.read(); },
        readTimeoutMs: scenario.timeout,
      });
      assert.equal(writes, 1, scenario.name);
      assert.equal(reads, 1, scenario.name);
      assert.equal(result.ok, true, scenario.name);
      assert.equal(result.upstream_accepted, true, scenario.name);
      assert.equal(result.effect_status, 'unconfirmed', scenario.name);
      assert.equal(result.readback.verified, false, scenario.name);
      assert.equal(result.retry_write, false, scenario.name);
      if (scenario.timeout) assert.equal(result.readback.reason, 'readback_timeout');
    } finally { restoreAudit(); }
  }
});

test('回执审计失败时保留上游接受用于冷却，但不能报告 confirmed', async () => {
  const audit = fakeAudit({ attach: () => { throw new Error('audit_disk_error'); } });
  try {
    const result = await executeWithReceipt({ ...common, write: async () => ({ status_code: 0 }),
      read: async () => ({ budget: 100 }) });
    assert.equal(result.upstream_accepted, true);
    assert.equal(result.effect_status, 'unconfirmed');
    assert.equal(result.audit_error, 'receipt_persistence_failed');
    assert.equal(result.readback.verified, false);
    assert.equal(audit.entry.success, true);
  } finally { restoreAudit(); }
});

test('ROI 已接受而预算明确未提交时保留部分回执与冷却事实，不确认整笔请求', async () => {
  const audit = fakeAudit();
  try {
    let reads = 0;
    const partialEffect = { roi_goal: 'upstream_accepted', budget: 'not_submitted' };
    const error = Object.assign(new Error('budget_conflict_after_partial_write'), {
      code: 'budget_conflict_after_partial_write', statusCode: 409, partial: true,
      effect_status: 'unconfirmed', upstream_accepted: true, advertising_writes: 1,
      details: { partial_effect: partialEffect }, partial_effect: partialEffect,
    });
    const result = await executeWithReceipt({ ...common,
      requested: { budget: 100, roi_goal: 2.2 },
      logEntry: { ...common.logEntry, action: 'update_budget_roi', params: { budget: 100, roiGoal: 2.2 } },
      write: async () => { throw error; }, read: async () => { reads++; } });
    assert.equal(result.ok, false);
    assert.equal(result.effect_status, 'unconfirmed');
    assert.equal(result.upstream_accepted, true);
    assert.equal(result.partial, true);
    assert.deepEqual(result.partial_effect, partialEffect);
    assert.deepEqual(result.details.partial_effect, partialEffect);
    assert.equal(result.advertising_writes, 1);
    assert.equal(result.retry_write, false);
    assert.equal(reads, 0);
    assert.equal(audit.entry.success, true);
    assert.equal(audit.entry.action, 'update_budget_roi');
    assert.equal(audit.entry.params.upstream_accepted, true);
    assert.equal(audit.entry.params.effect_status, 'unconfirmed');
    assert.equal(audit.entry.params.advertising_writes, 1);
    assert.deepEqual(audit.entry.params.partial_effect, partialEffect);
  } finally { restoreAudit(); }
});

test('部分 ROI 接受会启用 ROI 冷却，但不占用预算调整次数', () => {
  const id = opLog.log({ action: 'update_budget_roi', account_id: 'partial-cooldown-test', target_id: 'plan-partial-test',
    success: true, params: { upstream_accepted: true, effect_status: 'unconfirmed', partial: true,
      partial_effect: { roi_goal: 'upstream_accepted', budget: 'not_submitted' } }, source: 'e2e' });
  const limitsNow = actionLimits.getActionLimits('partial-cooldown-test', 'plan-partial-test');
  assert.ok(opLog.getLastSuccessfulRoiUpdate('partial-cooldown-test', 'plan-partial-test')?.id === id);
  assert.equal(limitsNow.update_roi.allowed, false);
  assert.equal(limitsNow.update_budget.allowed, true);
  assert.equal(limitsNow.update_budget.remaining, 3);
  const unknownId = opLog.log({ action: 'update_budget_roi', account_id: 'partial-unknown-cooldown-test', target_id: 'plan-partial-test',
    success: true, params: { upstream_accepted: true, effect_status: 'unconfirmed', partial: true,
      partial_effect: { roi_goal: 'upstream_accepted', budget: 'unknown' } }, source: 'e2e' });
  assert.ok(opLog.getRecentParameterUpdates('partial-unknown-cooldown-test', 'plan-partial-test').some(row => row.id === unknownId));
  const unknownLimits = actionLimits.getActionLimits('partial-unknown-cooldown-test', 'plan-partial-test');
  assert.equal(unknownLimits.update_roi.allowed, false);
  assert.equal(unknownLimits.update_budget.remaining, 2);
  const rejectedId = opLog.log({ action: 'update_budget_roi', account_id: 'partial-rejected-cooldown-test', target_id: 'plan-partial-test',
    success: true, params: { upstream_accepted: true, effect_status: 'unconfirmed', partial: true,
      partial_effect: { roi_goal: 'upstream_accepted', budget: 'rejected' } }, source: 'e2e' });
  assert.equal(opLog.getRecentParameterUpdates('partial-rejected-cooldown-test', 'plan-partial-test').some(row => row.id === rejectedId), false);
  const rejectedLimits = actionLimits.getActionLimits('partial-rejected-cooldown-test', 'plan-partial-test');
  assert.equal(rejectedLimits.update_roi.allowed, false);
  assert.equal(rejectedLimits.update_budget.remaining, 3);
  const completeId = opLog.log({ action: 'update_budget_roi', account_id: 'complete-mixed-cooldown-test', target_id: 'plan-partial-test',
    success: true, params: { upstream_accepted: true, effect_status: 'confirmed', requested: { budget: 100, roiGoal: 2 } }, source: 'e2e' });
  assert.ok(opLog.getRecentParameterUpdates('complete-mixed-cooldown-test', 'plan-partial-test').some(row => row.id === completeId));
  assert.equal(actionLimits.getActionLimits('complete-mixed-cooldown-test', 'plan-partial-test').update_budget.remaining, 2);
});

test('操作日志可按 effect_status 查询，且确认态来自已挂接回执', () => {
  const id = opLog.log({ action: 'update_budget', account_id: 'receipt-query-test', target_id: 'plan-query-test',
    success: true, params: { upstream_accepted: true, effect_status: 'unconfirmed' }, source: 'e2e' });
  opLog.attachReceipt(id, { effect_status: 'confirmed', readback: { verified: true } });
  assert.equal(opLog.query({ accountId: 'receipt-query-test', effectStatus: 'confirmed' }).some(row => row.id === id), true);
  assert.equal(opLog.query({ accountId: 'receipt-query-test', effectStatus: 'unconfirmed' }).some(row => row.id === id), false);
});
