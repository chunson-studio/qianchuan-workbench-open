/* Product preview. Loaded before shared.js so sample mode never starts a real API read. */
(function () {
  'use strict';
  if (new URLSearchParams(location.search).get('demo') !== '1') return;
  const started = new Date(Date.now() - 82 * 60000).toISOString();
  const accounts = [{ id:'demo_direct',name:'示例 · 品牌直营',break_even_roi:null },
    { id:'demo_partner',name:'示例 · 渠道合作',break_even_roi:null }];
  const rooms = [
    { account:'demo_direct',roomId:'demo_room_main',roomName:'品牌主直播间',name:'品牌主直播间',startTime:started,cost:1280.60,netRoi:6.42,gmv:9053.84,netGmv:8221.45,orders:108,target:6,boosts:3 },
    { account:'demo_direct',roomId:'demo_room_new',roomName:'新品专场',name:'新品专场',startTime:started,cost:426.80,netRoi:4.75,gmv:2304.72,netGmv:2027.30,orders:27,target:5,boosts:2 },
    { account:'demo_partner',roomId:'demo_room_partner',roomName:'渠道直播间',name:'渠道直播间',startTime:started,cost:685.20,netRoi:5.84,gmv:4446.95,netGmv:4001.57,orders:54,target:5.5,boosts:2 },
  ];
  const sampleDate = new Date(Date.now() + 8*3600000).toISOString().slice(0,10);
  const yesterday = new Date(Date.now() + 8*3600000 - 86400000).toISOString().slice(0,10);
  const archiveStart = yesterday + ' 19:30:00', archiveEnd = yesterday + ' 21:00:00';
  const archiveTrend = Array.from({length:18},(_,i)=>({
    time:new Date(Date.parse(yesterday+'T19:30:00+08:00')+(i+1)*300000).toISOString(),
    cost:50,gmvSettle:+(50*(5.2 + i*.085 + Math.sin(i*.6)*.45)).toFixed(2)
  }));
  const archiveGmv = +archiveTrend.reduce((sum,p)=>sum+p.gmvSettle,0).toFixed(2);
  function sampleSession(account) {
    return {roomId:'demo_archive_'+account,startTime:archiveStart,endTime:archiveEnd,status:'3',
      cost:900,netGmv:archiveGmv,netRoi:+(archiveGmv/900).toFixed(2),orderCount:78};
  }
  function sampleRounds(account, sessionKey) {
    return rooms.filter(r=>r.account===account).map((r,i)=>({
      round_id:'demo_round_'+r.roomId,account_id:account,session_key:[account,r.roomId,r.startTime].join('|'),
      phase:'live',observed_at:new Date(Date.now()-(i+1)*60000).toISOString(),
      summary:i===0?'示例：核对本场目标，继续观察':'示例：记录低于本地目标的房间',
      observations:[`本场消耗 ${r.cost.toFixed(2)} 元，平台 1 小时净 ROI ${r.netRoi.toFixed(2)}`],
      judgments:[`与本房间目标 ${r.target.toFixed(2)} 比较；达到目标不等于盈利`],
      recommendations:['保留本轮数据，后续继续核验同场变化'],actions:[],outcome:null,
      source:{type:'demo'},snapshot:{verified:false,reason:'demo_fixture',meta:{freshness:'示例',data_valid:false}}
    })).filter(r=>!sessionKey || r.session_key===sessionKey);
  }
  function response(url) {
    const at = new Date().toISOString(), account = url.searchParams.get('account') || url.searchParams.get('accountId') || url.searchParams.get('account_id') || accounts[0].id;
    const scopeRooms = rooms.filter(r => r.account === account), requestedRoom = url.searchParams.get('room_id');
    const room = requestedRoom ? scopeRooms.find(r => r.roomId === requestedRoom) : scopeRooms[0];
    if (!room) return {ok:false,code:'demo_scope_mismatch',error:'示例账户与直播间不匹配，请返回总览重新选择。'};
    switch (url.pathname) {
      case '/api/accounts': return {ok:true,accounts,archived_accounts:[]};
      case '/api/workbench-snapshot': return {ok:true,schema_version:1,source:'local_only',generated_at:at,max_age_seconds:300,accounts,issues:[],upstream_requests:0,
        sessions:rooms.map((r,i)=>({id:r.roomId,account_id:r.account,account_name:accounts.find(a=>a.id===r.account).name,name:r.name,
          binding:{advertiser_id:r.account,primary_ad_id:'demo_plan_'+i,room_id:r.roomId,session_started_at:started},
          source:'demo',captured_at:at,financial_at:at,online_at:at,freshness:'current',live_state:'live',execution:null,
          metrics:{cost:r.cost,gmv:r.gmv,roi:r.netRoi,cost_label:'整体消耗',roi_label:'净成交ROI',online:28+i*5,active_tasks:r.boosts},
          actions:{create:0,pause:0,resume:0},pending_count:0,operations:[],rounds:[],issues:[]}))};
      case '/api/version': return {ok:true,v:'demo-21'};
      case '/api/status': return {ok:true,queue:{running:0,pending:0}};
      case '/api/live-watch': return {ok:true,accounts:accounts.map(a=>({accountId:a.id,isLive:true,status_stale:false,liveCheckedAt:at,
        available_rooms:rooms.filter(r=>r.account===a.id)}))};
      case '/api/config': return {ok:true,account,room_id:room.roomId,account_params:{target_roi:room.target,target_roi_basis:'platform_net_1h'}};
      case '/api/live-dashboard': {
        const boosts = Array.from({length:room.boosts+1},(_,i)=>{
          const cost=+(room.cost*.018/(i+1)).toFixed(2),netRoi=6.1+i,payRoi=7.2+i;
          const paused = i === room.boosts;
          return {id:`demo_boost_${room.roomId}_${i}`,name:paused?'暂停回补示例':['产品讲解','用户场景','直播片段'][i],
            status:paused?'已暂停':'投放中',board_group:paused?'manual_paused':'active',cost,roi:payRoi,net_roi:netRoi,order_count:paused?3:3-i,
            budget:100,net_gmv:+(cost*netRoi).toFixed(2),gmv:+(cost*payRoi).toFixed(2),source_at:at,
            metric_roi_basis:{roi:'payment',net_roi:'platform_net_1h'},duration_seconds:paused?72000:[21600,36000,43200][i],duration_unit:'seconds',
            funnel:{show_cnt:2000+i*240,click_cnt:96+i*12,source_type:'boost_list_stats',window:{start:sampleDate,end:sampleDate},
              collected_at:at,upstream_updated_at:null,joint_evidence_valid:false,
              ctr:{value:4.8,percent:4.8,unit:'percent'},cvr:i===1?{value:1.8,percent:null,unit:'unknown'}:{value:2.2,percent:2.2,unit:'percent'}}};
        });
        return {ok:true,account,account_info:{name:accounts.find(a=>a.id===account)?.name},dataValid:true,stale:false,partial:false,
          fetchedAt:at,server_time:at,liveCheckedAt:at,session_key:[account,room.roomId,room.startTime].join('|'),source_type:'demo',
          live:{isLive:true,roomId:room.roomId,startTime:room.startTime,rooms:[room]},
          component_times:{core:{source_at:at}},thresholds:{target_roi:room.target,target_roi_basis:'platform_net_1h'},
          today:{cost:room.cost,roi:room.netRoi+.65,gmv:+(room.cost*(room.netRoi+.65)).toFixed(2),netRoi:room.netRoi,netGmv:room.netGmv,orderCount:room.orders,orderCountPay:room.orders+5},
          boost_tasks:boosts,boost_data_valid:true,boost_truncated:false,boost_source_at:at,boost_coverage:{list_complete:true},
          boost_window:{start:sampleDate,end:sampleDate},
          plan:{id:'demo_plan_'+room.roomId,name:'示例主计划',status:'投放中',budget:2000,roi_goal:room.target,roi_goal_basis:'platform_net_1h'},
          riskAlerts:[],suggestions:[],errors:[],materials_top:[],live_metrics:{cost:room.cost,assistCost:room.cost*.3,online:28,gpm:712},
          financial_basis:{payment_roi:'payment',net_roi:'platform_net_1h'}};
      }
      case '/api/onboarding': return {ok:true,first_use:false,accounts,account:accounts.find(a=>a.id===account)||accounts[0],answers:{},questions:[],next_questions:[],answered:[],
        authorization:{explanation:'这是示例工作区。连接你自己的账户后再配置经营资料。'},login_url:'https://qianchuan.jinritemai.com/',cookie_editor_url:'https://cookie-editor.com/'};
      case '/api/decision-rounds': {
        const rounds=sampleRounds(account,url.searchParams.get('session_key'));
        return {ok:true,account_id:account,rounds,total:rounds.length,has_more:false};
      }
      case '/api/agent-rounds': return {ok:true,rounds:[]};
      case '/api/agent-memory': return {ok:true,decisions:[],items:[]};
      case '/api/live-replay/sessions': {
        const start=url.searchParams.get('start'),end=url.searchParams.get('end');
        const sessionsFor=date=>date===yesterday?[sampleSession(account)]:[];
        if(!start || !end) return {ok:true,account,sessions:sessionsFor(url.searchParams.get('date')),settle_window_min:90};
        const days=[];
        for(let day=Date.parse(start+'T00:00:00Z'),last=Date.parse(end+'T00:00:00Z');day<=last && days.length<31;day+=86400000){
          const date=new Date(day).toISOString().slice(0,10),sessions=sessionsFor(date);
          days.push({date,status:'ready',stale:false,source_at:at,cache_stable:true,session_count:sessions.length,sessions});
        }
        return {ok:true,mode:'archive_catalog',account,date_range:{start,end},days,pending_dates:[],partial:false,
          settle_window_min:90,source_type:'demo',settlement_basis:'platform_net_1h',final_settlement_available:false};
      }
      case '/api/live-replay': return {ok:true,account,room_id:'demo_archive_'+account,start_time:archiveStart,end_time:archiveEnd,
        live_metrics:{cost:900,gmvSettle:archiveGmv,roiSettle:archiveGmv/900,orders:78,gpm:712},
        trend:archiveTrend,materials:[],riskAlerts:[],thresholds:{break_even_roi:null},
        source_type:'demo',fetched_at:at,settle_window_min:90,stale:false,final_settlement_available:false};
      case '/api/compass/screen': return {ok:false,code:'demo_optional_data',error:'示例未展示罗盘数据，可返回总览体验房间筛选。'};
      case '/api/home-split': return {ok:true,date:url.searchParams.get('date'),data_valid:false,reason:'demo_optional_data'};
      default: return {ok:false,code:'demo_not_available',error:'示例暂不展示这部分数据。连接账户后可使用。'};
    }
  }
  const realFetch = window.fetch.bind(window);
  window.QC_DEMO = Object.freeze({ active:true });
  document.documentElement.dataset.demo = 'true';
  window.fetch = async function (input, options = {}) {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
    if (url.origin !== location.origin || !/^\/(api|compass_api)(\/|$)/.test(url.pathname)) return realFetch(input, options);
    const method = String(options.method || input?.method || 'GET').toUpperCase();
    const result = method === 'GET' || method === 'HEAD' ? response(url)
      : {ok:false,code:'demo_read_only',error:'示例仅供体验，不会保存配置或操作投放。请退出示例后连接自己的账户。'};
    return new Response(JSON.stringify({...result,demo:true}),{status:result.ok===false?403:200,headers:{'Content-Type':'application/json'}});
  };
})();
