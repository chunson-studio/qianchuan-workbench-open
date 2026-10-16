

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createExplorer, explorerSource } from './qianchuan-explorer.mjs';
import { accountBinding, immutable, captureSource, guardRunner, ensureNoOpenForm, formFingerprint, unchangedForm, observedUrl } from './browser-runtime.mjs';

const sourceProof = await captureSource(import.meta.url, [explorerSource]);

import { readWithRecovery, assertAccountUrl } from './browser-readiness.mjs';

const source = fileURLToPath(import.meta.url);
const active = new Set();
export const filters = Object.freeze({
  source: { prefix: '来源：', options: ['本地上传','巨量方舟共享素材','巨量引擎工作台共享素材','巨量创意PC共享素材','星图共享素材','亚瑟共享素材','即创共享素材','直播剪辑素材','剪映共享素材','群峰市场共享素材','AI 修复素材','根据商品生产视频','其他共享素材','AI成片（店铺发布）'] },
  type: { prefix: '类型：', options: ['横版视频','竖版视频'] },
  evaluation: { prefix: '素材评估：', options: ['优质素材','低质素材','首发素材','搬运素材'] },
  review: { prefix: '审核状态：', options: ['审核通过','审核通过-可优化','审核不通过'] },
  delivery: { prefix: '投放情况：', options: ['未投放','已投放'] },
});

