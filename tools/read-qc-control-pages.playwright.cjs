'use strict';

const { readQianchuanControlRaw } = require('./read-qc-control-raw.playwright.cjs');

// Read the already selected pool from page 1. Changes pagination only and leaves
// the last page selected. The caller owns account/scene checks and view restoration.
async function readQianchuanControlPages(page, spec, { maxPages = 20, timeoutMs = 8000 } = {}) {
  const started = Date.now();
  const fail = (code, message) => { throw Object.assign(new Error(message), { code, advertising_writes: 0 }); };
  if (!Number.isInteger(maxPages) || maxPages < 1 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    fail('invalid_options', 'Positive page limit and timeout are required');
  }
  const selector = '.main-vmok-plugin-page-turner';
  const paging = async () => page.locator(selector).evaluateAll(elements => {
    const visible = elements.filter(e => e.getClientRects().length);
    if (!visible.length) return null;
    if (visible.length !== 1) return { ambiguous: true };
    const root = visible[0];
    const active = root.querySelectorAll('.main-vmok-plugin-page-turner__item--active');
    const next = root.lastElementChild;
    const sizes = Array.from(document.querySelectorAll('input')).filter(e => e.getClientRects().length && /^\d+条\/页$/.test(e.value));
    return {
      index: active.length === 1 ? Number(active[0].innerText.trim()) : null,
      size: sizes.length === 1 ? Number(sizes[0].value.match(/^\d+/)[0]) : null,
      next_verified: !!next?.querySelector('.main-vmok-plugin-page-turner__next-icon'),
      next_disabled: !!next?.classList.contains('main-vmok-plugin-page-turner__item--disabled'),
    };
  });
  const first = await readQianchuanControlRaw(page, spec);
  if (first.total === 0 && first.empty_verified) return { ...first, pages: [first], elapsed_ms: Date.now() - started };
  const initial = await paging();
  if (!initial || initial.ambiguous || initial.index !== 1 || !Number.isInteger(initial.size) || initial.size < 1 || !initial.next_verified) {
    fail('pagination_unverified', 'A unique verified pager on page 1 is required');
  }
  const pageCount = Math.ceil(first.total / initial.size);
  if (pageCount > maxPages) fail('page_limit', 'Selected pool exceeds the explicit page limit');
  const pages = [], ids = new Set();
  let current = first;
  for (let index = 1; index <= pageCount; index++) {
    const state = await paging();
    if (!state || state.ambiguous || state.index !== index || state.size !== initial.size || !state.next_verified ||
        state.next_disabled !== (index === pageCount)) fail('pagination_changed', 'Pager state differs from expected coverage');
    if (current.total !== first.total || JSON.stringify(current.headers) !== JSON.stringify(first.headers) ||
        current.visible_rows !== Math.min(initial.size, first.total - (index - 1) * initial.size)) {
      fail('coverage_changed', 'Total, columns or page size changed while scanning');
    }
    for (const task of current.tasks) {
      if (ids.has(task.task_id)) fail('duplicate_across_pages', 'A task appeared on more than one page');
      ids.add(task.task_id);
    }
    pages.push(current);
    if (index === pageCount) break;
    const previousFirst = current.tasks[0]?.task_id;
    await page.locator(selector).filter({ visible: true }).locator('li').last().click({ timeout: timeoutMs });
    await page.waitForFunction(({ selector, index, previousFirst }) => {
      const roots = Array.from(document.querySelectorAll(selector)).filter(e => e.getClientRects().length);
      if (roots.length !== 1 || Number(roots[0].querySelector('.main-vmok-plugin-page-turner__item--active')?.textContent.trim()) !== index) return false;
      const wrappers = Array.from(document.querySelectorAll('.main-vmok-plugin-oc-table-wrapper')).filter(e =>
        e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden' &&
        Array.from(e.querySelectorAll('th')).some(th => th.innerText.trim() === '任务名称'));
      if (wrappers.length !== 1) return false;
      const table = wrappers[0];
      const headers = Array.from(table.querySelector('thead tr')?.querySelectorAll('th') || []);
      const taskColumn = headers.findIndex(e => e.innerText.trim() === '任务名称');
      const cells = table.querySelector('tbody tr')?.querySelectorAll('td');
      const id = cells?.[taskColumn]?.innerText.match(/(?:^|\n)ID:\s*(\d+)/)?.[1];
      return !!id && id !== previousFirst;
    }, { selector, index: index + 1, previousFirst }, { timeout: timeoutMs });
    current = await readQianchuanControlRaw(page, spec);
  }
  if (ids.size !== first.total) fail('coverage_incomplete', 'Unique task count does not match the visible total');
  return { ...first, tasks: pages.flatMap(p => p.tasks), visible_rows: ids.size, complete: true,
    pages, elapsed_ms: Date.now() - started, captured_at: pages.at(-1).captured_at,
    limits: ['Pages were observed sequentially, not as an atomic server snapshot. Concurrent task edits can invalidate the scan.',
      'Logged-in account and live-scene verification remain with the caller.'] };
}

module.exports = { readQianchuanControlPages };
