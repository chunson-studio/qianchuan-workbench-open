

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { accountBinding, immutable, captureSource, guardRunner, accountIdentity, ensureNoOpenForm, updateActionCatalog, observedUrl, formFingerprint, unchangedForm } from './browser-runtime.mjs';
import { assertAccountUrl, redact, safeUrl } from './browser-readiness.mjs';
const sourceProof = await captureSource(import.meta.url);
const sourceFile = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(sourceFile), '../..');
const catalogFile = path.join(root, 'work/browser-actions/data-and-dashboard.json');
const busy = new Set();
const scopes = { account: '账户整体消耗(元)', overall: '乘方计划消耗(元)', standard: '标准投放消耗(元)', full: '全域投放消耗(元)', brand: '品牌投放消耗(元)' };
const presets = ['今天', '昨天', '最近3天', '最近7天', '最近30天', '上周', '本月', '上月'];
const targets = ['全部', '推商品', '推直播间'];
const sections = ['乘方期间数据', '全域期间数据'];
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const rel = p => path.relative(root, p).replaceAll('\\', '/');
const now = () => new Date().toISOString();

export function homeUrl(binding) {
  validateBinding(binding);
  if (!binding.home_entry_url) throw Error('首页直达需提供已验证的完整 home_entry_url；本轮省略 x_tt_random 的地址曾空白');
  const u = new URL(binding.home_entry_url);
  assertAccountUrl(u.href, binding, '/home');
  return u.href;
}
function validateBinding(b) {
  if (!b || typeof b.advertiser_id !== 'string' || !/^\d+$/.test(b.advertiser_id) || !b.advertiser_name?.trim()) throw Error('必须显式绑定广告主 ID 和名称');
  for (const key of ['date_start', 'date_end']) if (!/^\d{4}-\d{2}-\d{2}$/.test(b[key] || '')) throw Error('必须显式提供预期日期 ' + key);
  for (const key of ['date_start', 'date_end']) {
    const date = new Date(b[key] + 'T00:00:00Z');
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== b[key]) throw Error('日期不存在：' + key);
  }
  if (b.date_start > b.date_end) throw Error('日期范围倒置');
}

