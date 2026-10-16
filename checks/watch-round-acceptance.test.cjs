'use strict';
require('./setup-runtime.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const accounts = ['accept_a', 'accept_b', 'accept_c'];
const cfg = { qianchuan_accounts: accounts.map(id => ({id,aavid:'123',cookieFile:'unused.txt'})) };
fs.writeFileSync(path.join(process.env.QC_RUNTIME_CONFIG_ROOT, 'config.json'), JSON.stringify(cfg));
const { describeExecutionPolicy } = require('../server-app/server/lib/agentPolicy');
const { checkBoostElimination } = require('../server-app/server/lib/onboardingGuard');
const ledger = require('../server-app/server/lib/decisionLedger');
const { buildSnapshotId } = require('../server-app/server/lib/dataContract');
const { resolveRoundAccount, bindTrustedSnapshot, bindVerifiedActions } = require('../server-app/server/routes/decisionRounds')._test;
const opLog = require('../server-app/server/lib/operationLog');

test('操作由 Agent 决定，显式场次范围不跨账户继承', () => {
  const policy = {mode:'auto_guarded', allow_boost_write:true, account_policies:{
    accept_a:{mode:'auto_guarded', allow_boost_write:true, allow_plan_write:false, boost_write_scope:{
      primary_ad_id:'plan-a',room_id:'room-a',session_started_at:'2026-09-21T07:00:00Z',allowed_actions:['create','delete'],
      elimination:{zero_order_min_cost:10,order_roi_below:3},cookie:'must-not-leak'}},
    accept_b:{mode:'recommendation_only'},
    accept_c:{mode:'auto_guarded',allow_boost_write:true,onboarding_managed:true}
  }};
  const before = JSON.stringify(policy);
  const a = describeExecutionPolicy(policy,'accept_a');
  assert.equal(a.effective_mode,'agent_decides');
  assert.equal(a.scopes.boost.permitted_by_policy,true);
  assert.equal(a.scopes.plan.permitted_by_policy,true);
  assert.equal(a.boost_write_scope.room_id,'room-a');
  assert.equal(a.requires_live_write_precheck,true);
  assert.equal(a.boost_write_scope.cookie,undefined);
  for (const id of ['accept_b','accept_c','missing']) assert.equal(describeExecutionPolicy(policy,id).effective_mode,'agent_decides');
  assert.equal(describeExecutionPolicy(policy,'accept_a',{trialReadOnly:true}).effective_mode,'agent_decides');
  for (const id of ['accept_b','accept_c','missing']) assert.equal(describeExecutionPolicy(policy,id).boost_write_scope,null);
  assert.equal(JSON.stringify(policy),before);
});

test('三套不同淘汰阈值互不混用；零单不足测试金额、阈值等号和未知指标均不误删', () => {
  const metrics = (cost, orders, roi) => ({statCostForRoi2Assist:{value:cost},totalPayOrderCountForRoi2Assist:{value:orders},totalPrepayAndPayOrderRoi2Assist:{value:roi}});
  for (const floor of [2.4,4,9]) {
    const rule = {zero_order_min_cost:10,order_roi_below:floor};
    assert.equal(checkBoostElimination(metrics(9.99,0,0),rule).allowed,false);
    assert.equal(checkBoostElimination(metrics(10,0,null),rule).allowed,true);
    assert.equal(checkBoostElimination(metrics(20,1,floor),rule).allowed,false);
    assert.equal(checkBoostElimination(metrics(20,1,floor-0.01),rule).allowed,true);
    assert.equal(checkBoostElimination(metrics(20,null,0),rule).allowed,false);
    assert.equal(checkBoostElimination(metrics(20,1,null),rule).allowed,false);
  }
});

test('决策账户在 query、body 与嵌套 round 冲突时拒绝，不能静默写错店', () => {
  const url = new URL('http://local/api/decision-rounds?account=accept_a');
  assert.equal(resolveRoundAccount(url,{account_id:'accept_a',round:{account_id:'accept_a'}}),'accept_a');
  for (const body of [{account_id:'accept_b'},{accountId:'accept_c'},{round:{account_id:'accept_b'}}]) {
    assert.throws(()=>resolveRoundAccount(url,body),{code:'account_conflict'});
  }
  assert.throws(()=>resolveRoundAccount(new URL(url+'&accountId=accept_b')),{code:'account_conflict'});
  assert.throws(()=>resolveRoundAccount(url,[]),{code:'invalid_round'});
  assert.throws(()=>resolveRoundAccount(url,{round:[]}),{code:'invalid_round'});
});

test('无操作轮次可留底、重试幂等、同轮次 ID 按账号隔离且不能替换场次内容', () => {
  const observed_at = '2026-09-21T07:00:00Z';
  const round = {round_id:'round-001',phase:'live',session_key:'accept_a|room|start',observed_at,actions:[],summary:'保留观察'};
  const first = ledger.recordRound('accept_a',round);
  assert.equal(ledger.recordRound('accept_a',round).duplicate,true);
  const second = ledger.recordRound('accept_b',{...round,session_key:'accept_b|room|start'});
  assert.notEqual(first.round.round_id,second.round.round_id);
  assert.equal(ledger.listRounds('accept_a').length,1);
  assert.equal(ledger.listRounds('accept_b').length,1);
  assert.deepEqual(ledger.listRounds('accept_a')[0].actions,[]);
  assert.throws(()=>ledger.recordRound('accept_a',{...round,session_key:'accept_a|next|start'}),{code:'decision_round_conflict'});
  assert.throws(()=>ledger.recordRound('accept_a',{...round,round_id:'round-002',session_key:null}),{code:'session_key_required'});
});

test('错误快照场次不能绑定；别店操作回执不能冒充本店已执行', () => {
  const meta = {account_id:'accept_a',session_key:'accept_a|room|start',source_at:'2026-09-21T07:00:00Z',data_valid:true};
  const metrics = {spend:12};
  const snapshot_id = buildSnapshotId(meta,metrics);
  ledger.recordSnapshot('accept_a',{meta,metrics,snapshot_id});
  assert.equal(bindTrustedSnapshot('accept_a',{session_key:meta.session_key,snapshot:{snapshot_id,metrics:{spend:999}}}).snapshot.metrics.spend,12);
  assert.throws(()=>bindTrustedSnapshot('accept_a',{session_key:'accept_a|another|start',snapshot:{snapshot_id}}),{code:'snapshot_session_mismatch'});
  assert.equal(bindTrustedSnapshot('accept_b',{snapshot:{snapshot_id}}).snapshot.verified,false);
  const id = opLog.log({account_id:'accept_b',action:'boost_create',success:true,target_id:'test',source:'e2e'});
  assert.ok(id);
  assert.equal(bindVerifiedActions('accept_a',{actions:[{operation_id:id,success:true}]}).actions[0].verified,false);
});

test.after(()=>ledger.closeAll());
