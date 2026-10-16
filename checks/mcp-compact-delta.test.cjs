'use strict';
require('./setup-runtime.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildLiveSummary, compactLiveDelta } = require('../server-app/server/lib/mcpClean');
const { parseTask } = require('../server-app/server/lib/boostTaskContract');
const { SnapshotRing } = require('../server-app/server/lib/snapshotRing');

const ACCOUNT = 'compact_test', START = '2026-09-29T09:00:00+08:00';
const SESSION = `${ACCOUNT}|room-test|${START}`;
const TIME = Date.parse('2026-09-29T12:00:00+08:00');
const clone = value => structuredClone(value);
const bytes = value => Buffer.byteLength(JSON.stringify(value));

// Synthetic source data passes through the real task parser and summary builder.
// No account, advertising endpoint or production service is used.
function makeSummary(offset = 0, count = 15) {
  const at = new Date(TIME + offset).toISOString();
  const tasks = Array.from({ length: count }, (_, i) => {
    const id = `600000360${String(i).padStart(2, '0')}`;
    return parseTask({ id, name: `椿-测试素材-${i}`, status: i % 3 ? 1 : 2,
      adDeliveryName: i % 3 ? '投放中' : '已暂停', createTime: Date.parse(START) / 1000,
      budget: 10000000, ecpRoi2Goal: 8, smartBidType: 7,
      assistTaskInfoMap: { 2: { operation: { pause: { editable: true }, start: { editable: true }, edit: { editable: true } } } },
    }, { id: 'plan-test' }, { data: { adStatsMap: { [id]: { metrics: {
      statCostForRoi2Assist: { value: i * 2 }, totalPayOrderGmvForRoi2Assist: { value: i * 20 },
      totalPrepayAndPayOrderRoi2Assist: { value: i ? 10 : 0 },
      totalPrepayAndPaySettleRoi21HAssist: { value: i ? 9 : null },
      totalOrderSettleAmountForRoi21HAssist: { value: i * 18 }, totalPayOrderCountForRoi2Assist: { value: i },
    } } } } }, { accountId: ACCOUNT, sourceAt: at, start: '2026-09-29', end: '2026-09-29', sessionKey: SESSION });
  });
  const input = { ok: true, account: ACCOUNT, session_key: SESSION, fetchedAt: at, server_time: at,
    dataValid: true, liveCheckedAt: at, live: { isLive: true, roomId: 'room-test', startTime: START },
    today: { cost: 210, gmv: 2100, roi: 10, netGmv: 1890, netRoi: 9, orderCount: 21, orderCountPay: 24 },
    live_metrics: { online: 300, watchUcount: 1200, gpm: 40, watchToPayRate: 3, showToWatchRate: 12, orderCost: 10 },
    plan_binding: { data_valid: true, account_id: ACCOUNT, session_key: SESSION,
      primary_ad_id: 'plan-test', room_id: 'room-test', start_time: START },
    boost_tasks: tasks, boost_source_at: at, boost_data_valid: true, boost_window: 'daily', boost_truncated: false,
    boost_coverage: { list_complete: true, returned: count, truncated: false }, missing_components: ['funnel'],
    errors: [{ code: 'funnel_unavailable', component: 'funnel' }], partial: true,
  };
  return buildLiveSummary(input, { generatedAt: at });
}

function delta(before, current) {
  const ring = new SnapshotRing({ now: () => TIME });
  ring.put(before);
  return ring.delta(current, before.snapshot_id);
}

// Consumer implementation is intentionally in the test, independent of encoder.
function reconstruct(base, encoded) {
  const patch = encoded.boosts_delta;
  assert.equal(patch.schema_version, 'boost-fields/v1');
  assert.equal(patch.base_snapshot_id, base.snapshot_id);
  const tasks = new Map(base.boosts.map(row => [row.id, clone(row)]));
  for (const id of patch.removed_ids) tasks.delete(id);
  for (const row of patch.added) tasks.set(row.id, clone(row));
  for (const change of patch.updated) {
    assert.ok(tasks.has(change.id));
    const task = tasks.get(change.id);
    Object.assign(task, clone(change.set));
    for (const key of change.unset || []) delete task[key];
  }
  assert.equal(new Set(patch.current_ids).size, patch.current_ids.length);
  assert.equal(tasks.size, patch.current_ids.length);
  return patch.current_ids.map(id => tasks.get(id));
}

test('compact delta restores additions, removals, order, changed/null/zero/false values and removed fields exactly', () => {
  const before = makeSummary();
  const current = makeSummary(20000);
  current.snapshot_id = 'changed-snapshot';
  const changed = current.boosts[1];
  changed.cost = 0; changed.net_roi = null; changed.status = '已暂停'; changed.status_code = 2;
  changed.passive_stop = false; changed.available_actions.resume = { allowed: false, reason: 'manual_pause_protected' };
  delete changed.material_ids;
  before.boosts[1].material_ids = ['old-material'];
  current.boosts = [current.boosts[2], ...current.boosts.slice(3), current.boosts[0], changed,
    { ...clone(current.boosts[3]), id: 'new-task', cost: 0, net_roi: null }];
  current.boosts = current.boosts.filter(row => row.id !== before.boosts[4].id);
  current.boost_coverage.returned = current.boosts.length;
  const untouched = JSON.stringify({ before, current });
  const regular = delta(before, current);
  const compact = compactLiveDelta(regular, before, current);
  assert.ok(compact.boosts_delta);
  assert.deepEqual(reconstruct(before, compact), current.boosts);
  assert.equal(JSON.stringify({ before, current }), untouched, 'projection must not mutate stored snapshots');
  assert.equal(compact.boosts, undefined);
  assert.deepEqual(compact.boost_exits, regular.boost_exits);
  assert.equal(compact.boost_exits[0].confirmed_ended, false, 'not returned does not prove ended');
  for (const key of ['snapshot_id', 'previous_snapshot_id', 'live', 'components', 'financial_checks', 'boost_coverage']) {
    assert.deepEqual(compact[key], regular[key]);
  }
  for (const key of ['engagement', 'plan_binding', 'missing_components', 'boost_data_valid', 'boost_source_at', 'boost_window', 'boost_truncated']) {
    assert.deepEqual(compact[key], current[key]);
  }
  assert.deepEqual(compact.meta.errors, current.meta.errors);
  for (const update of compact.boosts_delta.updated) {
    const task = current.boosts.find(row => row.id === update.id);
    for (const key of ['primary_ad_id', 'status', 'status_code', 'passive_stop', 'source_at', 'available_actions', 'action_limits']) {
      assert.deepEqual(update.set[key], task[key], `${key} must be current on every row`);
    }
  }
});

test('unknown, stale and incomplete current lists remain full with explicit fallback and current quality', () => {
  const before = makeSummary();
  for (const alter of [
    s => { s.meta.stale = true; s.meta.freshness = 'stale'; },
    s => { s.meta.data_valid = false; },
    s => { s.components.boosts.data_valid = false; },
    s => { s.components.boosts.freshness = 'stale'; },
    s => { s.boost_coverage.list_complete = false; },
    s => { s.boost_coverage.truncated = true; },
    s => { s.boost_truncated = true; },
    s => { s.boost_data_valid = false; },
  ]) {
    const current = makeSummary(20000); alter(current);
    const compact = compactLiveDelta(delta(before, current), before, current);
    assert.equal(compact.boosts_delta, undefined);
    assert.equal(compact.compact_unavailable_reason, 'current_boost_data_not_complete_and_fresh');
    assert.deepEqual(compact.boosts, current.boosts);
    assert.deepEqual(compact.components, current.components);
  }
});

test('unavailable or cross-scope baselines, duplicate IDs and tiny output safely retain full rows', () => {
  const before = makeSummary(), current = makeSummary(20000), regular = delta(before, current);
  const missing = compactLiveDelta(regular, null, current);
  assert.equal(missing.compact_unavailable_reason, 'snapshot_not_found');
  for (const field of ['account_id', 'session_key', 'schema_version']) {
    const other = clone(before); other.meta[field] = 'different';
    assert.equal(compactLiveDelta(regular, other, current).compact_unavailable_reason, 'snapshot_binding_mismatch');
  }
  const duplicate = clone(regular); duplicate.boosts.push(duplicate.boosts[0]);
  assert.equal(compactLiveDelta(duplicate, before, current).compact_unavailable_reason, 'task_identity_unverified');
  const empty = makeSummary(20000, 0);
  const tiny = compactLiveDelta(delta(before, empty), before, empty);
  assert.equal(tiny.compact_unavailable_reason, 'compact_not_smaller');
  assert.deepEqual(tiny.boosts, []);
  assert.equal(compactLiveDelta({ ...current, mode: 'summary' }, null, current).compact_unavailable_reason, 'full_snapshot_required');
});

test('current plan binding conflicts stay explicit and return full rows; live end and unknown state cannot inherit old truth', () => {
  const before = makeSummary();
  for (const binding of [null, { ...before.plan_binding, data_valid: false, reason: 'primary_plan_ambiguous' },
    { ...before.plan_binding, account_id: 'another-account' }, { ...before.plan_binding, session_key: 'another-session' }]) {
    const current = makeSummary(20000); current.plan_binding = binding;
    const result = compactLiveDelta(delta(before, current), before, current);
    assert.equal(result.compact_unavailable_reason, 'current_plan_binding_unverified');
    assert.deepEqual(result.plan_binding, binding);
    assert.deepEqual(result.boosts, current.boosts);
  }
  for (const isLive of [false, null]) {
    const current = makeSummary(20000); current.live.is_live = isLive;
    current.components.live = { ...current.components.live, data_valid: isLive !== null };
    const result = compactLiveDelta(delta(before, current), before, current);
    assert.equal(result.live.is_live, isLive);
    assert.deepEqual(result.components.live, current.components.live);
  }
});

test('normal 15-task repeated poll reduces measured JSON bytes without losing task fields', t => {
  const before = makeSummary(), current = makeSummary(20000);
  const regular = delta(before, current);
  const compact = compactLiveDelta(regular, before, current);
  assert.deepEqual(reconstruct(before, compact), current.boosts);
  const originalBytes = bytes(regular), compactBytes = bytes(compact);
  assert.ok(compactBytes < originalBytes * 0.8, `${compactBytes}/${originalBytes}`);
  t.diagnostic(JSON.stringify({ fixture: '15 parsed tasks, unchanged business metrics, fresh source timestamps',
    original_bytes: originalBytes, compact_bytes: compactBytes,
    reduction_percent: +(100 * (1 - compactBytes / originalBytes)).toFixed(2),
    measure: 'UTF-8 JSON bytes, not tokens or billed usage' }));
});
