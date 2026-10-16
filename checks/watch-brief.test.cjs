'use strict';
require('./setup-runtime.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildBrief, collectBrief, loadScope } = require('../tools/watch-brief.cjs');
const { buildLiveSummary } = require('../server-app/server/lib/mcpClean');
const now = Date.parse('2026-09-29T14:00:00Z'), at = new Date(now).toISOString();
const binding = { account_id: 'test', primary_ad_id: 'plan', room_id: 'room', start_time: '2026-09-29 19:30:00' };
function fixtures() {
  const summary = buildLiveSummary({ account: 'test', session_key: 'test|room|2026-09-29 19:30:00',
    fetchedAt: at, server_time: at, dataValid: true, liveCheckedAt: at,
    live: { isLive: true, roomId: 'room', startTime: binding.start_time },
    today: { cost: 100, gmv: 1100, roi: 11, netGmv: 900, netRoi: 9, orderCount: 10 },
  });
  const task = (id, status, cost, orders, roi) => ({ id, primary_ad_id: 'plan',
    status: status === 1 ? '投放中' : '已暂停', status_code: status, source_at: at,
    create_time: Date.parse('2026-09-29T12:00:00Z') / 1000, cost, order_count: orders, net_roi: roi,
    metric_roi_basis: { net_roi: 'platform_net_1h' } });
  const tasks = [task('zero', 1, 5, 0, 0), task('low', 1, 10, 1, 7.9), task('keep', 1, 10, 1, 8),
    task('resume', 2, 10, 2, 10), task('wait', 2, 10, 2, 9.99)];
  const list = { ok: true, account: 'test', ad_id: 'plan', data_valid: true, truncated: false,
    source_at: at, total_tasks: tasks.length, date_range: '2026-09-29 ~ 2026-09-29', tasks };
  const policy = { protectedIds: [], digest: 'fixture', scope: {
    primary_ad_id: 'plan', room_id: 'room', session_started_at: binding.start_time,
    allowed_actions: ['pause','resume'], concurrency: { max_active_tasks: 4 }, judgment_basis: { primary: 'net_roi' },
    hysteresis_rules: { pause_active_below: 8, resume_paused_at_or_above: 10, hard_stop_below: 3.5, zero_order_gate_yuan: 5 },
  } };
  return { summary, list, policy };
}
test('真实 summary 契约下计算滞回建议，保留场次和口径且不执行', () => {
  const { summary, list, policy } = fixtures();
  const brief = buildBrief(binding, summary, list, policy, now);
  assert.equal(brief.ok, true); assert.equal(brief.executable, false);
  assert.deepEqual(brief.suggestions.map(t => [t.id,t.action]), [['zero','pause'],['low','pause'],['resume','resume']]);
  assert.equal(brief.metrics.net_roi, 9); assert.equal(brief.metrics.payment_minus_net_gmv, 200);
  assert.equal(brief.snapshot_id, summary.snapshot_id);
  assert.ok(brief.suggestions.every(t => t.metric_scope === 'task_date_range'));
});
test('未知数不补零，人工保护和已满容量不生成恢复，暂停不抵扣名额', () => {
  const { summary, list, policy } = fixtures();
  list.tasks[0].order_count = null; list.tasks[1].net_roi = null;
  policy.scope.concurrency.max_active_tasks = 3;
  let brief = buildBrief(binding, summary, list, policy, now);
  assert.equal(brief.suggestions.length, 0); assert.equal(brief.quality.missing.length, 3);
  policy.scope.concurrency.max_active_tasks = 4;
  list.tasks[3].available_actions = { resume: { allowed: false } };
  brief = buildBrief(binding, summary, list, policy, now);
  assert.equal(brief.suggestions.length, 0);
  assert.ok(brief.quality.missing.some(t => t.code === 'action_requires_review'));
});
test('错误绑定、陈旧数据、分页、口径不明和统计窗冲突不产生动作建议', () => {
  for (const mutate of [
    x => x.summary.live.room_id = 'other', x => x.summary.meta.source_at = '2026-09-29T13:00:00Z',
    x => x.list.truncated = true, x => x.list.source_at = null,
    x => x.summary.financial_checks.net_roi.roi_basis = 'payment',
    x => x.list.date_range = '2026-09-28 ~ 2026-09-29',
    x => x.list.tasks[0].status = '已暂停', x => x.policy.scope.hysteresis_rules = null,
  ]) {
    const f = fixtures(); mutate(f);
    const brief = buildBrief(binding, f.summary, f.list, f.policy, now);
    assert.equal(brief.ok, false); assert.equal(brief.suggestions.length, 0);
  }
  const f = fixtures(); f.list.tasks = []; f.list.total_tasks = 0; f.list.source_at = null;
  assert.ok(buildBrief(binding, f.summary, f.list, f.policy, now).quality.errors.includes('boost_data_stale'));
});
test('任务数量独立于建议规则和直播财务质量，坏列表仍保持未知', () => {
  const f = fixtures(); f.policy.scope.hysteresis_rules = null;
  let brief = buildBrief(binding, f.summary, f.list, f.policy, now);
  assert.equal(brief.ok, false);
  assert.ok(brief.quality.errors.includes('controller_rules_unavailable'));
  assert.deepEqual(brief.counts, { active: 3, paused: 2, awaiting_live: 0 });
  assert.equal(brief.counts_quality.data_valid, true);
  assert.equal(brief.counts_quality.scope, 'primary_plan_date_range');
  assert.deepEqual(brief.suggestions, []);
  f.summary.meta.data_valid = false;
  assert.equal(buildBrief(binding, f.summary, f.list, f.policy, now).counts.active, 3);
  for (const mutate of [x => x.list.truncated = true, x => x.list.source_at = null,
    x => x.list.ad_id = 'other', x => x.list.total_tasks = 999,
    x => x.list.tasks[0].status = '已暂停', x => x.list.tasks[0].id = x.list.tasks[1].id]) {
    const bad = fixtures(); mutate(bad);
    brief = buildBrief(binding, bad.summary, bad.list, bad.policy, now);
    assert.equal(brief.counts_quality.data_valid, false);
    assert.equal(brief.counts.active, null); assert.equal(brief.counts.paused, null);
    assert.deepEqual(brief.suggestions, []);
  }
  const waiting = fixtures(); waiting.list.tasks[0].status = '关联直播间未开播'; waiting.list.tasks[0].status_code = 1;
  brief = buildBrief(binding, waiting.summary, waiting.list, waiting.policy, now);
  assert.equal(brief.counts.awaiting_live, 1);
  assert.equal(brief.counts.active, 2); assert.equal(brief.counts.paused, 2);
});
test('同日旧任务仅在显式接管清单中才提出建议，动作时效与目标清单有效', () => {
  const f = fixtures(); f.list.tasks[0].create_time = Date.parse('2026-09-29T10:00:00Z') / 1000;
  assert.ok(!buildBrief(binding, f.summary, f.list, f.policy, now).suggestions.some(t => t.id === 'zero'));
  f.policy.scope.carryover_task_ids = ['zero'];
  assert.ok(buildBrief(binding, f.summary, f.list, f.policy, now).suggestions.some(t => t.id === 'zero'));
  f.policy.scope.action_target_ids = { pause: ['low'] }; f.policy.scope.action_expires_at = { resume: '2026-09-29T13:00:00Z' };
  assert.deepEqual(buildBrief(binding, f.summary, f.list, f.policy, now).suggestions.map(t => t.id), ['low']);
});
test('采集仅访问显式本机 GET，期间策略变化清空建议，不泄露配置', async () => {
  const f = fixtures(), configFile = path.join(process.env.QC_RUNTIME_CONFIG_ROOT, 'brief.json');
  const config = { qianchuan_accounts: [{ id: 'test', cookie: 'secret' }], agent_policy: { account_policies: { test: { boost_write_scope: f.policy.scope } } } };
  const save = () => fs.writeFileSync(configFile, JSON.stringify(config)); save();
  const old = loadScope(configFile, binding).digest, calls = [];
  const fetcher = async (url, options) => {
    calls.push([url, options]);
    if (url.pathname === '/api/boost-list') { config.agent_policy.account_policies.test.protected_object_ids = ['zero']; save(); }
    return { ok: true, json: async () => url.pathname === '/api/live-summary' ? f.summary : f.list };
  };
  const result = await collectBrief({ binding, config: configFile, url: 'http://127.0.0.1:18991' }, fetcher);
  assert.equal(calls.length, 2); assert.ok(calls.every(([u,o]) => o.method === 'GET' && o.redirect === 'error' && u.searchParams.get('account') === 'test'));
  assert.equal(calls.find(([u]) => u.pathname === '/api/live-summary')[0].searchParams.get('include_boosts'), '0');
  assert.equal(result.brief.ok, false); assert.ok(result.brief.quality.errors.includes('policy_changed_during_read'));
  assert.equal(result.brief.suggestions.length, 0); assert.notEqual(old, loadScope(configFile, binding).digest);
  assert.equal(JSON.stringify(result).includes('secret'), false);
  await assert.rejects(collectBrief({ binding, config: configFile, url: 'https://example.com' }, fetcher), /local_service_required/);
  delete config.agent_policy.account_policies.test; save();
  assert.throws(() => loadScope(configFile, binding), /account_policy_unavailable/);
});
