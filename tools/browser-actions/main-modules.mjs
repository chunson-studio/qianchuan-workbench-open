

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readWithRecovery, safeUrl, assertAccountUrl } from './browser-readiness.mjs';
import { createExplorer, explorerSource } from './qianchuan-explorer.mjs';
import { accountBinding, immutable, captureSource, guardRunner, ensureNoOpenForm, formFingerprint, unchangedForm } from './browser-runtime.mjs';

const sourceProof = await captureSource(import.meta.url, [explorerSource]);


const definitions = Object.freeze({
  uni: {
    name: '全域投放', path: '/uni-prom',
    columns: ['抖音号', '投放状态', '投放设置', '调控工具', '操作', '效果诊断'],
    button: '投放直播间', text: '直播全域投放产品手册',
    dates: ['请选择开始日期', '请选择结束日期'], scope: '推直播间列表布局'
  },
  brand: {
    name: '品牌投放', path: '/brand_bid/promotion/standard',
    columns: ['计划名称', '计划状态', '直播间信息', '广告组名称', '组预算', '出价(元)', '预算(元)'],
    button: '新建计划', text: '品牌竞价',
    dates: ['请选择开始日期', '请选择结束日期'], scope: '品牌竞价计划列表布局'
  },
  chengfang: {
    name: '乘方', path: '/overall-prom',
    columns: ['抖音号', '投放状态', '投放设置', '营销服务', '调控工具', '投放类型'],
    button: '直播乘方', text: '千川乘方产品手册',
    dates: ['开始日期', '结束日期'], scope: '乘方直播列表布局'
  }
});
export const mainModuleNames = Object.keys(definitions);

