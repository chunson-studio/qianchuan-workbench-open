import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { cleanTaskPool, calculateRoundDeltas, buildDecisionBrief, createRoundBriefReader, saveRoundBrief, compactControlResult } from './codex-qc-decision-brief.mjs';
import { loadQianchuanControlPools, loadQianchuanBoostReplay } from './codex-qc-boost-workflow.mjs';
import { createHash } from 'node:crypto';

const binding = { advertiser_id: '60000005', primary_ad_id: '60000006', room_id: '60000033', date: '2026-10-05' };
const id = '60000021';
test('compact result retains CTR and conversion fields and their basis for model judgment',()=>{
  const result={brief:{tasks:{columns:['id','cost','ctr_pct','conversion_rate_pct','clicks'],active:[['123',7,14.1,2.5,20]],paused:[],rate_basis:{ctr:'platform'}}}};
  const out=compactControlResult(result);
  assert.deepEqual(out.brief.tasks.columns,['id','cost','ctr_pct','conversion_rate_pct']);
  assert.deepEqual(out.brief.tasks.active,[['123',7,14.1,2.5]]);
  assert.deepEqual(out.brief.tasks.rate_basis,{ctr:'platform'});
});

test('compact output retains ended, failed and inconsistent results without inventing data',()=>{
  for(const result of [
    {status:'ended',host_actions:[{action:'pause_scheduler'}],unresolved:[{request_id:'unknown'}]},
    {status:'failed',issues:[{code:'read_failed'}]},
    {status:'live',unresolved:[],brief:{unresolved:[{request_id:'different'}],tasks:{columns:['id','cost','ctr_pct'],active:[[id,5]],paused:[]},quality:{write_ready:false}}}
  ])assert.deepEqual(compactControlResult(result),result);
});

test('compact scope groups preserve every task ID, owner, reason and extra detail',()=>{
  const uncovered=Array.from({length:10},(_,i)=>({task_id:String(60000018+i),pool:'paused',reason:'other_execution_owner',owner:'original-scene-owner',extra:{scope:'unchanged'}}));
  uncovered.push({...uncovered[0],task_id:'60000024',reason:'protected',owner:'another-owner'});
  const result={brief:{management_coverage:{uncovered,protected:[{task_id:'1',reason:'user'}],managed:[]}}};
  const before=structuredClone(result),out=compactControlResult(result);
  const grouped=out.brief.management_coverage.uncovered;
  assert.equal(grouped.grouped_by,'details');
  assert.deepEqual(grouped.groups.flatMap(g=>g.task_ids.map(task_id=>({task_id,...g.details}))),uncovered);
  assert.deepEqual(out.brief.management_coverage.protected,result.brief.management_coverage.protected);
  assert.deepEqual(result,before);
  assert.ok(JSON.stringify(out).length<JSON.stringify(result).length);
});
test('only the observed standalone protection badge is normalized; raw status and unknown states survive',()=>{
  for(const status of ['调控中\n保','调控中 保']){
    const out=cleanTaskPool({filter:'调控中',complete:true,total:1,tasks:[{task_id:id,status,cost:2.76}]},'调控中');
    assert.equal(out.complete,true);assert.equal(out.tasks[0].status,'调控中');assert.equal(out.tasks[0].status_raw,status);assert.deepEqual(out.tasks[0].status_badges,['保']);
  }
  for(const status of ['调控中\n保\n已暂停','调控中\n未知徽标','调控中保障']){
    const out=cleanTaskPool({filter:'调控中',complete:true,total:1,tasks:[{task_id:id,status}]},'调控中');
    assert.equal(out.complete,false);assert.equal(out.issues[0].status,status);
  }
});
const task = { task_id: id, status: '调控中', cost: 10, payment_orders: 1, payment_gmv: 39, budget: 100, duration_hours: 5 };
function fixture(at = '2026-10-05T12:00:00Z') {
  return { binding, captured_at: at, target_net_roi: 3, actions: [], decision: { reason: 'fixture' },
    compass: { room_id: binding.room_id, live_start_display: '2026/10/05 19:13', live_state: 'live', source: 'fixture',
      gmv: 226, refund: null, net_gmv: null, cost: 100, net_roi: null,
      five_minutes: { updated_at_text: '20:00更新', payment_gmv: 0, online_snapshot: 6, enters: 43, leaves: 45 } },
    active_pool: { pool: '调控中', complete: true, total: 1, captured_at: at, tasks: [{ ...task }] },
    paused_pool: { pool: '手动暂停', complete: true, total: 0, empty_verified: true, captured_at: at, tasks: [] } };
}

