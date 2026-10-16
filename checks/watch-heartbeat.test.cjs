'use strict';
require('./setup-runtime.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { formatHeartbeat, buildBrief, loadScope } = require('../tools/watch-brief.cjs');
const root = process.env.QC_RUNTIME_CONFIG_ROOT;
const now = Date.parse('2026-09-29T14:00:00Z'), at = new Date(now).toISOString();
const binding = { account_id: 'heartbeat_test', primary_ad_id: 'fixture-plan', room_id: 'fixture-room', start_time: '2026-09-29 19:30:00' };
const scope = { primary_ad_id: binding.primary_ad_id, room_id: binding.room_id, session_started_at: binding.start_time,
  allowed_actions: ['pause', 'resume'], concurrency: { max_active_tasks: 15 }, judgment_basis: { primary: 'net_roi' },
  hysteresis_rules: { pause_active_below: 8, resume_paused_at_or_above: 10, hard_stop_below: 3.5, zero_order_gate_yuan: 5 } };
const configFile = path.join(root, 'heartbeat-config.json');
const config = { qianchuan_accounts: [{ id: binding.account_id, cookie: 'fictional_sensitive_config_value' }],
  agent_policy: { account_policies: { [binding.account_id]: { boost_write_scope: scope } } } };
fs.writeFileSync(configFile, JSON.stringify(config));
const policy = loadScope(configFile, binding);
function fixture() {
  const tasks = Array.from({ length: 15 }, (_, i) => ({ id: 'fixture-task-' + i, primary_ad_id: binding.primary_ad_id,
    status: i < 3 ? '投放中' : '已暂停', status_code: i < 3 ? 1 : 2, source_at: at,
    create_time: Date.parse('2026-09-29T12:00:00Z') / 1000, cost: 10, order_count: 1, net_roi: 9,
    metric_roi_basis: { net_roi: 'platform_net_1h' } }));
  return { summary: { ok: true, snapshot_id: 'snapshot-0123456789abcdef0123456789abcdef', metrics_scope: 'current_session',
    meta: { account_id: binding.account_id, data_valid: true, stale: false, partial: false, source_at: at },
    live: { is_live: true, room_id: binding.room_id, start_time: binding.start_time, live_checked_at: at },
    financial_checks: { net_roi: { roi_basis: 'platform_net_1h', data_valid: true } },
    metrics: { spend: 100, payment_roi: 11, net_roi: 9, payment_gmv: 1100, net_gmv: 900 } },
  list: { ok: true, account: binding.account_id, ad_id: binding.primary_ad_id, data_valid: true, truncated: false,
    source_at: at, total_tasks: tasks.length, date_range: '2026-09-29 ~ 2026-09-29', tasks } };
}
const fixtureFile = path.join(root, 'heartbeat-fixture.json'), callsFile = path.join(root, 'heartbeat-calls.json');
const preload = path.join(root, 'heartbeat-preload.cjs');
fs.writeFileSync(preload, `
  require(${JSON.stringify(path.resolve(__dirname, 'setup-runtime.cjs'))});
  const fs = require('node:fs'), assert = require('node:assert/strict');
  require('node:test').mock.timers.enable({ apis: ['Date'], now: ${now} });
  const input = JSON.parse(fs.readFileSync(${JSON.stringify(fixtureFile)}, 'utf8'));
  const calls = [], output = ${JSON.stringify(callsFile)};
  fs.writeFileSync(output, '[]');
  global.fetch = async (value, options) => {
    const url = new URL(value);
    assert.equal(url.origin, 'http://127.0.0.1:18991');
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error');
    assert.equal(url.searchParams.get('account'), 'heartbeat_test');
    assert.ok(['/api/live-summary', '/api/boost-list'].includes(url.pathname));
    if (url.pathname === '/api/live-summary') {
      assert.equal(url.searchParams.get('room_id'), 'fixture-room');
      assert.equal(url.searchParams.get('start_time'), '2026-09-29 19:30:00');
    } else assert.equal(url.searchParams.get('adId'), 'fixture-plan');
    calls.push(url.pathname); fs.writeFileSync(output, JSON.stringify(calls));
    return { ok: true, json: async () => url.pathname === '/api/live-summary' ? input.summary : input.list };
  };
`);
function cli(input = fixture(), format, configPath = configFile) {
  fs.writeFileSync(fixtureFile, JSON.stringify(input));
  const args = ['--require', preload, path.resolve(__dirname, '../tools/watch-brief.cjs'),
    '--account-id', binding.account_id, '--primary-ad-id', binding.primary_ad_id, '--room-id', binding.room_id,
    '--start-time', binding.start_time, '--config', configPath, '--url', 'http://127.0.0.1:18991', '--output-dir', root];
  if (format) args.push('--format', format);
  return spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true, timeout: 15000 });
}
function briefPath(stdout) {
  const first = stdout.trimEnd().split('\n')[0], marker = ' brief_file=';
  return JSON.parse(first.slice(first.indexOf(marker) + marker.length));
}
test('heartbeat preserves unknown/zero, complete identity and audit references without mutating evidence', () => {
  const f = fixture(), brief = buildBrief(binding, f.summary, f.list, policy, now);
  brief.metrics.cost = 0; brief.metrics.net_roi = null; brief.counts.active = null; brief.counts.paused = 0;
  brief.quality.partial = true; brief.quality.missing = [{ id: 'one', code: 'task_metrics_unavailable' }];
  brief.suggestions = [{ action: 'pause', id: 'one', reason: 'fixture_suggestion' }];
  brief.snapshot_id += '\ncontinuation';
  const before = JSON.stringify(brief), file = path.join(root, 'full-evidence.brief.json');
  const output = formatHeartbeat(brief, file);
  assert.equal(JSON.stringify(brief), before);
  assert.match(output, /消耗=0/); assert.match(output, /净1hROI=未知/);
  assert.match(output, /在投=未知 暂停=0/); assert.match(output, /任务缺项=1 建议=1/);
  assert.match(output, /未执行/); assert.match(output, /定点读取完整证据/);
  assert.equal(output.split('\n').length, 2, 'embedded source newline must be escaped');
  assert.ok(output.includes('snapshot_id=' + JSON.stringify(brief.snapshot_id)));
  assert.ok(output.includes('policy_digest=' + JSON.stringify(policy.digest)));
  assert.ok(output.includes('account=' + JSON.stringify(binding.account_id)));
  assert.equal(briefPath(output), file);
});
test('CLI heartbeat changes stdout only, retains complete files and measures bytes including evidence reference', t => {
  const full = cli(), heartbeat = cli(fixture(), 'heartbeat');
  for (const result of [full, heartbeat]) assert.equal(result.status, 0, result.stderr || result.stdout);
  const json = JSON.parse(full.stdout), storedFull = JSON.parse(fs.readFileSync(json.evidence_file.replace(/\.raw\.json$/, '.brief.json'), 'utf8'));
  assert.deepEqual(json, storedFull, 'default stdout remains the complete brief JSON');
  assert.equal(heartbeat.stdout.trimEnd().split('\n').length, 1);
  assert.match(heartbeat.stdout, /在投=3 暂停=12/); assert.match(heartbeat.stdout, /质量=有效 错误=0 任务缺项=0 建议=0/);
  const file = briefPath(heartbeat.stdout), stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  const withoutFile = ({ evidence_file, ...value }) => value;
  assert.deepEqual(withoutFile(stored), withoutFile(json));
  assert.equal(stored.executable, false);
  const raw = JSON.parse(fs.readFileSync(stored.evidence_file, 'utf8'));
  assert.deepEqual(raw.summary, fixture().summary); assert.deepEqual(raw.list, fixture().list);
  assert.deepEqual(raw.binding, binding); assert.equal(raw.policy_digest, policy.digest);
  assert.equal(JSON.parse(fs.readFileSync(callsFile, 'utf8')).length, 2);
  assert.equal(full.stdout.includes('fictional_sensitive_config_value'), false);
  const originalBytes = Buffer.byteLength(full.stdout), heartbeatBytes = Buffer.byteLength(heartbeat.stdout);
  assert.ok(heartbeatBytes < originalBytes, `${heartbeatBytes}/${originalBytes}`);
  t.diagnostic(JSON.stringify({ sample: '15 synthetic tasks, 3 active and 12 paused, no suggestions',
    json_stdout_bytes: originalBytes, heartbeat_stdout_bytes: heartbeatBytes,
    reduction_percent: +(100 * (1 - heartbeatBytes / originalBytes)).toFixed(2),
    includes: 'newline, full identity, timestamps, snapshot, policy digest and brief file reference',
    measure: 'UTF-8 bytes, not tokens or billed usage', real_network_requests: 0 }));
  const needsReview = fixture(); needsReview.list.tasks[0].net_roi = 7;
  const pending = cli(needsReview, 'heartbeat'); assert.equal(pending.status, 0, pending.stderr);
  assert.equal(pending.stdout.trimEnd().split('\n').length, 2); assert.match(pending.stdout, /建议=1/);
  const savedPending = JSON.parse(fs.readFileSync(briefPath(pending.stdout), 'utf8'));
  assert.deepEqual(savedPending.suggestions.map(row => [row.action, row.id]), [['pause', 'fixture-task-0']]);
  assert.equal(savedPending.executable, false);
});
test('malformed config returns stable errors without echoing JSON fragments or issuing requests', () => {
  const malformed = path.join(root, 'invalid-config.json');
  fs.writeFileSync(malformed, '{"cookie":"fictional_credential_fragment_DO_NOT_ECHO", broken}');
  assert.throws(() => loadScope(malformed, binding), error => error.code === 'invalid_config_json' && !error.message.includes('credential_fragment'));
  const bad = cli(fixture(), 'heartbeat', malformed);
  assert.equal(bad.status, 1);
  assert.deepEqual(JSON.parse(bad.stdout), { ok: false, code: 'invalid_config_json', advertising_writes: 0 });
  assert.equal((bad.stdout + bad.stderr).includes('credential_fragment'), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(callsFile, 'utf8')), []);
  fs.writeFileSync(malformed, 'null');
  assert.throws(() => loadScope(malformed, binding), { code: 'invalid_config_shape' });
  const invalidFormat = cli(fixture(), 'unsupported');
  assert.equal(JSON.parse(invalidFormat.stdout).code, 'invalid_format');
  assert.deepEqual(JSON.parse(fs.readFileSync(callsFile, 'utf8')), []);
});
