
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { safeUrl, readWithRecovery, assertAccountUrl } from './browser-readiness.mjs';

import { accountBinding, immutable, captureSource, guardRunner, ensureNoOpenForm, formFingerprint, unchangedForm, observedUrl } from './browser-runtime.mjs';
import { createExplorer, explorerSource } from './qianchuan-explorer.mjs';
const sourceProof = await captureSource(import.meta.url, [explorerSource]);

const source = fileURLToPath(import.meta.url);
const pages = Object.freeze({
  audience: { path: '/tools/audience-package/package-manage/pkg-manage', columns: ['定向包名称','定向包描述','关联计划数','操作'], button: '新建定向包' },
  rise: { path: '/tools/smart-boost/smart-boost-tools/account-boost-manage', columns: ['起量日预算','起量消耗','起量日期','实际生效时间','任务名称','状态','操作'], button: '新建起量任务' },
  comments: { path: '/tools/comment-management/comment-content', columns: ['评论内容','操作','回复状态','隐藏状态','评论层级','评论用户','评论时间','相关回复数','点赞数','视频标题','视频所属抖音号','评论类型','评论来源计划','关联视频素材'], placeholder: '请输入评论内容关键词' },
  comment_words: { path: '/tools/comment-management/comment-term', columns: ['屏蔽词','操作'], button: '添加屏蔽词' },
  comment_users: { path: '/tools/comment-management/comment-user', columns: ['屏蔽方式','关键词','屏蔽用户','操作'], button: '添加屏蔽用户' },
  phrases: { path: '/tools/comment-management/phrase', columns: ['常用语','操作'], button: '添加常用语' },
  audit_ai: { path: '/tools/creative-management/material-ai-repair-task', columns: ['拒绝内容','修复后视频','修复状态','所属计划','修复时间','操作'] },
  audit_center: { path: '/advocacy/audit-page', markers: ['审核数据诊断','近7天审核参考通过率','行业审核规则指南','规则速递','行业常见违规案例'] },
  quota: { path: '/tools/account-search-tools/quota-search', markers: ['在投计划配额查询（不含全域投放）','在投计划配额的计算及升级方式'] },
  violation: { path: '/advocacy/violation-center', markers: ['近30天违规概览','账户积分规则'], columns: ['违规单ID','账户信息','违规单状态','考试状态','违规时间','违规类型','积分变更','违规分类','操作'] }
});
const previews = Object.freeze({
  audience_preview: { page: 'audience', button: '新建定向包', path: '/tools/audience-package/package-manage/create', placeholder: '请输入定向包名称，1-20个字符', description: '请输入定向包描述，1-50个字符（选填）' },
  words_preview: { page: 'comment_words', button: '添加屏蔽词', placeholder: '请粘贴或输入关键词，一行一个' },
  users_preview: { page: 'comment_users', button: '添加屏蔽用户', placeholder: '请输入' },
  phrases_preview: { page: 'phrases', button: '添加常用语', placeholder: '请输入' }
});
export const accountToolPages = Object.keys(pages);
export const accountToolPreviews = Object.keys(previews);

