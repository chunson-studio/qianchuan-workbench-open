

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createExplorer, explorerSource } from './qianchuan-explorer.mjs';
import { accountBinding, immutable, captureSource, guardRunner, ensureNoOpenForm, formFingerprint, unchangedForm, observedUrl } from './browser-runtime.mjs';

const sourceProof = await captureSource(import.meta.url, [explorerSource]);

import { readWithRecovery, assertAccountUrl, redact, idTextPattern } from './browser-readiness.mjs';

const source = fileURLToPath(import.meta.url);
const active = new Set();
const pages = Object.freeze({
  image: { path: '/tools/creative-management/picture-library', label: '图片' },
  post: { path: '/tools/creative-management/atlas-library', label: '图文' },
  tag: { path: '/tools/creative-management/tag-library', label: '标签' },
  creative_rank: { path: '/creative/creative-ranking/ad', label: '营销创意榜' },
  content_rank: { path: '/creative/creative-ranking/nature', label: '爆款内容榜' },
});
export const assetActions = Object.freeze(['image_detail', 'post_layout', 'tag_preview', 'creative_rank_layout', 'content_rank_layout']);

export async function createAssetRunner(tab, binding, options = {}) {
  binding = accountBinding(binding);
  options = immutable(options);
  if (!tab?.playwright || !binding?.entry_urls) throw Error('Explicit CUA tab and observed entry_urls required');
  const entries = {};
  for (const [name, value] of Object.entries(binding.entry_urls)) {
    if (!Object.hasOwn(pages, name)) throw Error('Unverified asset page: ' + name);
    const u = assertAccountUrl(value, binding, pages[name].path);
    entries[name] = u;
  }
  const evidence = await createExplorer(tab, binding);
  const sha = sourceProof.sha256;
  const timeoutMs = Math.min(20000, Math.max(1000, options.timeout_ms || 12000));
  const key = binding.extension_instance_id + ':' + tab.id;
  const text = value => tab.playwright.getByText(value, { exact: true }).filter({ visible: true });
  const button = value => tab.playwright.getByRole('button', { name: value, exact: true }).filter({ visible: true });
  const drawer = () => tab.playwright.locator('.oc-drawer-body-wrap').filter({ visible: true });
  
  const modeButton = value => tab.playwright.locator('.data-drawer-tabs .ovui-tabs__tab-btn')
    .filter({ has: tab.playwright.getByText(value, { exact: true }), visible: true });
  let activePath = null;
  const detail = extra => ({ flow_script: 'work/browser-actions/scripts/asset-workflows.mjs', flow_script_sha256: sha, source_manifest: sourceProof.sources, expected_path: activePath, ...extra });
  const save = (id, name, status, fields = {}, dom = null) => evidence.save(id, name, status, detail(fields), 'materials', tab, dom);
  const action = (id, name, fn, verify, fields = {}) => evidence.action(id, name, fn, verify, detail(fields), 'materials');
  async function unique(locator) {
    if (await locator.count() !== 1) throw Error('Expected one visible asset control');
    return locator;
  }
  const dates = () => readWithRecovery(() => tab.playwright.getByRole('textbox', { name: /^(开始日期|结束日期)$/ }).evaluateAll(es => es.map(e => e.value)));
  let seq = 0;
  async function panelReady(expectedMode) {
    const modes = await readWithRecovery(() => tab.playwright.locator('.data-drawer-tabs .ovui-tabs__tab--active').allTextContents({ timeoutMs }));
    if (modes.length !== 1 || modes[0].trim() !== expectedMode) throw Error('Image data mode changed before read');
    const loaders = drawer().getByText(/^(?:数据)?加载中(?:\.{3}|…)?$/).filter({ visible: true });
    for (const loader of await readWithRecovery(() => loaders.all()))
      await readWithRecovery(() => loader.waitFor({ state: 'hidden', timeoutMs }));
    if (await readWithRecovery(() => loaders.count())) throw Error('Image metrics still loading; values not verified');
    await evidence.identity();
  }

  async function open(name) {
    const entry = entries[name];
    if (!entry) throw Error('Missing observed entry URL for ' + name);
    await evidence.identity();
    await ensureNoOpenForm(tab);
    const current = new URL(await readWithRecovery(() => tab.url()));
    const same = current.origin === entry.origin && current.pathname === entry.pathname && current.searchParams.getAll('aavid').length === 1 && current.searchParams.get('aavid') === binding.advertiser_id;
    if (!same || options.refresh === true) {
      let navError = null;
      try { if (same) await tab.reload(); else await tab.goto(entry.href); } catch (e) { navError = String(e); }
      await save('tools.' + name + '.direct', name + '直达', 'opened', { locator: same ? 'tab.reload' : 'tab.goto(observed entry_url)', navigation_error: navError, ui_clicks: 0 });
    }
    await evidence.identity();
    const destination = new URL(await readWithRecovery(() => tab.url()));
    if (destination.pathname !== entry.pathname) throw Error('Asset destination route mismatch');
    activePath = entry.pathname;
    if (name === 'image' || name === 'post' || name === 'tag') {
      await readWithRecovery(() => tab.playwright.getByRole('columnheader', { name: pages[name].label, exact: true }).waitFor({ state: 'visible', timeoutMs }));
    } else {
      await readWithRecovery(() => button('热度飙升').waitFor({ state: 'visible', timeoutMs }));
      
      await readWithRecovery(() => tab.playwright.getByRole('textbox', { name: '请输入视频标题搜索', exact: true }).waitFor({ state: 'visible', timeoutMs }));
    }
    let dom = await readWithRecovery(() => tab.playwright.domSnapshot());
    if ((name === 'creative_rank' || name === 'content_rank') && await button('我再想想').count() === 1) {
      await save('tools.' + name + '.agreement.preview', '榜单自动协议预览', 'opened', { agreement_accepted: false, data_access_verified: false }, dom);
      await action('tools.' + name + '.agreement.dismiss', '关闭榜单协议预览', async () => (await unique(button('我再想想'))).click({ timeoutMs }), async () => await button('同意').count() === 0, { locator: 'button 我再想想 exact', agreement_accepted: false });
      dom = await readWithRecovery(() => tab.playwright.domSnapshot());
    }
    const agreementGate = dom.includes('签署协议') || dom.includes('无法查看榜单');
    await save('tools.' + name + '.layout', pages[name].label + '布局读取', 'read_verified', {
      verified_scope: 'controls_and_headers_only', dates: await dates(), agreement_gate: agreementGate, agreement_accepted: false,
      dataset_completeness: agreementGate ? 'not_accessible' : 'unknown', business_rows_verified: false,
      table_state: /generic: (?:数据)?加载中/.test(dom) ? 'loading' : dom.includes('暂无数据') ? 'current_visible_empty' : 'content_not_sampled',
      raw_ui: dom, source_at: null, formal_fresh_sample: false,
    }, dom);
    return { agreement_gate: agreementGate, data_access_verified: false };
  }

  async function imageDetail(materialId) {
    if (typeof materialId !== 'string' || !/^\d+$/.test(materialId)) throw Error('Explicit image material ID string required');
    const row = tab.playwright.getByRole('row').filter({ hasText: idTextPattern(materialId), visible: true });
    const trigger = row.getByText('数据', { exact: true }).filter({ visible: true });
    await row.waitFor({ state: 'visible', timeoutMs });
    await unique(row);
    await action('tools.image.detail.open', '打开指定图片数据', async () => {
      await (await unique(trigger)).click({ timeoutMs });
      await drawer().getByText('全域投放数据', { exact: true }).waitFor({ state: 'visible', timeoutMs });
    }, async () => await drawer().count() === 1 && (await drawer().innerText()).includes('标准投放+品牌投放数据'), { material_id: materialId, locator: 'row exact material ID → 数据', verified_scope: 'panel_and_mode_tabs_only' });
    const mode = await tab.playwright.locator('.data-drawer-tabs .ovui-tabs__tab--active').allTextContents({ timeoutMs });
    if (mode.length !== 1) throw Error('Image data mode is not uniquely selected');
    if (mode[0].trim() !== '全域投放数据') {
      await action('tools.image.whole.open', '切换图片全域数据', async () => {
        await (await unique(modeButton('全域投放数据'))).click({ timeoutMs });
        await readWithRecovery(() => drawer().getByText('用户实际支付金额(元)', { exact: true }).waitFor({ state: 'visible', timeoutMs }));
      }, async () => (await drawer().innerText()).includes('整体消耗(元)'), { locator: '全域投放数据 exact', prior_mode: mode[0], loaded_marker: '用户实际支付金额(元)' });
    } else {
      await readWithRecovery(() => drawer().getByText('用户实际支付金额(元)', { exact: true }).waitFor({ state: 'visible', timeoutMs }));
    }
    await panelReady('全域投放数据');
    await save('tools.image.whole.read', '读取图片全域数据', 'read_verified', { material_id: materialId, data_mode: '全域投放数据', visible_loading_cleared: true, business_metric_freshness: 'unverified', raw_panel: await drawer().innerText(), dates: await dates(), missing_values_preserved: true, scope: '继承图片库日期；全域口径，不解释为纯付费或利润' });
    await action('tools.image.standard.open', '切换图片标准及品牌数据', async () => {
      await (await unique(modeButton('标准投放+品牌投放数据'))).click({ timeoutMs });
      
      await readWithRecovery(() => drawer().getByText('直接成交金额(元)', { exact: true }).waitFor({ state: 'visible', timeoutMs }));
      await readWithRecovery(() => drawer().getByText('平均千次展现费用(元)', { exact: true }).waitFor({ state: 'visible', timeoutMs }));
    }, async () => (await drawer().innerText()).includes('直接成交金额(元)'), { locator: '.data-drawer-tabs .ovui-tabs__tab-btn containing exact 标准投放+品牌投放数据', loaded_markers: ['直接成交金额(元)', '平均千次展现费用(元)'] });
    await panelReady('标准投放+品牌投放数据');
    await save('tools.image.standard.read', '读取图片标准及品牌数据', 'read_verified', { material_id: materialId, data_mode: '标准投放+品牌投放数据', visible_loading_cleared: true, business_metric_freshness: 'unverified', raw_panel: await drawer().innerText(), missing_values_preserved: true, note: '--为缺值，不补零；不与全域数据混算' });
    await action('tools.image.compare.expand', '展开图片数据对比', async () => (await unique(text('展开对比'))).click({ timeoutMs }), async () => await text('收起对比').count() === 1, { locator: '展开对比 exact', verified_scope: 'expanded_state_only' });
    await action('tools.image.compare.collapse', '收起图片数据对比', async () => (await unique(text('收起对比'))).click({ timeoutMs }), async () => await text('展开对比').count() === 1, { locator: '收起对比 exact', verified_scope: 'collapsed_state_only' });
    const close = tab.playwright.locator('.oc-drawer-close').filter({ visible: true });
    await action('tools.image.detail.close', '关闭图片数据面板', async () => {
      await (await unique(close)).click({ timeoutMs });
      await drawer().waitFor({ state: 'hidden', timeoutMs });
    }, async () => await drawer().count() === 0, { locator: 'visible .oc-drawer-close' });
  }

  async function tagPreview() {
    const input = tab.playwright.getByRole('textbox', { name: '请输入', exact: true }).filter({ visible: true });
    await action('tools.tag.create.preview', '预览新建标签表单', async () => {
      await (await unique(button('新建标签'))).click({ timeoutMs });
      await input.waitFor({ state: 'visible', timeoutMs });
    }, async () => await input.count() === 1 && !await button('确定').isEnabled(), { locator: 'button 新建标签 exact', fields_filled: false, submitted: false });
    const initialFingerprint = await formFingerprint(tab);
    if (await input.evaluate(el => el.value) !== '') throw Error('Tag form is not empty; preserve page');
    await action('tools.tag.create.cancel', '取消新建标签', async () => {
      await unchangedForm(tab, initialFingerprint);
      if (await input.evaluate(el => el.value) !== '') throw Error('Tag changed; cancellation stopped');
      await (await unique(button('取消'))).click({ timeoutMs });
      await input.waitFor({ state: 'hidden', timeoutMs });
    }, async () => await input.count() === 0, { locator: 'button 取消 exact', submitted: false });
  }

  async function run(name, args = {}) {
    if (!assetActions.includes(name)) throw Error('Unsupported asset action');
    if (active.has(key)) throw Error('Tab already running asset script');
    active.add(key);
    const start = Date.now(), first = evidence.records.length, resultNumber = ++seq;
    let result;
    try {
      const page = name === 'image_detail' ? 'image' : name === 'post_layout' ? 'post' : name === 'tag_preview' ? 'tag' : name === 'creative_rank_layout' ? 'creative_rank' : 'content_rank';
      const state = await open(page);
      if (name === 'image_detail') await imageDetail(args.material_id);
      if (name === 'tag_preview') await tagPreview();
      result = { ok: true, action: name, verified_scope: name === 'image_detail' ? 'explicit_image_panel_and_controls' : name === 'tag_preview' ? 'form_preview_and_cancel' : 'layout_only', ...state, data_access_verified: name === 'image_detail', screenshot: await evidence.snapshot('asset-result-' + resultNumber + '.png') };
    } catch (e) {
      await save('tools.asset.' + name + '.failed', '素材复合脚本失败留痕', 'attempt_failed', { error: String(e) });
      result = { ok: false, action: name, error: String(e) };
    } finally { active.delete(key); }
    result = redact({ ...result, run_dir: evidence.run_dir, binding, elapsed_ms: Date.now() - start, script_sha256: sha, evidence: evidence.records.slice(first), page: await observedUrl(tab), advertising_writes: 0, agreement_accepted: false, formal_fresh_sample: false, source_at: null });
    const file = path.join(evidence.run_dir, 'asset-result-' + resultNumber + '.json');
    await fs.writeFile(file, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    const back = JSON.parse(await fs.readFile(file, 'utf8'));
    if (back.script_sha256 !== sha || back.ok !== result.ok) throw Error('Asset result readback failed');
    return { ...back, result_file: file };
  }
  return guardRunner([tab], { run, run_dir: evidence.run_dir, script_sha256: sha }, sourceProof);
}
