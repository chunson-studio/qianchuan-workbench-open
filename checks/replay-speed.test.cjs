'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(require('./test-output.cjs').testOutputRoot(), 'replay-speed-'));
process.env.QC_RUNTIME_CONFIG_ROOT = root;
process.env.QC_RUNTIME_DATA_ROOT = root;
const config = require('../server-app/server/lib/config');
config.QIANCHUAN_ACCOUNTS.push({id:'replay_test',name:'Test',aavid:'1234567890'});
const tabs = require('../server-app/server/lib/qianchuanTabs');
const board = require('../server-app/server/lib/liveBoard');
const details = require('../server-app/server/lib/liveBoardDetail');
const collector = require('../server-app/server/lib/liveCollector');
collector.getLatestWatch = () => [];
let listCalls = 0, boardCalls = 0, listWait, boardWait, failBoard = false;
const today = require('../server-app/server/lib/utils').beijingDay();
const start = today + ' 18:00:00', end = today + ' 21:00:00';
const stamp = new Date(Date.now()-120000).toISOString();
const value = Value => ({Value});
tabs.fetchLiveSessions = async () => { listCalls++; if(listWait) await listWait; return {sessions:[{roomId:'r1',startTime:start,endTime:end,status:'4',cost:99}]}; };
board.fetchLiveBoard = async () => { boardCalls++; if(boardWait) await boardWait; return {fetched_at:new Date().toISOString(),anchorId:'anchor',metrics:{rows:failBoard?[]:[{Metrics:{stat_cost_for_roi2:value(99),total_order_settle_amount_realtime_for_roi2_1h:value(198),total_order_settle_count_realtime_for_roi2_1h:value(2)}}]},trend:{rows:[]},materials:{}}; };
details.fetchBoardDetail = async () => ({partial:false,errors:[]});
const route = require('../server-app/server/routes/liveReplay');
const dir = path.join(config.STORAGE_DIR,'replay'); fs.mkdirSync(dir,{recursive:true});
const listFile = date => path.join(dir,`sessions_replay_test_${date}.json`);
async function read(query, list = false) {
  let payload, status;
  await route({method:'GET'}, {writeHead(s){status=s;},end(s){payload=JSON.parse(s);}},new URL('http://localhost/api/live-replay'+(list?'/sessions':'')+'?account=replay_test&'+query));
  return {payload,status};
}
const nextTurn = () => new Promise(resolve=>setImmediate(resolve));

test('当天列表先返已有场次，阻塞刷新去重；更新后替换，历史空日无需反复请求', async () => {
  fs.writeFileSync(listFile(today),JSON.stringify({ok:true,date:today,fetchedAt:stamp,sessions:[{roomId:'r1',startTime:start,endTime:end,status:'4',cost:50}]}));
  let release; listWait = new Promise(r=>release=r);
  const results = await Promise.all(Array.from({length:8},()=>read('date='+today,true)));
  assert.equal(listCalls,1);
  assert.ok(results.every(r=>r.payload.sessions[0].cost===50 && r.payload.refreshing));
  release(); listWait = null; await nextTurn();
  assert.equal((await read('date='+today,true)).payload.sessions[0].cost,99);
  const prior = '2020-01-01';
  fs.writeFileSync(listFile(prior),JSON.stringify({ok:true,date:prior,fetchedAt:new Date().toISOString(),sessions:[]}));
  await read('date='+prior,true); assert.equal(listCalls,1);
});

test('未稳定详情先返存档，多读取只补采一次；真实来源时间保留', async () => {
  // 无结束时间，必须更新，不能当作最终数据。
  const file=route._internal.replayStoragePath('replay_test','r1',start);
  fs.writeFileSync(file,JSON.stringify({ok:true,roomId:'r1',room:{room_id:'r1',start_time:start},fetchedAt:stamp,dataValid:true,live_metrics:{cost:50},trend:[]}));
  let release; boardWait=new Promise(r=>release=r);
  const q='roomId=r1&startTime='+encodeURIComponent(start);
  const results=await Promise.all(Array.from({length:8},()=>read(q)));
  assert.equal(boardCalls,1);
  assert.ok(results.every(r=>r.payload.live_metrics.cost===50 && r.payload.fetchedAt===stamp && r.payload.refreshing));
  release(); boardWait=null; await nextTurn();
  const latest=(await read(q)).payload;
  assert.equal(latest.live_metrics.cost,99);
  assert.notEqual(latest.fetchedAt,stamp);
  assert.equal(latest.room.start_time,start);
});

test('早期单场存档不会随时间变成稳定终值，补采后才稳定且不重复读取', async () => {
  const sessionStart = '2020-01-01 18:00:00', sessionEnd = '2020-01-01 20:00:00';
  const sampledEarly = '2020-01-01T20:10:00+08:00';
  const file = route._internal.replayStoragePath('replay_test', 'early-room', sessionStart);
  const cached = { ok: true, account: 'replay_test', roomId: 'early-room',
    room: { room_id: 'early-room', start_time: sessionStart, end_time: sessionEnd },
    dataValid: true, fetchedAt: sampledEarly, cachedAt: new Date().toISOString(), live_metrics: { cost: 42 } };
  const settled = route._internal.replaySettled;
  assert.equal(settled(cached), false);
  assert.equal(settled({ ...cached, fetchedAt: undefined }), false, '落盘时间不能代替源采样时间');
  assert.equal(settled({ ...cached, fetchedAt: '2020-01-01T21:30:00+08:00' }), false);
  assert.equal(settled({ ...cached, fetchedAt: '2020-01-01T21:30:00.001+08:00' }), true);
  assert.equal(settled({ ...cached, fetchedAt: new Date(Date.now() + 61000).toISOString() }), false);
  assert.equal(settled({ ...cached, dataValid: false, fetchedAt: new Date().toISOString() }), false);
  fs.writeFileSync(file, JSON.stringify(cached));
  let release; boardWait = new Promise(resolve => { release = resolve; });
  const before = boardCalls;
  const query = 'roomId=early-room&startTime=' + encodeURIComponent(sessionStart) + '&endTime=' + encodeURIComponent(sessionEnd);
  const first = await read(query);
  assert.equal(first.payload.live_metrics.cost, 42);
  assert.equal(first.payload.fetchedAt, sampledEarly);
  assert.equal(first.payload.settlement_state.cache_stable, false);
  assert.equal(first.payload.refreshing, true);
  assert.equal(boardCalls, before + 1);
  release(); boardWait = null; await nextTurn();
  const fresh = await read(query);
  assert.equal(fresh.payload.live_metrics.cost, 99);
  assert.equal(fresh.payload.settlement_state.cache_stable, true);
  assert.equal(boardCalls, before + 1, '稳定源样本可复用，不再发上游读取');
});

test('失败的核心数据不会覆盖成功存档；账户和场次边界仍受验证', async () => {
  const file=route._internal.replayStoragePath('replay_test','r2',start);
  const original=JSON.stringify({ok:true,roomId:'r2',room:{room_id:'r2',start_time:start},fetchedAt:stamp,dataValid:true,live_metrics:{cost:20}});
  fs.writeFileSync(file,original); failBoard=true;
  const q='roomId=r2&startTime='+encodeURIComponent(start);
  await read(q); await nextTurn();
  assert.equal(fs.readFileSync(file,'utf8'),original);
  assert.equal((await read('roomId=r2')).status,400);
  assert.equal(route._internal.loadReplayStorage('replay_test','r2',today+' 19:00:00'),null);
});
