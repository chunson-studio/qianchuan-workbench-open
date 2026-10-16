
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createExplorer, explorerSource } from './qianchuan-explorer.mjs';
import { readWithRecovery } from './browser-readiness.mjs';
import { accountBinding, immutable, captureSource, guardRunner, ensureNoOpenForm, formFingerprint, unchangedForm } from './browser-runtime.mjs';

const sourceProof = await captureSource(import.meta.url, [explorerSource]);


const source = fileURLToPath(import.meta.url);
const definitions = {
  hosted_authorization: {
    title: '巨量千川-商品投放-托管授权',
    url: 'https://bytedance.larkoffice.com/docx/ZsJqdSWb1oQdXAxqkgVcnI0nnag',
    date_year_verified: false,
    sections: {
      product: { link: '详细介绍（文字版）', markers: ['商品全域投放授权流程', '满足条件可默认投放商品全域投放'] },
      creator: { link: '1. 达人操作说明', markers: ['关闭开关，不影响之前已经合作挂车的商家', '授权记录管理'] },
      merchant: { link: '2. 商家操作说明', markers: ['仅支持抖音号主页挂车视频', '满足条件'] },
      live_faq: { link: '2. 达人开启托管授权，会影响直播间嘛？', markers: ['不会授权托管到推直播间'] }
    },
    gaps: ['图文版图片未完整阅读', '账户是否满足自动授权条件尚未核验', '页眉修改日期未显示年份']
  },
  smart_rise: {
    title: '巨量千川-智能起量工具产品手册（可对外）',
    url: 'https://bytedance.larkoffice.com/docx/doxcnFYm6NWvNOsN7rggab4b0w1',
    historical_reference: true,
    date_year_verified: false,
    sections: {
      product: { link: '产品详解', markers: ['生效粒度', '策略范围', '不适用成本保障'] },
      operation: { link: '操作流程', markers: ['起量前', '起量中', '起量后'] },
      cautions: { link: '注意事项', markers: ['正确认识起量周期内超成本现象', '成本可能有一定涨幅'] },
      qa: { link: '常见QA', markers: ['Q3：计划一键起量和账户优选起量可以同时使用吗？', '策略偶发延迟'] }
    },
    gaps: ['正文含2022年版本历史，不证明当前规则', '操作方法论与QA5图片未完整阅读', '优秀案例效果未独立验证', '未核验本账户当前起量资格']
  }
};
export const manualDefinitions = structuredClone(definitions);

function checkUrl(raw, doc) {
  const u = new URL(raw);
  const expected = new URL(doc.url);
  if (!['https://bytedance.larkoffice.com', 'https://bytedance.feishu.cn'].includes(u.origin) || u.username || u.password
      || u.pathname !== expected.pathname || u.search) throw Error('Manual URL binding mismatch');
  return u.href;
}

function article(dom, title) {
  const marker = '- heading "' + title + '" [level=1]:';
  const at = dom.indexOf(marker);
  if (at < 0) throw Error('Manual title not present in rendered DOM');
  
  return dom.slice(at + marker.length).split('- generic: 全文评论')[0];
}

