'use strict';

const { normalizeBrowserBoostCapture } = require('../../server-app/server/lib/browserBoostSnapshot.js');

// 本地 CDP 追投表读取；定位依据来自已有页面观察，不借用 CUA 的成功回执。
const PLAN_TYPES = { '/uni-prom/detail': 'quan_yu', '/overall-prom/detail': 'cheng_fang' };
const TASK_HEADERS = ['任务名称', '调控任务', '追投任务'];
const BUDGET_HEADERS = ['调控预算(元)', '调控预算（元）', '调控预算', '预算'];
const MAX_ATTEMPTS = 3;
const LOADING = /(?:^|\n)\s*(?:加载中|正在加载|Loading)[.…。]*\s*(?:$|\n)/i;
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const { OperationDeadline } = require('../../server-app/server/lib/browserBoostContract.js');
function boostTableReady() {
  const visible=el=>!!el.getClientRects().length && getComputedStyle(el).visibility!=='hidden';
  if([...document.querySelectorAll('[aria-busy="true"],[role="progressbar"]')].some(visible))return false;
  const tables=[...document.querySelectorAll('table,[role="table"]')].filter(visible).filter(t=>{
    const headers=[...t.querySelectorAll('th,[role="columnheader"]')].map(el=>el.innerText.trim());
    return headers.some(h=>['任务名称','调控任务','追投任务'].includes(h))&&headers.some(h=>['调控预算(元)','调控预算（元）','调控预算','预算'].includes(h));
  });
  return tables.length===1 && [...tables[0].querySelectorAll('tr,[role="row"]')].some(el=>visible(el)&&/(?:任务|追投)?\s*ID\s*[:：#]\s*[A-Za-z0-9_-]+/.test(el.innerText));
}
const isDate = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00.000Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

function validateBoostReadRequest(request) {
  const range = request.date_range ?? (request.date ? [request.date, request.date] : null);
  if (!Array.isArray(range) || range.length !== 2 || !range.every(isDate) || range[0] > range[1]) {
    fail('boost_read_date_required', '追投读取需要有效的 date 或起止有序的 date_range');
  }
  if (request.date != null && (!isDate(request.date) || range.some(date => date !== request.date))) {
    fail('boost_read_date_conflict', 'date 与 date_range 不一致');
  }
  if (request.plan_type != null && !Object.values(PLAN_TYPES).includes(request.plan_type)) {
    fail('boost_read_plan_type_invalid', '计划类型必须是 quan_yu 或 cheng_fang');
  }
  return range;
}

async function inspectIdentity(adapter, request, range) {
  await adapter.assertIdentity({ ...request, date_range: range });
  const url = new URL(await adapter.currentUrl());
  const planType = PLAN_TYPES[url.pathname];
  if (url.protocol !== 'https:' || url.hostname !== 'qianchuan.jinritemai.com' || !planType) {
    fail('boost_read_page_unsupported', '需要已观察过结构的千川全域或乘方计划详情页');
  }
  if (request.plan_type && request.plan_type !== planType) fail('boost_read_identity_mismatch', '计划类型不匹配');
  const unique = key => {
    const values = url.searchParams.getAll(key);
    if (values.length !== 1 || !values[0]) fail('boost_read_identity_mismatch', '页面参数缺失或重复：' + key);
    return values[0];
  };
  const dateKey = planType === 'quan_yu' ? 'dr' : 'dateRange';
  if (url.searchParams.has(dateKey === 'dr' ? 'dateRange' : 'dr')) fail('boost_read_identity_mismatch', '页面版本与日期参数冲突');
  let actualRange;
  const rawRange = unique(dateKey);
  try { actualRange = JSON.parse(rawRange); } catch { actualRange = rawRange.split(/[~,]/); }
  if (JSON.stringify(actualRange) !== JSON.stringify(range) || unique('aavid') !== request.advertiser_id || unique('adId') !== request.primary_ad_id) {
    fail('boost_read_identity_mismatch', '页面账户、主计划或日期与请求不一致');
  }
  const page = adapter.page();
  for (const text of ['ID：' + request.advertiser_id, '计划ID：' + request.primary_ad_id]) {
    const target = page.getByText(text, { exact: true });
    await target.waitFor({ state: 'visible', timeoutMs: 3000 });
    if (await target.count() !== 1) fail('boost_read_identity_mismatch', '页面身份不唯一');
  }
  const dates = await page.getByRole('textbox').evaluateAll(elements => elements
    .map(element => String(element.value || '')).filter(value => /^\d{4}-\d{2}-\d{2}$/.test(value)));
  if (JSON.stringify(dates) !== JSON.stringify(range)) fail('boost_read_identity_mismatch', '页面日期控件与请求不一致');
  return { url: url.href, plan_type: planType, date_range: range };
}

// 在页面内按表头找到所属表格，避免把旁边另一张表的行混进来。
function extractTableFromHeaders(elements) {
  const groups = new Map();
  for (const element of elements) {
    if (!element.parentElement) continue;
    if (!groups.has(element.parentElement)) groups.set(element.parentElement, []);
    groups.get(element.parentElement).push(element);
  }
  return Array.from(groups.values()).filter(group => {
    const names = group.map(element => String(element.innerText || '').trim());
    return names.some(name => ['任务名称', '调控任务', '追投任务'].includes(name))
      && names.some(name => ['调控预算(元)', '调控预算（元）', '调控预算', '预算'].includes(name));
  }).map(group => {
    const table = group[0].closest('table,[role="table"]');
    const rows = table ? Array.from(table.querySelectorAll('tr,[role="row"]'))
      .filter(row => row.closest('table,[role="table"]') === table) : [];
    return {
      headers: group.map(element => String(element.innerText || '')),
      table_found: Boolean(table), truncated: rows.length > 103,
      rows: rows.slice(0, 103).map(row => Array.from(row.cells || row.querySelectorAll('[role="cell"],[role="columnheader"]'))
        .map(cell => String(cell.innerText || ''))),
    };
  });
}

function parseBoostTable(tables) {
  if (!Array.isArray(tables) || tables.length === 0) fail('page_data_unavailable', '追投表尚未加载');
  if (tables.length !== 1) fail('boost_read_table_ambiguous', '追投表匹配不唯一');
  const table = tables[0];
  if (!table.table_found) fail('boost_read_table_unsupported', '无法确认表头所属表格');
  const headers = table.headers;
  if (table.truncated || !Array.isArray(headers) || headers.length > 128) fail('boost_read_table_limit', '追投表超过采集限制');
  const indexes = headers.map((header, index) => TASK_HEADERS.includes(header.trim()) ? index : -1).filter(index => index >= 0);
  if (indexes.length !== 1 || !headers.some(header => BUDGET_HEADERS.includes(header.trim()))) fail('boost_read_table_invalid', '任务或预算表头无法唯一核验');
  const rows = [], summaryRows = [], ids = new Set();
  let totalCount = null;
  for (const row of table.rows) {
    if (!Array.isArray(row) || row.some(cell => typeof cell !== 'string' || cell.length > 4096)) fail('boost_read_table_limit', '单元格结构或长度异常');
    if (row.every(cell => !cell.trim()) || (row.length === headers.length && row.every((cell, index) => cell.trim() === headers[index].trim()))) continue;
    const task = row[indexes[0]] || '';
    const matches = [...task.matchAll(/(?:任务|追投)\s*(?:ID|编号)\s*[:：#]?\s*([A-Za-z0-9_-]+)|\bID\s*[:：#]\s*([A-Za-z0-9_-]+)/gi)];
    const summary = row.join('\n').match(/共\s*(\d+)\s*条任务/);
    if (summary && matches.length === 0) {
      const count = Number(summary[1]);
      if (!Number.isSafeInteger(count) || (totalCount !== null && totalCount !== count)) fail('boost_read_table_invalid', '合计数量异常或不一致');
      totalCount = count; summaryRows.push(row); continue;
    }
    if (matches.length === 0 && row.some(cell => /^(?:加载中[.…。]*|正在加载[.…。]*|Loading[.…]*|暂无数据|暂无任务)$/i.test(cell.trim()))) fail('page_data_unavailable', '追投表尚未取得有效任务，不能按零处理');
    if (matches.length !== 1 || row.length !== headers.length) fail('boost_read_table_invalid', '任务 ID 或行宽无法核验');
    const id = matches[0][1] || matches[0][2];
    if (ids.has(id)) fail('boost_read_table_invalid', '任务 ID 重复');
    ids.add(id); rows.push(row);
  }
  if (!rows.length) fail('page_data_unavailable', '当前空表按未取得处理，不能用于补建任务');
  if (rows.length > 100 || (totalCount !== null && totalCount < rows.length)) fail('boost_read_table_invalid', '任务行数与合计不一致或超过限制');
  return { headers, rows, summary_rows: summaryRows, total_count: totalCount };
}

async function controls(page, planType) {
  if (planType !== 'quan_yu') return { filters: null, keyword: null };
  const filters = page.getByRole('textbox', { name: '请选择', exact: true });
  const search = page.getByRole('textbox', { name: '输入任务名称或ID搜索', exact: true });
  if (await filters.count() !== 3 || await search.count() !== 1) fail('boost_read_controls_unverified', '筛选和搜索结构未能核验');
  return { filters: await filters.evaluateAll(elements => elements.map(element => String(element.value ?? ''))), keyword: await search.inputValue() };
}

async function readBoostTable(adapter, request, options = {}) {
  const range = validateBoostReadRequest(request);
  const clock=options.clock || new OperationDeadline();
  const verified = options.onVerified || (async () => {});
  const before = await inspectIdentity(adapter, request, range);
  await verified('common.identity.verify', { identity: before }, 0);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const refresh_started_at = new Date().toISOString();
      await adapter.reload({ waitUntil: 'domcontentloaded', timeout: clock.timeout(15000) });
      const after = await inspectIdentity(adapter, request, range);
      if (JSON.stringify(before) !== JSON.stringify(after)) fail('boost_read_identity_mismatch', '刷新后页面身份变化');
      const page = adapter.page();
      try{await adapter.waitForFunction(boostTableReady,null,{timeout:clock.timeout(15000),polling:'raf'});}
      catch(error){if(error.name==='TimeoutError'||error.code==='page_data_unavailable')fail('page_data_unavailable','追投表没有就绪，不能按零处理');throw error;}
      const dom=await adapter.domSnapshot();if(!String(dom).trim()||LOADING.test(dom))fail('page_data_unavailable','追投表仍在加载');
      const first=parseBoostTable(await page.getByRole('columnheader').evaluateAll(extractTableFromHeaders));
      const firstControls = await controls(page, after.plan_type);
      const refresh_completed_at = new Date().toISOString();
      await verified('common.page.reload', { identity: after, refresh_started_at, refresh_completed_at }, attempt);
      const second = parseBoostTable(await page.getByRole('columnheader').evaluateAll(extractTableFromHeaders));
      const secondControls = await controls(page, after.plan_type);
      const finalIdentity = await inspectIdentity(adapter, request, range);
      const finalDom = await adapter.domSnapshot();
      if (JSON.stringify(after) !== JSON.stringify(finalIdentity)) fail('boost_read_identity_mismatch', '读取后页面身份变化');
      if (!String(finalDom).trim() || LOADING.test(finalDom) || JSON.stringify(first) !== JSON.stringify(second)
        || JSON.stringify(firstControls) !== JSON.stringify(secondControls)) fail('boost_read_table_changed', '读取期间表格或筛选状态变化');
      const captured_at = new Date().toISOString();
      const capture = {
        schema_version: '1.0', source: 'browser_dom',
        binding: { account_id: request.account_id, advertiser_id: request.advertiser_id, primary_ad_id: request.primary_ad_id },
        page: { ...finalIdentity, advertiser_id: request.advertiser_id, primary_ad_id: request.primary_ad_id,
          metric_applicability: { comprehensive_roi: after.plan_type === 'cheng_fang' ? 'applicable' : 'not_applicable' },
          ...secondControls, status_filter: secondControls.filters?.[2] || null,
          updated_at_label: String(finalDom).match(/\d{2}-\d{2}\s+\d{2}:\d{2}\s*更新/)?.[0] ?? null,
          ...second, coverage: { scope: 'current_page_only', page_number: null, page_size: null } },
        timing: { refresh_started_at, refresh_completed_at, captured_at },
      };
      if (Buffer.byteLength(JSON.stringify(capture)) > 256 * 1024) fail('boost_read_table_limit', '采集结果超过 256 KiB');
      // 复用服务端契约验收必需列、单位与 ID；这里只校验，不写账本。
      normalizeBrowserBoostCapture(capture, { now: new Date(captured_at) });
      await verified('common.table.read_headers_and_row', { capture }, attempt);
      return { capture, attempts: attempt };
    } catch (error) {
      if (options.onAttemptFailed) await options.onAttemptFailed({ attempt, code: error.code || 'boost_read_failed' });
      if (!['page_data_unavailable', 'boost_read_table_changed'].includes(error.code) || attempt === MAX_ATTEMPTS) throw error;
    }
  }
}

module.exports = { readBoostTable, validateBoostReadRequest, parseBoostTable, extractTableFromHeaders,boostTableReady };
