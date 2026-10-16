import {test} from 'node:test';
import assert from 'node:assert/strict';
import {summarizeMaterialTests,evaluateMaterialActions,formatMaterialReport} from '../tools/codex-qc-material-control.cua.mjs';
test('public material execution keeps raw values without recommendations',()=>{
 const brief=summarizeMaterialTests({board:{cost:0,net_gmv:null,roi:null,online:0},pool:{complete:true,issues:[],human_editor:false,tasks:[]}});
 assert.equal(brief.strategy_status,'not_included');assert.equal(brief.board.cost,0);assert.equal(brief.board.net_gmv,null);
 assert.deepEqual(evaluateMaterialActions({}).actions,[]);
 const report=formatMaterialReport(brief);assert.match(report,/¥0/);assert.match(report,/未知/);assert.doesNotMatch(report,/好计划|ROI≥|零消耗/);
});
