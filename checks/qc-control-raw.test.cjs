'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {createRequire}=require('node:module');
const {chromium}=createRequire(path.resolve(__dirname,'../server-app/package.json'))('playwright-core');
const {readQianchuanControlRaw}=require('../tools/read-qc-control-raw.playwright.cjs');
const spec={advertiser_id:'10001',primary_ad_id:'20001',date:'2026-10-15',pool:'调控中'};
const headers=['','任务名称','素材','调控状态','调控预算(元)','综合营销ROI目标','支付ROI目标','出价','调控时长(小时)','追投方式','创建时间','调控综合成本','调控综合营销ROI','调控成交订单数','调控展示次数','调控点击次数','调控点击率','调控转化率','调控消耗'];
const cells=id=>['','任务'+id+'\nID: '+id,'素材','调控中','100','2.45','-','-','12','控成本追投','2026-10-15 01:00','5','3','1','100','10','10%','10%','5'];
const standardHeaders=['','任务名称','素材','调控状态','调控预算(元)','净成交ROI目标','支付ROI目标','出价','调控时长(小时)','追投方式','创建时间','调控消耗','调控支付ROI','调控成交订单数','调控点击率','调控转化率','调控净成交ROI'];
const standardCells=id=>['','任务'+id+'\nID: '+id,'素材','调控中','100','2.10','2.45','-','12','控成本追投','2026-10-15 01:00','5','3.70','1','10%','10%','2.95'];
const escape=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const row=(id,columns=headers,standard=false)=>'<tr>'+columns.map(h=>'<td>'+escape((standard?standardCells:cells)(id)[(standard?standardHeaders:headers).indexOf(h)]).replaceAll('\n','<br>')+'</td>').join('')+'</tr>';
function html(options={}) {
  const standard=options.standard===true,columns=options.headers || (standard?standardHeaders:headers),ids=options.ids || [],date=options.date || spec.date,total=options.total ?? ids.length;
  const selected=options.selected!==false,datePrefix=standard?'请选择':'';
  const tab=standard?`<div class="row ${selected?'tab--active':''}" data-e2e="oc_emptyKey_uni-prom/detail_uni_task_center"><span>调控</span></div>`:`<button role="tab" aria-selected="${selected}">调控</button>`;
  return `<!doctype html><meta charset="utf-8"><p>计划ID：${spec.primary_ad_id}</p><p>ID：${spec.advertiser_id}</p>
    ${tab}<input placeholder="${datePrefix}开始日期" aria-label="${datePrefix}开始日期" value="${date}"><input placeholder="${datePrefix}结束日期" aria-label="${datePrefix}结束日期" value="${date}">
    <input placeholder="请选择" aria-label="请选择" value="${escape(options.firstFilter||'')}"><input placeholder="请选择" aria-label="请选择"><input placeholder="请选择" aria-label="请选择" value="调控中">
    <input placeholder="输入任务名称或ID搜索" aria-label="输入任务名称或ID搜索" value="${escape(options.search||'')}">
    <div class="${standard?'oc-table-wrapper':'main-vmok-plugin-oc-table-wrapper'}">
    <table id="control"><thead><tr>${columns.map(h=>'<th>'+escape(h)+'</th>').join('')}</tr></thead>${standard?'</table><table id="control-body">':''}<tbody>${ids.map(id=>row(id,columns,standard)).join('')}</tbody></table>
    <div id="total">共 ${total} 条记录</div><div id="empty">${ids.length===0 && options.emptyLabel!==false?'暂无数据':''}</div></div>
    ${options.otherId?'<table id="unrelated"><thead><tr><th>其他对象</th></tr></thead><tbody>'+row(options.otherId)+'</tbody></table>':''}`;
}
let browser;
test.before(async()=>{browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});});
test.after(async()=>{await browser?.close();});
async function withPage(options,fn) {
  const context=await browser.newContext({serviceWorkers:'block'});
  try{
    await context.route('**/*',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:html(options)}));
    const page=await context.newPage();
    await page.goto(options.url || 'https://qianchuan.jinritemai.com/'+(options.standard?'uni-prom/detail?aavid=10001&adId=20001&dr=':'overall-prom/detail?aavid=10001&adId=20001&dateRange=')+encodeURIComponent((options.date||spec.date)+','+(options.date||spec.date)));
    return await fn(page);
  }finally{await context.close();}
}
async function mustNotClaimComplete(page,binding=spec) {
  let result,error;
  try{result=await readQianchuanControlRaw(page,binding);}catch(e){error=e;}
  assert.ok(error || result.complete!==true,'ambiguous or filtered data must not be reported as a complete control pool');
}