export async function createHomeRunner(tab, binding, options = {}) {
  validateBinding(binding);
  const b = accountBinding(binding);
  options = immutable(options);
  const timeout = Math.min(20000, Math.max(1000, options.timeout_ms || 15000));
  const runDir = await fs.mkdtemp(path.join(root, 'work/browser-actions/runs/home-script-'));
  const scriptSha = sourceProof.sha256;
  const lockKey = (options.browser_id || '') + ':' + tab.id;
  let seq = 0, runSequence = 0;
  const records = [];
  const navigationRecoveries = [];
  const pw = () => tab.playwright;
  const button = name => pw().getByRole('button', { name, exact: typeof name === 'string' }).filter({ visible: true });
  const text = name => pw().getByText(name, { exact: true }).filter({ visible: true });

  async function readAgain(fn, stage) {
    const deadline = Date.now() + timeout;
    for (let attempt = 0; ; attempt++) {
      try { return await fn(); }
      catch (error) {
        if (!String(error).includes('Detached while handling command') || attempt >= 2 || Date.now() >= deadline) throw error;
        navigationRecoveries.push({ at: now(), stage, outcome: '页面切换中读取脱离；有限次重读，不重复页面动作' });
      }
    }
  }

  async function waitDOM(check, label, targetTab = tab) {
    const started = Date.now();
    let dom = '';
    let transientErrors = 0, observations = 0;
    do {
      if (++observations > 20) throw Error('Bounded observation limit: ' + label);
      try { dom = await targetTab.playwright.domSnapshot(); }
      catch (e) {
        if (!String(e).includes('Detached while handling command') || ++transientErrors > 3) throw e;
        navigationRecoveries.push({ at: now(), stage: label, outcome: '导航切换中的 DOM 脱离；仅重新读取，不重复点击' });
        continue;
      }
      if (check(dom)) return dom;
      
    } while (Date.now() - started < timeout);
    throw Error('等待失败：' + label);
  }
  const loaded = d => Boolean(d.trim()) && !/(?:status|generic)[^\n]*(?:指标和趋势加载中|趋势加载中|数据加载中|加载中)|aria-busy=["']?true/.test(d);
  async function navigate(url) {
    try { if (url) await tab.goto(url); else await tab.reload(); }
    catch (e) {
      if (!String(e).includes('Detached while handling command')) throw e;
      const actual = new URL(await readAgain(() => tab.url(), '导航后地址'));
      const wanted = url ? new URL(url) : actual;
      if (actual.hostname !== wanted.hostname || actual.pathname !== wanted.pathname || actual.searchParams.get('aavid') !== b.advertiser_id) throw e;
      navigationRecoveries.push({ at: now(), stage: url ? 'goto' : 'reload', outcome: '已到目标地址；重新等待读取，不再次导航' });
    }
  }
  async function clickVerified(loc, verify, stage) {
    try { await loc.click(); }
    catch (e) {
      if (!/Timed out.*CDP command Input\.dispatchMouseEvent/s.test(String(e)) && !String(e).includes('Detached while handling command')) throw e;
      const deadline = Date.now() + timeout;
      do {
        const dom = await waitDOM(() => true, '点击后状态');
        if (await readAgain(() => verify(dom), '点击后选中状态')) {
          navigationRecoveries.push({ at: now(), stage, outcome: '点击响应中断；新页面状态已证实动作完成，未重复点击' });
          return;
        }
      } while (Date.now() < deadline);
      throw e;
    }
  }
  async function settle() {
    await waitDOM(loaded, '指标或趋势加载完成');
    return await waitDOM(loaded, '读取前确认加载完成');
  }
  async function identity(t = tab) { return accountIdentity(t, b); }
  async function dates(t = tab, startName = '开始日期', endName = '结束日期') {
    return await Promise.all([startName, endName].map(name => readAgain(() => t.playwright.getByRole('textbox', { name, exact: true }).evaluate(e => e.value), '日期 ' + name)));
  }
  async function expectDates(t = tab, startName, endName, wanted = [b.date_start, b.date_end]) {
    const actual = await dates(t, startName, endName);
    if (actual[0] !== wanted[0] || actual[1] !== wanted[1]) throw Error('页面日期不符：' + actual.join(' ~ ') + '；预期 ' + wanted.join(' ~ '));
    return actual;
  }
  async function record(id, status, detail = {}, targetTab = tab) {
    const stem = String(++seq).padStart(3, '0') + '-' + id;
    const domPath = path.join(runDir, stem + '.dom.txt');
    const recPath = path.join(runDir, stem + '.json');
    let dom = '';
    try { dom = await waitDOM(() => true, '保存动作证据', targetTab); } catch (e) { if (status !== 'attempt_failed') throw e; detail = { ...detail, observation_error: String(e) }; }
    await fs.writeFile(domPath, redact(dom), { flag: 'wx' });
    const rec = { id: 'qianchuan.home.' + id, channel: 'codex-cua', name: id, page: await observedUrl(targetTab), entry: '显式账户首页复用脚本', locator: detail.locator || '已验证的页面地址、role/name 控件；见脚本', status, binding: redact(b), observed_at: now(), source_at: null, formal_fresh_sample: false, script: rel(sourceFile), script_sha256: scriptSha, source_manifest: sourceProof.sources, success_evidence: { ...redact(detail), dom_file: rel(domPath) }, exit: '调用下一已验证只读动作', constraints: ['页面与脚本学习样本，不标为正式实时数据', '只读入口和临时筛选；广告写入次数 0', '缺失或 -- 字段保留原值，不填零'], sources: [rel(recPath), rel(domPath)] };
    await fs.writeFile(recPath, JSON.stringify(rec, null, 2) + '\n', { flag: 'wx' });
    const rb = JSON.parse(await fs.readFile(recPath, 'utf8'));
    if (rb.status !== status || rb.script_sha256 !== scriptSha) throw Error('动作证据回读失败');
    await updateActionCatalog(catalogFile, rec);
    records.push({ id: rb.id, status, file: recPath });
    return rb;
  }
  async function step(id, fn, targetTab = tab) {
    try { if (id !== 'open') await identity(targetTab); const detail = await fn(); await identity(targetTab); await record(id, 'read_verified', detail || {}, targetTab); return detail; }
    catch (error) { await record(id, 'attempt_failed', { error: String(error) }, targetTab); throw error; }
  }
  async function openHome() {
    const current = new URL(await readAgain(() => tab.url(), '首页当前地址') || 'about:blank');
    if (current.hostname !== 'qianchuan.jinritemai.com' || current.pathname !== '/home' || current.searchParams.get('aavid') !== b.advertiser_id) {
      await navigate(homeUrl(b));
    }
    await waitDOM(d => d.includes('heading "数据概览"'), '首页数据概览');
    await identity();
    return { direct_url: homeUrl(b), navigation_clicks: 0 };
  }
  async function prepareHome() {
    await step('open', openHome);
    await step('refresh', async () => {
      const refresh_started_at = now();
      await navigate();
      await waitDOM(d => d.includes('heading "数据概览"') && loaded(d) && d.includes('账户整体消耗(元)'), '刷新后首页加载');
      return { refresh_started_at, refresh_completed_at: now(), platform_updated_at_raw: (await waitDOM(() => true, '页眉更新时间')).match(/更新于：[^\n]+/g) || [] };
    });
  }
  async function scope(key) {
    if (!Object.hasOwn(scopes, key)) throw Error('不支持的消耗分区');
    return await step('scope_' + key, async () => {
      const loc = button(new RegExp('^' + esc(scopes[key]) + ' '));
      if (await readAgain(() => loc.getAttribute('aria-pressed'), '消耗选中状态') !== 'true') {
        await clickVerified(loc, async () => await loc.getAttribute('aria-pressed') === 'true', 'scope_' + key);
      }
      await settle();
      if (await readAgain(() => loc.getAttribute('aria-pressed'), '消耗选中回读') !== 'true') throw Error('消耗分区没有选中');
      return { scope: key, scope_label: scopes[key], selected: true, locator: 'button name /^' + esc(scopes[key]) + ' /' };
    });
  }
  async function readHome(args) {
    if (!Object.hasOwn(scopes, args.scope || 'overall') || !targets.includes(args.target || '全部') || (args.section && !sections.includes(args.section)) || (args.date_preset && !presets.includes(args.date_preset))) throw Error('不支持的首页参数');
    if (args.section && (args.scope || 'overall') !== 'overall') throw Error('分区选择仅封装乘方页面');
    await prepareHome();
    if (args.date_preset) {
      await step('date_menu', async () => { await clickVerified(pw().getByRole('textbox', { name: '开始日期', exact: true }), d => d.includes('listitem: 最近7天'), 'date_menu'); await waitDOM(d => d.includes('listitem: 最近7天'), '日期快捷菜单'); return { locator: 'textbox(开始日期)' }; });
      await step('date_select', async () => { await clickVerified(text(args.date_preset), async d => !d.includes('listitem: 最近7天') && (await dates()).join(',') === [b.date_start, b.date_end].join(','), 'date_select'); await waitDOM(d => !d.includes('listitem: 最近7天'), '日期菜单关闭'); await settle(); return { preset: args.date_preset, dates: await expectDates(), locator: 'getByText(' + args.date_preset + ', exact).filter(visible)' }; });
    } else await step('date_verify', async () => ({ dates: await expectDates() }));
    await scope(args.scope || 'overall');
    if ((args.scope || 'overall') !== 'account') {
      await step('filter_target', async () => {
        const label = args.target || '全部';
        const loc = pw().getByRole('tab', { name: label, exact: true });
        if (await readAgain(() => loc.getAttribute('aria-selected'), '目标选中状态') !== 'true') await clickVerified(loc, async () => await loc.getAttribute('aria-selected') === 'true', 'filter_target');
        await settle();
        if (await readAgain(() => loc.getAttribute('aria-selected'), '目标选中回读') !== 'true') throw Error('商品或直播间筛选未选中');
        return { target: label, selected: true, locator: 'tab(' + label + ')' };
      });
    }
    if (args.section) {
      if ((args.scope || 'overall') !== 'overall') throw Error('分区选择仅封装乘方页面');
      await step('section_menu', async () => { await clickVerified(pw().getByRole('combobox', { name: '乘方分区选择', exact: true }), d => d.includes('listbox:'), 'section_menu'); await waitDOM(d => d.includes('listbox:'), '分区菜单'); return { locator: 'combobox(乘方分区选择)' }; });
      await step('section_select', async () => {
        await clickVerified(text(args.section), d => d.includes('generic: ' + args.section) && !d.includes('listbox:'), 'section_select'); await settle();
        if (!(await waitDOM(() => true, '分区标签回读')).includes('generic: ' + args.section)) throw Error('分区标签不符');
        return { section: args.section, locator: 'getByText(' + args.section + ', exact).filter(visible)' };
      });
    }
    return await step('read_metrics', async () => {
      await settle(); await expectDates();
      const costCards = await readAgain(() => pw().getByRole('button', { name: /^(账户整体|乘方计划|标准投放|全域投放|品牌投放)消耗\(元\) / }).evaluateAll(es => es.map(e => ({ raw: e.innerText, selected: e.getAttribute('aria-pressed') === 'true' }))), '首页消耗卡片');
      const personalOnly = await readAgain(() => pw().getByRole('checkbox', { name: '仅看个人数据', exact: true }).evaluate(e => e.checked), '个人数据筛选');
      const dom = await waitDOM(() => true, '首页指标读取');
      const sectionDom = dom.split('generic "趋势内容区"')[1]?.split('heading "更多投放机会"')[0];
      if (costCards.length !== 5 || !sectionDom) throw Error('首页字段缺失');
      const selectedCard = costCards.find(x => x.selected)?.raw;
      if (!selectedCard?.startsWith(scopes[args.scope || 'overall'])) throw Error('页面最终消耗分区与请求不符，停止混用数据');
      return { dates: await expectDates(), personal_only: personalOnly, requested: args, cost_cards: costCards, trend_and_metrics_raw: sectionDom, collected_at: now(), platform_updated_at_raw: dom.match(/更新于：[^\n]+/g) || [], scope_note: '广告主首页聚合；乘方与全域期间、商品与直播间分别解释；非单条计划或场次' };
    });
  }
  async function previewMetrics() {
    await prepareHome(); await scope('overall');
    const detail = await step('custom_preview', async () => { await clickVerified(button('自定义数据'), d => d.includes('dialog "自定义数据"'), 'custom_preview'); const dom = await waitDOM(d => d.includes('dialog "自定义数据"') && d.includes('checkbox "整体成交金额"'), '自定义指标完整面板'); return { preview_only: true, panel_raw: dom.split('- dialog "自定义数据"')[1], locator: 'button(自定义数据)' }; });
    const metricFingerprint = await formFingerprint(tab);
    await step('custom_cancel', async () => { await unchangedForm(tab, metricFingerprint); await clickVerified(pw().getByRole('dialog', { name: '自定义数据', exact: true }).getByRole('button', { name: '取消', exact: true }), d => !d.includes('dialog "自定义数据"'), 'custom_cancel'); await waitDOM(d => !d.includes('dialog "自定义数据"'), '取消后面板关闭'); return { submitted: false, locator: 'dialog(自定义数据).button(取消)' }; });
    return detail;
  }
  async function readOverallData() {
    return await step('data_direct', async () => {
      const url = new URL('https://qianchuan.jinritemai.com/dataV2/overall-promotion'); url.searchParams.set('aavid', b.advertiser_id);
      const current = new URL(await readAgain(() => tab.url(), '数据页当前地址') || 'about:blank');
      if (current.pathname !== url.pathname || current.searchParams.get('aavid') !== b.advertiser_id) await navigate(url.href);
      else await navigate();
      await waitDOM(d => loaded(d) && d.includes('重点数据概览') && d.includes('columnheader "综合营销ROI"') && d.includes('共 '), '乘方数据表格');
      const actualDates = await expectDates();
      const views = await readAgain(() => pw().getByRole('textbox', { name: '请选择', exact: true }).evaluateAll(es => es.map(e => e.value)), '数据页统计口径');
      if (!views.includes('乘方数据-直播') || !views.includes('乘方期间数据')) throw Error('乘方数据页统计口径与已验证页面不符');
      return { direct_url: url.href, dates: actualDates, views, headers: await readAgain(() => pw().getByRole('columnheader').allTextContents({ timeoutMs: timeout }), '数据表头'), rows_raw: await readAgain(() => pw().getByRole('row').allTextContents({ timeoutMs: timeout }), '数据表行'), collected_at: now(), navigation_clicks: 0, scope_note: '广告主汇总乘方数据，不是单条计划或直播场次' };
    });
  }
  async function run(action, args = {}) {
    if (busy.has(lockKey)) throw Error('同一标签页正在执行脚本');
    busy.add(lockKey);
    const startedAt = now(); const started = Date.now(); const resultNumber = ++runSequence;
    const firstRecord = records.length;
    let output;
    try {
      await ensureNoOpenForm(tab);
      const initialUrl = await tab.url();
      if (initialUrl !== 'about:blank' && !initialUrl.startsWith('chrome://newtab')) await identity();
      let result;
      if (action === 'home') result = await readHome(args);
      else if (action === 'preview_metrics') result = await previewMetrics();
      else if (action === 'overall_data') result = await readOverallData();
      else if (action === 'open') result = await step('open', openHome);
      else throw Error('不支持的动作：' + action);
      const screenshot = path.join(runDir, 'result-' + resultNumber + '.png');
      await fs.writeFile(screenshot, await readAgain(() => tab.screenshot({ fullPage: false }), '结果截图'), { flag: 'wx' });
      output = { ok: true, action, result, screenshot };
    } catch (e) { output = { ok: false, action, error: String(e) }; }
    finally { busy.delete(lockKey); }
    output = redact({ ...output, binding: b, started_at: startedAt, completed_at: now(), elapsed_ms: Date.now() - started, script_sha256: scriptSha, evidence: records.slice(firstRecord), navigation_recoveries: [...navigationRecoveries], advertising_writes: 0, formal_fresh_sample: false, run_dir: runDir });
    const resultFile = path.join(runDir, 'result-' + resultNumber + '.json');
    await fs.writeFile(resultFile, JSON.stringify(output, null, 2) + '\n', { flag: 'wx' });
    return { ...JSON.parse(await fs.readFile(resultFile, 'utf8')), result_file: resultFile };
  }
  return guardRunner([tab], { run, run_dir: runDir, script_sha256: scriptSha }, sourceProof);
}
