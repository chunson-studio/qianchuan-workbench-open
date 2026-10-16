'use strict';
// 本地隔离页面验证，不连接千川、不复用客户登录态。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('../server-app/node_modules/playwright-core');
const ops = require('./qc-control-pools.playwright.cjs');
const headers=['','任务名称','素材','调控状态','调控预算(元)','净成交ROI目标','支付ROI目标','出价','调控时长(小时)','追投方式','创建时间','调控消耗','调控支付ROI','调控成交订单数','调控点击率','调控转化率','调控净成交ROI'];
const row = status => ['', '测试任务\nID: 60000020','素材',status,'100.00','-','-','-','12.0\n预计结束','放量追投','2026-10-04\n13:54:33','33.82','18.30','7','13.64%','4.76%','15.97'];
async function main() {
 const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 try {
  const context=await browser.newContext();
  const page=await context.newPage();
  await page.route('**/*',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:`
   <div>计划ID：60000010</div><div>ID：60000009</div>
   <input aria-label="请选择开始日期" value="2026-10-04"><input aria-label="请选择结束日期" value="2026-10-04">
   <input aria-label="请选择"><input aria-label="请选择"><input id="state" aria-label="请选择" readonly onclick="menu.hidden=false">
   <div id="menu" hidden><div>全部（包括已删除）</div><div onclick="sub.hidden=false">已暂停</div><div id="sub" hidden onclick="choose('手动暂停')">手动暂停</div><div onclick="choose('调控中')">调控中</div></div>
   <table><thead><tr>${headers.map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody id="rows"></tbody></table><div>共 1 条记录</div>
   <script>const values=${JSON.stringify(row('调控中'))};function choose(s){state.value=s;menu.hidden=true;sub.hidden=true;values[3]=s==='调控中'?s:'已暂停\\n手动暂停';rows.innerHTML='<tr>'+values.map((v,i)=>'<td>'+(i===0?'<input type="checkbox">':v.replaceAll('\\n','<br>'))+'</td>').join('')+'</tr>'}choose('调控中')</script>`}));
  await page.goto('https://qianchuan.jinritemai.com/uni-prom/detail?aavid=60000009&adId=60000010');
  const live=await context.newPage();
  const small=(label,value)=>`<div><div><span>${label}</span></div><div>${value}</div></div>`;
  await live.route('**/*',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:`<style>span{display:block}</style><div>开播时间2026/10/04 12:59开播</div>
   <div><div><div><div><span>直播间成交金额</span></div></div></div><div class="odometer-inside">${'2000'.split('').map(d=>`<span class="odometer-digit"><span class="odometer-value">${d}</span></span>`).join('')}</div></div>
   ${small('投放消耗(店铺绑定)','¥100')}${small('退款金额','¥200')}${small('实时在线人数','34')}
   <div>近5分钟数据</div><div>15:56更新</div><div>用户支付金额</div><div>¥292</div><div>在线人数</div><div>38</div><div>进入人数</div><div>224</div><div>离开人数</div><div>223</div><div>实时评论</div>`}));
  await live.goto('https://compass.jinritemai.com/screen/live/shop?live_room_id=60000032');
  const events=[];
  const cfg={account_id:'test-account',advertiser_id:'60000009',primary_ad_id:'60000010',room_id:'60000032',live_start_time:'2026-10-04T12:59:46+08:00',date:'2026-10-04',execute:false,min_net_roi:10,online_cap:40,response_wait_ms:300000,on_checkpoint:async e=>events.push(e)};
  const result=await ops.runQianchuanBrowserRound({control_tab:page,live_tab:live},cfg);
  assert.equal(result.ok,true,JSON.stringify(result.issues));
  assert.deepEqual(events.filter(e=>e.id==='control.pool.table').map(e=>e.pool),['手动暂停','调控中']);
  assert.equal(result.tasks[0].displayed_net_roi,15.97);
  assert.equal(result.tasks[0].payment_orders,7);
  assert.equal(result.live.net_roi,18);
  assert.equal(result.live.five_minutes.enters,224);
  assert.deepEqual(result.actions,[]);
  const bad=await ops.readQianchuanControlPool(page,{...cfg,advertiser_id:'wrong',pool:'调控中'});
  assert.equal(bad.ok,false);
  await page.getByRole('checkbox').check();
  const selected=await ops.readQianchuanControlPool(page,{...cfg,pool:'手动暂停'});
  assert.equal(selected.ok,false);assert.match(selected.error,/选中任务/);
  const evidence={channel:'playwright-cdp',evidence_origin:'isolated_local_fixture',real_qianchuan_verified:false,passed:true,checks:['同页暂停优先','17列表格','实时ROI及流量解析','账户不匹配拒绝','人工选择保护','只读无广告提交'],captured_at:new Date().toISOString()};
  const file=path.join(require('../checks/test-output.cjs').testOutputRoot(),'result.json');
  fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
 } finally {await browser.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
