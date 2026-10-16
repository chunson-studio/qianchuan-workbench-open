
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { safeUrl, redact, classifyPage, readWithRecovery, assertAccountUrl } from './browser-readiness.mjs';
import { accountBinding, accountIdentity, captureSource, verifySources, withTabLease, updateActionCatalog, ensureNoOpenForm } from './browser-runtime.mjs';

const source = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(source), '../..');
const rel = p => path.relative(root, p).replaceAll('\\', '/');
export const explorerSource = await captureSource(import.meta.url);

export async function createExplorer(tab, binding) {
  const b = accountBinding(binding);
  await verifySources(explorerSource);
  const runDir = await fs.mkdtemp(path.join(root, 'work/browser-actions/runs/explore-'));
  const sha = explorerSource.sha256;
  const records = [];
  let seq = 0;
  let progressQueue = Promise.resolve();
  const read = readWithRecovery;
  async function identity(target = tab) {
    return accountIdentity(target, b);
  }
  async function save(id, name, status, details = {}, group = 'data-and-dashboard', target = tab, suppliedDom = null) {
    if (!['common', 'data-and-dashboard', 'materials', 'controls-and-audit', 'compass-and-traffic'].includes(group) || !/^[a-z0-9._-]+$/.test(id)) throw Error('Invalid catalog group or action ID');
    if (!['observed', 'opened', 'read_verified', 'attempt_failed'].includes(status)) throw Error('Unsupported exploration status');
    const stamp = new Date().toISOString();
    const stem = String(++seq).padStart(3, '0') + '-' + id;
    const evidenceKind = details.evidence_kind || 'dom_snapshot';
    if (!['dom_snapshot', 'structured_visible_dom', 'action_note'].includes(evidenceKind)) throw Error('Invalid evidence kind');
    const domFile = path.join(runDir, stem + (evidenceKind === 'dom_snapshot' ? '.dom.txt' : '.observation.txt'));
    const jsonFile = path.join(runDir, stem + '.json');
    let dom = suppliedDom;
    let rawUrl = null;
    if (dom === null) {
      try { dom = await read(() => target.playwright.domSnapshot()); }
      catch (e) { dom = ''; details = { ...details, observation_error: String(e) }; }
    }
    try { rawUrl = await read(() => target.url()); } catch (e) { details = { ...details, url_error: String(e) }; }
    if (status !== 'attempt_failed' && (!rawUrl || details.observation_error || details.url_error)) throw Error('Observation unavailable; cannot record verified evidence');
    dom = redact(dom);
    await fs.writeFile(domFile, dom, { flag: 'wx' });
    const rec = { id, channel: 'codex-cua', name, page: safeUrl(rawUrl), entry: 'CUA 显式账户探索与复用', locator: details.locator || '读取当前可见 DOM', status, binding: redact(b), browser_binding_verification: 'caller_supplied; verify Chrome connection before factory', observed_at: stamp, source_at: null, formal_fresh_sample: false, script: rel(source), script_sha256: sha, source_manifest: explorerSource.sources, success_evidence: { ...redact(details), evidence_kind: evidenceKind, [evidenceKind === 'dom_snapshot' ? 'dom_file' : 'observation_file']: rel(domFile) }, exit: details.exit || '仅继续已观察的只读动作', constraints: ['学习样本，非正式实时盘面', '广告写入次数 0', '未知字段保留，不用旧场次补实时数据'], sources: [rel(jsonFile), rel(domFile)] };
    await fs.writeFile(jsonFile, JSON.stringify(rec, null, 2) + '\n', { flag: 'wx' });
    const proof = JSON.parse(await fs.readFile(jsonFile, 'utf8'));
    if (proof.status !== status || proof.script_sha256 !== sha || await fs.readFile(domFile, 'utf8') !== dom) throw Error('Evidence readback failed');
    await updateActionCatalog(path.join(root, 'work/browser-actions', group + '.json'), rec);
    const brief = { id, status, evidence: jsonFile, tab_id: target.id, url: rec.page };
    records.push(brief);
    const writeProgress = async () => {
      const out = path.join(runDir, 'progress.json'), temp = out + '.pending';
      const content = JSON.stringify({ binding: b, records, advertising_writes: 0 }, null, 2) + '\n';
      await fs.writeFile(temp, content, { flag: 'wx' });
      await fs.rename(temp, out);
      if (await fs.readFile(out, 'utf8') !== content) throw Error('Progress readback failed');
    };
    progressQueue = progressQueue.then(writeProgress, writeProgress);
    await progressQueue;
    return brief;
  }
  async function observe(id, name, details = {}, group = 'data-and-dashboard', target = tab) {
    const current = await identity(target);
    return save(id, name, 'read_verified', details, group, target, current.dom);
  }
  
  
  async function action(id, name, fn, verify, details = {}, group = 'data-and-dashboard', target = tab) {
    try {
      await identity(target);
      if (details.expected_path) assertAccountUrl(await read(() => target.url()), b, details.expected_path);
      let actionError = null;
      try { await fn(); } catch (e) { actionError = e; }
      const dom = await read(() => target.playwright.domSnapshot());
      if (!await verify(dom)) throw actionError || Error('Action result not verified');
      await identity(target);
      if (details.expected_path) assertAccountUrl(await read(() => target.url()), b, details.expected_path);
      return await save(id, name, 'read_verified', { ...details, transport_result: actionError ? 'result confirmed without repeating action' : 'completed' }, group, target, dom);
    } catch (e) {
      await save(id, name, 'attempt_failed', { ...details, error: String(e) }, group, target);
      throw e;
    }
  }
  async function snapshot(fileName = 'view.png', target = tab) {
    if (!/^[a-z0-9._-]+$/i.test(fileName)) throw Error('Invalid screenshot name');
    const out = path.join(runDir, fileName);
    await fs.writeFile(out, await target.screenshot({ fullPage: false }), { flag: 'wx' });
    return out;
  }
  async function recoverHomeOnce({ max_reloads = 1 } = {}) {
    if (![0, 1].includes(max_reloads)) throw Error('Recovery permits at most one reload');
    const expected = { hostname: 'qianchuan.jinritemai.com', advertiser_id: b.advertiser_id,
      identity_markers: [b.advertiser_name, 'ID：' + b.advertiser_id], loaded_markers: ['首页'] };
    const inspect = async () => {
      const url = await read(() => tab.url());
      const dom = await read(() => tab.playwright.domSnapshot());
      let state = classifyPage(dom, url, expected);
      if (state.ready) {
        try { await identity(); }
        catch (e) { state = { ready: false, code: 'visible_identity_mismatch', error: String(e) }; }
      }
      return { url, dom, state };
    };
    let current = await inspect();
    await save('common.network.recovery.inspect', '核验首页加载状态', current.state.ready ? 'read_verified' : 'attempt_failed', current.state, 'common', tab, current.dom);
    if (current.state.ready || !max_reloads || !['network_error', 'loading', 'blank_unloaded', 'identity_unverified'].includes(current.state.code))
      return { ...current.state, reloads: 0, advertising_writes: 0 };
    
    const u = new URL(current.url);
    if (u.origin !== 'https://' + expected.hostname || u.username || u.password || u.pathname !== '/home' || u.searchParams.getAll('aavid').length !== 1 || u.searchParams.get('aavid') !== b.advertiser_id)
      return { ready: false, code: 'recovery_binding_mismatch', reloads: 0, advertising_writes: 0 };
    await ensureNoOpenForm(tab);
    let reloadError = null;
    try { await tab.reload(); } catch (e) { reloadError = String(e); }
    await save('common.network.recovery.reload', '同一首页单次恢复重载', 'opened', { attempts: 1, content_verified: false, error: reloadError }, 'common');
    current = await inspect();
    if (!current.state.ready && ['loading', 'blank_unloaded', 'identity_unverified'].includes(current.state.code)) {
      try { await tab.playwright.getByText(b.advertiser_name, { exact: true }).filter({ visible: true }).waitFor({ state: 'visible', timeoutMs: 15000 }); } catch {}
      current = await inspect();
    }
    await save('common.network.recovery.after', '回读重载后的首页身份与内容', current.state.ready ? 'read_verified' : 'attempt_failed', current.state, 'common', tab, current.dom);
    return { ...current.state, reloads: 1, advertising_writes: 0, run_dir: runDir };
  }
  async function recoverHome(options = {}) {
    return recoverHomeOnce(options);
  }
  const guarded = (fn, targetIndex) => (...args) => withTabLease([args[targetIndex] || tab], async () => {
    await verifySources(explorerSource); return fn(...args);
  });
  return { identity: guarded(identity, 0), observe: guarded(observe, 4), action: guarded(action, 6),
    save: guarded(save, 5), snapshot: guarded(snapshot, 1), recoverHome: guarded(recoverHome, -1),
    run_dir: runDir, records };
}
