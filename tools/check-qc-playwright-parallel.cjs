'use strict';

// Real isolated browsers; page requests are intercepted before navigation.
// Never uses a customer profile or submits an advertising request.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { createQianchuanPlaywrightSessions } = require('./connect-qc-playwright.cjs');

const quantile = (values, q) => [...values].sort((a,b)=>a-b)[Math.min(values.length-1, Math.ceil(values.length*q)-1)];
const duration = async fn => { const start=performance.now(); const value=await fn(); return {ms:performance.now()-start,value}; };
function fixture(spec) {
  return `<!doctype html><meta charset="utf-8"><title>Isolated parallel test</title>
  <p id="account">${spec.advertiser_id}</p><p id="plan">${spec.primary_ad_id}</p>
  <input aria-label="budget" value="100"><button id="submit">Save fixture</button>
  <output id="confirmed"></output><script>
  window.submissions=0; document.cookie='fixture_account=${spec.advertiser_id}; SameSite=Strict';
  localStorage.setItem('fixture_account','${spec.advertiser_id}');
  document.querySelector('#submit').onclick=()=>{ window.submissions++;
    const value=document.querySelector('input').value;
    setTimeout(()=>{document.querySelector('#confirmed').textContent='${spec.primary_ad_id}:'+value},500);
  };
  </script>`;
}
async function run(options={}) {
  const count=options.accounts ?? 5, rounds=options.rounds ?? 20;
  assert.ok(Number.isSafeInteger(count) && count>=2 && count<=10);
  assert.ok(Number.isSafeInteger(rounds) && rounds>=2 && rounds<=100);
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qc-playwright-parallel-'));
  const profileRoot=path.join(root,'profiles');
  const executablePath=options.executablePath || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  let intercepted=0, contexts=0;
  const sessions=createQianchuanPlaywrightSessions({executablePath,headless:true,timeoutMs:5000,
    onContextCreated:async(context,spec)=>{
      contexts++;
      await context.route('**/*', async route=>{
        intercepted++;
        if(route.request().resourceType()==='document') await route.fulfill({contentType:'text/html; charset=utf-8',body:fixture(spec)});
        else await route.abort();
      });
    }});
  const specs=Array.from({length:count},(_,i)=>({
    profile_dir:path.join(profileRoot,'account-'+i), account_id:'fixture-'+i,
    advertiser_id:String(60000036+i), primary_ad_id:String(60000035+i),
    url:`https://qianchuan.jinritemai.com/uni-prom/detail?aavid=${60000036+i}&adId=${60000035+i}`
  }));
  const checks=[], samples=[], perAccount=specs.map(()=>[]);
  const verifyRaw=async({page},spec,delay=0)=>{
    const raw=await page.evaluate(async delayMs=>{
      if(delayMs) await new Promise(resolve=>setTimeout(resolve,delayMs));
      return {advertiser_id:document.querySelector('#account').textContent,
        primary_ad_id:document.querySelector('#plan').textContent,
        cookie:document.cookie, storage:localStorage.getItem('fixture_account'),
        captured_at:new Date().toISOString()};
    },delay);
    assert.equal(raw.advertiser_id,spec.advertiser_id); assert.equal(raw.primary_ad_id,spec.primary_ad_id);
    assert.deepEqual(raw.cookie.split('; ').filter(v=>v.startsWith('fixture_account=')),['fixture_account='+spec.advertiser_id]); assert.equal(raw.storage,spec.advertiser_id);
    return raw;
  };
  let result;
  try {
    const cold=await duration(()=>Promise.all(specs.map(spec=>sessions.open(spec))));
    const browserVersion=cold.value[0].context.browser()?.version() || null;
    assert.equal(contexts,count);
    for(let round=0;round<rounds;round++) {
      const batch=await duration(()=>Promise.all(specs.map(async(spec,i)=>{
        const sample=await duration(()=>sessions.run(spec,handles=>verifyRaw(handles,spec)));
        perAccount[i].push(sample.ms); return sample.value;
      })));
      samples.push(batch.ms);
    }
    assert.equal(contexts,count,'warm rounds must reuse contexts');
    checks.push({name:'five_way_identity_and_storage_isolation',passed:true,accounts:count,rounds,observations:count*rounds});
    const serial=await duration(async()=>{for(const spec of specs)await sessions.run(spec,h=>verifyRaw(h,spec,150));});
    const parallel=await duration(()=>Promise.all(specs.map(spec=>sessions.run(spec,h=>verifyRaw(h,spec,150)))));
    const ratio=parallel.ms/serial.ms;
    assert.ok(ratio<0.65,`parallel/serial ratio ${ratio.toFixed(3)} must be below 0.65 for controlled 150ms browser work`);
    checks.push({name:'no_global_serial_queue',passed:true,serial_ms:serial.ms,parallel_ms:parallel.ms,ratio,work_delay_ms:150});

    let inFlight=0,maxInFlight=0;
    await Promise.all([1,2,3].map(()=>sessions.run(specs[0],async h=>{
      inFlight++;maxInFlight=Math.max(maxInFlight,inFlight);
      try{return await verifyRaw(h,specs[0],30);}finally{inFlight--;}
    })));
    assert.equal(maxInFlight,1);checks.push({name:'same_profile_actions_do_not_overlap',passed:true});

    let failedRouteSettled=false;
    const broken=sessions.run(specs[0],async({page})=>page.locator('#does-not-exist').click({timeout:1800}))
      .then(()=>{throw new Error('missing control unexpectedly succeeded');},()=>{failedRouteSettled=true;});
    const healthy=await duration(async()=>{for(let i=0;i<10;i++)await Promise.all(specs.slice(1).map(spec=>sessions.run(spec,h=>verifyRaw(h,spec))));});
    const healthyFinishedBeforeFault= !failedRouteSettled;
    await broken;
    assert.ok(healthyFinishedBeforeFault,'healthy profiles waited for unrelated timeout');
    await sessions.run(specs[0],h=>verifyRaw(h,specs[0]));
    checks.push({name:'one_profile_timeout_does_not_block_other_profiles',passed:true,healthy_observations:(count-1)*10,healthy_ms:healthy.ms});

    await assert.rejects(sessions.run({...specs[0],account_id:'wrong-account'},()=>{}));
    await assert.rejects(sessions.open({...specs[0],url:specs[1].url}));
    checks.push({name:'binding_conflicts_rejected',passed:true});
    await assert.rejects(sessions.run(specs[0],async({page})=>page.close()));
    await sessions.run(specs[0],h=>verifyRaw(h,specs[0]));
    checks.push({name:'closed_page_recovered_by_explicit_binding',passed:true});

    let pending={task_id:specs[0].primary_ad_id,value:'150',status:'pending'};
    await assert.rejects(sessions.run(specs[0],async({page})=>{
      await page.getByRole('textbox',{name:'budget',exact:true}).fill(pending.value);
      await page.getByRole('button',{name:'Save fixture',exact:true}).click();
      await page.locator('#confirmed').filter({hasText:pending.task_id+':'+pending.value}).waitFor({timeout:50});
    }));
    const reconciled=await sessions.run(specs[0],async({page})=>{
      await page.locator('#confirmed').filter({hasText:pending.task_id+':'+pending.value}).waitFor({timeout:2000});
      return {actual:await page.locator('#confirmed').innerText(),submissions:await page.evaluate(()=>window.submissions)};
    });
    assert.equal(reconciled.submissions,1);assert.equal(reconciled.actual,pending.task_id+':150');
    pending.status='confirmed';
    checks.push({name:'accepted_but_delayed_submission_reconciled_without_resubmit',passed:true,submissions:reconciled.submissions});
    const witness=require('node:crypto').randomUUID();
    await sessions.run(specs[0],async({page})=>page.evaluate(value=>{
      localStorage.setItem('persistent_witness',value);
      document.cookie='persistent_witness='+value+'; Max-Age=3600; SameSite=Strict';
    },witness));
    await sessions.close(specs[0].profile_dir);
    await sessions.run(specs[0],async h=>{
      await verifyRaw(h,specs[0]);
      const restored=await h.page.evaluate(()=>({storage:localStorage.getItem('persistent_witness'),cookie:document.cookie}));
      assert.equal(restored.storage,witness);assert.ok(restored.cookie.split('; ').includes('persistent_witness='+witness));
    });
    checks.push({name:'profile_reopen_preserves_persistent_storage_and_cookie',passed:true});
    result={passed:true,evidence_origin:'isolated_real_browser_fixture',real_qianchuan_verified:false,
      advertising_writes:0,page_requests_intercepted:true,intercepted_requests:intercepted,
      browser_version:browserVersion,accounts:count,rounds,checks,
      timings:{cold_open_all_ms:cold.ms,warm_batch_median_ms:quantile(samples,.5),warm_batch_p95_ms:quantile(samples,.95),
        per_account:perAccount.map((v,i)=>({account:i,median_ms:quantile(v,.5),p95_ms:quantile(v,.95)}))},
      captured_at:new Date().toISOString(),test_root:root,
      limits:['Synthetic page timings exclude platform and model latency.','No production account or ad request used.','Context routing intercepts page requests; it does not prove Chrome background traffic is blocked.','Next stage: logged-in multi-room reads and business action coverage.']};
  } catch(error) {
    result={passed:false,evidence_origin:'isolated_real_browser_fixture',real_qianchuan_verified:false,
      advertising_writes:0,accounts:count,rounds,checks,error:{name:error.name,message:error.message},
      captured_at:new Date().toISOString(),test_root:root};
  } finally {
    try {await sessions.close();} catch(error) {result={...(result||{}),passed:false,close_error:error.message};}
  }
  fs.writeFileSync(path.join(root,'result.json'),JSON.stringify(result,null,2)+'\n');
  if(options.output){const file=path.resolve(options.output);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(result,null,2)+'\n');}
  return result;
}
if(require.main===module){
  const args=process.argv.slice(2),get=k=>{const i=args.indexOf(k);return i<0?undefined:args[i+1];};
  if(args.includes('--help'))console.log('node tools/check-qc-playwright-parallel.cjs [--accounts 5] [--rounds 20] [--browser absolute-path] [--output result.json]\nUses temporary isolated profiles and intercepted pages only.');
  else run({accounts:get('--accounts')===undefined?undefined:Number(get('--accounts')),rounds:get('--rounds')===undefined?undefined:Number(get('--rounds')),executablePath:get('--browser'),output:get('--output')})
    .then(r=>{console.log(JSON.stringify(r));if(!r.passed)process.exitCode=1;}).catch(e=>{console.error(e.stack||e);process.exitCode=1;});
}
module.exports={run};