test('header-based cleaning preserves long IDs despite moved columns and missing values', () => {
  const out = cleanTaskPool({ actual_filter: '调控中', complete: true, total: 1,
    headers: ['调控成交订单数', '任务名称', '调控消耗(元)', '调控状态', '调控时长(小时)', '调控支付ROI'],
    rows: [['1', `示例用户\nID: ${id}`, '12.90', '调控中', '5.0\n预计 明天结束', '3.02']] }, '调控中');
  assert.equal(out.complete, true);
  assert.equal(out.tasks[0].task_id, id);
  assert.equal(out.tasks[0].cost, 12.9);
  assert.equal(out.tasks[0].duration_hours, 5);
  assert.equal(out.tasks[0].payment_gmv, null);
});

test('user example with an active row in paused is rejected without silently moving it', () => {
  const out = cleanTaskPool({ pool: '手动暂停', complete: true, total: 1, tasks: [{ ...task, cost: 12.09 }] }, '手动暂停');
  assert.equal(out.complete, false);
  assert.equal(out.tasks.length, 0);
  assert.equal(out.issues[0].code, 'task_status_mismatch');
  assert.equal(out.issues[0].id, id);
  assert.equal(cleanTaskPool({ rows: [['no headers']], pool: '调控中', complete: true }, '调控中').complete, false);
});

test('task CTR/CVR survive normalized and header input with explicit percent units and unknown samples', () => {
  const cur = fixture();
  cur.active_pool.tasks[0] = { ...task, ctr_pct: 8.17, conversion_rate_pct: '5.88%', clicks: 17, impressions: 208 };
  const out = buildDecisionBrief(null, cur);
  const at = key => out.tasks.active[0][out.tasks.columns.indexOf(key)];
  assert.equal(at('ctr_pct'), 8.17);
  assert.equal(at('conversion_rate_pct'), 5.88);
  assert.equal(at('clicks'), 17);
  assert.equal(at('impressions'), 208);
  assert.equal(out.actions.length, 0); // The cleaner never decides spending from rates.
  cur.active_pool.tasks[0] = { ...task, ctr_pct: 0, conversion_rate_pct: '-', clicks: null };
  const t = cleanTaskPool(cur.active_pool, '调控中').tasks[0];
  assert.equal(t.ctr_pct, 0);
  assert.equal(t.conversion_rate_pct, null);
  assert.equal(t.clicks, null);
  assert.equal(t.impressions, null);
});

test('rates omitted by an older normalizer are recovered from the same ID and actual state only', () => {
  const pool = { actual_filter: '调控中', complete: true, total: 1, tasks: [task],
    headers: ['调控转化率', '调控状态', '任务名称', '调控点击率', '调控点击次数'],
    rows: [['5.88％', '调控中', `示例用户\nID: ${id}`, '8.17%', '17']] };
  let t = cleanTaskPool(pool, '调控中').tasks[0];
  assert.equal(t.ctr_pct, 8.17);
  assert.equal(t.conversion_rate_pct, 5.88);
  assert.equal(t.clicks, 17);
  pool.rows[0][2] = '示例用户\nID: 60000019';
  assert.equal(cleanTaskPool(pool, '调控中').tasks[0].ctr_pct, null);
  pool.rows[0][2] = `示例用户\nID: ${id}`;
  pool.rows[0][1] = '已暂停\n手动暂停';
  assert.equal(cleanTaskPool(pool, '调控中').tasks[0].ctr_pct, null);
  pool.rows[0][1] = '调控中';
  pool.rows.push([...pool.rows[0]]);
  assert.equal(cleanTaskPool(pool, '调控中').tasks[0].ctr_pct, null);
});

test('row-only rates use exact task control headers rather than whole-room conversion', () => {
  const pool = { actual_filter: '手动暂停', complete: true, total: 1,
    headers: ['任务名称', '调控状态', '调控点击率', '观看成交率'],
    rows: [[`示例用户\nID: ${id}`, '已暂停\n手动暂停', '0.5%', '77%']] };
  const t = cleanTaskPool(pool, '手动暂停').tasks[0];
  assert.equal(t.ctr_pct, 0.5);
  assert.equal(t.conversion_rate_pct, null);
});

test('empty and partial pools cannot claim full coverage without evidence', () => {
  assert.equal(cleanTaskPool({ pool: '手动暂停', complete: true, total: 0, tasks: [] }, '手动暂停').complete, false);
  assert.equal(cleanTaskPool({ pool: '手动暂停', complete: true, total: 0, empty_verified: true, tasks: [] }, '手动暂停').complete, true);
  assert.equal(cleanTaskPool({ pool: '调控中', complete: true, total: 2, tasks: [task] }, '调控中').complete, false);
  assert.equal(cleanTaskPool({ pool: '调控中', complete: true, tasks: [{ ...task, task_id: Number(id) }] }, '调控中').complete, false);
});

