
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createExplorer, explorerSource } from './qianchuan-explorer.mjs';
import { assertAccountUrl, readWithRecovery } from './browser-readiness.mjs';
import { accountBinding, immutable, captureSource, guardRunner, ensureNoOpenForm, formFingerprint, unchangedForm } from './browser-runtime.mjs';

const sourceProof = await captureSource(import.meta.url, [explorerSource]);


const source = fileURLToPath(import.meta.url);
const pages = {
  pre_audit: { host: 'qianchuan.jinritemai.com', path: '/brand_pre_review/list', markers: ['什么是创意素材预审工具', '品牌投放素材预审工具', '预审素材名称及ID'] },
  inquiry: { host: 'qianchuan.jinritemai.com', path: '/brand_inquiry_tool/list', markers: ['什么是品牌询量？', '查询模版', '新建查询模板'] },
  inquiry_form: { host: 'qianchuan.jinritemai.com', path: '/brand_inquiry_tool/form', markers: ['产品类型与目标', '保存为新模板', '已选 0 天', '询量结果'] },
  showcase: { host: 'brand.oceanengine.com', path: '/brand_pre_sales/index', markers: ['品牌营销', '品牌招商', '品牌案例', '库存查询'] },
  agency: { host: 'fuwu.oceanengine.com', path: '/agent', markers: ['服务伙伴', '我的代理服务需求', '发布代理需求'], frame: 'agentContent' },
  marketing_tools: { host: 'fuwu.oceanengine.com', path: '/tool/category/100310040055/1', markers: ['一级类型：', '巨量千川工具', '排序：'] }
};
export const extendedToolKinds = Object.keys(pages);
const normalizedPath = u => u.pathname.replace(/\/$/, '');

function scrubDom(dom, external, form) {
  let clean = dom;
  if (external) clean = clean.replace(/用户\d{5,}/g, '[外部平台用户已省略]').replace(/ID：\d+/g, 'ID：[外部平台用户ID已省略]');
  if (!form) {
    
    const lines = clean.split('\n'), out = [];
    for (let i = 0; i < lines.length;) {
      if (/^\s*- row(?: |:)/.test(lines[i])) {
        const indent = lines[i].search(/\S/), block = [lines[i++]];
        while (i < lines.length && (lines[i].trim() === '' || lines[i].search(/\S/) > indent)) block.push(lines[i++]);
        if (block.some(x => x.includes('- columnheader'))) out.push(...block);
        else out.push(' '.repeat(indent) + '- row: [业务行未采集]');
      } else out.push(lines[i++]);
    }
    clean = out.join('\n');
  }
  return clean;
}

