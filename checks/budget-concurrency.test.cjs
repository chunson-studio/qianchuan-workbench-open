'use strict';
require('./setup-runtime.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');

const accountId = 'budget_test';
fs.writeFileSync(path.join(process.env.QC_RUNTIME_CONFIG_ROOT, 'config.json'), JSON.stringify({
  qianchuan_accounts: [{ id: accountId, aavid: '12345', cookieFile: 'unused.txt' }], accounts: [],
}));
fs.mkdirSync(path.join(process.env.QC_RUNTIME_CONFIG_ROOT, 'scripts'), { recursive: true });
fs.writeFileSync(path.join(process.env.QC_RUNTIME_CONFIG_ROOT, 'scripts', 'unused.txt'), 'sessionid=isolated-test-cookie');
process.env.QC_TRIAL_READ_ONLY = '0';

const qianchuan = require('../server-app/server/lib/qianchuan');
const realUpdateCampaignBudgetAndROI = qianchuan.updateCampaignBudgetAndROI;
const tabs = require('../server-app/server/lib/qianchuanTabs');
const opLog = require('../server-app/server/lib/operationLog');
const writeReceipt = require('../server-app/server/lib/writeReceipt');
let currentPlanBudget = 100;
let currentBoostBudget = 100;
let planWrites = 0;
let submittedOptions = [];
let executeReceiptCalls = 0;
let lastReceiptOptions = null;
let forcedReceiptResult = null;

Object.assign(qianchuan, {
  fetchPlanCurrentValues: async () => ({ budget: currentPlanBudget, roiGoal: 2, status: 1 }),
  updateCampaignBudgetAndROI: async (...args) => {
    planWrites++;
    submittedOptions.push(args[5]);
    currentPlanBudget = args[2];
    return { status_code: 0 };
  },
});
Object.assign(tabs, {
  fetchBoostList: async () => ({ data: { adInfos: [{
    id: '77', status: 1, budget: currentBoostBudget * 100000, ecpRoi2Goal: 2, bid: 500_000, smartBidType: 0,
    audience: { CityDivide: 0 }, assistTaskInfoMap: { '2': { operation: { edit: { editable: true } } } },
  }] } }),
  fetchUniPromAdList: async () => ({ data: { adInfos: [] } }),
});
Object.assign(opLog, {
  query: () => [],
  getLastSuccessfulRoiUpdate: () => null,
  log: () => 'mock-operation-id',
  attachReceipt: () => true,
});
const realExecuteWithReceipt = writeReceipt.executeWithReceipt;
Object.assign(writeReceipt, {
  executeWithReceipt: async options => {
    executeReceiptCalls++;
    lastReceiptOptions = options;
    if (forcedReceiptResult) {
      const value = forcedReceiptResult;
      forcedReceiptResult = null;
      return value;
    }
    const result = await options.write();
    return { ok: true, effect_status: 'confirmed', message: 'mock confirmed', operation_id: 'mock-operation-id',
      upstream_accepted: true, before: options.before, requested: options.requested, actual: options.requested,
      readback: { verified: true, target_id: String(options.logEntry.target_id) }, result };
  },
});
const actionLimits = require('../server-app/server/lib/actionLimits');
Object.assign(actionLimits, {
  getActionLimits: () => ({ update_budget: { allowed: true, remaining: 3 } }),
  assertActionAllowed: () => {},
});
const owner = require('../server-app/server/lib/boostExecutionOwner');
owner.assertBoostExecutionOwner = () => {};
const { handleCampaignBudget, handleCampaignStatus } = require('../server-app/server/routes/campaignOps');

function request(body, authorization, apiPath = '/api/campaign/budget', handler = handleCampaignBudget) {
  const req = new PassThrough();
  req.method = 'POST';
  req.url = apiPath;
  req.headers = { 'content-type': 'application/json' };
  req.socket = { remoteAddress: '127.0.0.1' };
  if (authorization) req._qcWriteAuthorization = authorization;
  req.end(JSON.stringify(body));
  const res = {
    statusCode: 200, headersSent: false, body: '',
    writeHead(status) { this.statusCode = status; this.headersSent = true; },
    end(value = '') { this.body += value; },
  };
  return { req, res, run: () => handler(req, res, new URL(`http://localhost${apiPath}`)),
    json: () => JSON.parse(res.body) };
}