export async function createAccountToolRunner(tab, binding, { timeout_ms = 15000 } = {}) {
  binding = accountBinding(binding);
  if (!binding?.entry_urls) throw Error('Missing verified entry URLs');
  const entries = { ...binding.entry_urls };
  const explorer = await createExplorer(tab, Object.fromEntries(
    ['advertiser_id', 'advertiser_name', 'extension_instance_id', 'profile_name'].map(key => [key, binding[key]])));
  const sha = sourceProof.sha256;
  let busy = false;
  let resultSeq = 0;
  let batchSeq = 0;
  const read = readWithRecovery;
  const identity = () => explorer.identity();
  
  
  async function waitObserved(locator, state) {
    for (let attempt = 1; ; attempt++) {
      try { return await locator.waitFor({ state, timeoutMs: timeout_ms }); }
      catch (error) {
        if (attempt >= 3 || !/(?:selector deadline exceeded|locator\.waitFor\([^)]*\) timed out)/i.test(String(error))) throw error;
        await read(() => tab.playwright.domSnapshot());
        await identity();
      }
    }
  }
  const text = name => tab.playwright.getByText(name, { exact: true }).filter({ visible: true });
  const button = name => tab.playwright.getByRole('button', { name, exact: true }).filter({ visible: true });
  const field = name => tab.playwright.getByRole('textbox', { name, exact: true }).filter({ visible: true });
  function target(raw, expectedPath) {
    return assertAccountUrl(raw, binding, expectedPath).href;
  }
  async function unique(locator) {
    if (await read(() => locator.count()) !== 1) throw Error('Visible control is missing or ambiguous');
    return locator;
  }
  async function persist(id, name, status, details, observed = null) {
    return explorer.save('account_tools.' + id, name, status,
      { flow_script_sha256: sha, source_manifest: sourceProof.sources, evidence_kind: observed === null ? 'action_note' : 'structured_visible_dom', advertising_writes: 0, external_writes: 0, ...details },
      'controls-and-audit', tab, observed === null ? 'Action recorded; business rows and operator identities omitted.' : JSON.stringify(observed, null, 2));
  }
  async function ready(def) {
    await identity();
    for (const name of def.columns || []) await waitObserved(tab.playwright.getByRole('columnheader', { name, exact: true }), 'visible');
    for (const name of def.markers || []) await waitObserved(text(name), 'visible');
    if (def.button) await waitObserved(button(def.button), 'visible');
    if (def.placeholder) await waitObserved(field(def.placeholder), 'visible');
    const loaders = await read(() => tab.playwright.getByText(/^(?:数据)?加载中(?:\.{3}|…)?$/).filter({ visible: true }).all());
    for (const loader of loaders) await waitObserved(loader, 'hidden');
    target(await read(() => tab.url()), def.path);
    await identity();
  }
  async function layout(def) {
    const banner = await read(() => tab.playwright.getByRole('banner').innerText({ timeoutMs: timeout_ms }));
    const columns = await read(() => tab.playwright.getByRole('columnheader').allTextContents({ timeoutMs: timeout_ms }));
    const seen = { banner, columns: columns.map(x => x.trim()), markers: def.markers || [], business_rows_read: false, layout_only: true };
    if (def.button) seen.button = { name: def.button, enabled: await read(() => button(def.button).isEnabled()) };
    return seen;
  }
  async function openPage(kind, steps, counters) {
    const def = pages[kind];
    if (!def || !entries[kind]) throw Error('Page has no verified entry');
    const url = target(entries[kind], def.path);
    await identity();
    await ensureNoOpenForm(tab);
    
    if (await read(() => button('取消').count())) throw Error('Visible form must be resolved before navigation');
    const current = await read(() => tab.url());
    let navError = null;
    if (current !== url) {
      counters.navigation_attempts++;
      try { await tab.goto(url); }
      catch (error) {
        navError = String(error);
        await read(() => tab.playwright.waitForURL(url, { timeoutMs: timeout_ms }));
      }
    }
    steps.push(await persist(kind + '.open', '直达：' + kind, 'opened', { content_verified: false, navigation_error: navError, ...counters }));
    await ready(def);
    const seen = await layout(def);
    steps.push(await persist(kind + '.layout', '核验布局：' + kind, 'read_verified', { expected_path: def.path, ...seen, ...counters }, seen));
  }
  async function clickOnce(name, counters) {
    await identity();
    const control = await unique(button(name));
    if (!await read(() => control.isEnabled())) throw Error('Control is disabled');
    counters.click_attempts++;
    try { await control.click({ timeoutMs: timeout_ms }); return null; }
    catch (error) { return String(error); } 
  }
  async function preview(kind, steps, counters) {
    const def = previews[kind];
    await openPage(def.page, steps, counters);
    const clickError = await clickOnce(def.button, counters);
    steps.push(await persist(kind + '.open', '打开空表单：' + def.button, 'opened', { content_verified: false, click_error: clickError, locator: 'getByRole(button,' + def.button + ')', ...counters }));
    
    await read(() => tab.playwright.domSnapshot());
    await waitObserved(field(def.placeholder), 'visible');
    await unique(field(def.placeholder));
    const value = await read(() => field(def.placeholder).evaluate(el => el.value));
    let description = null;
    if (def.description) {
      target(await read(() => tab.url()), def.path);
      await unique(field(def.description));
      description = await read(() => field(def.description).evaluate(el => el.value));
      if (description !== '') throw Error('Audience description is not empty');
    } else if (value !== '') throw Error('Preview field is not empty');
    await identity();
    const initialFingerprint = await formFingerprint(tab);
    const seen = { placeholder: def.placeholder, empty_input: !value, default_name: def.description ? value : null, description_empty: description === '', fields_changed: false, confirmed: false };
    steps.push(await persist(kind + '.fields', '核验空表单：' + kind, 'read_verified', { ...seen, click_error: clickError, ...counters }, seen));
    const previewFingerprint = initialFingerprint;
    
    await unchangedForm(tab, previewFingerprint);
    
    if (await read(() => field(def.placeholder).evaluate(el => el.value)) !== value ||
        (def.description && await read(() => field(def.description).evaluate(el => el.value)) !== description))
      throw Error('Form changed after preview; cancellation stopped');
    target(await read(() => tab.url()), def.path || pages[def.page].path);
    await unchangedForm(tab, initialFingerprint);
    const cancelError = await clickOnce('取消', counters);
    steps.push(await persist(kind + '.cancel.open', '取消空表单：' + kind, 'opened', { content_verified: false, click_error: cancelError, ...counters }));
    await read(() => tab.playwright.domSnapshot());
    await waitObserved(field(def.placeholder), 'hidden');
    await ready(pages[def.page]);
    steps.push(await persist(kind + '.cancel', '回读已取消：' + kind, 'read_verified', { form_closed: true, fields_changed: false, confirmed: false, click_error: cancelError, ...counters }, await layout(pages[def.page])));
  }
  async function runUnlocked(kind) {
    const started = Date.now();
    const steps = [];
    const counters = { navigation_attempts: 0, click_attempts: 0, navigation_repeated: false, click_repeated: false };
    let error = null;
    try {
      if (Object.hasOwn(pages, kind)) await openPage(kind, steps, counters);
      else if (Object.hasOwn(previews, kind)) await preview(kind, steps, counters);
      else throw Error('Unknown account tool action');
    } catch (e) {
      error = String(e);
      steps.push(await persist(kind + '.failure', '流程失败：' + kind, 'attempt_failed', { error, ...counters }));
    }
    const result = { ok: error === null, action: kind, elapsed_ms: Date.now() - started, url: await observedUrl(tab),
      script_sha256: sha, ...counters, advertising_writes: 0, external_writes: 0, formal_fresh_sample: false, source_at: null,
      verified_scope: error ? 'incomplete' : previews[kind] ? 'form_preview_and_cancel' : 'layout_only', evidence: steps,
      error, run_dir: explorer.run_dir };
    const out = path.join(explorer.run_dir, 'account-tools-result-' + (++resultSeq) + '.json');
    await fs.writeFile(out, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    const back = JSON.parse(await fs.readFile(out, 'utf8'));
    if (back.script_sha256 !== sha || back.ok !== result.ok || back.evidence.length !== steps.length) throw Error('Result readback failed');
    return { ...result, result_file: out };
  }
  async function run(kind) {
    if (busy) throw Error('Account tool runner busy');
    busy = true;
    try { return await runUnlocked(kind); } finally { busy = false; }
  }
  async function runMany(kinds) {
    if (busy) throw Error('Account tool runner busy');
    if (!Array.isArray(kinds) || !kinds.length || kinds.some(k => !Object.hasOwn(pages, k) && !Object.hasOwn(previews, k))) throw Error('Invalid batch actions');
    busy = true;
    try {
      const started = Date.now();
      const results = [];
      for (const kind of kinds) { const result = await runUnlocked(kind); results.push(result); if (!result.ok) break; }
      const result = { ok: results.length === kinds.length && results.every(r => r.ok), requested: kinds, completed: results.length,
        stop_on_failure: true, elapsed_ms: Date.now() - started, script_sha256: sha, results,
        advertising_writes: 0, external_writes: 0, formal_fresh_sample: false, source_at: null };
      const out = path.join(explorer.run_dir, 'account-tools-batch-' + (++batchSeq) + '.json');
      await fs.writeFile(out, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
      if (JSON.parse(await fs.readFile(out, 'utf8')).ok !== result.ok) throw Error('Batch readback failed');
      return { ...result, result_file: out, run_dir: explorer.run_dir };
    } finally { busy = false; }
  }
  return guardRunner([tab], { run, runMany, run_dir: explorer.run_dir, records: explorer.records, script_sha256: sha,
    pages: accountToolPages, previews: accountToolPreviews, snapshot: explorer.snapshot }, sourceProof);
}
