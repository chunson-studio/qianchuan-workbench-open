'use strict';
// Isolated UI verification: a static loopback server and synthetic API responses only.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('../server-app/node_modules/playwright-core');
const publicRoot = path.resolve(__dirname, '../server-app/server/public');
async function launchWorkbench({ firstUse = true } = {}) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://local');
    if (url.pathname.startsWith('/api/')) { res.writeHead(500); res.end('Unexpected API network request'); return; }
    const name = decodeURIComponent(url.pathname === '/v4' || url.pathname === '/v4/' ? '/v4/index.html' : url.pathname);
    const file = path.resolve(publicRoot, '.' + name);
    if (!file.startsWith(publicRoot + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', ({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.json':'application/json'})[path.extname(file)] || 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block', locale: 'zh-CN' });
  const page = await context.newPage(), apiCalls = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && /ReferenceError|TypeError/.test(message.text())) errors.push(message.text()); });
  await page.route('**/api/**', async route => {
    const request = route.request(), u = new URL(request.url());
    apiCalls.push({ path: u.pathname, method: request.method() });
    let data;
    if (u.pathname === '/api/accounts') data = { ok:true, accounts:firstUse ? [] : [{ id:'ui-test',name:'示例品牌账户' }],archived_accounts:[] };
    else if (u.pathname === '/api/workbench-snapshot') {
      const at = new Date(Date.now()-600000).toISOString();
      data = { ok:true,schema_version:1,generated_at:new Date().toISOString(),source:'local_only',max_age_seconds:300,
        accounts:[{id:'ui-test',name:'示例品牌账户'}],issues:[],upstream_requests:0,
        sessions:[{id:'test-scene',account_id:'ui-test',name:'测试直播间',binding:{advertiser_id:'12345',primary_ad_id:'23456',room_id:'34567',session_started_at:at},
          captured_at:at,financial_at:at,online_at:at,freshness:'stale',live_state:'live',execution:{owner:'test-owner',status:'active'},
          metrics:{cost:25,gmv:300,roi:8,cost_label:'整体消耗',roi_label:'净成交ROI',online:0,active_tasks:null},pending_count:1,
          operations:[{task_id:'45678',action:'create',status:'unconfirmed',at}],rounds:[{round_id:'r1',captured_at:at,display:'本轮汇报'}],issues:[]}]
      };
    }
    else if (u.pathname === '/api/onboarding') data = { ok:true,first_use:firstUse,accounts:firstUse?[]:[{id:'ui-test',name:'示例品牌账户'}],
      account:{id:'ui-test',name:'示例品牌账户'},answers:{},questions:[],next_questions:[],answered:[],authorization:{explanation:'测试'},
      login_url:'https://qianchuan.jinritemai.com/',cookie_editor_url:'https://cookie-editor.com/' };
    else if (u.pathname === '/api/live-watch') data = {ok:true,accounts:firstUse?[]:[{accountId:'ui-test',isLive:false,available_rooms:[],status_stale:false}]};
    else if (u.pathname === '/api/status') data = {ok:true,queue:{running:0,pending:0}};
    else if (u.pathname === '/api/version') data = {ok:true,v:'ui-test'};
    else data = {ok:false,code:'fixture_not_defined',error:'未提供本页面测试数据'};
    await route.fulfill({ status:200,contentType:'application/json',body:JSON.stringify(data) });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { page, browser, context, origin, apiCalls, errors, close:async()=>{await browser.close(); await new Promise(resolve=>server.close(resolve));} };
}
module.exports = { launchWorkbench };
if (require.main === module) (async()=>{
  const run = await launchWorkbench(), output = require('./test-output.cjs').testOutputRoot();
  try {
    await run.page.goto(run.origin + '/v4#/onboarding');
    await run.page.getByRole('button',{name:'连接我的千川账户 →',exact:true}).waitFor();
    await run.page.screenshot({path:path.join(output,'onboarding-after-desktop.png'),fullPage:true});
    await run.page.setViewportSize({width:390,height:844});
    await run.page.screenshot({path:path.join(output,'onboarding-after-mobile.png'),fullPage:true});
    console.log(JSON.stringify({errors:run.errors,apiCalls:run.apiCalls,overflow:await run.page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)}));
  } finally {await run.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
