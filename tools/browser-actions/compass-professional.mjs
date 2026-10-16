

import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { immutable, captureSource, guardRunner, ensureNoOpenForm, updateActionCatalog, observedUrl, formFingerprint, unchangedForm } from './browser-runtime.mjs';
import { redact } from './browser-readiness.mjs';
const sourceProof = await captureSource(import.meta.url);
const scriptFile = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptFile), '../..');
const actionRoot = path.join(projectRoot, 'work/browser-actions');
const activeTabs = new Set();

export const actions = Object.freeze({
  traffic_analysis: '流量分析',
  short_videos: '引流短视频',
  traffic_diagnosis: '流量诊断',
  anchor_analysis: '主播分析',
  violations: '违规情况',
  products: '商品列表',
  product_detail: '商品详情',
  product_columns_preview: '查看商品列配置并取消',
  crowd: '全场累计用户画像',
  qianchuan_entry: '千川入口',
});

function binding(cfg) {
  if (!cfg || ['room_id', 'live_app_id'].some(k => typeof cfg[k] !== 'string' || !/^\d+$/.test(cfg[k]))
    || typeof cfg.room_name !== 'string' || !cfg.room_name.trim()
    || typeof cfg.session_started_minute !== 'string' || !/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/.test(cfg.session_started_minute)) {
    throw new Error('explicit_room_name_id_app_and_session_required');
  }
  return { room_id: cfg.room_id, live_app_id: cfg.live_app_id, room_name: cfg.room_name,
    session_started_minute: cfg.session_started_minute, sample_kind: cfg.sample_kind || 'unclassified_ui_read' };
}

export function professionalUrl(cfg) {
  const b = binding(cfg);
  const url = new URL('https://compass.jinritemai.com/screen/live/shop');
  url.searchParams.set('live_room_id', b.room_id);
  url.searchParams.set('live_app_id', b.live_app_id);
  return url.href;
}