function boostAuthorization({ planId = '88', taskIds } = {}) {
  return { allowed: true, accountId, scope: 'boost', action: 'update_budget', binding: {
    primary_ad_id: planId, room_id: 'room', session_started_at: '2026-09-22T00:00:00Z',
    allowed_actions: ['update_budget'], budget_adjustment: { max_increase_yuan: 100 },
    ...(taskIds ? { action_target_ids: { update_budget: taskIds } } : {}),
  } };
}

test('并发预算请求使用写锁和预期前值，只让一个请求提交', async () => {
  currentPlanBudget = 100; planWrites = 0; submittedOptions = []; executeReceiptCalls = 0;
  const first = request({ accountId, primaryAdId: '42', budget: 150, expectedBudget: 100 });
  const second = request({ accountId, primaryAdId: '42', budget: 150, expectedBudget: 100 });
  await Promise.all([first.run(), second.run()]);
  const results = [first, second].map(item => ({ status: item.res.statusCode, body: item.json() }));
  assert.equal(results.filter(result => result.body.effect_status === 'confirmed').length, 1);
  assert.equal(results.filter(result => result.body.code === 'budget_conflict').length, 1);
  assert.equal(planWrites, 1);
  assert.equal(currentPlanBudget, 150);
  assert.equal(submittedOptions[0].expectedBudget, 100);
});

test('追投场次明确授权后可按 expectedBudget 从100增至200', async () => {
  submittedOptions = []; executeReceiptCalls = 0;
  const call = request({ accountId, primaryAdId: '88', assistTaskId: '77', budget: 200, expectedBudget: 100 }, boostAuthorization());
  await call.run();
  assert.equal(call.res.statusCode, 200);
  assert.equal(call.json().effect_status, 'confirmed');
  assert.equal(submittedOptions[0].expectedBudget, 100);
});

test('混合ROI与预算请求发现预算冲突时向HTTP调用方明确返回待核验的部分结果', async () => {
  currentBoostBudget = 100;
  forcedReceiptResult = { ok: false, code: 'budget_conflict_after_partial_write', effect_status: 'unconfirmed',
    http_status: 409, error: '预算已变化', details: { expected_budget: 100, current_budget: 300 } };
  const call = request({ accountId, primaryAdId: '88', assistTaskId: '77', budget: 200, expectedBudget: 100 }, boostAuthorization());
  await call.run();
  const result = call.json();
  assert.equal(call.res.statusCode, 409);
  assert.equal(result.effect_status, 'unconfirmed');
  assert.equal(result.partial, true);
  assert.equal(result.upstream_accepted, true);
  assert.equal(result.advertising_writes, 1);
  assert.deepEqual(result.details.partial_effect, { roi_goal: 'upstream_accepted', budget: 'not_submitted' });
});

test('预算范围与预期值继续核验，旧只读环境变量不限制调用', async () => {
  const before = executeReceiptCalls;
  const mismatch = request({ accountId, primaryAdId: '88', assistTaskId: '77', budget: 200, expectedBudget: 100 }, boostAuthorization({ planId: 'other' }));
  await mismatch.run();
  assert.equal(mismatch.json().code, 'budget_increase_not_authorized');
  const missing = request({ accountId, primaryAdId: '88', assistTaskId: '77', budget: 200, expectedBudget: 100 });
  await missing.run();
  assert.equal(missing.json().code, 'budget_increase_not_authorized');
  assert.equal(executeReceiptCalls, before);

  const prior = process.env.QC_TRIAL_READ_ONLY;
  process.env.QC_TRIAL_READ_ONLY = '1';
  try {
    const readonly = request({ accountId, primaryAdId: '42', budget: 150, expectedBudget: 100 });
    await readonly.run();
    assert.equal(readonly.res.statusCode, 409);
    assert.equal(readonly.json().code, 'budget_conflict');
    assert.equal(executeReceiptCalls, before);
  } finally { process.env.QC_TRIAL_READ_ONLY = prior; }
});

