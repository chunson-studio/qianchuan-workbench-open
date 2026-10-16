// Real bound browser validation: UI navigation and dry-run preflight only.
// No engine runRound/applyDecisions and no advertising submit is called here.
export async function verifyBrowserRead({tab,compass,binding,stepsModule,checkpoint,label='current'}) {
  if(typeof checkpoint!=='function'||!stepsModule?.createQianchuanBrowserSteps)throw Error('verification_dependencies_required');
  const scene={url:await compass.url(),dom:await compass.playwright.domSnapshot(),observed_at:new Date().toISOString()};
  const sceneUrl=new URL(scene.url);
  if(sceneUrl.hostname!=='compass.jinritemai.com'||sceneUrl.searchParams.get('live_room_id')!==binding.room_id
    ||!scene.dom.includes(binding.live_name)||!scene.dom.includes(binding.live_start_display)||!scene.dom.includes('直播已结束'))throw Error('ended_scene_not_verified');
  await checkpoint({id:'verification.scene',status:'read_verified',binding,...scene});
  const calls=[],builders=new Set(['getByRole','getByText','getByLabel','getByPlaceholder','getByTestId','locator','filter','nth','first','last','frameLocator']);
  const wrap=obj=>new Proxy(obj,{get(target,key){const value=target[key];if(key==='playwright')return wrap(value);if(typeof value!=='function')return value;
    return (...args)=>{if(builders.has(key))return wrap(value.apply(target,args));const start=Date.now();return Promise.resolve(value.apply(target,args)).finally(()=>calls.push({method:key,elapsed_ms:Date.now()-start}));};
  }});
  const measured=wrap(tab),ui=stepsModule.createQianchuanBrowserSteps({tab:measured,binding,checkpoint,allowed_pools:['调控中','手动暂停'],allow_search:false});
  const initial=await ui.view();
  if(!['调控中','手动暂停'].includes(initial.view.actual_filter))throw Error('preserve_nonstandard_initial_pool');
  const started=Date.now(),offset=calls.length,stages=[];
  let active,paused,dryRun;
  try {
    for(const pool of ['调控中','手动暂停']){
      const start=Date.now(),first=calls.length,result=await ui.readPool(pool);
      stages.push({pool,elapsed_ms:Date.now()-start,call_count:calls.length-first,total:result.pool.total,complete:result.pool.complete});
      if(pool==='调控中')active=result.pool;else paused=result.pool;
    }
    const read_ms=Date.now()-started,read_calls=calls.length-offset;
    if(paused.tasks.length){
      const target_id=paused.tasks[0].task_id;
      dryRun=await stepsModule.executeQianchuanTaskAction(measured,{action:'resume',target_id,binding,execute:false,allowed_pools:['调控中','手动暂停'],allow_search:false,on_checkpoint:checkpoint});
      if(dryRun.effect_status!=='not_submitted'||dryRun.ad_writes!==0)throw Error('dry_run_contract_failed');
    }
    return {label,binding,advertising_writes:0,read_ms,read_calls,stages,active_ids:active.tasks.map(t=>t.task_id),paused_ids:paused.tasks.map(t=>t.task_id),dry_run:dryRun??{status:'no_paused_target'},calls};
  } finally {
    await ui.choosePool(initial.view.actual_filter);
    await checkpoint({id:'verification.restored',status:'read_verified',pool:initial.view.actual_filter,binding});
  }
}
