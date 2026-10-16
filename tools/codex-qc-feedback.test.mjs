import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildFeedbackReviews,reconcileFeedback} from './codex-qc-feedback.mjs';

const at='2026-10-10T06:40:00Z',binding={advertiser_id:'1',primary_ad_id:'2',room_id:'3',session_started_at:'2026-10-10T06:00:00Z'};
const event={task_id:'4',event_id:'create-4',feedback_until:'2026-10-10T06:39:00Z'};
const fixture=()=>({status:'live',observation_id:'observation-1',binding,unresolved:[],brief:{at,binding,evidence:'memory:reader:1',
  tasks:{coverage:{active:true,paused:true},columns:['id','cost','orders','payment_roi'],active:[['4',5.5,0,0]],paused:[]},pending:[event]}});
const review=r=>buildFeedbackReviews(r,{reviewed_at:at});

test('startup review records observed values without an advertising decision or input mutation',()=>{
  const r=fixture(),before=structuredClone(r), reviews=review(r);
  assert.equal(reviews.length,1);assert.deepEqual(JSON.parse(reviews[0].result),{kind:'observed_startup_feedback',sampled_at:at,pool:'active',cost:5.5,orders:0,payment_roi:0});
  assert.deepEqual(r,before);
  const reconciled=reconcileFeedback({pending_queue:[event]},{completed_startup_feedback:reviews},at);
  assert.equal(reconciled.pending.length,0);assert.equal(reconciled.completed.length,1);assert.deepEqual(reconciled.issues,[]);
});
test('startup review preserves unknown ROI, and reads paused tasks by ID',()=>{
  const r=fixture();r.brief.tasks.active=[];r.brief.tasks.paused=[['4',6.8,0,null]];
  assert.deepEqual(JSON.parse(review(r)[0].result),{kind:'observed_startup_feedback',sampled_at:at,pool:'paused',cost:6.8,orders:0,payment_roi:null});
});
test('startup review skips incomplete, future, stale, replayed or cross-scene observations',()=>{
  for(const change of [r=>r.replayed=true,r=>r.status='ended',r=>r.brief.tasks.coverage.paused=false,
    r=>r.brief.binding={...binding,room_id:'9'},r=>r.brief.evidence=null,r=>r.brief.at='2026-10-10T06:35:00Z',
    r=>r.brief.at='2026-10-10T06:41:00Z',r=>r.brief.pending=[{...event,feedback_until:'2026-10-10T06:40:01Z'}]]){
    const r=fixture();change(r);assert.deepEqual(review(r),[]);
  }
});
test('startup review does not complete missing, duplicate, unknown or unresolved targets',()=>{
  for(const change of [r=>r.brief.tasks.active=[],r=>r.brief.tasks.active.push(['4',6,0,0]),r=>r.brief.tasks.active[0][1]=null,
    r=>r.brief.tasks.active[0][2]=null,r=>r.unresolved=[{task_id:'4'}],r=>r.brief.tasks.active[0].pop()]){
    const r=fixture();change(r);assert.deepEqual(review(r),[]);
  }
});
test('startup review deduplicates the same event without merging different events',()=>{
  const r=fixture();r.brief.pending=[event,event,{...event,event_id:'create-4-second'}];
  assert.deepEqual(review(r).map(x=>x.event_id),['create-4','create-4-second']);
});