export async function createMainModuleRunner(tab, binding) {
  binding = accountBinding(binding);
  if (!binding?.entry_urls) throw Error('Verified entry URLs required');
  const ownFile = fileURLToPath(import.meta.url);
  const sha = sourceProof.sha256;
  const explorer = await createExplorer(tab, Object.fromEntries(
    ['advertiser_id', 'advertiser_name', 'extension_instance_id', 'profile_name'].map(k => [k, binding[k]])));
  const entries = { ...binding.entry_urls };
  const read = readWithRecovery;
  const text = value => tab.playwright.getByText(value, { exact: true }).filter({ visible: true });
  let resultSequence = 0;
  let busy = false;

  function assertRoute(raw, expectedPath = null) {
    return assertAccountUrl(raw, binding, expectedPath);
  }
  
  async function waitObserved(locator, state = 'visible') {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await locator.waitFor({ state, timeoutMs: 15000 }); return; }
      catch (error) {
        if (attempt === 2 || !/timed out|deadline|detached/i.test(String(error))) throw error;
        const dom = await read(() => tab.playwright.domSnapshot());
        assertRoute(await read(() => tab.url()));
        if (/ERR_[A-Z_]+|请重新登录|登录已失效/.test(dom)) throw Error('Page requires recovery or login');
      }
    }
  }
  async function identity() {
    assertRoute(await read(() => tab.url()));
    await waitObserved(text(binding.advertiser_name));
    await waitObserved(text('ID：' + binding.advertiser_id));
    if (await read(() => text(binding.advertiser_name).count()) !== 1 ||
        await read(() => text('ID：' + binding.advertiser_id).count()) !== 1)
      throw Error('Visible advertiser identity is ambiguous');
    assertRoute(await read(() => tab.url()));
    return { advertiser_id: binding.advertiser_id, advertiser_name: binding.advertiser_name };
  }
  async function save(kind, stage, status, details) {
    return explorer.save('main_modules.direct.' + kind + '.' + stage,
      definitions[kind].name + '：' + stage, status,
      { flow_script_sha256: sha, source_manifest: sourceProof.sources, evidence_kind: 'structured_visible_dom', advertising_writes: 0, external_writes: 0, ...details },
      'data-and-dashboard', tab, JSON.stringify(details));
  }
  async function ready(kind) {
    const def = definitions[kind];
    const account = await identity();
    assertRoute(await read(() => tab.url()), def.path);
    for (const column of def.columns)
      await waitObserved(tab.playwright.getByRole('columnheader', { name: column, exact: true }).filter({ visible: true }));
    await waitObserved(tab.playwright.getByRole('button', { name: def.button, exact: true }).filter({ visible: true }));
    await waitObserved(text(def.text));
    
    
    const loadingCount = await read(() => tab.playwright.getByText(/^(?:数据)?加载中(?:\.{3}|…)?$/).filter({ visible: true }).count());
    const dates = [];
    for (const label of def.dates) {
      const field = tab.playwright.getByRole('textbox', { name: label, exact: true }).filter({ visible: true });
      if (await read(() => field.count()) !== 1) throw Error('Date control missing or ambiguous');
      dates.push(await read(() => field.evaluate(el => el.value)));
    }
    const selectedTab = await read(() => tab.playwright.getByRole('tab').evaluateAll(es =>
      es.filter(el => el.getAttribute('aria-selected') === 'true').map(el => el.textContent.trim())));
    assertRoute(await read(() => tab.url()), def.path);
    return { ...account, columns: def.columns, required_button: def.button,
      page_marker: def.text, date_start: dates[0], date_end: dates[1], selected_tabs: selectedTab,
      scope: def.scope, business_rows_read: false, layout_only: true,
      visible_loading_markers: loadingCount, business_data_verified: false,
      data_readiness: loadingCount ? 'loading_present' : 'not_checked' };
  }
  async function persistResult(result, prefix) {
    const out = path.join(explorer.run_dir, prefix + '-' + (++resultSequence) + '.json');
    const serialized = JSON.stringify(result, null, 2) + '\n';
    await fs.writeFile(out, serialized, { flag: 'wx' });
    if (await fs.readFile(out, 'utf8') !== serialized) throw Error('Result readback failed');
    return { ...result, result_file: out };
  }
  async function runOne(kind) {
    if (!Object.hasOwn(definitions, kind)) throw Error('Unknown main module');
    const start = Date.now();
    const evidence = [];
    let navigationAttempts = 0, error = null, observed = null, navigationError = null;
    try {
      const target = assertRoute(entries[kind], definitions[kind].path);
      
      if ([...target.searchParams.keys()].some(k => k !== 'aavid') || target.hash)
        throw Error('Main entry must contain only the explicit advertiser parameter');
      await ensureNoOpenForm(tab);
      evidence.push(await save(kind, 'identity', 'read_verified', await identity()));
      if (await read(() => tab.playwright.getByRole('dialog').filter({ visible: true }).count()) ||
          await read(() => tab.playwright.getByRole('button', { name: '取消', exact: true }).filter({ visible: true }).count()))
        throw Error('Resolve the open form before navigating');
      
      if (assertRoute(await read(() => tab.url())).pathname !== target.pathname) {
        navigationAttempts++;
        try { await tab.goto(target.href); }
        catch (e) { navigationError = String(e); } 
        await read(() => tab.playwright.domSnapshot());
      }
      assertRoute(await read(() => tab.url()), definitions[kind].path);
      evidence.push(await save(kind, 'open', 'opened', {
        requested_url: target.href, navigation_attempts: navigationAttempts,
        navigation_error: navigationError, content_verified: false }));
      observed = await ready(kind);
      evidence.push(await save(kind, 'layout', 'read_verified', observed));
    } catch (e) {
      error = String(e);
      evidence.push(await save(kind, 'failure', 'attempt_failed', { error, navigation_attempts: navigationAttempts }));
    }
    let finalUrl = null;
    try { finalUrl = safeUrl(await read(() => tab.url())); } catch {}
    return persistResult({ kind, ok: error === null, elapsed_ms: Date.now() - start,
      navigation_attempts: navigationAttempts, menu_clicks: 0, advertising_writes: 0, external_writes: 0,
      formal_fresh_sample: false, source_at: null, script_sha256: sha,
      verified_scope: error ? 'incomplete' : 'layout_only', observed, evidence, error,
      final_url: finalUrl, run_dir: explorer.run_dir }, 'main-module-result');
  }
  async function run(kind) {
    if (busy) throw Error('Runner busy');
    busy = true;
    try { return await runOne(kind); } finally { busy = false; }
  }
  async function runMany(kinds = mainModuleNames) {
    if (busy) throw Error('Runner busy');
    if (!Array.isArray(kinds) || !kinds.length || kinds.some(k => !Object.hasOwn(definitions, k))) throw Error('Invalid module batch');
    busy = true;
    try {
      const start = Date.now(), results = [];
      for (const kind of kinds) { const result = await runOne(kind); results.push(result); if (!result.ok) break; }
      return await persistResult({ ok: results.length === kinds.length && results.every(r => r.ok),
        requested: kinds, elapsed_ms: Date.now() - start, script_sha256: sha, results,
        stop_on_failure: true, advertising_writes: 0, external_writes: 0, source_at: null,
        formal_fresh_sample: false, run_dir: explorer.run_dir }, 'main-module-batch');
    } finally { busy = false; }
  }
  return guardRunner([tab], { run, runMany, run_dir: explorer.run_dir, script_sha256: sha, snapshot: explorer.snapshot }, sourceProof);
}