test('相同预算返回带完整目标的 unchanged 回执且不调用写入口', async () => {
  currentPlanBudget = 100; planWrites = 0; executeReceiptCalls = 0;
  const call = request({ accountId, primaryAdId: '42', budget: 100, expectedBudget: 100 });
  await call.run();
  const receipt = call.json();
  assert.equal(receipt.effect_status, 'unchanged');
  assert.equal(receipt.advertising_writes, 0);
  assert.equal(receipt.upstream_accepted, false);
  assert.equal(receipt.readback.verified, true);
  assert.equal(receipt.readback.target_id, '42');
  assert.equal(receipt.actual.budget, receipt.requested.budget);
  assert.equal(planWrites, 0);
  assert.equal(executeReceiptCalls, 0);
});

test('相同追投状态返回带目标和零写入证据的 unchanged 回执', async () => {
  executeReceiptCalls = 0;
  const call = request({ accountId, primaryAdId: '88', assistTaskId: '77', status: 1 }, null,
    '/api/campaign/status', handleCampaignStatus);
  await call.run();
  const receipt = call.json();
  assert.equal(receipt.effect_status, 'unchanged');
  assert.equal(receipt.advertising_writes, 0);
  assert.equal(receipt.readback.verified, true);
  assert.equal(receipt.readback.target_id, '77');
  assert.equal(receipt.target_id, '77');
  assert.equal(executeReceiptCalls, 0);
});

