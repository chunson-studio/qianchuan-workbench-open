// Import in Codex CUA. All browser interactions stay on the supplied CUA tab.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const activeTabs = new Set();
const defaultRunRoot = path.join(projectRoot, 'work/browser-actions/runs');
const require = createRequire(import.meta.url);
const { loadBrowserBindings, validateBrowserBinding } = require('./lib/browser-profile-binding.cjs');

function runFinalizer(runDir, nodeExecutable) {
  return new Promise((resolve, reject) => {
    // This subprocess handles local JSON/SQLite only, never browser control.
    execFile(nodeExecutable, [path.join(projectRoot, 'tools/finalize-browser-read.cjs'), '--run-dir', runDir],
      { cwd: projectRoot, windowsHide: true, timeout: 15000, maxBuffer: 256 * 1024, shell: false },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(`本地保存未完成：${String(stderr || error.message).trim().slice(0, 1200)}`));
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error('本地保存没有返回有效回执')); }
      });
  });
}

async function writeJson(file, value) {
  await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
}

async function saveActionCatalogEvidence(id, event, runDir) {
  const actionsRoot = path.join(projectRoot, 'work/browser-actions');
  const names = await fs.readdir(actionsRoot);
  const sourceRef = path.relative(projectRoot, path.join(runDir, id + '.json')).replaceAll(path.sep, '/');
  for (const name of names.filter(entry => entry.endsWith('.json'))) {
    const file = path.join(actionsRoot, name);
    let catalog;
    try { catalog = JSON.parse(await fs.readFile(file, 'utf8')); } catch { continue; }
    if (!Array.isArray(catalog.actions)) continue;
    const entry = catalog.actions.find(action => action.id === id);
    if (!entry) continue;
    entry.last_validation = event;
    entry.sources = Array.isArray(entry.sources) ? entry.sources : [];
    if (!entry.sources.includes(sourceRef)) entry.sources.push(sourceRef);
    await fs.writeFile(file, JSON.stringify(catalog, null, 2) + '\n');
    return name;
  }
  throw new Error(`按钮登记不存在：${id}`);
}

/** One call: refreshed capture -> canonical normalization -> isolated ledger readback -> compact display.
 * Bind AX + Playwright to the SAME tab beforehand. No navigation, ads or schedules.
 * nodeExecutable can be an installed Node executable path; it is never interpolated into shell code.
 */
