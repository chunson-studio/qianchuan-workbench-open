'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {launchWorkbench}=require('./workbench-browser.cjs');
test('new-account login guidance neither requests pasted credentials nor submits changes',async t=>{
 const app=await launchWorkbench();t.after(()=>app.close());const p=app.page;
 await p.goto(app.origin+'/v4#/onboarding');await p.locator('[data-new]').click();
 await p.getByRole('heading',{name:'连接千川账户',exact:true}).waitFor();
 assert.equal(await p.locator('input[type=file],#ob-file,#ob-json-paste').count(),0);
 assert.equal(await p.getByRole('link',{name:'打开千川登录',exact:true}).getAttribute('href'),'https://qianchuan.jinritemai.com/');
 assert.equal(app.apiCalls.filter(x=>x.method!=='GET').length,0);assert.deepEqual(app.errors,[]);
 await p.locator('[data-back]').click();await p.locator('[data-new]').waitFor();
 assert.equal(app.apiCalls.filter(x=>x.method!=='GET').length,0);
});
test('existing account keeps its connection and only opens instructions to update login',async t=>{
 const app=await launchWorkbench({firstUse:false});t.after(()=>app.close());const p=app.page;
 await p.goto(app.origin+'/v4#/onboarding');await p.locator('[data-qc]').click();
 await p.getByRole('heading',{name:'接续所选账户',exact:true}).waitFor();
 assert.equal(await p.locator('input[type=file],#ob-json-paste').count(),0);
 assert.equal(app.apiCalls.filter(x=>x.method!=='GET').length,0);assert.deepEqual(app.errors,[]);
 await p.locator('[data-back]').click();await p.locator('.ob-connected-label').waitFor();
 assert.equal(await p.locator('.ob-connected h2').textContent(),'示例品牌账户');
});
