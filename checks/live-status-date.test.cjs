'use strict';
require('./setup-runtime.cjs');
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const cookie=require('../server-app/server/lib/cookie');
cookie.resolveAavid=()=> 'fixture-advertiser';
const qc=require('../server-app/server/lib/qianchuan');
const calls=[];
qc.statQuery=async body=>{
  calls.push(body);
  return {status_code:0,data:{StatsData:{Rows:[{Dimensions:{
    room_id:{Value:'fixture-live-room'},room_status:{Value:'2'},
    room_start_time:{Value:body.StartTime.replace('00:00:00','19:25:53')},
    room_end_time:{Value:'-'},room_name:{Value:'fixture'}
  },Metrics:{}}]}}};
};
const {fetchLiveStatus}=require('../server-app/server/lib/qianchuanTabs');
const {getLocalDateStr}=require('../server-app/server/lib/utils');
const projectConfig=path.resolve(__dirname,'../server-app/config.json');

for(const explicit of [undefined,'2026-09-27'])test('live status does not consult a stale production date override; explicit='+explicit,async t=>{
  const read=fs.readFileSync;let escapedReads=0;
  // Model the actual failed deployment without reading or editing real config.
  t.mock.method(fs,'readFileSync',function(file,...args){
    if(typeof file==='string'&&path.resolve(file)===projectConfig){
      escapedReads++;return JSON.stringify({date_override:'2000-01-01'});
    }
    return read.call(this,file,...args);
  });
  const status=await fetchLiveStatus('fixture-account',explicit?{date:explicit}:{});
  assert.equal(escapedReads,0);
  assert.equal(calls.at(-1).StartTime,(explicit||getLocalDateStr())+' 00:00:00');
  assert.equal(status.isLive,true);assert.equal(status.rooms[0].roomId,'fixture-live-room');
  assert.equal(status.rooms[0].startTime,(explicit||getLocalDateStr())+' 19:25:53');
});