export async function createExtendedToolRunner(tab, binding, { accountTab, entry_urls } = {}) {
  binding = accountBinding(binding);
  entry_urls = immutable(entry_urls);
  if (!accountTab || !entry_urls) throw Error('Explicit advertiser source tab and observed entries required');
  const explorer = await createExplorer(accountTab, binding);
  const sha = sourceProof.sha256;
  const id = binding.advertiser_id;
  let serial = 0;
  function checkUrl(raw, kind) {
    const u = new URL(raw), p = pages[kind];
    if (u.origin !== 'https://' + p.host || u.username || u.password || normalizedPath(u) !== p.path) throw Error('Observed entry path mismatch');
    if (p.host === 'qianchuan.jinritemai.com') assertAccountUrl(raw, binding);
    if ((p.host === 'qianchuan.jinritemai.com' || kind === 'marketing_tools') && (u.searchParams.getAll('aavid').length !== 1 || u.searchParams.get('aavid') !== id)) throw Error('Advertiser URL mismatch');
    if (kind === 'inquiry_form' && (u.searchParams.getAll('aadvid').length !== 1 || u.searchParams.get('aadvid') !== id)) throw Error('Inquiry form account mismatch');
    return u.href;
  }
  for (const kind of extendedToolKinds) checkUrl(entry_urls[kind], kind);

  async function checkAccount(target) {
    const u = assertAccountUrl(await readWithRecovery(() => target.url()), binding);
    const bannerCount = await readWithRecovery(() => target.playwright.getByRole('banner').count());
    if (bannerCount === 1) { await explorer.identity(target); return 'standard_banner'; }
    const legacy = Object.entries(pages).find(([k, p]) => ['pre_audit', 'inquiry', 'inquiry_form'].includes(k) && p.path === normalizedPath(u));
    if (bannerCount !== 0 || !legacy) throw Error('Unrecognized account layout');
    
    const nameControl = target.playwright.getByText(binding.advertiser_name, { exact: true }).filter({ visible: true });
    const idControl = target.playwright.getByText('ID：' + id, { exact: true }).filter({ visible: true });
    
    
    for (const control of [nameControl, idControl]) {
      if (await readWithRecovery(() => control.count()) === 0)
        await readWithRecovery(() => control.waitFor({ state: 'visible', timeoutMs: 12000 }));
      if (await readWithRecovery(() => control.count()) !== 1) throw Error('Legacy visible identity mismatch');
    }
    const dom = await readWithRecovery(() => target.playwright.domSnapshot());
    if (!dom.includes(legacy[1].markers[0])) throw Error('Legacy visible identity mismatch');
    return 'legacy_root_unique_name_and_ID';
  }
  await checkAccount(accountTab);

  async function readState(kind) {
    const rawUrl = await readWithRecovery(() => tab.url()), dom = await readWithRecovery(() => tab.playwright.domSnapshot());
    checkUrl(rawUrl, kind);
    return { url: rawUrl, dom };
  }
  async function save(kind, suffix, label, status, state, details = {}) {
    const external = pages[kind].host !== 'qianchuan.jinritemai.com';
    const clean = scrubDom(state?.dom ?? '', external, kind === 'inquiry_form');
    const metadataTarget = { id: tab.id, url: async () => {
      const u = new URL(await tab.url()); u.searchParams.delete('uid'); return u.href;
    }};
    return explorer.save('extended.script.' + kind + '.' + suffix, label, status, {
      ...details, workflow_script: 'work/browser-actions/scripts/extended-tools.mjs', workflow_script_sha256: sha,
      verified_scope: details.verified_scope ?? null, destination_advertiser_identity_verified: status === 'read_verified' && !external,
      operator_identity_omitted: true, business_rows_read: false, formal_fresh_sample: false,
      form_submitted: false, service_request_submitted: false
    }, 'controls-and-audit', metadataTarget, clean);
  }
  async function waitBody(kind) {
    let state;
    for (let attempt = 1; attempt <= 3; attempt++) {
      state = await readState(kind);
      if (/检测到当前账号登录失效|安全验证/.test(state.dom)) throw Error('authentication_required');
      if (state.dom.includes('加载失败')) throw Error('platform_load_failed');
      if (pages[kind].markers.every(x => state.dom.includes(x))) return state;
      if (attempt < 3) {
        try { await tab.playwright.getByText(pages[kind].markers[0], { exact: true }).filter({ visible: true }).first().waitFor({ state: 'visible', timeoutMs: 15000 }); } catch {}
      }
    }
    throw Error('Expected page body not ready');
  }

  async function run(kind) {
    if (!Object.hasOwn(pages, kind)) throw Error('Unknown observed page');
    if (pages[kind].host !== 'qianchuan.jinritemai.com' && tab.id === accountTab.id) throw Error('External destination requires a separate advertiser source tab');
    const start = Date.now(), result = { ok: false, flow: kind, script: 'scripts/extended-tools.mjs', script_sha256: sha,
      binding: { ...binding }, navigation_attempts: 0, click_count: 0, evidence: [], run_dir: explorer.run_dir,
      advertising_writes: 0, external_writes: 0, formal_fresh_sample: false, source_at: null, business_rows_read: false };
    try {
      result.source_identity_method = await checkAccount(accountTab);
      let currentIsTarget = false;
      try { checkUrl(await tab.url(), kind); currentIsTarget = true; } catch {}
      if (currentIsTarget && kind === 'inquiry_form') throw Error('Existing query form is not owned by this replay; preserve page');
      if (!currentIsTarget) {
        await ensureNoOpenForm(tab);
        
        if (normalizedPath(new URL(await tab.url())) === '/brand_inquiry_tool/form') throw Error('Existing query form requires explicit review');
        result.navigation_attempts++;
        let navigationError = null;
        try { await tab.goto(entry_urls[kind]); } catch (e) { navigationError = String(e); }
        const state = { url: await readWithRecovery(() => tab.url()), dom: await readWithRecovery(() => tab.playwright.domSnapshot()) };
        checkUrl(state.url, kind);
        result.evidence.push(await save(kind, 'open', '已直达观察过的工具页', 'opened', state, { navigation_error: navigationError, content_verified: false }));
      }
      let state = await waitBody(kind);
      if (pages[kind].host === 'qianchuan.jinritemai.com') result.destination_identity_method = await checkAccount(tab);
      else result.destination_identity_method = 'external_layout_only_not_advertiser_identity';
      if (kind === 'agency' && await tab.playwright.getByRole('button', { name: '跳过', exact: true }).count() === 1) {
        result.click_count++;
        await tab.playwright.getByRole('button', { name: '跳过', exact: true }).click();
        state = await readState(kind);
        const dismissed = !state.dom.includes('- generic: 升级提示');
        result.evidence.push(await save(kind, 'tour', '新功能引导退出回读', dismissed ? 'read_verified' : 'opened', state, { tour_dismissed: dismissed }));
      }
      result.verified_scope = kind === 'inquiry_form' ? 'initial_form_preview_and_exit' : (pages[kind].host === 'qianchuan.jinritemai.com' ? 'layout_only' : 'external_service_layout_only');
      const initial = kind === 'inquiry_form' ? await formFingerprint(tab) : null;
      result.evidence.push(await save(kind, 'read', '工具页面布局与范围已核对', 'read_verified', state, { verified_scope: result.verified_scope,
        source_identity_method: result.source_identity_method, destination_identity_method: result.destination_identity_method,
        body_markers: pages[kind].markers, content_verified: true, selected_days: kind === 'inquiry_form' ? 0 : null }));
      if (kind === 'inquiry_form') {
        const beforeExit = await readState(kind);
        if (!beforeExit.dom.includes('已选 0 天')) throw Error('Query form changed; preserve current page');
        await unchangedForm(tab, initial);
        result.navigation_attempts++;
        let exitNavigationError = null;
        try { await tab.goto(entry_urls.inquiry); } catch (e) { exitNavigationError = String(e); }
        
        
        await readWithRecovery(() => tab.playwright.waitForURL(entry_urls.inquiry, { waitUntil: 'domcontentloaded', timeoutMs: 15000 }));
        const exited = await waitBody('inquiry');
        await checkAccount(tab);
        result.evidence.push(await save(kind, 'exit', '未改字段的预览已返回查询列表', 'read_verified', exited, { fields_changed: false, queries_submitted: 0, navigation_error: exitNavigationError, navigation_repeated: false }));
      }
      await checkAccount(accountTab); result.ok = true;
    } catch (e) {
      result.error = String(e);
      let state = { dom: '' };
      try { state = { dom: await tab.playwright.domSnapshot() }; } catch {}
      result.evidence.push(await save(kind, 'failure', '直达工具回放未通过', 'attempt_failed', state, { error: result.error }));
    } finally {
      result.elapsed_ms = Date.now() - start;
      result.result_path = path.join(explorer.run_dir, 'extended-result-' + (++serial) + '.json');
      await fs.writeFile(result.result_path, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
      const back = JSON.parse(await fs.readFile(result.result_path, 'utf8'));
      if (back.ok !== result.ok || back.script_sha256 !== sha) throw Error('Extended result readback mismatch');
    }
    return result;
  }
  async function runMany(kinds) {
    if (!Array.isArray(kinds) || !kinds.length || kinds.some(k => !Object.hasOwn(pages, k))) throw Error('Invalid extended tool batch');
    const start = Date.now(), results = [];
    for (const kind of kinds) { const r = await run(kind); results.push(r); if (!r.ok) break; }
    const batch = { ok: results.length === kinds.length && results.every(r => r.ok), requested: kinds, results,
      elapsed_ms: Date.now() - start, script_sha256: sha, advertising_writes: 0, external_writes: 0 };
    batch.result_path = path.join(explorer.run_dir, 'extended-batch-' + serial + '.json');
    await fs.writeFile(batch.result_path, JSON.stringify(batch, null, 2) + '\n', { flag: 'wx' });
    const back = JSON.parse(await fs.readFile(batch.result_path, 'utf8'));
    if (back.ok !== batch.ok) throw Error('Batch readback mismatch');
    return batch;
  }
  return guardRunner([tab, accountTab], { run, runMany, run_dir: explorer.run_dir, snapshot: name => explorer.snapshot(name, tab) }, sourceProof);
}
