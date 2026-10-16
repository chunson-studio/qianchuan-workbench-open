import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizePoolPages} from './codex-qc-browser-data.mjs';
import {buildDecisionBrief} from './codex-qc-decision-brief.mjs';
const binding={advertiser_id:'11',primary_ad_id:'22',room_id:'33',date:'2026-10-08',session_started_at:'2026-10-08T09:00:00+08:00'};
const at='2026-10-08T10:00:00+08:00';
const brief=()=>({binding,at,board:{cost:10,gmv:199,net_roi:12,metric_basis:'platform_整体消耗_净成交ROI'},live_top:{realtime_online:32},five:{online:99},
 tasks:{columns:['id','payment_roi'],active:[['101',6],['102',8]],coverage:{active:true},sampled_at:[at,at]}});

test('task parser keeps per-task ROI without touching the former summary rows',()=>{
 const headers=['任务名称','调控状态','调控消耗','调控成交订单数','调控支付ROI','调控预算(元)','调控时长(小时)'];
 const dom=['- generic: ID：11','- generic: 计划ID：22','- textbox "请选择开始日期": 2026-10-08','- textbox "请选择结束日期": 2026-10-08','- textbox "请选择"','- textbox "请选择"','- textbox "请选择": 调控中','- table:','  - row:',...headers.map(h=>'    - columnheader "'+h+'"'),'  - row "共1条任务":','- generic: 共1条记录'].join('\n');
 const page={page:1,dom,captured_at:at,rows:[['人工原生名称 ID: 101','调控中','10','1','7','100','6']],
  get summary_rows(){throw Error('summary extraction removed');}};
 const pool=normalizePoolPages([page],'调控中',binding);assert.equal(pool.complete,true);
 assert.equal(pool.tasks[0].payment_roi,7);assert.equal(pool.tasks[0].task_id,'101');assert.equal(pool.native_summary,undefined);
});
test('old native totals are not carried into the decision brief and do not gate trading',()=>{
 const pool={total:0,tasks:[],complete:true,empty_verified:true,captured_at:at,get native_summary(){throw Error('old summary must not propagate');}};
 const current={binding,captured_at:at,compass:{room_id:binding.room_id,live_start_display:'09:00',in_live:true,cost:1,net_gmv:10,net_roi:10,gmv:12,refund:2},
 active_pool:Object.assign(Object.create(pool),{filter:'调控中'}),paused_pool:Object.assign(Object.create(pool),{filter:'手动暂停'})};
 const b=buildDecisionBrief(null,current);assert.equal(b.quality.write_ready,true);assert.deepEqual(b.quality.missing,[]);assert.equal(b.reporting,undefined);
});