test('script computes actual elapsed deltas, and same five-minute snapshot is not a new window', () => {
  const prev = fixture(), cur = fixture('2026-10-05T12:04:00Z');
  Object.assign(cur.active_pool.tasks[0], { cost: 12.9, payment_orders: 2, payment_gmv: 78 });
  cur.compass.five_minutes.online_snapshot = 5;
  cur.compass.five_minutes.comparison = { online: { direction: 'down', percent: 14.29 } };
  const d = calculateRoundDeltas(prev, cur);
  assert.equal(d.tasks[0].cost_delta, 2.9);
  assert.equal(d.tasks[0].orders_delta, 1);
  assert.equal(d.tasks[0].payment_gmv_delta, 39);
  assert.equal(d.tasks[0].displayed_cost_per_minute, 0.725);
  assert.equal(d.board.online_snapshot, null);
  assert.equal(d.comparison.five_new_window, false);
  assert.equal(d.board.refund, null);
  assert.deepEqual(buildDecisionBrief(prev, cur).five.ring, cur.compass.five_minutes.comparison);
  cur.compass.five_minutes.updated_at_text = '20:04更新';
  assert.equal(calculateRoundDeltas(prev, cur).board.online_snapshot, -1);
  cur.compass.five_minutes.updated_at_text = '19:58更新';
  assert.equal(calculateRoundDeltas(prev, cur).comparison.five_new_window, false);
});

test('source changes and cross-scene changes prevent misleading comparisons', () => {
  const prev = fixture(), cur = fixture('2026-10-05T12:02:00Z');
  cur.compass.source = 'different dashboard';
  assert.equal(calculateRoundDeltas(prev, cur).board.cost, null);
  assert.throws(() => buildDecisionBrief(prev, { ...cur, binding: { ...binding, room_id: 'other' } }), /different scene/);
  assert.throws(() => buildDecisionBrief(prev, prev), /advance/);
  cur.compass.source = 'fixture';
  cur.compass.top_metric_source_time = prev.compass.top_metric_source_time = '20:00';
  cur.compass.gmv = 999;
  assert.equal(calculateRoundDeltas(prev, cur).board.gmv, null);
  cur.compass.live_start_display = '2026/10/05 20:01';
  assert.equal(calculateRoundDeltas(prev, cur).tasks[0].displayed_cost_per_minute, null);
  assert.throws(() => buildDecisionBrief(prev, { ...cur, binding: { ...binding, session_started_at: '2026-10-05T12:01:00Z' } }), /different scene/);
});

test('backfill is compared by ID across pools and duplicate cross-pool states block writes', () => {
  const prev = fixture(), cur = fixture('2026-10-05T12:02:00Z');
  cur.paused_pool = { pool: '手动暂停', complete: true, total: 1, captured_at: cur.captured_at,
    tasks: [{ ...task, status: '已暂停\n手动暂停', cost: 11, payment_orders: 2 }] };
  cur.active_pool = { pool: '调控中', complete: true, total: 0, empty_verified: true, captured_at: cur.captured_at, tasks: [] };
  assert.equal(calculateRoundDeltas(prev, cur).tasks[0].orders_delta, 1);
  cur.active_pool.tasks = [task]; cur.active_pool.total = 1;
  const brief = buildDecisionBrief(prev, cur);
  assert.equal(brief.quality.write_ready, false);
  assert.ok(brief.quality.issues.some(i => i.code === 'task_in_both_pools'));
  assert.equal(calculateRoundDeltas(prev, cur).tasks[0].orders_delta, null);
});

test('all paused tasks, actions, unknowns, feedback and human changes survive reduction', () => {
  const cur = fixture();
  cur.paused_pool.tasks = Array.from({ length: 25 }, (_, i) => ({ ...task, task_id: `18780000000000${String(i).padStart(2, '0')}`, status: '已暂停\n手动暂停' }));
  cur.paused_pool.total = 25;
  cur.actions = [{ type: 'budget', task_id: id, before: 100, after: 200, verified: true }];
  cur.external_changes = [{ task_id: id, duration_hours: 8 }];
  cur.pending_queue = [{ task_id: id, feedback_until: '2026-10-05T12:05:00Z', baseline_cost: 10, baseline_orders: 1 }];
  const out = buildDecisionBrief(null, cur, { now: '2026-10-05T12:01:00Z', triggered_at: cur.captured_at,
    policy: { target_net_roi: 3 }, task_state: { [id]: { opportunity_yuan: 5, last_order_cost: 6, last_order_orders: 1, recovery_baseline: { cost: 8, orders: 1 } } } });
  assert.equal(out.tasks.paused.length, 25);
  assert.equal(out.goal.target_net_roi, 3); // Never copy the other account's ROI10.
  assert.equal(out.board.net_roi, null);
  assert.equal(out.task_state[id].since_order_growth.cost, 4);
  assert.equal(out.task_state[id].since_recovery.cost, 2);
  assert.equal(out.pending[0].due, false);
  assert.equal(out.pending[0].feedback_until, cur.pending_queue[0].feedback_until);
  assert.deepEqual(out.actions, cur.actions);
  assert.deepEqual(out.external_changes, cur.external_changes);
  assert.ok(out.quality.missing.includes('refund'));
});

