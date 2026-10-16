
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { safeUrl, readWithRecovery, assertAccountUrl } from './browser-readiness.mjs';

import { accountBinding, immutable, captureSource, guardRunner, ensureNoOpenForm, formFingerprint, unchangedForm } from './browser-runtime.mjs';
import { createExplorer, explorerSource } from './qianchuan-explorer.mjs';
const sourceProof = await captureSource(import.meta.url, [explorerSource]);

const source = fileURLToPath(import.meta.url);
const definitions = Object.freeze({
  rules: { path: '/tools/automatic-rules/rule-management/rule-manage', columns: ['规则','应用对象','执行操作','创建者','操作'] },
  rule_history: { path: '/tools/automatic-rules/running-record/run-record', columns: ['规则','执行时间','应用维度','应用对象','满足条件','执行操作','结果'] },
  plan_cleanup: { path: '/tools/cleanup-assistant/ad-clean', columns: ['计划名称','计划类型','计划状态','诊断状态','消耗','诊断日期','自动暂停日期','操作'] },
  material_cleanup: { path: '/tools/cleanup-assistant/home', heading: '素材清理可以帮助你', button: '开始扫描' },
  cleanup_history: { path: '/tools/cleanup-assistant/clear-records', columns: ['操作时间','清理类型','ID','问题类型','操作类型','操作人','操作结果','操作IP'] },
  batch_tasks: { path: '/tools/task-center/batch-task', columns: ['任务名称','创建时间','状态','操作人','操作'] },
  download_tasks: { path: '/tools/task-center/download-task', columns: ['创建时间','文件场景','文件信息','任务状态','操作'], button: '新建下载任务' }
});
export const toolPageActions = Object.keys(definitions);

export async function createToolPageRunner(tab, binding, { timeout_ms = 15000 } = {}) {
  binding = accountBinding(binding);
  if (!binding?.entry_urls) throw Error('Missing verified entry URLs');
  const entries = { ...binding.entry_urls };
  const explorer = await createExplorer(tab, binding);
  const sha = sourceProof.sha256;
  let busy = false;
  let resultSeq = 0;
  async function checkTarget(url, def) {
    return assertAccountUrl(url, binding, def.path).href;
  }
  async function ready(def) {
    await explorer.identity();
    if (def.heading) await tab.playwright.getByRole('heading', { name: def.heading, exact: true }).waitFor({ state: 'visible', timeoutMs: timeout_ms });
    for (const name of def.columns || []) await tab.playwright.getByRole('columnheader', { name, exact: true }).waitFor({ state: 'visible', timeoutMs: timeout_ms });
    if (def.button) await tab.playwright.getByRole('button', { name: def.button, exact: true }).waitFor({ state: 'visible', timeoutMs: timeout_ms });
    const loaders = await tab.playwright.getByText(/^(?:数据)?加载中(?:\.{3}|…)?$/).filter({ visible: true }).all();
    for (const loader of loaders) await loader.waitFor({ state: 'hidden', timeoutMs: timeout_ms });
    await checkTarget(await readWithRecovery(() => tab.url()), def);
    await explorer.identity();
  }
  
  async function layout(def) {
    const banner = await readWithRecovery(() => tab.playwright.getByRole('banner').innerText({ timeoutMs: timeout_ms }));
    const columns = await readWithRecovery(() => tab.playwright.getByRole('columnheader').allTextContents({ timeoutMs: timeout_ms }));
    const heading = def.heading ? await tab.playwright.getByRole('heading', { name: def.heading, exact: true }).innerText({ timeoutMs: timeout_ms }) : null;
    const buttons = def.button ? [await tab.playwright.getByRole('button', { name: def.button, exact: true }).innerText({ timeoutMs: timeout_ms })] : [];
    return { banner, columns: columns.map(x => x.trim()), heading, buttons, business_rows_read: false };
  }
  async function run(kind) {
    if (busy) throw Error('Tool page runner busy');
    const def = Object.hasOwn(definitions, kind) ? definitions[kind] : null;
    if (!def || !entries[kind]) throw Error('Action has no verified entry');
    const url = await checkTarget(entries[kind], def);
    busy = true;
    const started = Date.now();
    const prefix = 'tools.direct.' + kind;
    let navigationAttempts = 0;
    let navigationError = null;
    try {
      
      await explorer.identity();
      await ensureNoOpenForm(tab);
      const current = await readWithRecovery(() => tab.url());
      if (current !== url) {
        navigationAttempts = 1;
        try { await tab.goto(url); }
        catch (error) {
          navigationError = String(error);
          
          
          await readWithRecovery(() => tab.playwright.waitForURL(url, { timeoutMs: timeout_ms }));
        }
      }
      await explorer.save(prefix + '.open', '直达工具页：' + kind, 'opened', { flow_script_sha256: sha, source_manifest: sourceProof.sources, evidence_kind: 'action_note', navigation_attempts: navigationAttempts, navigation_error: navigationError, navigation_repeated: false, click_count: 0, content_verified: false }, 'controls-and-audit', tab, 'Navigation issued or target already open; page contents not yet verified.');
      await ready(def);
      const seen = await layout(def);
      const evidenceDom = 'Layout-only observation from live DOM; business rows omitted.\n' + JSON.stringify(seen, null, 2);
      const evidence = await explorer.save(prefix + '.layout', '核验工具页：' + kind, 'read_verified', { flow_script_sha256: sha, source_manifest: sourceProof.sources, evidence_kind: 'structured_visible_dom', ...seen, expected_path: def.path, click_count: 0, advertising_writes: 0 }, 'controls-and-audit', tab, evidenceDom);
      const result = { ok: true, action: kind, url: safeUrl(await tab.url()), elapsed_ms: Date.now() - started, script_sha256: sha, click_count: 0, navigation_attempts: navigationAttempts, navigation_error: navigationError, navigation_repeated: false, advertising_writes: 0, formal_fresh_sample: false, source_at: null, layout_only: true, evidence, run_dir: explorer.run_dir };
      const out = path.join(explorer.run_dir, 'tools-result' + (++resultSeq) + '.json');
      await fs.writeFile(out, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
      const back = JSON.parse(await fs.readFile(out, 'utf8'));
      if (back.script_sha256 !== sha || !back.ok) throw Error('Result readback failed');
      return { ...result, result_file: out };
    } catch (error) {
      const evidence = await explorer.save(prefix + '.failure', '工具页读取失败：' + kind, 'attempt_failed', { flow_script_sha256: sha, source_manifest: sourceProof.sources, evidence_kind: 'action_note', error: String(error), navigation_attempts: navigationAttempts, navigation_error: navigationError, navigation_repeated: false, advertising_writes: 0 }, 'controls-and-audit', tab, 'Failed layout verification; business rows not captured.');
      return { ok: false, action: kind, elapsed_ms: Date.now() - started, script_sha256: sha, error: String(error), advertising_writes: 0, evidence, run_dir: explorer.run_dir };
    } finally { busy = false; }
  }
  return guardRunner([tab], { run, run_dir: explorer.run_dir, records: explorer.records, script_sha256: sha, actions: toolPageActions }, sourceProof);
}
