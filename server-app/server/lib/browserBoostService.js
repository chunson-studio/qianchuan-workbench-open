'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const { normalizeRequest,READS,legacyWrite,requestedValues,OperationDeadline,fail }=require('./browserBoostContract');
const { BrowserBoostRequests,assertNoUnknownBrowserRequest }=require('./browserBoostRequests');
const { checkHttpWritePolicy,verifyBoostScope }=require('./onboardingGuard');
const { assertBoostExecutionOwner }=require('./boostExecutionOwner');
const { withTargetWriteLock }=require('./targetWriteLock');
const { checkBudgetAdjustment }=require('./budgetAdjustment');
const { getActionLimits,assertActionAllowed,resumeProtection }=require('./actionLimits');
const { validateRoiGoalWrite }=require('./roiBasis');
const { executeWithReceipt }=require('./writeReceipt');
const { selectBinding }=require('../../../tools/playwright-channel.cjs');
const { createPlaywrightBrowserAdapter }=require('../../../tools/lib/playwright-browser-adapter.cjs');
const { normalizeLocalEndpoint }=require('../../../tools/lib/playwright-profile-binding.cjs');
const { BrowserBoostPage }=require('../../../tools/lib/playwright-boost-operations.cjs');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');

function validateParameters(r,before,authorization,optimization) {
  if(r.action==='update_budget') checkBudgetAdjustment({budget:r.budget,expectedBudget:r.expected_budget,current:before?.budget,
    boost:true,authorization,accountId:r.account_id,primaryAdId:r.primary_ad_id,assistTaskId:r.target_id});
  if(r.action==='update_duration' && (!Number.isSafeInteger(before?.duration_seconds) || before.duration_seconds!==r.expected_duration_seconds)) fail('duration_conflict','实际总时长缺失或与预期旧值不一致',409);
  if(r.action==='update_roi' || (r.action==='create' && r.roi_goal!=null)) {
    const contract=validateRoiGoalWrite({providedBasis:r.roi_basis,entity:optimization || before?.optimization});
    if(!contract.ok)fail(contract.code,contract.error,contract.status);
    if(r.action==='update_roi' && (!(before?.roi_goal>0) || Math.abs(r.roi_goal-before.roi_goal)/before.roi_goal>0.1+1e-9))fail('roi_change_exceeds_limit','ROI单次变化不得超过10%，且必须核对实际旧值',403);
  }
  if(r.action==='update_duration' && before?.smart_bid_type!==7)fail('duration_mode_not_supported','必须核验有限期放量模式才能修改时长',423);
  if(['pause','resume','stop','delete'].includes(r.action) && before?.status==null)fail('target_status_unavailable','任务状态未核验',423);
}
class BrowserBoostService {
  constructor(options={}) {this.options=options;this.pool=new Map();}
  config() {return this.options.config || require('./accountRegistry').readConfig(require('./config').CONFIG_PATH);}
  db() {return this.options.db || require('./db').getDB();}
  root() {return this.options.dataRoot || path.join(require('./config').RUNTIME_DATA_ROOT,'browser-boost');}
  bindingsFile() {
    if(this.options.bindingsFile)return this.options.bindingsFile;
    if(process.env.QC_BROWSER_BINDINGS)return path.resolve(process.env.QC_BROWSER_BINDINGS);
    const c=require('./config'), local=path.join(path.dirname(c.CONFIG_PATH),'private-runtime','playwright-bindings.json');
    return fs.existsSync(local)||path.dirname(c.CONFIG_PATH)!==c.ROOT_DIR?local:path.resolve(c.ROOT_DIR,'../private-runtime/playwright-bindings.json');
  }
  async connection(r,clock,selected,endpoint) {
    if(this.options.sessionFactory)return {session:await this.options.sessionFactory(r,clock),reused:false,endpoint,release:async()=>{}};
    const entry=selected.entry;
    const key=[endpoint,r.account_id,r.primary_ad_id,r.start,r.end].join('|');
    const existing=this.pool.get(key);
    if(existing) {try{await existing.adapter.connect(r);clearTimeout(existing.timer);return {adapter:existing.adapter,reused:true,endpoint,key,release:async()=>this.idle(key)};}catch{await existing.adapter.close().catch(()=>{});this.pool.delete(key);}}
    const adapter=createPlaywrightBrowserAdapter({cdp_url:endpoint,profile_name:entry.profile_name,connect_timeout_ms:clock.timeout(15000)});
    try{await adapter.connect({...r,date_range:[r.start,r.end]});}catch(error){await adapter.close().catch(()=>{});throw error;}
    this.pool.set(key,{adapter});
    return {adapter,reused:false,endpoint,key,release:async()=>this.idle(key)};
  }
  idle(key) {const entry=this.pool.get(key);if(!entry)return;entry.timer=setTimeout(()=>{this.pool.delete(key);entry.adapter.close().catch(()=>{});},300000);entry.timer.unref?.();}
  async close() {for(const entry of this.pool.values()){clearTimeout(entry.timer);await entry.adapter.close().catch(()=>{});}this.pool.clear();}
  async run(input,req={headers:{}}) {
    const clock=new OperationDeadline(this.options.totalMs || 50000);let r;
    try{r=normalizeRequest(input);}catch(error){return {ok:false,code:error.code,error:error.message,effect_status:'rejected',advertising_writes:0,retry_write:false,timings:clock.result()};}
    const write=!READS.has(r.action), config=this.config();
    const account=config.qianchuan_accounts?.find(a=>a.id===r.account_id);
    if(!account)return {ok:false,code:'account_required',advertising_writes:0,effect_status:'rejected',retry_write:false};
    r.advertiser_id=String(account.aavid || account.aadvid || account.id);
    const fingerprintPayload={...r}; // Preserve omitted dates when replaying after midnight.
    const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    r.start=r.start || today;r.end=r.end || today;
    // Returning the original receipt is a read, even when the old scope was revoked.
    if(write && !r.preview) {
      try{const prior=new BrowserBoostRequests(this.db()).lookup(r,fingerprintPayload);if(prior)return prior;}
      catch{return {ok:false,code:'browser_request_store_unavailable',effect_status:'rejected',advertising_writes:0,retry_write:false};}
    }
    const headers=req.headers || {};
    if(write && r.execution_owner && (r.execution_owner!==(headers['x-qc-execution-owner'] || headers['X-QC-Execution-Owner']) ||
      r.session_key!==(headers['x-qc-session-key'] || headers['X-QC-Session-Key'])))return {ok:false,code:'browser_owner_headers_mismatch',
        effect_status:'rejected',advertising_writes:0,retry_write:false};
    const mapped=write?legacyWrite(r):null;
    const auth=write?checkHttpWritePolicy(config,mapped.pathname,mapped.body):null;
    if(write && !r.preview && !auth.allowed)return {ok:false,code:auth.code,error:auth.error,effect_status:'rejected',advertising_writes:0,retry_write:false};
    const root=this.root();fs.mkdirSync(root,{recursive:true});
    const requestId=r.request_id || crypto.randomUUID();const runDir=path.join(root,'runs',requestId+'-'+crypto.randomUUID());
    fs.mkdirSync(runDir,{recursive:true});let sequence=0,session,connection,dispatched=false,journal;
    const evidence=async(id,status,value)=>{
      const file=path.join(runDir,String(++sequence).padStart(3,'0')+'-'+id.replace(/[^A-Za-z0-9_.-]/g,'_')+'.json');
      const data={channel:'playwright-cdp',evidence_origin:this.options.sessionFactory || this.options.evidenceOrigin==='isolated_fixture'?'isolated_fixture':'real_browser',id,status,
        observed_at:new Date().toISOString(),binding:{account_id:r.account_id,advertiser_id:r.advertiser_id,primary_ad_id:r.primary_ad_id,session_key:r.session_key||null},evidence:value};
      const body=JSON.stringify(data,null,2)+'\n';if(Buffer.byteLength(body)>256*1024)fail('browser_evidence_too_large','页面证据超出上限');fs.writeFileSync(file,body,{flag:'wx'});
    };
    let selected,endpoint;
    try{
      if(this.options.sessionFactory)endpoint=this.options.sessionEndpoint?normalizeLocalEndpoint(this.options.sessionEndpoint(r)):'fixture';
      else {selected=selectBinding(this.bindingsFile(),r);endpoint=selected.verified.evidence.cdp_endpoint;}
    }catch(error){return {ok:false,code:error.code || 'browser_binding_unavailable',error:error.message,execution_channel:'browser',
      request_id:r.request_id||null,effect_status:'rejected',advertising_writes:0,retry_write:false,timings:clock.result(),evidence_dir:runDir};}
    const execute=async()=>{
      let profileFd,profileFile;
      try{
        clock.timeout(5000);
        if(write && !r.preview) {
          journal=new BrowserBoostRequests(this.db());const replay=journal.reserve(r,fingerprintPayload);if(replay)return replay;
          assertNoUnknownBrowserRequest(r.account_id,r.primary_ad_id,r.request_id,this.db());
          (this.options.assertOwner || assertBoostExecutionOwner)(req,r.account_id,r.primary_ad_id);
        }
        // The profile UI is shared even for reads. Lock before connecting or navigating.
        profileFile=path.join(root,'endpoint-'+sha(endpoint)+'.lock');
        try{profileFd=fs.openSync(profileFile,'wx');fs.writeFileSync(profileFd,JSON.stringify({pid:process.pid,request_id:requestId,started_at:new Date().toISOString()}));}
        catch(error){fail(error.code==='EEXIST'?'browser_profile_busy':'browser_lock_unavailable','该浏览器有在途操作或锁不可用；不抢占遗留锁',409);}
        connection=await clock.stage('connect',()=>this.connection(r,clock,selected,endpoint));
        session=connection.session || new BrowserBoostPage(connection.adapter,r,clock,evidence);
        const prepared=await clock.stage('locate',()=>session.prepare());
        if(!write)return {ok:true,execution_channel:'browser',channel:'playwright-cdp',advertising_writes:0,data:prepared.read,
          result_status:'read_verified',timings:{...clock.result(),connection_reused:connection.reused},evidence_dir:runDir};
        const before=prepared.before,requested=prepared.requested || requestedValues(r);
        let preflight=null;
        try{
          if(!auth.allowed)fail(auth.code,auth.error,403);
          (this.options.assertOwner || assertBoostExecutionOwner)(req,r.account_id,r.primary_ad_id);
          validateParameters(r,before,auth,session.optimization);
          const limits=(this.options.getLimits || getActionLimits)(r.account_id,r.target_id || r.primary_ad_id);
          if(r.action.startsWith('update_'))assertActionAllowed(limits,r.action);
          if(r.action==='resume') {const protection=(this.options.resumeProtection || resumeProtection)(r.account_id,r.target_id,before.status,before.passive_stop);if(!protection.allowed)fail(protection.reason,'系统被动停止的任务不能直接恢复',423);}
          await (this.options.verifyScope || verifyBoostScope)(auth,mapped.body,session.guardReaders());
        }catch(error){preflight={code:error.code || 'browser_preflight_failed',error:error.message};if(!r.preview)throw error;}
        if(r.preview) {await session.cancel();return {ok:true,preview:true,execution_channel:'browser',advertising_writes:0,
          result_status:'form_verified',before,requested,execution_allowed:!preflight,preflight,effect_status:'preview',retry_write:false,
          timings:{...clock.result(),connection_reused:connection.reused},evidence_dir:runDir};}
        const unchanged=Object.keys(requested).length && Object.entries(requested).every(([key,value])=>JSON.stringify(before?.[key])===JSON.stringify(value));
        if(unchanged){await session.cancel();const result={ok:true,result_status:'no_change',effect_status:'no_change',advertising_writes:0,before,requested,actual:before,request_id:r.request_id,retry_write:false};journal.finish(r,result);return result;}
        const logAction=({create:'create_boost',resume:'enable'})[r.action] || r.action;
        const receipt=await (this.options.receipt || executeWithReceipt)({before,requested,
          write:()=>clock.stage('submit',()=>session.submitOnce(async()=>{clock.timeout(5000);journal.dispatched(r);dispatched=true;await evidence('dispatch','observed',{request_id:r.request_id});})),
          read:()=>clock.stage('readback',()=>session.readback()),readTimeoutMs:()=>clock.timeout(15000),
          preserveFields:before?['budget','duration_seconds','roi_goal','bid','status'].filter(key=>before[key]!=null):[],
          logEntry:{action:logAction,account_id:r.account_id,primary_ad_id:r.primary_ad_id,assist_task_id:r.target_id||null,
            target_type:'boost_task',target_id:r.target_id || 'request:'+r.request_id,source:'agent',params:{execution_channel:'browser',request_id:r.request_id,session_key:r.session_key||null,evidence_dir:runDir}}});
        const result={...receipt,execution_channel:'browser',channel:'playwright-cdp',request_id:r.request_id,
          ...(r.action==='create' && receipt.actual?.id?{task_id:receipt.actual.id}:{}),
          result_status:receipt.effect_status==='confirmed'?'write_verified':receipt.effect_status==='rejected'?'platform_rejected':'unconfirmed',
          timings:{...clock.result(),connection_reused:connection.reused},evidence_dir:runDir};
        // The caller's request value is never substituted for missing actual values.
        try {await evidence('result',result.result_status,result);journal.finish(r,result);}
        catch {result.effect_status='unconfirmed';result.result_status='unconfirmed';result.audit_error='browser_receipt_persistence_failed';result.retry_write=false;if(result.readback){result.readback.verified=false;result.readback.reason=result.audit_error;}
          try{if(result.operation_id)require('./operationLog').attachReceipt(result.operation_id,result);}catch{}
          try{journal.finish(r,result);}catch{}
        }
        return result;
      }catch(error){
        if(session && !dispatched)await session.cancel().catch(()=>{});
        const result={ok:false,code:error.code || 'browser_boost_failed',error:dispatched?'浏览器已到提交环节，结果未确认；沿原编号只读查证':error.message,
          execution_channel:'browser',request_id:r.request_id||null,effect_status:dispatched?'unconfirmed':'rejected',retry_write:false,
          ...(!dispatched?{advertising_writes:0}:{}),timings:clock.result(),evidence_dir:runDir};
        try{if(journal)journal.finish(r,result);}catch{result.audit_error='browser_request_receipt_persistence_failed';if(dispatched)result.effect_status='unconfirmed';}
        try{await evidence('failure','attempt_failed',{code:result.code,dispatched});}catch{result.audit_error=result.audit_error || 'browser_evidence_persistence_failed';}
        return result;
      }finally{try{await connection?.release();}finally{if(profileFd!==undefined){fs.closeSync(profileFd);fs.unlinkSync(profileFile);}}}
    };
    // A queued request must not submit later after its caller has timed out.
    let started=false,expired=false,timer;
    const pending=withTargetWriteLock(r.account_id,'boost-scope:'+r.primary_ad_id,()=>withTargetWriteLock('browser-profile',endpoint,()=>{
      if(expired)return null;started=true;clearTimeout(timer);return execute();
    }));
    const queuedDeadline=new Promise(resolve=>{timer=setTimeout(()=>{if(!started){expired=true;resolve({ok:false,code:'browser_queue_timeout',
      execution_channel:'browser',effect_status:'rejected',advertising_writes:0,retry_write:false,timings:clock.result(),evidence_dir:runDir});}},clock.timeout(50000));});
    try{return await Promise.race([pending,queuedDeadline]);}finally{clearTimeout(timer);}
  }
}
module.exports={BrowserBoostService,validateParameters};