test('deadline flags cannot terminate an unresolved submission or restart an ended scene', () => {
  const cur = fixture();
  cur.unresolved_submissions = [{ task_id: id, outcome: 'unknown' }];
  cur.compass.live_state = 'ended';
  const out = buildDecisionBrief(null, cur, { check_interval_seconds: 120, triggered_at: cur.captured_at, now: '2026-10-05T12:01:45Z' });
  assert.equal(out.timing.remaining_seconds, 15);
  assert.equal(out.timing.enough_for_new_write, false);
  assert.equal(out.quality.write_ready, false);
  assert.deepEqual(out.unresolved, cur.unresolved_submissions);
});

test('not-live alone never means ended and mismatched rooms cannot supply lifecycle state', () => {
  const cur = fixture();
  delete cur.compass.live_state;
  cur.compass.in_live = false;
  assert.equal(buildDecisionBrief(null, cur).live_state, 'unknown');
  assert.equal(buildDecisionBrief(null, cur).quality.write_ready, false);
  cur.compass.live_state = 'pre_live';
  assert.equal(buildDecisionBrief(null, cur).live_state, 'pre_live');
  cur.compass.live_state = 'ended';
  cur.compass.live_state_evidence = '同房间显示直播已结束';
  let out = buildDecisionBrief(null, cur);
  assert.equal(out.live_state, 'ended');
  assert.equal(out.live_state_evidence.basis, cur.compass.live_state_evidence);
  cur.compass.room_id = 'other';
  assert.equal(buildDecisionBrief(null, cur).live_state, 'unknown');
  cur.compass.room_id = binding.room_id;
  cur.compass.in_live = true;
  assert.equal(buildDecisionBrief(null, cur).live_state, 'unknown');
});

test('the bound reader retains raw evidence before returning only the model brief', async () => {
  const calls = [], previous = fixture(), current = fixture('2026-10-05T12:02:00Z');
  current.raw_dom = 'RAW PRIVATE DOM MUST NOT BE RETURNED';
  const read = createRoundBriefReader({ loadPrevious: async () => { calls.push('previous'); return previous; },
    readCurrent: async () => { calls.push('capture'); return current; },
    retainCurrent: async data => { calls.push('retain'); assert.equal(data.raw_dom, current.raw_dom); return 'fixture/full.json'; },
    policy: { target_net_roi: 3 } });
  const out = await read({ triggered_at: current.captured_at });
  assert.deepEqual(calls, ['previous', 'capture', 'retain']);
  assert.equal(out.raw_dom, undefined);
  assert.equal(JSON.stringify(out).includes(current.raw_dom), false);
  assert.equal(out.evidence, 'fixture/full.json');
});

test('budget capacity uses actual five-minute spending, next action delay and sample age', () => {
  const prev = fixture(), cur = fixture('2026-10-05T12:05:00Z');
  Object.assign(prev.active_pool.tasks[0], { cost: 150, budget: 200 });
  Object.assign(cur.active_pool.tasks[0], { cost: 175.05, budget: 200, payment_roi: 9.31 });
  const opts = { now: cur.captured_at, check_interval_seconds: 300, action_delay_seconds: 30 };
  let out = buildDecisionBrief(prev, cur, opts);
  const b = out.budget_watch[0];
  assert.equal(b.remaining_yuan, 24.95);
  assert.equal(b.used_pct, 87.525);
  assert.equal(b.cost_per_minute, 5.01);
  assert.equal(b.capacity_risk, 'before_next_action');
  assert.equal(b.required_seconds_at_capture, 330);
  assert.deepEqual(out.actions, []); // Capacity risk is not permission or an automatic refill decision.
  out = buildDecisionBrief(prev, cur, { ...opts, check_interval_seconds: 120 });
  assert.equal(out.budget_watch[0].capacity_risk, 'covered_at_recent_rate');
  out = buildDecisionBrief(prev, cur, { ...opts, check_interval_seconds: 120, now: '2026-10-05T12:08:00Z' });
  assert.equal(out.budget_watch[0].capacity_risk, 'before_next_action');
  cur.active_pool.tasks[0].budget = 500; // Manual budget changes must replace stale capacity.
  assert.equal(buildDecisionBrief(prev, cur, opts).budget_watch[0].remaining_yuan, 324.95);
});

