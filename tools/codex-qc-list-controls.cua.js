// Codex CUA 会话内的列表控件；只改选择/分页，不点击任何广告提交按钮。
// 定位证据：control.cf.row_multiselect / header_select_all / clear_selection / page_size。
var qianchuanListControls = (function () {
  const error = (code, message) => { throw Object.assign(new Error(message), { code }); };
  const checked = async locator => locator.evaluate(el => el.checked === true || el.getAttribute('aria-checked') === 'true');
  async function inspect(tab, binding) {
    if (!binding || typeof binding.advertiser_id !== 'string' || typeof binding.primary_ad_id !== 'string'
      || !Array.isArray(binding.date_range) || binding.date_range.length !== 2) error('binding_required', '需要广告户、主计划和日期范围');
    const url = new URL(await tab.url());
    if (url.origin !== 'https://qianchuan.jinritemai.com' || url.pathname !== '/overall-prom/detail'
      || ['aavid', 'adId', 'dateRange'].some(k => url.searchParams.getAll(k).length !== 1)
      || url.searchParams.get('aavid') !== binding.advertiser_id || url.searchParams.get('adId') !== binding.primary_ad_id
      || url.searchParams.get('dateRange') !== binding.date_range.join(',')) error('page_binding_mismatch', '页面身份、版本或日期不匹配');
    const dom = await tab.playwright.domSnapshot();
    if (/加载中|正在加载/.test(dom)) error('page_loading', '列表仍在加载');
    if (!dom.includes(binding.primary_ad_id) || !dom.includes(binding.advertiser_id)) error('visible_identity_missing', '页面没有完整身份');
    const rows = await tab.playwright.locator('table tr').evaluateAll(elements => elements
      .filter(el => el.querySelector('[role="checkbox"],input[type="checkbox"]') && el.querySelector('td'))
      .map(el => {
        const firstCell = el.querySelectorAll('td')[1];
        const text = firstCell?.innerText || '';
        const matches = Array.from(text.matchAll(/\bID\s*[:：]\s*(\d+)/g), m => m[1]);
        const cb = el.querySelector('[role="checkbox"],input[type="checkbox"]');
        return { ids: matches, checked: cb?.checked === true || cb?.getAttribute('aria-checked') === 'true' };
      }));
    const seen = new Set();
    for (const row of rows) {
      if (row.ids.length !== 1 || seen.has(row.ids[0])) error('ambiguous_task_rows', '任务行 ID 缺失或不唯一');
      seen.add(row.ids[0]);
    }
    const selected = rows.filter(row => row.checked).map(row => row.ids[0]).sort();
    const counters = [...dom.matchAll(/已选\s*(\d+)\s*个\s*任务/g)].map(match => Number(match[1]));
    const counter = counters.length ? counters[0] : 0;
    if (counters.some(value => value !== counter) || counter !== selected.length) error('offpage_or_unknown_selection', '存在不可核对的跨页选择或选择数不一致');
    return { ids: [...seen], selected, url: url.href, dom };
  }
  async function selectCurrentPage(tab, binding, targetIds) {
    if (!Array.isArray(targetIds) || !targetIds.length || targetIds.some(id => typeof id !== 'string' || !/^\d+$/.test(id))
      || new Set(targetIds).size !== targetIds.length) error('invalid_targets', '必须指定不重复的任务 ID 集合');
    const before = await inspect(tab, binding);
    if (targetIds.some(id => !before.ids.includes(id))) error('target_not_on_current_page', '本次只支持已展示在当前页的目标');
    // 先清除可核验的本页旧选择，不能把未知跨页选择混入本次操作。
    if (before.selected.length) {
      const header = tab.playwright.getByRole('columnheader').getByRole('checkbox');
      if (await header.count() !== 1) error('ambiguous_header_checkbox', '表头选择框不唯一');
      await header.uncheck();
      const cleared = await inspect(tab, binding);
      if (cleared.selected.length) error('clear_selection_failed', '旧选择未清除');
    }
    for (const id of targetIds) {
      const current = await inspect(tab, binding);
      if (!current.ids.includes(id)) error('target_not_on_current_page', '页面变化后目标已不在当前页');
      const row = tab.playwright.locator('table tr').filter({ hasText: id });
      if (await row.count() !== 1) error('ambiguous_target', '目标行定位不唯一');
      const box = row.getByRole('checkbox');
      if (await box.count() !== 1) error('ambiguous_checkbox', '目标行选择框不唯一');
      await box.check();
      if (!await checked(box)) error('selection_not_applied', '点击后没有勾选成功');
    }
    const after = await inspect(tab, binding);
    const expected = [...targetIds].sort();
    if (JSON.stringify(after.selected) !== JSON.stringify(expected)) error('selection_mismatch', '实际勾选集合与目标不一致');
    return { ok: true, advertising_writes: 0, selected_ids: after.selected, coverage: 'current_page_only', observed_at: new Date().toISOString() };
  }
  async function clearCurrentPage(tab, binding) {
    const before = await inspect(tab, binding);
    if (before.selected.length) {
      const header = tab.playwright.getByRole('columnheader').getByRole('checkbox');
      if (await header.count() !== 1) error('ambiguous_header_checkbox', '表头选择框不唯一');
      await header.uncheck();
    }
    const after = await inspect(tab, binding);
    if (after.selected.length) error('clear_selection_failed', '取消后仍有选中项');
    return { ok: true, advertising_writes: 0, selected_ids: [], observed_at: new Date().toISOString() };
  }
  async function setPageSize(tab, binding, size) {
    if (![20, 50].includes(size)) error('page_size_not_verified', '目前仅有 20/50 条切换证据');
    const before = await inspect(tab, binding);
    if (before.selected.length) error('clear_selection_first', '切页容量前先明确清除当前选择');
    const input = tab.playwright.getByRole('textbox').last();
    const readValue = () => input.evaluate(el => el.value);
    if (!['20条/页', '50条/页'].includes(await readValue())) error('page_size_control_changed', '页容量控件与已验证结构不同');
    if (await readValue() !== `${size}条/页`) {
      await input.click();
      await tab.playwright.domSnapshot();
      await tab.playwright.getByText(`${size}条/页`, { exact: true }).click();
    }
    // 有界重读加载状态；失败不循环点击，不对已展示的旧行宣称成功。
    let state;
    for (let attempt = 0; attempt < 4; attempt++) {
      try { state = await inspect(tab, binding); break; }
      catch (err) { if (err.code !== 'page_loading' || attempt === 3) throw err; }
    }
    if (await readValue() !== `${size}条/页` || state.selected.length) error('page_size_unconfirmed', '页容量或选择状态回读不符');
    return { ok: true, advertising_writes: 0, page_size: size, visible_ids: state.ids, coverage: 'current_page_only', observed_at: new Date().toISOString() };
  }
  return { inspect, selectCurrentPage, clearCurrentPage, setPageSize };
})();
if (typeof module !== 'undefined') module.exports = qianchuanListControls;