export async function createCompassRunner(tab, cfg, options = {}) {
  const expected = immutable(binding(cfg));
  options = immutable(options);
  if (!tab?.playwright || typeof tab.url !== 'function') throw new Error('codex_cua_tab_required');
  const runRoot = path.join(actionRoot, 'runs');
  await fs.mkdir(runRoot, { recursive: true });
  const runDir = await fs.mkdtemp(path.join(runRoot, 'compass-script-'));
  const sha = sourceProof.sha256;
  let sequence = 0, resultSequence = 0;
  let refreshStarted = null, refreshCompleted = null;
  const timeoutMs = Math.min(30000, Math.max(1000, options.timeout_ms || 20000));
  const key = (options.browser_id || 'cua') + ':' + tab.id;
  const text = (name, exact = true) => tab.playwright.getByText(name, { exact }).filter({ visible: true });
  const wait = async (name, exact = true) => {
    const locator = text(name, exact);
    await locator.waitFor({ state: 'visible', timeoutMs });
    if (await locator.count() !== 1) throw new Error('visible_locator_ambiguous:' + name);
    return locator;
  };
  const click = async name => { const locator = await wait(name); await locator.click({ timeoutMs }); };
  const idCheck = async () => {
    const url = new URL(await tab.url());
    if (url.origin !== 'https://compass.jinritemai.com' || url.username || url.password || url.pathname !== '/screen/live/shop'
      || url.searchParams.getAll('live_room_id').length !== 1 || url.searchParams.get('live_room_id') !== expected.room_id
      || url.searchParams.getAll('live_app_id').length !== 1 || url.searchParams.get('live_app_id') !== expected.live_app_id) {
      throw new Error('room_url_binding_mismatch');
    }
    await wait('专业版');
    await wait(expected.room_name);
    await wait(expected.session_started_minute, false);
    const dom = await tab.playwright.domSnapshot();
    if (!dom.includes(expected.room_name) || !dom.includes(expected.session_started_minute)) throw new Error('visible_session_mismatch');
    return dom;
  };
  const record = async (id, name, locator, status, evidence, dom, started) => {
    const event = { channel: 'codex-cua', id: 'compass.professional.' + id, name,
      page: await observedUrl(tab), entry: professionalUrl(expected), locator, status,
      binding: expected, script: path.relative(projectRoot, scriptFile).replaceAll(path.sep, '/'),
      script_sha256: sha, source_manifest: sourceProof.sources, success_evidence: redact(evidence), exit: '同场页面读取',
      constraints: ['explicit room and session required', 'visible UI only', 'no advertising submissions'],
      observed_at: new Date().toISOString(), source_at: null,
      refresh_started_at: refreshStarted, refresh_completed_at: refreshCompleted,
      formal_fresh_sample: false, advertising_writes: 0, elapsed_ms: Date.now() - started };
    const stem = String(++sequence).padStart(2, '0') + '-' + id;
    const domFile = path.join(runDir, stem + '-dom.txt');
    const eventFile = path.join(runDir, stem + '.json');
    await fs.writeFile(domFile, redact(dom || ''), { flag: 'wx' });
    event.sources = [path.relative(projectRoot, domFile).replaceAll(path.sep, '/')];
    await fs.writeFile(eventFile, JSON.stringify(event, null, 2) + '\n', { flag: 'wx' });
    const reread = JSON.parse(await fs.readFile(eventFile, 'utf8'));
    if (reread.id !== event.id || reread.status !== status) throw new Error('step_evidence_readback_failed');
    event.sources.push(path.relative(projectRoot, eventFile).replaceAll(path.sep, '/'));
    await updateActionCatalog(path.join(actionRoot, 'compass-and-traffic.json'), event);
    return event;
  };
  const step = async (id, name, locator, perform, verify = async () => ({})) => {
    const started = Date.now();
    try {
      if (id !== 'direct_url' && id !== 'identity.verify') await idCheck();
      await perform();
      const evidence = await verify();
      const dom = await idCheck();
      return await record(id, name, locator, 'read_verified', evidence, dom, started);
    } catch (error) {
      let dom = '';
      try { dom = await tab.playwright.domSnapshot(); } catch {}
      await record(id, name, locator, 'attempt_failed', { error: String(error.message) }, dom, started);
      throw error;
    }
  };
  const productList = async () => step('product.open', '打开商品列表', 'a[href="#product"]',
    async () => { await tab.playwright.locator('a[href="#product"]').click({ timeoutMs }); await wait('全部商品'); },
    async () => {
      await tab.playwright.getByRole('columnheader', { name: /累计用户支付金额/ }).waitFor({ state: 'visible', timeoutMs });
      return { raw_rows: await tab.playwright.getByRole('row').filter({ visible: true }).allTextContents({ timeoutMs }), coverage: 'visible_current_table' };
    });
  const panel = async (name, marker, { repeated_marker = false } = {}) => step(name, actions[name], `getByText('${actions[name]}',{exact:true})`,
    async () => {
      await click(actions[name]);
      
      
      if (repeated_marker) await text(marker).first().waitFor({ state: 'visible', timeoutMs });
      else await wait(marker);
    }, async () => {
      const count = await text(marker).count();
      if (count < 1 || (!repeated_marker && count !== 1)) throw new Error('panel_marker_not_verified:' + marker);
      return { loaded_marker: marker, visible_marker_count: count };
    });

  const runAction = async (action, args) => {
    switch (action) {
      case 'traffic_analysis': return panel(action, '分钟级流量结构');
      case 'anchor_analysis': return panel(action, '以下主播按本场直播用户支付金额排序');
      case 'violations':
        
        return panel(action, '本场直播没有违规，请继续保持~');
      case 'short_videos': {
        await panel(action, '直播入口曝光次数', { repeated_marker: true });
        if (args.sort_metric) {
          if (!['直播入口曝光次数', '引流直播间次数', '直播入口点击率(次数)'].includes(args.sort_metric)) throw new Error('unverified_sort_metric');
          await step('short_video.metric_menu', '展开短视频排序', 'getByRole(combobox)',
            async () => { await tab.playwright.getByRole('combobox').click({ timeoutMs }); await wait('直播入口点击率(次数)'); },
            () => ({ menu_options: ['直播入口曝光次数', '引流直播间次数', '直播入口点击率(次数)'] }));
          return step('short_video.metric_select', '选择短视频排序', 'getByText(explicit sort_metric,{exact:true})',
            async () => { await click(args.sort_metric); },
            async () => {
              const combo = tab.playwright.getByRole('combobox');
              if (await combo.count() !== 1) throw Error('sort_control_ambiguous');
              const selected = await combo.evaluate(el => (el.value || el.textContent || '').trim());
              if (selected !== args.sort_metric) throw new Error('sort_label_not_verified');
              return { selected_metric: args.sort_metric, raw_selected_text: selected };
            });
        }
        return;
      }
      case 'traffic_diagnosis': {
        await panel(action, '看流量影响因素');
        if (args.improve || args.warning_window) {
          await step('traffic_diagnosis.improve', '查看可提升指标', "getByText('看可提升指标',{exact:true})",
            async () => { await click('看可提升指标'); await wait('可提升指标优化以下指标可提升问题渠道流量'); },
            async () => {
              const checked = await tab.playwright.getByRole('radio', { name: '看可提升指标', exact: true }).evaluate(el => typeof el.checked === 'boolean' ? el.checked : el.getAttribute('aria-checked') === 'true');
              if (!checked) throw Error('improve_radio_not_selected');
              return { checked: true };
            });
        }
        if (args.warning_window) {
          if (!/^\d{2}:\d{2}~\d{2}:\d{2}$/.test(args.warning_window)) throw new Error('explicit_visible_warning_window_required');
          await step('traffic_diagnosis.window_menu', '展开预警时间', 'getByRole(combobox)',
            async () => { await tab.playwright.getByRole('combobox').click({ timeoutMs }); await wait(args.warning_window); },
            () => ({ requested_window_raw: args.warning_window }));
          return step('traffic_diagnosis.window_select', '选择预警时间', 'getByText(explicit warning_window,{exact:true})',
            async () => { await click(args.warning_window); await wait('选择预警时间：' + args.warning_window); },
            () => ({ selected_window_raw: args.warning_window, source_timezone: 'unknown; raw label retained' }));
        }
        return;
      }
      case 'products': return productList();
      case 'product_detail': {
        if (typeof args.product_title !== 'string' || !args.product_title.trim()) throw new Error('explicit_product_title_required');
        await productList();
        return step('product.detail.open', '打开指定商品详情', 'getByRole(row).filter({hasText:product_title}).getByRole(button,{name:查看详情})',
          async () => {
            const row = tab.playwright.getByRole('row').filter({ hasText: args.product_title, visible: true });
            if (await row.count() !== 1 || await row.getByText(args.product_title, { exact: true }).count() !== 1) throw new Error('product_row_missing_or_ambiguous');
            await row.getByRole('button', { name: '查看详情', exact: true }).click({ timeoutMs });
            await wait('商品详情'); await wait('SKU数据'); await wait('讲解效果分析');
          }, () => ({ product_title: args.product_title, loaded_sections: ['商品详情', '讲解效果分析', 'SKU数据'],
            entering_scope: '讲解历史进入次数；不是实时进入人数', online_scope: '讲解平均在线；不是实时在线' }));
      }
      case 'product_columns_preview':
        await productList();
        await step('product.columns.open', '查看商品列配置', "getByRole(button,{name:'配置列表'})",
          async () => { await tab.playwright.getByRole('button', { name: '配置列表', exact: true }).click({ timeoutMs }); await wait('配置指标'); },
          () => ({ preview_only: true }));
        const columnsFingerprint = await formFingerprint(tab);
        return step('product.columns.cancel', '取消商品列配置', "getByRole(button,{name:'取消'})",
          async () => { await unchangedForm(tab, columnsFingerprint); await tab.playwright.getByRole('button', { name: '取消', exact: true }).click({ timeoutMs });
            await tab.playwright.getByText('配置指标', { exact: true }).waitFor({ state: 'hidden', timeoutMs }); },
          () => ({ configuration_submissions: 0, popup_closed: true }));
      case 'crowd': return step('crowd.open', '打开全场累计画像', 'a[href="#crowd"]',
        async () => { await tab.playwright.locator('a[href="#crowd"]').click({ timeoutMs }); await wait('全场累计用户画像'); },
        () => ({ scope: 'historical aggregate; realtime viewer and purchaser cards may be unavailable' }));
      case 'qianchuan_entry': return step('ad.open', '打开千川入口', 'a[href="#ad"]',
        async () => { await tab.playwright.locator('a[href="#ad"]').click({ timeoutMs });
          await tab.playwright.getByRole('button', { name: '立即进入', exact: true }).waitFor({ state: 'visible', timeoutMs }); },
        () => ({ entry_visible: true, board_not_opened_by_this_action: true }));
      default: throw new Error('unsupported_action:' + action);
    }
  };

  async function run(action, args = {}) {
    if (!Object.hasOwn(actions, action)) throw new Error('unsupported_action:' + action);
    if (activeTabs.has(key)) throw new Error('tab_busy');
    activeTabs.add(key);
    const started = Date.now(), resultNumber = ++resultSequence;
    refreshStarted = null; refreshCompleted = null;
    let result;
    try {
      await ensureNoOpenForm(tab);
      await step('identity.verify', '核验专业版和场次', 'URL + visible room name + raw session minute', async () => { await idCheck(); }, () => expected);
      if (options.refresh !== false) {
        refreshStarted = new Date().toISOString();
        await step('refresh', '刷新同场页面', 'tab.reload()', async () => {
          await tab.reload(); await idCheck(); refreshCompleted = new Date().toISOString();
        }, () => ({ refresh_started_at: refreshStarted, refresh_completed_at: refreshCompleted, source_at: null }));
      }
      await runAction(action, args);
      const dom = await idCheck();
      const evidenceFile = path.join(runDir, 'result-' + resultNumber + '-dom.txt');
      await fs.writeFile(evidenceFile, redact(dom), { flag: 'wx' });
      const shotFile = path.join(runDir, 'result-' + resultNumber + '.png');
      await fs.writeFile(shotFile, await tab.screenshot({ fullPage: false }), { flag: 'wx' });
      result = { ok: true, action, binding: expected, run_dir: runDir, screenshot: shotFile,
        dom_file: evidenceFile, script_sha256: sha, elapsed_ms: Date.now() - started,
        formal_fresh_sample: false, source_at: null, advertising_writes: 0 };
    } catch (error) {
      result = { ok: false, action, binding: expected, run_dir: runDir, error: String(error.message),
        elapsed_ms: Date.now() - started, formal_fresh_sample: false, advertising_writes: 0 };
    } finally { activeTabs.delete(key); }
    const resultFile = path.join(runDir, 'result-' + resultNumber + '.json');
    await fs.writeFile(resultFile, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    return JSON.parse(await fs.readFile(resultFile, 'utf8'));
  }

  async function open() {
    if (activeTabs.has(key)) throw new Error('tab_busy');
    activeTabs.add(key);
    try {
      await ensureNoOpenForm(tab);
      return await step('direct_url', '专业版直达', 'tab.goto(verified professionalUrl) + visible identity', async () => {
        let same = false;
        try { const url = new URL(await tab.url()); same = url.origin === 'https://compass.jinritemai.com'
          && url.pathname === '/screen/live/shop' && url.searchParams.get('live_room_id') === expected.room_id
          && url.searchParams.get('live_app_id') === expected.live_app_id; } catch {}
        if (!same) await tab.goto(professionalUrl(expected));
        await idCheck();
      }, () => ({ ...expected, ui_clicks: 0 }));
    } finally { activeTabs.delete(key); }
  }
  return guardRunner([tab], { open, run, run_dir: runDir, script_sha256: sha }, sourceProof);
}