test('missing timing, no rate, incomplete pools and depleted budget remain distinct', () => {
  const prev = fixture(), cur = fixture('2026-10-05T12:05:00Z');
  const opts = { check_interval_seconds: 300, action_delay_seconds: 30 };
  Object.assign(cur.active_pool.tasks[0], { cost: 99, budget: 100 });
  assert.equal(buildDecisionBrief(prev, cur).budget_watch[0].capacity_risk, 'unknown');
  assert.equal(buildDecisionBrief(prev, cur).timing.remaining_seconds, null);
  assert.equal(buildDecisionBrief(null, cur, opts).budget_watch[0].runway_seconds_at_capture, null);
  prev.active_pool.tasks[0].cost = 99;
  assert.equal(buildDecisionBrief(prev, cur, opts).budget_watch[0].capacity_risk, 'unknown');
  cur.active_pool.tasks[0].cost = 100;
  assert.equal(buildDecisionBrief(prev, cur, opts).budget_watch[0].capacity_risk, 'exhausted');
  cur.active_pool.complete = false;
  assert.equal(buildDecisionBrief(prev, cur, opts).budget_watch[0].capacity_risk, 'unknown');
});

test('reader forwards configured timing and overdue feedback even when current capture omits it', async () => {
  const prev = fixture(), cur = fixture('2026-10-05T12:16:40Z');
  prev.pending_queue = [{ task_id: id, feedback_until: '2026-10-05T12:05:00Z' }];
  const out = buildDecisionBrief(prev, cur);
  assert.equal(out.pending[0].overdue_seconds, 700);
  assert.equal(out.pending[0].due, true);
  const read = createRoundBriefReader({ readCurrent: async () => cur, loadPrevious: async () => prev,
    retainCurrent: async () => 'fixture/raw.json', check_interval_seconds: 300, action_delay_seconds: 45 });
  const brief = await read({ next_check_at: '2026-10-05T12:20:00Z' });
  assert.equal(brief.timing.check_interval_seconds, 300);
  assert.equal(brief.timing.action_delay_seconds, 45);
  assert.equal(brief.pending.length, 1);
});

test('brief finalizer retains complete evidence but returns no duplicated full result; CAS still protects state', async () => {
  const root = process.env.QC_TEST_RUN_ROOT;
  assert.ok(root, 'Run through checks/run-tests.cjs');
  const scene = path.join(root, 'brief-record');
  await fs.mkdir(scene, { recursive: true });
  const prev = fixture(), cur = fixture('2026-10-05T12:02:00Z');
  const latest = path.join(scene, 'codex-latest-round.json');
  await fs.writeFile(latest, JSON.stringify(prev));
  const args = { scene_dir: scene, round_dir: path.join(scene, 'round'), previous: prev, current: cur, state_text: 'fixture state' };
  const out = await saveRoundBrief(args);
  assert.equal(out.saved, true);
  assert.equal(out.result, undefined);
  assert.deepEqual(JSON.parse(await fs.readFile(out.full_round, 'utf8')).actions, []);
  await assert.rejects(saveRoundBrief({ ...args, round_dir: path.join(scene, 'conflict') }), /advanced/);
  assert.equal(JSON.parse(await fs.readFile(latest, 'utf8')).captured_at, cur.captured_at);
});

test('handoff loads shared current control and write modules with source hashes and no browser actions', async () => {
  const root = path.join(process.env.QC_TEST_RUN_ROOT, 'module-handoff');
  const control = await loadQianchuanControlPools({ run_root: root });
  const replay = await loadQianchuanBoostReplay({ run_root: root });
  assert.equal(typeof control.readQianchuanControlPool, 'function');
  assert.equal(typeof replay.replayQianchuanBoostCreate, 'function');
  for (const dir of await fs.readdir(path.join(root,'control-modules'))) {
    const stamp = JSON.parse(await fs.readFile(path.join(root,'control-modules', dir, 'source.json'), 'utf8'));
    for(const source of stamp.sources)assert.equal(source.sha256,createHash('sha256').update(await fs.readFile(source.source)).digest('hex'));
    assert.equal(stamp.advertising_writes, 0);
  }
});
