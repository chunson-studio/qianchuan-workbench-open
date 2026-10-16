'use strict';
require('./setup-runtime.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const runtimeRoot = process.env.QC_RUNTIME_CONFIG_ROOT;
const configFile = path.join(runtimeRoot, 'config.json');
const policy = { account_policies: { decide_a: { mode: 'auto_guarded', allow_boost_write: false,
  boost_write_scope: { primary_ad_id: '123456', room_id: 'room-a', session_started_at: '2026-09-26T00:00:00Z' } } } };
fs.writeFileSync(configFile, JSON.stringify({ qianchuan_accounts: [{ id: 'decide_a', aavid: '12345', name: 'Test account', cookieFile: 'unused.txt' }], agent_policy: policy }));
const onboarding = require('../server-app/server/lib/accountOnboarding');
const cfg = require('../server-app/server/lib/config');
const { describeExecutionPolicy } = require('../server-app/server/lib/agentPolicy');
const { healthReport, entryIdentity } = require('../server-app/scripts/start-workbench');

test('接入保存保留已有账户策略，旧模式只是偏好，身份预演与版本控制仍生效', async () => {
  const options = { configPath: configFile, profileDir: cfg.ACCOUNT_PROFILES_DIR, scriptsDir: cfg.SCRIPTS_DIR,
    cookieReader: () => 'test-only-credential', applyRegistry: () => {},
    identity: async () => ({ status_code: 0, data: { accountInfo: { advId: '12345', advName: 'Test account' } } }),
    plans: async () => ({ data: { adInfos: [{ id: '123456', aavid: '12345', name: 'Test plan' }] } }),
    live: async () => ({ isLive: true }), balance: async () => ({ data: { balanceInfos: { cash: { valid: 0 } } } }) };
  const initial = onboarding.getStatus('decide_a', options);
  assert.equal(initial.questions.some(q => q.key === 'mode'), false);
  const draft = await onboarding.updateDraft('decide_a', { revision: initial.revision, answers: { mode: 'recommendation_only' } }, options);
  assert.equal(draft.authorization.effective_mode, 'agent_decides');
  assert.deepEqual(draft.authorization.write_blockers, []);
  await assert.rejects(onboarding.save('decide_a', { revision: draft.revision, confirm: true }, options), { code: 'rehearsal_required' });
  const rehearsal = await onboarding.rehearse('decide_a', options);
  const saved = await onboarding.save('decide_a', { revision: rehearsal.revision, confirm: true }, options);
  assert.equal(saved.account_ready, true);
  assert.equal(saved.authorization.enforced_by_workbench, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile, 'utf8')).agent_policy, policy);
  const profile = JSON.parse(fs.readFileSync(path.join(cfg.ACCOUNT_PROFILES_DIR, 'decide_a.json'), 'utf8'));
  assert.equal(profile.safety.mode, 'agent_decides');
  assert.equal(profile.metrics.break_even_roi, null);
});

test('可选动作范围缺省不会被投影为空许可表，显式空表继续保留', () => {
  const p = structuredClone(policy);
  assert.equal(Object.hasOwn(describeExecutionPolicy(p, 'decide_a').boost_write_scope, 'allowed_actions'), false);
  p.account_policies.decide_a.boost_write_scope.allowed_actions = [];
  assert.deepEqual(describeExecutionPolicy(p, 'decide_a').boost_write_scope.allowed_actions, []);
});

test('单次巡检分别识别本项目进程、错误进程与断线，不启动服务', async () => {
  const config = { url: 'http://127.0.0.1:18991', entry: path.resolve('server-app/server.js') };
  const valid = { ok: true, component: 'http_process', entrypoint_id: entryIdentity(config.entry), pid: 123 };
  assert.equal((await healthReport(config, async () => valid)).code, 'service_healthy');
  assert.equal((await healthReport(config, async () => ({ ...valid, entrypoint_id: 'other' }))).code, 'service_identity_mismatch');
  assert.equal((await healthReport(config, async () => { throw Error('offline'); })).code, 'service_unreachable');
});