test('稳定空池需同时存在0总数、空任务表与空态，正常非空池保留原字段',async()=>{
  await withPage({},async page=>{const result=await readQianchuanControlRaw(page,spec);assert.equal(result.empty_verified,true);assert.equal(result.complete,true);assert.equal(result.advertising_writes,0);});
  await withPage({ids:['30001','30002']},async page=>{const result=await readQianchuanControlRaw(page,spec);assert.equal(result.complete,true);assert.deepEqual(result.tasks.map(t=>t.task_id),['30001','30002']);assert.deepEqual(result.headers,headers);assert.equal(result.tasks[0].raw_cells.length,headers.length);});
});
test('部分分页必须明确不完整，不能将当前页当全部池',async()=>{
  await withPage({ids:['30001','30002'],total:5},async page=>{const result=await readQianchuanControlRaw(page,spec);assert.equal(result.complete,false);assert.equal(result.total,5);assert.equal(result.visible_rows,2);});
});
test('示例甲标准页面空池：新日期名、无role调控页签与分离thead/body容器',async()=>{
  await withPage({standard:true},async page=>{
    const result=await readQianchuanControlRaw(page,spec);
    assert.equal(result.complete,true);assert.equal(result.empty_verified,true);assert.equal(result.advertising_writes,0);
    assert.deepEqual(result.headers,standardHeaders);assert.deepEqual(result.tasks,[]);
  });
});
test('示例甲标准页面非空池保留所有原列，支付ROI与净成交ROI各自保留',async()=>{
  const url='https://qianchuan.jinritemai.com/uni-prom/detail?aavid=10001&adId=20001&dr=2026-10-15%2C2026-10-15#/detail?uniDetailJSON='+encodeURIComponent('{"source":"fixture"}');
  await withPage({standard:true,ids:['30001','30002'],otherId:'39999',url},async page=>{
    const result=await readQianchuanControlRaw(page,spec);
    assert.equal(result.complete,true);assert.equal(result.empty_verified,false);
    assert.deepEqual(result.headers,standardHeaders);
    assert.deepEqual(result.tasks,[{task_id:'30001',raw_cells:standardCells('30001')},{task_id:'30002',raw_cells:standardCells('30002')}]);
  });
});
test('示例甲标准页面部分分页不能报告完整池',async()=>{
  await withPage({standard:true,ids:['30001','30002'],total:33},async page=>{
    const result=await readQianchuanControlRaw(page,spec);
    assert.equal(result.complete,false);assert.equal(result.total,33);assert.equal(result.visible_rows,2);
  });
});
for(const standard of [false,true]){
  test(`${standard?'示例甲标准':'乘方'}页面调控页签未选中时拒绝`,async()=>{
    await withPage({standard,selected:false},page=>assert.rejects(readQianchuanControlRaw(page,spec),{code:'wrong_tab'}));
  });
}
const auxiliaryTab=(label='调控',selected=true,opacity='0')=>`<div role="tab" aria-selected="${selected}" class="aurora-qc-tabs-tab-btn" tabindex="0" id="rc-tabs-0-tab-uni_task_center" aria-controls="rc-tabs-0-panel-uni_task_center"><div aria-live="polite" style="width: 0px; height: 0px; position: absolute; overflow: hidden; opacity: ${opacity};">Tab 3 of 6</div>${escape(label)}</div>`;
test('乘方实际隐藏aria-live辅助文字不污染精确调控标签',async()=>{
  await withPage({ids:['30001']},async page=>{
    await page.getByRole('tab').evaluate((el,html)=>{el.outerHTML=html;},auxiliaryTab());
    assert.equal(await page.getByRole('tab',{name:'调控',exact:true}).count(),0,'fixture reproduces the observed accessible-name pollution');
    const result=await readQianchuanControlRaw(page,spec);
    assert.equal(result.complete,true);assert.deepEqual(result.tasks.map(t=>t.task_id),['30001']);
  });
});
test('隐藏辅助文字清除后仍要求精确标签，包含调控的其他标签均拒绝',async()=>{
  for(const label of ['调控记录','暂停调控','调控设置'])await withPage({},async page=>{
    await page.getByRole('tab').evaluate((el,html)=>{el.outerHTML=html;},auxiliaryTab(label));
    await assert.rejects(readQianchuanControlRaw(page,spec),{code:'wrong_tab'});
  });
});
test('含隐藏辅助文字的调控页签未选中仍拒绝',async()=>{
  await withPage({},async page=>{
    await page.getByRole('tab').evaluate((el,html)=>{el.outerHTML=html;},auxiliaryTab('调控',false));
    await assert.rejects(readQianchuanControlRaw(page,spec),{code:'wrong_tab'});
  });
});
test('普通及含隐藏辅助文字的两个调控页签并存时拒绝歧义',async()=>{
  await withPage({},async page=>{
    await page.getByRole('tab').evaluate((el,html)=>{el.insertAdjacentHTML('afterend',html);},auxiliaryTab());
    await assert.rejects(readQianchuanControlRaw(page,spec),{code:'wrong_tab'});
  });
});
test('不符合实见隐藏辅助节点的额外文字不得被剥除',async()=>{
  await withPage({},async page=>{
    await page.getByRole('tab').evaluate((el,html)=>{el.outerHTML=html;},auxiliaryTab('调控',true,'1'));
    await assert.rejects(readQianchuanControlRaw(page,spec),{code:'wrong_tab'});
  });
});
test('示例甲标准页签必须是已观察的明确对象，不能仅凭active样式接受',async()=>{
  await withPage({standard:true},async page=>{
    await page.locator('.row').evaluate(el=>el.removeAttribute('data-e2e'));
    await assert.rejects(readQianchuanControlRaw(page,spec),{code:'wrong_tab'});
  });
});
test('示例甲标准页面可见日期与URL dr日期分别校验',async()=>{
  const url='https://qianchuan.jinritemai.com/uni-prom/detail?aavid=10001&adId=20001&dr=2026-10-15%2C2026-10-15';
  await withPage({standard:true,date:'2026-10-14',url},page=>assert.rejects(readQianchuanControlRaw(page,spec),{code:'date_mismatch'}));
  await withPage({standard:true,url:url.replaceAll('2026-10-15','2026-10-14')},page=>assert.rejects(readQianchuanControlRaw(page,spec),{code:'date_mismatch'}));
});
test('示例甲标准页面URL额外账户冲突仍拒绝',async()=>{
  await withPage({standard:true,url:'https://qianchuan.jinritemai.com/uni-prom/detail?aavid=10001&adId=20001&advertiser_id=10002'},page=>assert.rejects(readQianchuanControlRaw(page,spec),{code:'identity_mismatch'}));
});
for(const [visible,total,checked] of [[33,33,0],[10,33,0],[33,33,3]]){
  test(`33条池：当前${visible}条、已选${checked}条，按全部数据ID判断覆盖`,async()=>{
    const ids=Array.from({length:visible},(_,i)=>String(40000+i));
    await withPage({ids,total},async page=>{
      if(checked)await page.locator('#control tbody tr').evaluateAll((rows,count)=>rows.slice(0,count).forEach(row=>{row.children[0].innerHTML='<input type="checkbox" checked>'; }),checked);
      const result=await readQianchuanControlRaw(page,spec);
      assert.deepEqual(result.tasks.map(t=>t.task_id),ids);assert.equal(result.total,total);assert.equal(result.visible_rows,visible);
      assert.equal(result.complete,visible===total);
    });
  });
}
test('表头汇总与分页总数冲突时拒绝，不按任务ID数量自行推断总数',async()=>{
  await withPage({ids:Array.from({length:33},(_,i)=>String(40000+i))},async page=>{
    await page.locator('.main-vmok-plugin-oc-table-wrapper').evaluate(el=>{const summary=document.createElement('div');summary.textContent='共 34 条任务';el.prepend(summary);});
    await assert.rejects(readQianchuanControlRaw(page,spec),{code:'coverage_unknown'});
  });
});
for(const marker of ['aria-busy','progressbar']){
  test(`无文字${marker}加载态保留33条旧行时，不报告完整池`,async()=>{
    await withPage({ids:Array.from({length:33},(_,i)=>String(40000+i))},async page=>{
      await page.locator('.main-vmok-plugin-oc-table-wrapper').evaluate((el,type)=>{
        if(type==='aria-busy')el.setAttribute('aria-busy','true');
        else {const spinner=document.createElement('div');spinner.setAttribute('role','progressbar');spinner.style.cssText='width:20px;height:20px';el.append(spinner);}
      },marker);
      await assert.rejects(readQianchuanControlRaw(page,spec),{code:'data_unavailable'});
    });
  });
}
test('隐藏的旧加载指示器不阻止已就绪任务表读取',async()=>{
  await withPage({ids:['30001']},async page=>{
    await page.locator('.main-vmok-plugin-oc-table-wrapper').evaluate(el=>{const spinner=document.createElement('div');spinner.setAttribute('role','progressbar');spinner.style.display='none';el.append(spinner);});
    const result=await readQianchuanControlRaw(page,spec);assert.equal(result.complete,true);
  });
});
test('没有空态的0总数、重复任务ID、URL账户不符均拒绝',async()=>{
  await withPage({emptyLabel:false},page=>assert.rejects(readQianchuanControlRaw(page,spec)));
  await withPage({ids:['30001','30001']},page=>assert.rejects(readQianchuanControlRaw(page,spec)));
  await withPage({url:'https://qianchuan.jinritemai.com/overall-prom/detail?aavid=10002&adId=20001'},page=>assert.rejects(readQianchuanControlRaw(page,spec)));
});
test('只采集已核验任务表，不混入同页其他含ID对象',async()=>{
  await withPage({ids:['30001'],otherId:'39999'},async page=>{
    const result=await readQianchuanControlRaw(page,spec);
    assert.deepEqual(result.tasks.map(t=>t.task_id),['30001']);assert.equal(result.complete,true);
  });
});
test('搜索或额外筛选的子集不报告完整调控池',async()=>{
  await withPage({ids:['30001'],search:'任务30001'},page=>mustNotClaimComplete(page));
  await withPage({ids:['30001'],firstFilter:'控成本追投'},page=>mustNotClaimComplete(page));
});
test('缺少调控消耗时不报告完整可用池',async()=>{
  await withPage({ids:['30001'],headers:headers.filter(h=>h!=='调控消耗')},page=>mustNotClaimComplete(page));
});
test('重复列时不报告完整可用池',async()=>{
  await withPage({ids:['30001'],headers:[...headers,'调控成交订单数']},page=>mustNotClaimComplete(page));
});
test('行状态与选定池不符时不能报告完整池',async()=>{
  await withPage({ids:['30001']},async page=>{
    await page.locator('#control tbody tr td').nth(3).evaluate(el=>{el.textContent='已暂停';});
    await mustNotClaimComplete(page);
  });
});
test('正常数据行缺少ID不能被静默丢弃后报告完整池',async()=>{
  await withPage({ids:['30001'],total:1},async page=>{
    await page.locator('#control tbody').evaluate(el=>{const tr=el.firstElementChild.cloneNode(true);tr.children[1].textContent='尚未拿到ID的任务';el.append(tr);});
    await mustNotClaimComplete(page);
  });
});
test('请求日期必须真实有效',async()=>{
  await withPage({date:'2026-02-30'},page=>assert.rejects(readQianchuanControlRaw(page,{...spec,date:'2026-02-30'})));
});
test('URL日期与可见日期不得冲突',async()=>{
  await withPage({url:'https://qianchuan.jinritemai.com/overall-prom/detail?aavid=10001&adId=20001&dateRange=2026-10-14%2C2026-10-14'},page=>assert.rejects(readQianchuanControlRaw(page,spec)));
});
for(const [name,suffix] of [['别名','&advertiser_id=10002'],['hash','#/detail?aavid=10002']]){
  test('账户URL'+name+'中的冲突不能绕过串户校验',async()=>{
    await withPage({url:'https://qianchuan.jinritemai.com/overall-prom/detail?aavid=10001&adId=20001'+suffix},page=>assert.rejects(readQianchuanControlRaw(page,spec)));
  });
}
test('读取途中换成同数量的新池，不把旧行与新总数拼成complete',async()=>{
  await withPage({ids:['30001'],total:2},async page=>{
    let changed=false;
    const observed=new Proxy(page,{get(target,key){
      if(key==='locator')return (selector,...args)=>{
        const locator=target.locator(selector,...args);
        if(selector!=='body')return locator;
        return new Proxy(locator,{get(raw,name){
          if(name==='innerText')return async(...a)=>{
            if(!changed){changed=true;await page.evaluate(()=>{document.querySelector('#control tbody tr td:nth-child(2)').innerHTML='新任务<br>ID: 30002';document.querySelector('#total').textContent='共 1 条记录';});}
            return raw.innerText(...a);
          };
          const value=raw[name];return typeof value==='function'?value.bind(raw):value;
        }});
      };
      const value=target[key];return typeof value==='function'?value.bind(target):value;
    }});
    let result,error;try{result=await readQianchuanControlRaw(observed,spec);}catch(e){error=e;}
    assert.ok(error || !result.complete || result.tasks[0]?.task_id==='30002','old task 30001 must not be combined with new total=1 as complete');
  });
});