export async function createMaterialRunner(tab, binding, options = {}) {
  binding = accountBinding(binding);
  options = immutable(options);
  if (!tab?.playwright || typeof binding?.video_entry_url !== 'string') throw Error('Explicit CUA tab and observed video_entry_url required');
  const entry = assertAccountUrl(binding.video_entry_url, binding, '/tools/creative-management/video-library');
  const evidence = await createExplorer(tab, binding);
  const sha = sourceProof.sha256;
  const timeoutMs = Math.min(20000, Math.max(1000, options.timeout_ms || 12000));
  const key = binding.extension_instance_id + ':' + tab.id;
  const control = spec => tab.playwright.locator('.ovui-select__input').filter({ hasText: spec.prefix });
  const search = () => tab.playwright.getByRole('textbox', { name: '请输入视频名称/ID搜索', exact: true });
  const dates = () => readWithRecovery(() => tab.playwright.getByRole('textbox', { name: /^(开始日期|结束日期)$/ }).evaluateAll(es => es.map(e => e.value)));
  const values = () => readWithRecovery(() => tab.playwright.locator('.ovui-select__input').getByRole('textbox').evaluateAll(es => es.map(e => e.value)));
  const isOpen = spec => readWithRecovery(() => control(spec).evaluate(el => !!el.querySelector('.ovui-select__arrow--open')));
  const detail = extra => ({ flow_script: 'work/browser-actions/scripts/material-library.mjs', flow_script_sha256: sha, source_manifest: sourceProof.sources, expected_path: entry.pathname, ...extra });
  let resultSequence = 0;

  async function open() {
    await evidence.identity();
    await ensureNoOpenForm(tab);
    const current = new URL(await readWithRecovery(() => tab.url()));
    const same = current.origin === entry.origin && current.pathname === entry.pathname
      && current.searchParams.getAll('aavid').length === 1 && current.searchParams.get('aavid') === binding.advertiser_id;
    if (!same) {
      let failure = null;
      try { await tab.goto(entry.href); } catch (e) { failure = String(e); }
      await evidence.save('tools.video_library.direct','视频库直达','opened',detail({ locator:'tab.goto(observed video_entry_url)', navigation_error:failure, ui_clicks:0 }), 'materials');
    }
    try {
      await evidence.identity();
      const destination = new URL(await readWithRecovery(() => tab.url()));
      if (destination.pathname !== entry.pathname) throw Error('Video destination route mismatch');
      await readWithRecovery(() => tab.playwright.getByRole('columnheader', { name:'视频', exact:true }).waitFor({state:'visible',timeoutMs}));
      await readWithRecovery(() => tab.playwright.getByRole('columnheader', { name:'整体支付ROI', exact:true }).waitFor({state:'visible',timeoutMs}));
      const dom = await readWithRecovery(() => tab.playwright.domSnapshot());
      const loading = /generic: (?:数据)?加载中/.test(dom);
      return await evidence.save('tools.video_library.controls','核验视频库控件与表头','read_verified',detail({
        locator:'visible video headers + explicit advertiser identity', dates:await dates(), headers:await readWithRecovery(() => tab.playwright.getByRole('columnheader').allTextContents({timeoutMs})),
        verified_scope:'controls_and_headers_only', table_state:loading?'loading':dom.includes('generic: 暂无数据')?'current_window_empty':'content_not_sampled',
        business_data_valid:false, source_at:null, formal_fresh_sample:false,
      }), 'materials', tab, dom);
    } catch(e) {
      await evidence.save('tools.video_library.controls','核验视频库控件与表头','attempt_failed',detail({error:String(e)}),'materials');
      throw e;
    }
  }

  async function preview(name) {
    const spec = filters[name];
    if (!spec) throw Error('Unsupported or unverified video filter: ' + name);
    const beforeDates = await dates(), beforeValues = await values();
    const locator = '.ovui-select__input with ' + spec.prefix + ' → textbox';
    await evidence.action('tools.video_library.'+name+'.open', '预览视频库'+spec.prefix+'筛选', async()=>{
      if (!await isOpen(spec)) await control(spec).getByRole('textbox').click({timeoutMs});
      await readWithRecovery(() => tab.playwright.getByText(spec.options[0], {exact:true}).filter({visible:true}).waitFor({state:'visible',timeoutMs}));
    }, async dom=>await isOpen(spec) && spec.options.every(value=>dom.includes(value)), detail({locator,options:spec.options,selected_option_changed:false}), 'materials');
    await evidence.action('tools.video_library.'+name+'.close', '收起视频库'+spec.prefix+'筛选', ()=>search().click({timeoutMs}), async dom=>
      !await isOpen(spec) && !dom.includes('generic: 最近15天') && JSON.stringify(await dates())===JSON.stringify(beforeDates)
      && JSON.stringify(await values())===JSON.stringify(beforeValues), detail({locator:'textbox 请输入视频名称/ID搜索',date_changed:false,selected_option_changed:false}), 'materials');
  }

  async function run(action='preview_filters', args={}) {
    if (active.has(key)) throw Error('Tab already running material script');
    if (!['open','preview_filters'].includes(action)) throw Error('Unsupported material action');
    const names = action==='preview_filters' ? (args.filters || Object.keys(filters)) : [];
    if (!Array.isArray(names) || names.some(name=>!Object.hasOwn(filters,name)) || new Set(names).size!==names.length) throw Error('Unverified or duplicate filter');
    active.add(key);
    const start=Date.now(), first=evidence.records.length;
    let result;
    try {
      await open();
      for(const name of names) await preview(name);
      const screenshot=await evidence.snapshot('material-'+(++resultSequence)+'.png');
      result={ok:true,action,filters:names,screenshot,ui_clicks_note:'direct navigation and filter preview only'};
    } catch(e) { result={ok:false,action,error:String(e)}; ++resultSequence; }
    finally { active.delete(key); }
    result={...result,binding,run_dir:evidence.run_dir,elapsed_ms:Date.now()-start,script_sha256:sha,evidence:evidence.records.slice(first),page:await observedUrl(tab),advertising_writes:0,formal_fresh_sample:false,source_at:null};
    const file=path.join(evidence.run_dir,'material-result-'+resultSequence+'.json');
    await fs.writeFile(file,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
    return {...JSON.parse(await fs.readFile(file,'utf8')),result_file:file};
  }
  return guardRunner([tab], {run,run_dir:evidence.run_dir,script_sha256:sha}, sourceProof);
}
