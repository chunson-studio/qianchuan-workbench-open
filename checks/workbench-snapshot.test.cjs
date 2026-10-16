'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createSnapshotReader, projectState } = require('../server-app/server/lib/workbenchSnapshot');
const root = require('./test-output.cjs').testOutputRoot();
const at = '2026-10-09T03:00:00Z', now = Date.parse(at), hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const binding = { advertiser_id: '12345', primary_ad_id: '23456', room_id: '34567', session_started_at: '2026-10-09 10:00:00' };
const key = JSON.stringify(Object.values(binding));
const accounts = [{ id: 'one', name: '测试账户', aavid: '12345' }, { id: 'two', name: '另一账户', aavid: '56789' }];
function fixture() {
  const brief = { binding, at, board: { cost: 25, overall_cost: 25, gmv: 300, net_transaction_roi: 8, metric_basis: 'platform_整体消耗_净成交ROI', captured_at: at },
    five: { online: 0, captured_at: at }, tasks: { columns: ['id'], active: [['45678']], coverage: { active: true }, sampled_at: [at] } };
  return { schema_version: 1, revision: 2, owner: { id: 'test-owner', session: key, status: 'active' }, operations: {},
    scenes: { [key]: { binding, status: 'live', policy: { secret: 'DO_NOT_EXPOSE' }, authorization: { source: 'DO_NOT_EXPOSE' },
      last_observation: { brief, round_id: 'r1', operation_ids: [] }, rounds: { r1: { binding, brief, round_id: 'r1', display: '本轮测试记录' } } } } };
}
function save(state, directory = fs.mkdtempSync(path.join(root, 'snapshot-'))) {
  const folder = path.join(directory, 'codex-control', hash(['12345', '23456']));
  fs.mkdirSync(folder, { recursive: true }); const file = path.join(folder, 'state.json');
  fs.writeFileSync(file, JSON.stringify(state)); return { directory, file };
}
test('只读原账，保留0与未知、原生ROI及采集时间，不传出策略凭据', () => {
  const f = save(fixture()), before = fs.readFileSync(f.file), read = createSnapshotReader({ roots: [f.directory] });
  const result = read(accounts, { now }), row = result.sessions[0];
  assert.equal(row.account_id, 'one'); assert.equal(row.metrics.online, 0); assert.equal(row.metrics.roi, 8);
  assert.equal(row.metrics.active_tasks, 1); assert.equal(row.freshness, 'current');
  assert.equal(row.captured_at, at); assert.equal(result.upstream_requests, 0);
  assert.doesNotMatch(JSON.stringify(result), /DO_NOT_EXPOSE|authorization|policy/);
  assert.deepEqual(fs.readFileSync(f.file), before);
  assert.equal(read(accounts, { now: now + 360000 }).sessions[0].freshness, 'stale');
  assert.equal(read([accounts[1]], { now }).sessions.length, 0);
});
test('缺失、未来及财务过期时间不以本机刷新时间洗新', () => {
  for (const value of [null, '2026-10-10T03:00:00Z', '2026-10-09T01:00:00Z']) {
    const state = fixture(); state.scenes[key].last_observation.brief.board.captured_at = value;
    const f = save(state), row = createSnapshotReader({ roots: [f.directory] })(accounts, { now }).sessions[0];
    assert.notEqual(row.freshness, 'current'); assert.equal(row.captured_at, at);
  }
});
test('任何未决操作保留未知，不计成功且不声称当前任务总数完整', () => {
  const state = fixture(); state.operations.x = { request_id: 'x', session: key, action: 'create', status: 'unconfirmed', submit_started_at: at };
  state.scenes[key].last_observation.operation_ids = ['x'];
  const row = projectState(state, accounts, 'test')[0];
  assert.equal(row.pending_count, 1); assert.equal(row.metrics.active_tasks, null); assert.equal(row.actions.create, 0);
  assert.equal(row.operations[0].status, 'unconfirmed');
});
test('精确回读的池成员变动只计算一次，已入采集池的旧操作不重复扣减', () => {
  const state = fixture(); state.operations.x = { request_id: 'x', session: key, action: 'pause', task_id: '45678', status: 'write_verified', verified_at: '2026-10-09T03:00:02Z' };
  state.scenes[key].last_observation.operation_ids = ['x'];
  const row = projectState(state, accounts, 'test')[0];
  assert.equal(row.metrics.active_tasks, 0); assert.equal(row.actions.pause, 1);
  state.operations.x.verified_at = '2026-10-09T02:00:00Z';
  assert.equal(projectState(state, accounts, 'test')[0].metrics.active_tasks, 1);
});
test('同场双来源不择一冒充权威，坏文件不返回缓存旧值', () => {
  const a = save(fixture()), b = save(fixture()); const read = createSnapshotReader({ roots: [a.directory, b.directory] });
  const row = read(accounts, { now }).sessions[0]; assert.equal(row.metrics.cost, null); assert.equal(row.freshness, 'unknown');
  assert.ok(row.issues.includes('local_source_conflict'));
  const single = createSnapshotReader({ roots: [a.directory] }); single(accounts, { now }); fs.writeFileSync(a.file, '{');
  const broken = single(accounts, { now }); assert.equal(broken.sessions.length, 0); assert.equal(broken.issues[0].code, 'local_state_unreadable');
});
test('跨账户、跨场次brief、错误状态目录均不会合并到本账户', () => {
  const state = fixture(); state.scenes[key].binding = { ...binding, account_id: 'two' };
  assert.equal(projectState(state, accounts, 'test').length, 0);
  const bad = fixture(); bad.scenes[key].last_observation.brief.binding = { ...binding, room_id: '99999' };
  assert.equal(projectState(bad, accounts, 'test')[0].metrics.cost, null);
  const f = save(fixture()), folder = path.dirname(f.file); fs.renameSync(folder, path.join(path.dirname(folder), 'a'.repeat(64)));
  assert.equal(createSnapshotReader({ roots: [f.directory] })(accounts, { now }).sessions.length, 0);
});
test('没有控制器记录时返回空状态，不启动采集；乘方指标不替换成净ROI', () => {
  const result = createSnapshotReader({ roots: [path.join(root, 'absent')] })(accounts, { now });
  assert.equal(result.sessions.length, 0); assert.equal(result.accounts.length, 2);
  const s = fixture(), board = s.scenes[key].last_observation.brief.board;
  board.metric_basis = 'platform_综合成本_综合营销ROI'; board.net_roi = 3.5;
  const row = projectState(s, accounts, 'test')[0]; assert.equal(row.metrics.roi, 3.5); assert.equal(row.metrics.roi_label, '综合营销ROI');
});
test('首次CLI接入拒绝手动导出流程，不调用任何账户写入或提问', async () => {
  const vm = require('node:vm'), module = { exports: {} }, messages = [];
  const service = { getStatus: () => ({ accounts: [] }) };
  const requireMock = id => id.includes('accountOnboarding') ? service : require(id);
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../server-app/scripts/setup-account.js'), 'utf8'),
    { require: requireMock, module, process, console: { log: x => messages.push(x) } });
  await assert.rejects(module.exports.main(['--non-interactive']), { code: 'browser_login_required' });
  assert.equal(messages.length, 0);
});