export async function runQianchuanReadWorkflow(tab, cfg, options = {}) {
  if (options.browser_adapter || options.playwright_bindings_file || options.browser_identity?.browserType === 'playwright-cdp') {
    throw new Error('CUA 工作流不接收本地 CDP；请用 tools/playwright-channel.cjs 的 read_boost_table 动作');
  }
  if (!cfg || ['account_id', 'advertiser_id', 'primary_ad_id'].some(key => typeof cfg[key] !== 'string' || !cfg[key])) {
    throw new Error('必须显式绑定本机账户、广告户和主计划');
  }
  const workflowTab = tab;
  if (!workflowTab?.playwright || typeof workflowTab.url !== 'function'
    || typeof workflowTab.reload !== 'function' || typeof workflowTab.getAXState !== 'function') {
    throw new Error('需要同一 CUA 标签的 playwright/url/reload/getAXState');
  }
  let browserBinding = null;
  const runtimeBrowserIdentity = options.browser_identity;
  if (options.profile_bindings_file || options.browser_identity) {
    if (!options.profile_bindings_file || !runtimeBrowserIdentity) {
      throw new Error('浏览器 Profile 绑定校验需要同时提供登记文件和当前浏览器身份');
    }
    try {
      const registry = loadBrowserBindings(path.resolve(options.profile_bindings_file));
      browserBinding = validateBrowserBinding(registry, {
        account_id: cfg.account_id,
        advertiser_id: cfg.advertiser_id,
        primary_ad_id: cfg.primary_ad_id,
      }, runtimeBrowserIdentity);
    } catch (error) {
      throw new Error(`浏览器 Profile 绑定失败：${error.code || 'browser_binding_invalid'}`);
    }
  }
  // tab_key must be browser ID + tab ID when callers construct new adapters each time.
  const tabKey = options.tab_key || workflowTab;
  if (activeTabs.has(tabKey)) throw new Error('这个标签正在读取，请等待本轮结束');
  activeTabs.add(tabKey);
  const started = Date.now();
  const timings = {};
  let runDir, stage = 'prepare', captureResult;
  try {
    const runRoot = options.run_root ? path.resolve(options.run_root) : defaultRunRoot;
    await fs.mkdir(runRoot, { recursive: true });
    runDir = await fs.mkdtemp(path.join(runRoot, 'read-'));
    const source = await fs.readFile(path.join(projectRoot, 'tools/codex-qc-read-once.cua.js'), 'utf8');
    const sourceSha256 = createHash('sha256').update(source).digest('hex');
    // A per-run ESM adapter uses the exact current source: no eval, copied implementation or stale module cache.
    const adapterFile = path.join(runDir, 'reader.mjs');
    await fs.writeFile(adapterFile, source + '\nexport { runQianchuanCapturePage };\n', { flag: 'wx' });
    const reader = await import(pathToFileURL(adapterFile).href);
    const binding = { account_id: cfg.account_id, advertiser_id: cfg.advertiser_id, primary_ad_id: cfg.primary_ad_id };
    const onVerified = async (id, evidence) => {
      const event = { channel: 'codex-cua', id, status: 'read_verified', observed_at: new Date().toISOString(), binding,
        browser_binding: browserBinding ? {
          ...browserBinding.identity,
          evidence: browserBinding.evidence,
        } : null,
        advertising_writes: 0, reader_sha256: sourceSha256, evidence };
      // One immutable registration per verified action, saved before the next action.
      await writeJson(path.join(runDir, id + '.json'), event);
      await saveActionCatalogEvidence(id, event, runDir);
    };
    timings.prepare_ms = Date.now() - started;
    stage = 'capture';
    const captureStarted = Date.now();
    captureResult = await reader.runQianchuanCapturePage(workflowTab, { ...cfg, on_verified: onVerified });
    timings.capture_ms = Date.now() - captureStarted;
    await writeJson(path.join(runDir, 'capture-result.json'), captureResult);
    if (!captureResult.ok) throw new Error(captureResult.error || '浏览器读取失败');
    await writeJson(path.join(runDir, 'capture.json'), captureResult.capture);
    stage = 'finalize';
    const finalizeStarted = Date.now();
    const summary = await runFinalizer(runDir, options.node_executable || 'node');
    timings.finalize_ms = Date.now() - finalizeStarted;
    if (summary.ok !== true || summary.persisted !== true || !summary.snapshot_id) throw new Error('本地回执未证明快照已保存');
    timings.total_ms = Date.now() - started;
    const result = { ...summary, mode: 'read_only', advertising_writes: 0,
      registry_used: Boolean(browserBinding),
      browser_binding: browserBinding ? {
        ...browserBinding.identity,
        evidence: browserBinding.evidence,
      } : null,
      coverage: 'current_page_only', run_dir: runDir, reader_sha256: sourceSha256, timings,
      capture_trace: captureResult.trace };
    await writeJson(path.join(runDir, 'workflow-result.json'), result);
    return result;
  } catch (error) {
    timings.total_ms = Date.now() - started;
    const result = { ok: false, mode: 'read_only', advertising_writes: 0, stage,
      registry_used: Boolean(browserBinding),
      browser_binding: browserBinding ? {
        ...browserBinding.identity,
        evidence: browserBinding.evidence,
      } : null,
      error: String(error.message), run_dir: runDir || null, timings,
      // A finalizer may have saved a ledger before a later report error; don't claim no persistence.
      persistence: stage === 'finalize' ? 'unconfirmed_check_receipt' : 'not_started' };
    if (runDir) await writeJson(path.join(runDir, 'workflow-failure.json'), result);
    return result;
  } finally {
    activeTabs.delete(tabKey);
  }
}
