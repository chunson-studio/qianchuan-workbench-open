'use strict';
require('./setup-runtime.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const qc = require('../server-app/server/lib/qianchuan');
const cookie = require('../server-app/server/lib/cookie');
let upstream;
cookie.resolveAavid = id => { assert.equal(id, 'test'); return 'advertiser'; };
qc.statQuery = async () => upstream;
const { fetchLiveSessions } = require('../server-app/server/lib/qianchuanTabs');
test('净 ROI 真实零与隐藏值分开，场次读取失败不伪造空成功', async () => {
  const row = { Dimensions: { room_id: { Value: 'room' }, room_status: { Value: '2' }, room_start_time: { Value: '2026-09-29 19:30:00' } },
    Metrics: { total_prepay_and_pay_settle_roi2_1h: { Value: 0 }, stat_cost_for_roi2: { Value: 0 } } };
  upstream = { code: '0', data: { StatsData: { Rows: [row] } } };
  let result = await fetchLiveSessions('2026-09-29', { accountId: 'test' });
  assert.equal(result.data_valid, true); assert.equal(result.sessions[0].netRoi, 0); assert.equal(result.sessions[0].cost, 0);
  row.Metrics.total_prepay_and_pay_settle_roi2_1h = { Value: 0, ControlType: '0' };
  result = await fetchLiveSessions('2026-09-29', { accountId: 'test' });
  assert.equal(result.sessions[0].netRoi, null);
  upstream = { code: 1, data: { StatsData: { Rows: [] } } };
  result = await fetchLiveSessions('2026-09-29', { accountId: 'test' });
  assert.equal(result.data_valid, false); assert.equal(result.count, null);
});

test('numeric scene timestamps use platform Asia/Shanghai rather than the host timezone',async()=>{
  const start=Date.parse('2026-10-16T01:40:42Z')/1000,end=Date.parse('2026-10-16T04:00:00Z')/1000;
  upstream={code:0,data:{StatsData:{Rows:[{Dimensions:{room_id:{Value:'room'},room_status:{Value:'4'},room_start_time:{Value:String(start)},room_end_time:{Value:String(end)}}}]}}};
  const result=await fetchLiveSessions('2026-10-16',{accountId:'test'});
  assert.equal(result.sessions[0].startTime,'2026-10-16 09:40:42');
  assert.equal(result.sessions[0].endTime,'2026-10-16 12:00:00');
});