export async function createManualReader(tab, binding, documentKey, { accountTab } = {}) {
  binding = accountBinding(binding);
  if (tab.id === accountTab?.id) throw Error('Manual requires a separate advertiser source tab');
  if (!accountTab) throw Error('An explicit verified advertiser tab is required');
  const doc = Object.hasOwn(definitions, documentKey) ? definitions[documentKey] : null;
  if (!doc) throw Error('Unknown observed manual');
  const explorer = await createExplorer(accountTab, binding);
  await explorer.identity(accountTab);
  const sha = sourceProof.sha256;
  let serial = 0;

  async function documentState() {
    const url = checkUrl(await readWithRecovery(() => tab.url()), doc);
    const dom = await readWithRecovery(() => tab.playwright.domSnapshot());
    const body = article(dom, doc.title);
    return { url, dom, body };
  }

  async function save(id, label, status, state, details = {}) {
    return explorer.save('manual.script.' + documentKey + '.' + id, label, status, {
      ...details, document_key: documentKey, document_title: doc.title,
      source_type: 'publisher_manual_visible_page',
      account_identity_checked_on: accountTab.id, manual_is_not_account_identity_proof: true,
      workflow_script: 'work/browser-actions/scripts/manual-reader.mjs', workflow_script_sha256: sha,
      source_at: null, whole_document_read: false, current_account_rule_applicability: 'unverified',
      historical_reference: Boolean(doc.historical_reference), date_year_verified: false,
      gaps: doc.gaps
    }, 'data-and-dashboard', tab, state?.dom ?? null);
  }

  async function ensureOpen(result) {
    const actual = await tab.url();
    let correct = false;
    try { checkUrl(actual, doc); correct = true; } catch {}
    if (!correct) {
      await ensureNoOpenForm(tab);
      result.navigation_attempts++;
      let error = null;
      try { await tab.goto(doc.url); } catch (e) { error = String(e); }
      
      let state;
      try { state = { url: checkUrl(await readWithRecovery(() => tab.url()), doc), dom: await readWithRecovery(() => tab.playwright.domSnapshot()) }; }
      catch (e) { throw Error(error || String(e)); }
      result.evidence.push(await save('open', '手册直达已打开', 'opened', state,
        { content_verified: false, requested_url: doc.url, navigation_error: error }));
    }
    await readWithRecovery(() => tab.playwright.getByRole('heading', { name: doc.title, exact: true }).waitFor({ state: 'visible', timeoutMs: 15000 }));
    const target = tab.playwright.getByRole('link', { name: doc.sections[result.section].link, exact: true });
    await readWithRecovery(() => target.waitFor({ state: 'visible', timeoutMs: 15000 }));
    const state = await documentState();
    const toc = await readWithRecovery(() => target.count());
    if (toc !== 1) throw Error('Manual TOC target missing or ambiguous');
    result.evidence.push(await save('identity', '手册标题、路径与目录已核对', 'read_verified', state,
      { verified_scope: 'document_identity_and_TOC', content_verified: false, chapter_read: false }));
  }

  async function run(sectionKey) {
    const section = Object.hasOwn(doc.sections, sectionKey) ? doc.sections[sectionKey] : null;
    if (!section) throw Error('Unknown verified section');
    const start = Date.now();
    const result = { ok: false, document: documentKey, section: sectionKey,
      script: 'scripts/manual-reader.mjs', script_sha256: sha,
      binding: { ...binding }, navigation_attempts: 0, click_count: 0,
      advertising_writes: 0, external_writes: 0, source_at: null, formal_fresh_sample: false,
      verified_scope: null, whole_document_read: false, gaps: doc.gaps, evidence: [], run_dir: explorer.run_dir };
    try {
      await explorer.identity(accountTab);
      await ensureOpen(result);
      const link = tab.playwright.getByRole('link', { name: section.link, exact: true });
      if (!await link.isVisible() || !await link.isEnabled()) throw Error('TOC target not actionable');
      const href = await link.getAttribute('href');
      if (!href?.startsWith('#')) throw Error('TOC is no longer a local chapter link');
      let clickError = null;
      result.click_count++;
      try { await link.click({ timeoutMs: 15000 }); } catch (e) { clickError = String(e); }
      let state = await documentState();
      result.evidence.push(await save(sectionKey + '.jump', '目录直达' + section.link,
        clickError ? 'attempt_failed' : 'opened', state,
        { locator: 'getByRole(link, exact=true, name=' + section.link + ')', observed_href: href, click_error: clickError, content_verified: false }));
      let reads = 1;
      while (!section.markers.every(x => state.body.includes(x)) && reads < 3) {
        
        try { await tab.playwright.getByText(section.markers[0], { exact: false }).filter({ visible: true }).first().waitFor({ state: 'visible', timeoutMs: 15000 }); } catch {}
        state = await documentState(); reads++;
      }
      if (!section.markers.every(x => state.body.includes(x))) throw Error('Chapter body markers not rendered');
      result.evidence.push(await save(sectionKey + '.read', section.link + '文字回读已核对', 'read_verified', state,
        { verified_scope: 'specified_visible_chapter_text_only', content_verified: true,
          matched_body_markers: section.markers, read_attempts: reads, click_error: clickError,
          image_content_verified: false, comments_used_as_rules: false }));
      await explorer.identity(accountTab);
      result.verified_scope = 'specified_visible_chapter_text_only'; result.ok = true;
    } catch (e) {
      result.error = String(e);
      result.evidence.push(await save(sectionKey + '.failure', '手册章节回放未通过', 'attempt_failed', null, { error: result.error }));
    } finally {
      result.elapsed_ms = Date.now() - start;
      result.result_path = path.join(explorer.run_dir, 'manual-result-' + (++serial) + '.json');
      await fs.writeFile(result.result_path, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
      const back = JSON.parse(await fs.readFile(result.result_path, 'utf8'));
      if (back.ok !== result.ok || back.script_sha256 !== sha) throw Error('Manual result readback mismatch');
    }
    return result;
  }

  async function runMany(keys) {
    if (!Array.isArray(keys) || !keys.length || keys.some(k => !Object.hasOwn(doc.sections, k))) throw Error('Invalid chapter batch');
    const start = Date.now(), results = [];
    for (const key of keys) { const r = await run(key); results.push(r); if (!r.ok) break; }
    const batch = { ok: results.length === keys.length && results.every(r => r.ok), document: documentKey,
      requested: keys, results, elapsed_ms: Date.now() - start, script_sha256: sha, advertising_writes: 0, external_writes: 0 };
    batch.result_path = path.join(explorer.run_dir, 'manual-batch-' + serial + '.json');
    await fs.writeFile(batch.result_path, JSON.stringify(batch, null, 2) + '\n', { flag: 'wx' });
    const back = JSON.parse(await fs.readFile(batch.result_path, 'utf8'));
    if (back.ok !== batch.ok || back.script_sha256 !== sha) throw Error('Manual batch readback mismatch');
    return batch;
  }
  return guardRunner([tab, accountTab], { run, runMany, run_dir: explorer.run_dir, snapshot: name => explorer.snapshot(name, tab) }, sourceProof);
}