test('追投局部预算写入不回填出价和定向；内层重读发现300时拒绝覆盖为200', async () => {
  // 验证路由会把 expectedBudget 透传到实际更新函数；模块级隔离 mock 避免任何上游请求。
  submittedOptions = [];
  const routeCall = request({ accountId, primaryAdId: '88', assistTaskId: '77', budget: 200, expectedBudget: 100 }, boostAuthorization());
  await routeCall.run();
  assert.equal(submittedOptions[0].expectedBudget, 100);
  assert.equal(lastReceiptOptions.before.budget, 100);
  assert.equal(lastReceiptOptions.before.bid, 5);
  assert.equal(lastReceiptOptions.before.smart_bid_type, 0);
  assert.deepEqual(lastReceiptOptions.preserveFields, ['budget', 'smart_bid_type', 'audience', 'bid']);

  const originalBoostList = tabs.fetchBoostList;
  const originalPlanList = tabs.fetchUniPromAdList;
  let upstreamRequests = 0;
  const https = require('node:https');
  const originalHttpsRequest = https.request;
  https.request = (...args) => { upstreamRequests++; return originalHttpsRequest(...args); };
  tabs.fetchBoostList = async () => ({ status_code: 0, data: { adInfos: [{
    id: '77', budget: currentBoostBudget * 100000, ecpRoi2Goal: 2, bid: 500_000, smartBidType: 0,
    audience: { CityDivide: 0 }, deepExternalAction: 0, name: 'mock task', externalAction: 169,
  }] } });
  tabs.fetchBoostMaterialDetail = async () => ({ data: { StatsData: { Rows: [{ Dimensions: { material_id: { Value: 'm1' } } }] } } });
  try {
    currentBoostBudget = 300;
    await assert.rejects(realUpdateCampaignBudgetAndROI('88', '77', 200, undefined, accountId, { expectedBudget: 100 }), error => {
      assert.equal(error.code, 'budget_conflict');
      assert.equal(error.statusCode, 409);
      return true;
    });
    assert.equal(upstreamRequests, 0);

    tabs.fetchUniPromAdList = async () => ({ data: { adInfos: [{ id: '42', budget: 30_000_000, ecpRoi2Goal: 2 }] } });
    await assert.rejects(realUpdateCampaignBudgetAndROI('42', undefined, 200, undefined, accountId, { expectedBudget: 100 }), error => {
      assert.equal(error.code, 'budget_conflict');
      assert.equal(error.details.current_budget, 300);
      return true;
    });
    assert.equal(upstreamRequests, 0);

    let planReadCount = 0;
    tabs.fetchUniPromAdList = async () => {
      planReadCount++;
      const budget = planReadCount <= 2 ? 10_000_000 : 30_000_000;
      return { data: { adInfos: [{ id: '42', budget, ecpRoi2Goal: 2 }] } };
    };
    const mixedWritePaths = [];
    https.request = (options, onResponse) => {
      const req = new EventEmitter();
      req.setTimeout = () => req;
      req.write = () => true;
      req.destroy = () => req;
      req.end = () => queueMicrotask(() => {
        mixedWritePaths.push(options.path);
        const response = new EventEmitter();
        response.statusCode = 200;
        response.setEncoding = () => {};
        onResponse(response);
        response.emit('data', '{"status_code":0}');
        response.emit('end');
      });
      return req;
    };
    await assert.rejects(realUpdateCampaignBudgetAndROI('42', undefined, 200, 2.1, accountId, { expectedBudget: 100 }), error => {
      assert.equal(error.code, 'budget_conflict_after_partial_write');
      assert.equal(error.effect_status, 'unconfirmed');
      assert.equal(error.upstream_accepted, true);
      assert.equal(error.advertising_writes, 1);
      assert.deepEqual(error.partial_effect, { roi_goal: 'upstream_accepted', budget: 'not_submitted' });
      assert.deepEqual(error.details.partial_effect, error.partial_effect);
      return true;
    });
    assert.equal(mixedWritePaths.length, 1);
    assert.match(mixedWritePaths[0], /update_uni_promotion_roi/);

    planReadCount = 0;
    mixedWritePaths.length = 0;
    tabs.fetchUniPromAdList = async () => {
      planReadCount++;
      if (planReadCount <= 2) return { data: { adInfos: [{ id: '42', budget: 10_000_000, ecpRoi2Goal: 2 }] } };
      throw new Error('mock budget reread failed');
    };
    await assert.rejects(realUpdateCampaignBudgetAndROI('42', undefined, 200, 2.1, accountId, { expectedBudget: 100 }), error => {
      assert.equal(error.code, 'budget_verification_failed_after_partial_write');
      assert.equal(error.upstream_accepted, true);
      assert.deepEqual(error.partial_effect, { roi_goal: 'upstream_accepted', budget: 'not_submitted' });
      return true;
    });
    assert.equal(mixedWritePaths.length, 1);
    assert.match(mixedWritePaths[0], /update_uni_promotion_roi/);

    planReadCount = 0;
    mixedWritePaths.length = 0;
    tabs.fetchUniPromAdList = async () => ({ data: { adInfos: [{ id: '42', budget: 10_000_000, ecpRoi2Goal: 2 }] } });
    https.request = (options, onResponse) => {
      const req = new EventEmitter();
      req.setTimeout = () => req;
      req.write = () => true;
      req.destroy = () => req;
      req.end = () => queueMicrotask(() => {
        mixedWritePaths.push(options.path);
        const response = new EventEmitter();
        response.statusCode = options.path.includes('batch_update_budget') ? 500 : 200;
        response.setEncoding = () => {};
        onResponse(response);
        response.emit('data', options.path.includes('batch_update_budget') ? 'mock failure' : '{"status_code":0}');
        response.emit('end');
      });
      return req;
    };
    await assert.rejects(realUpdateCampaignBudgetAndROI('42', undefined, 200, 2.1, accountId, { expectedBudget: 100 }), error => {
      assert.equal(error.code, 'budget_submission_failed_after_partial_write');
      assert.equal(error.upstream_accepted, true);
      assert.deepEqual(error.partial_effect, { roi_goal: 'upstream_accepted', budget: 'unknown' });
      return true;
    });
    assert.equal(mixedWritePaths.length, 2);
    assert.match(mixedWritePaths[0], /update_uni_promotion_roi/);
    assert.match(mixedWritePaths[1], /batch_update_budget/);

    const mockMixedResponses = budgetResponse => {
      mixedWritePaths.length = 0;
      https.request = (options, onResponse) => {
        const req = new EventEmitter();
        req.setTimeout = () => req;
        req.write = () => true;
        req.destroy = () => req;
        req.end = () => queueMicrotask(() => {
          mixedWritePaths.push(options.path);
          const response = new EventEmitter();
          const isBudget = options.path.includes('batch_update_budget');
          response.statusCode = isBudget ? (budgetResponse.httpStatus || 200) : 200;
          response.setEncoding = () => {};
          onResponse(response);
          response.emit('data', JSON.stringify(isBudget ? budgetResponse.body : { status_code: 0 }));
          response.emit('end');
        });
        return req;
      };
    };
    mockMixedResponses({ body: { status_code: 40002, message: 'mock budget rejected' } });
    await assert.rejects(realUpdateCampaignBudgetAndROI('42', undefined, 200, 2.1, accountId, { expectedBudget: 100 }), error => {
      assert.equal(error.code, 'budget_rejected_after_partial_write');
      assert.equal(error.effect_status, 'unconfirmed');
      assert.equal(error.upstream_accepted, true);
      assert.equal(error.upstream_code, 40002);
      assert.deepEqual(error.partial_effect, { roi_goal: 'upstream_accepted', budget: 'rejected' });
      return true;
    });
    assert.equal(mixedWritePaths.length, 2);

    mockMixedResponses({ httpStatus: 401, body: { error: 'expired' } });
    await assert.rejects(realUpdateCampaignBudgetAndROI('42', undefined, 200, 2.1, accountId, { expectedBudget: 100 }), error => {
      assert.equal(error.code, 'budget_submission_failed_after_partial_write');
      assert.equal(error.statusCode, 401);
      assert.equal(error.upstream_code, 'cookie_expired');
      assert.equal(error.upstream_accepted, true);
      assert.equal(error.advertising_writes, undefined);
      assert.deepEqual(error.partial_effect, { roi_goal: 'upstream_accepted', budget: 'unknown' });
      return true;
    });
    assert.equal(mixedWritePaths.length, 2);

    mockMixedResponses({ body: { message: 'missing status' } });
    await assert.rejects(realUpdateCampaignBudgetAndROI('42', undefined, 200, 2.1, accountId, { expectedBudget: 100 }), error => {
      assert.equal(error.code, 'budget_submission_failed_after_partial_write');
      assert.equal(error.upstream_code, 'missing_status_code');
      assert.equal(error.upstream_accepted, true);
      assert.equal(error.advertising_writes, undefined);
      assert.deepEqual(error.partial_effect, { roi_goal: 'upstream_accepted', budget: 'unknown' });
      return true;
    });
    assert.equal(mixedWritePaths.length, 2);

    currentBoostBudget = 100;
    await assert.rejects(realUpdateCampaignBudgetAndROI('88', '77', 200, undefined, accountId, {
      expectedBudget: 100,
      beforeWrite: () => { throw Object.assign(new Error('execution owner revoked'), { code: 'execution_owner_stopped', statusCode: 409, skipOpLog: true }); },
    }), error => error.code === 'execution_owner_stopped');
    assert.equal(upstreamRequests, 0);

    currentBoostBudget = 100;
    let submittedBody;
    https.request = (options, onResponse) => {
      upstreamRequests++;
      const req = new EventEmitter();
      req.setTimeout = () => req;
      req.write = value => { submittedBody = JSON.parse(value); return true; };
      req.destroy = () => req;
      req.end = () => queueMicrotask(() => {
        const response = new EventEmitter();
        response.statusCode = 200;
        response.setEncoding = () => {};
        onResponse(response);
        response.emit('data', '{"status_code":0}');
        response.emit('end');
      });
      return req;
    };
    const accepted = await realUpdateCampaignBudgetAndROI('88', '77', 200, undefined, accountId, { expectedBudget: 100 });
    assert.equal(accepted.status_code, 0);
    assert.deepEqual(submittedBody, { ForceAsync: false, AdsData: [{ AdId: '77', AdBudget: 20_000_000 }] });
    assert.equal(accepted.confirmation_pending, true);
  } finally {
    https.request = originalHttpsRequest;
    tabs.fetchBoostList = originalBoostList;
    tabs.fetchUniPromAdList = originalPlanList;
  }
});

test.after(() => {
  writeReceipt.executeWithReceipt = realExecuteWithReceipt;
});
