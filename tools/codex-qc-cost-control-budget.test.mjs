import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateCostControlBudget as calculate} from './codex-qc-cost-control-budget.mjs';

const window = {start:'2026-10-10',end:'2026-10-10'};
const task = (task_id, budget, cost, extra = {}) => ({task_id,budget,cost,type:'控成本追投',status:'调控中',window,...extra});
const pool = (tasks, extra = {}) => ({tasks,window,complete:true,issues:[],daily_budget:2400,remaining_budget:1900,...extra});

test('release unspent amounts without returning spent funds or changing official available budget', () => {
  const result = calculate({pool:pool([task('1',100,40),task('2',100,30),task('3',100,30)])});
  assert.equal(result.releasable_budget,200);
  assert.equal(result.estimated_remaining_budget,2100);
  assert.equal(result.remaining_budget,1900);
  assert.equal(result.daily_budget,2400);
  assert.equal(result.complete,true);
});
test('selected IDs are deduplicated; totals are supplied by the platform', () => {
  const result = calculate({pool:pool([task('1',200,5),task('2',200,10)],{daily_budget:6000,remaining_budget:5000}),task_ids:['2','2']});
  assert.equal(result.releasable_budget,190);
  assert.equal(result.estimated_remaining_budget,5190);
  assert.equal(result.scope,'selected_tasks');
});
test('cents, overspent tasks and already deleted tasks', () => {
  const result = calculate({pool:pool([task('1',100,0.01),task('2',100,120),task('3',100,10,{status:'已删除'})]),task_ids:['1','2','3']});
  assert.equal(result.releasable_budget,99.99);
  assert.equal(result.estimated_remaining_budget,1999.99);
});
test('only cost-control tasks in the current pool enter default release calculation', () => {
  const result=calculate({pool:pool([task('1',100,10),task('2',100,0,{type:'放量追投'})])});
  assert.equal(result.releasable_budget,90);
  assert.equal(result.scope,'read_pool');
  assert.equal(calculate({pool:pool([task('2',100,0,{type:'放量追投'})]),task_ids:['2']}).releasable_budget,null);
});
test('incomplete, unverified, missing, duplicate and cross-day task data remain unknown', () => {
  const fixtures = [
    pool([task('1',100,10)],{complete:false}),
    pool([task('1',100,10)],{issues:['plan_identity_mismatch']}),
    pool([task('1',100,null)]),
    pool([task('1',100,1),task('1',100,1)]),
    pool([task('1',100,1,{window:{start:'2026-10-09',end:'2026-10-09'}})]),
    pool([task('1',100,1)],{window:{start:'2026-10-09',end:'2026-10-10'}})
  ];
  for (const input of fixtures) assert.equal(calculate({pool:input}).releasable_budget,null);
  assert.equal(calculate({pool:pool([]),task_ids:['9']}).releasable_budget,null);
});
test('unknown or inconsistent official limits do not become spendable estimates', () => {
  let result=calculate({pool:pool([task('1',100,10)],{remaining_budget:null})});
  assert.equal(result.releasable_budget,90);
  assert.equal(result.estimated_remaining_budget,null);
  result=calculate({pool:pool([task('1',100,10)],{remaining_budget:2390})});
  assert.equal(result.estimated_remaining_budget,null);
  assert.ok(result.issues.includes('budget_snapshot_inconsistent'));
});
test('empty selection releases zero; invalid numeric IDs are rejected', () => {
  assert.equal(calculate({pool:pool([task('1',100,10)]),task_ids:[]}).releasable_budget,0);
  assert.throws(()=>calculate({pool:pool([]),task_ids:[60000022]}),/invalid_task_ids/);
});
