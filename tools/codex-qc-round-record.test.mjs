import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeRound } from './codex-qc-round-record.mjs';

const binding = { advertiser_id: 'test-account', primary_ad_id: 'test-plan', room_id: 'test-room', date: '2026-10-01' };
function fixture(at, cost, gmv, orders) {
  return { binding, captured_at: at, actions: [], decision: { reason: 'offline fixture' },
    compass: { room_id: 'test-room', live_start_display: '2026/10/01 10:00', source: 'fixture', cost, gmv, refund: 0, net_gmv: gmv, net_roi: null },
    active_pool: { pool: '调控中', complete: true, captured_at: at, tasks: [{ task_id: 'test-boost', status: '调控中', cost, payment_orders: orders }] },
    paused_pool: { pool: '手动暂停', complete: true, empty_verified: true, captured_at: at, tasks: [] } };
}
const before = fixture('2026-10-01T02:00:00Z', 10, 100, 1);

test('unknown stays unknown, zero order delta is real, rates use actual elapsed time', () => {
  const after = fixture('2026-10-01T02:04:00Z', 12, 100, 1);
  after.compass.refund = null;
  after.deltas = { cost: 999 }; // Historical alias must not carry a stale earlier round.
  const result = summarizeRound(before, after);
  assert.equal(result.delta.refund, null);
  assert.equal(result.delta.net_roi, null);
  assert.equal(result.delta.incremental_net_roi, 0);
  assert.equal(result.task_deltas[0].orders_delta, 0);
  assert.equal(result.task_deltas[0].displayed_cost_per_minute, 0.5);
  assert.deepEqual(result.actions, []);
  assert.equal(result.deltas.cost, 2);
});

test('paused backfill does not automatically complete an expired feedback window', () => {
  const after = fixture('2026-10-01T02:06:00Z', 12, 150, 2);
  after.paused_pool.tasks = after.active_pool.tasks;
  after.paused_pool.tasks[0].status = '已暂停\n手动暂停';
  after.active_pool.tasks = [];
  after.active_pool.empty_verified = true;
  after.pending_queue = [{ task_id: 'test-boost', feedback_until: '2026-10-01T02:05:00Z' }];
  const result = summarizeRound(before, after);
  assert.equal(result.task_deltas[0].orders_delta, 1);
  assert.equal(result.pending_queue.length, 1);
  assert.equal(result.pending_queue[0].overdue_seconds, 60);
  assert.equal(result.pending_queue[0].feedback_until, '2026-10-01T02:05:00Z');
  assert.equal(result.completed_startup_feedback.length, 0);
});

test('feedback survives omitted queues, read failures and rolling deadlines until explicitly reviewed', () => {
  const pending = { task_id: 'test-boost', feedback_until: '2026-10-01T02:05:00Z', baseline_cost: 10 };
  const prev = { ...before, pending_queue: [pending] };
  const after = fixture('2026-10-01T02:16:40Z', 12, 150, 2);
  after.active_pool.complete = false;
  let out = summarizeRound(prev, after);
  assert.equal(out.pending_queue[0].overdue_seconds, 700);
  assert.equal(out.completed_startup_feedback.length, 0);
  after.pending_queue = [{ ...pending, feedback_until: '2026-10-01T02:20:00Z' }];
  out = summarizeRound(prev, after);
  assert.equal(out.pending_queue.length, 2); // New deadline cannot hide the old review.
  after.pending_queue = [];
  after.completed_startup_feedback = [{ ...pending, result: 'expired' }];
  out = summarizeRound(prev, after);
  assert.equal(out.pending_queue.length, 1);
  assert.equal(out.feedback_issues[0].code, 'feedback_review_unverified');
  after.completed_startup_feedback = [{ ...pending, reviewed_at: after.captured_at,
    result: 'Scene ended; effect remains unverified, exact-ID receipt missing', evidence: 'fixture/ended.json' }];
  out = summarizeRound(prev, after);
  assert.equal(out.pending_queue.length, 0);
  assert.equal(out.completed_startup_feedback.length, 1);
  const next = fixture('2026-10-01T02:18:00Z', 12, 150, 2);
  assert.equal(summarizeRound(out, next).completed_startup_feedback.length, 1);
});

test('a review after capture is accepted only within the recorded finalization time', () => {
  const pending = { task_id: 'test-boost', feedback_until: '2026-10-01T02:05:00Z' };
  const prev = { ...before, pending_queue: [pending] };
  const after = fixture('2026-10-01T02:06:00Z', 12, 150, 2);
  after.completed_startup_feedback = [{ ...pending, reviewed_at: '2026-10-01T02:06:30Z', result: 'Keep after reviewing new order', evidence: 'fixture/receipt.json' }];
  assert.equal(summarizeRound(prev, after).pending_queue.length, 1);
  after.finalized_at = '2026-10-01T02:06:40Z';
  assert.equal(summarizeRound(prev, after).pending_queue.length, 0);
  after.completed_startup_feedback[0].task_id = 'another-task';
  assert.equal(summarizeRound(prev, after).pending_queue.length, 1);
});

test('cross-scene identity or nonadvancing round rejected; incomplete pools do not invent deltas', () => {
  const after = fixture('2026-10-01T02:06:00Z', 12, 150, 2);
  assert.throws(() => summarizeRound(before, { ...after, binding: { ...binding, room_id: 'other' } }), /binding/);
  assert.throws(() => summarizeRound(before, { ...after, captured_at: before.captured_at }), /advance/);
  after.paused_pool.complete = false;
  assert.equal(summarizeRound(before, after).task_deltas[0].orders_delta, null);
});
