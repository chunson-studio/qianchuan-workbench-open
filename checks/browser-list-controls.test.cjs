'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const localRequire = createRequire(path.join(__dirname, '../tools/codex-qc-list-controls.cua.js'));
const moduleShim = { exports: {} };
const source = localRequire('node:fs').readFileSync(path.join(__dirname, '../tools/codex-qc-list-controls.cua.js'), 'utf8');
vm.runInNewContext(source, { URL, module: moduleShim }, { filename: 'codex-qc-list-controls.cua.js' });
const controls = moduleShim.exports;

const advertiserId = 'adv-1';
const primaryAdId = 'plan-1';
const dateRange = ['2026-09-23', '2026-09-23'];
const binding = { advertiser_id: advertiserId, primary_ad_id: primaryAdId, date_range: dateRange };
const taskIds = ['60000013', '60000016', '60000014', '60000015'];

function createHarness({
  ids = taskIds,
  selected = [],
  offPageSelectedCount = 0,
  pageSize = 20,
  advertiser = advertiserId,
  plan = primaryAdId,
  urlDateRange = dateRange,
  hideIdentity = false,
  changeUrlOnCheck = false,
  changeRowsOnCheck = false,
  loadingSnapshots = 0,
} = {}) {
  const state = { ids: [...ids], selected: new Set(selected), offPageSelectedCount, pageSize, advertiser, plan,
    urlDateRange: [...urlDateRange], hideIdentity, changeUrlOnCheck, changeRowsOnCheck, loadingSnapshots,
    menuOpen: false, urlReadCount: 0, events: [] };
  const url = () => `https://qianchuan.jinritemai.com/overall-prom/detail?aavid=${state.advertiser}&adId=${state.plan}&dateRange=${encodeURIComponent(state.urlDateRange.join(','))}`;
  const rowElement = id => {
    const checkbox = {
      checked: state.selected.has(id),
      getAttribute(name) { return name === 'aria-checked' ? (this.checked ? 'true' : 'false') : null; },
    };
    const cells = [{ innerText: '' }, { innerText: `测试任务 ID: ${id}` }];
    return {
      querySelector(selector) {
        if (selector === 'td') return cells[0];
        return /role="checkbox"|input\[type="checkbox"\]/.test(selector) ? checkbox : null;
      },
      querySelectorAll(selector) { return selector === 'td' ? cells : []; },
      cells,
      id,
      checkbox,
    };
  };
  const rowById = new Map();
  const currentRows = () => state.ids.map(id => {
    if (!rowById.has(id)) rowById.set(id, rowElement(id));
    const row = rowById.get(id);
    row.checkbox.checked = state.selected.has(id);
    return row;
  });
  const selectedCount = () => state.selected.size + state.offPageSelectedCount;
  const snapshot = () => {
    if (state.loadingSnapshots > 0) { state.loadingSnapshots--; return '加载中'; }
    const count = selectedCount();
    const counter = count > 0 ? `已选${count}个 任务` : '';
    const identity = state.hideIdentity ? '' : `${state.advertiser} ${state.plan}`;
    return `${identity} ${counter} 日期 ${state.urlDateRange.join(' 至 ')}`;
  };
  const headerCheckbox = {
    async count() { return 1; },
    async uncheck() {
      state.events.push('header-uncheck');
      state.selected.clear();
    },
  };
  const pageSizeInput = {
    async evaluate(fn) { return fn({ value: `${state.pageSize}条/页` }); },
    async click() { state.menuOpen = true; state.events.push('page-size-open'); },
  };
  const tab = {
    state,
    async url() { state.urlReadCount++; return url(); },
    playwright: {
      async domSnapshot() { return snapshot(); },
      locator(selector) {
        assert.equal(selector, 'table tr');
        const all = () => currentRows();
        return {
          async evaluateAll(fn) { return fn(all()); },
          filter({ hasText }) {
            const matches = () => all().filter(row => row.cells.some(cell => String(cell.innerText).includes(String(hasText))));
            return {
              async count() { return matches().length; },
              getByRole(role) {
                assert.equal(role, 'checkbox');
                return {
                  async count() { return matches().length === 1 ? 1 : 0; },
                  async check() {
                    const rows = matches();
                    if (rows.length !== 1) throw new Error('row checkbox not unique');
                    state.selected.add(rows[0].id);
                    rows[0].checkbox.checked = true;
                    state.events.push(`check:${rows[0].id}`);
                    if (state.changeUrlOnCheck) state.plan = 'changed-plan';
                    if (state.changeRowsOnCheck) state.ids = state.ids.filter(id => id !== rows[0].id);
                  },
                  async evaluate(fn) {
                    const rows = matches();
                    if (rows.length !== 1) throw new Error('row checkbox not unique');
                    return fn(rows[0].checkbox);
                  },
                };
              },
            };
          },
        };
      },
      getByRole(role) {
        if (role === 'columnheader') return { getByRole: nestedRole => {
          assert.equal(nestedRole, 'checkbox');
          return headerCheckbox;
        } };
        if (role === 'textbox') return { last: () => pageSizeInput };
        throw new Error(`unexpected role: ${role}`);
      },
      getByText(text, options) {
        assert.equal(options?.exact, true);
        return {
          async click() {
            if (!state.menuOpen || ![`20条/页`, `50条/页`].includes(text)) throw new Error('page-size option is not open');
            state.pageSize = Number(text.replace('条/页', ''));
            state.menuOpen = false;
            state.events.push(`page-size:${state.pageSize}`);
          },
        };
      },
    },
  };
  return tab;
}

test('selects exactly the requested visible task ID set and makes no advertising writes', async () => {
  const tab = createHarness();
  const result = await controls.selectCurrentPage(tab, binding, [taskIds[1], taskIds[0]]);
  assert.equal(result.ok, true);
  assert.equal(result.advertising_writes, 0);
  assert.equal(result.coverage, 'current_page_only');
  assert.deepEqual(Array.from(result.selected_ids), [taskIds[0], taskIds[1]].sort());
  assert.deepEqual([...tab.state.selected].sort(), [taskIds[0], taskIds[1]].sort());
});

test('clears the old visible selection before applying the requested set and clears it on request', async () => {
  const tab = createHarness({ selected: [taskIds[2], taskIds[3]] });
  const selected = await controls.selectCurrentPage(tab, binding, [taskIds[0]]);
  assert.equal(selected.ok, true);
  assert.deepEqual(Array.from(selected.selected_ids), [taskIds[0]]);
  assert.equal(tab.state.events.includes('header-uncheck'), true);
  const cleared = await controls.clearCurrentPage(tab, binding);
  assert.equal(cleared.ok, true);
  assert.deepEqual(Array.from(cleared.selected_ids), []);
  assert.equal(tab.state.selected.size, 0);
});

test('rejects unknown off-page selection and targets that are absent from the current page', async () => {
  const unknown = createHarness({ offPageSelectedCount: 1 });
  await assert.rejects(controls.inspect(unknown, binding), { code: 'offpage_or_unknown_selection' });
  const absentTarget = createHarness();
  await assert.rejects(controls.selectCurrentPage(absentTarget, binding, ['60000046']), { code: 'target_not_on_current_page' });
  assert.equal(absentTarget.state.selected.size, 0);
});

test('rejects identity, URL date, and plan version mismatches before changing selection', async (t) => {
  await t.test('advertiser identity', async () => {
    const tab = createHarness({ advertiser: 'other-account' });
    await assert.rejects(controls.selectCurrentPage(tab, binding, [taskIds[0]]), { code: 'page_binding_mismatch' });
    assert.equal(tab.state.selected.size, 0);
  });
  await t.test('primary plan identity', async () => {
    const tab = createHarness({ plan: 'other-plan' });
    await assert.rejects(controls.selectCurrentPage(tab, binding, [taskIds[0]]), { code: 'page_binding_mismatch' });
    assert.equal(tab.state.selected.size, 0);
  });
  await t.test('date range', async () => {
    const tab = createHarness({ urlDateRange: ['2026-09-22', '2026-09-22'] });
    await assert.rejects(controls.selectCurrentPage(tab, binding, [taskIds[0]]), { code: 'page_binding_mismatch' });
    assert.equal(tab.state.selected.size, 0);
  });
  await t.test('visible identity missing', async () => {
    const tab = createHarness({ hideIdentity: true });
    await assert.rejects(controls.selectCurrentPage(tab, binding, [taskIds[0]]), { code: 'visible_identity_missing' });
    assert.equal(tab.state.selected.size, 0);
  });
});

test('switches page size 20 to 50 and rejects the unverified 100 option', async () => {
  const tab = createHarness();
  const result = await controls.setPageSize(tab, binding, 50);
  assert.equal(result.ok, true);
  assert.equal(result.page_size, 50);
  assert.deepEqual(Array.from(result.visible_ids).sort(), [...taskIds].sort());
  assert.equal(result.coverage, 'current_page_only');
  const backTo20 = await controls.setPageSize(tab, binding, 20);
  assert.equal(backTo20.ok, true);
  assert.equal(backTo20.page_size, 20);
  await assert.rejects(controls.setPageSize(tab, binding, 100), { code: 'page_size_not_verified' });
  assert.equal(tab.state.pageSize, 20);
});

test('refuses page-size changes with selected tasks and fails closed when page identity changes during selection', async (t) => {
  await t.test('selection must be cleared before page-size change', async () => {
    const tab = createHarness({ selected: [taskIds[0]] });
    await assert.rejects(controls.setPageSize(tab, binding, 50), { code: 'clear_selection_first' });
    assert.equal(tab.state.pageSize, 20);
  });
  await t.test('identity change after a checkbox action', async () => {
    const tab = createHarness({ changeUrlOnCheck: true });
    await assert.rejects(controls.selectCurrentPage(tab, binding, [taskIds[0], taskIds[1]]), { code: 'page_binding_mismatch' });
    assert.equal(tab.state.selected.has(taskIds[1]), false);
  });
  await t.test('target row disappears during selection', async () => {
    const tab = createHarness({ changeRowsOnCheck: true });
    await assert.rejects(controls.selectCurrentPage(tab, binding, [taskIds[0]]), /row checkbox not unique/);
  });
});

test('rejects loading, duplicate task IDs, and a selected-count mismatch', async (t) => {
  await t.test('loading', async () => {
    const tab = createHarness({ loadingSnapshots: 1 });
    await assert.rejects(controls.inspect(tab, binding), { code: 'page_loading' });
  });
  await t.test('duplicate task IDs', async () => {
    const tab = createHarness({ ids: [taskIds[0], taskIds[0]] });
    await assert.rejects(controls.inspect(tab, binding), { code: 'ambiguous_task_rows' });
  });
  await t.test('selected counter cannot be reconciled', async () => {
    const tab = createHarness({ selected: [taskIds[0]], offPageSelectedCount: 1 });
    await assert.rejects(controls.inspect(tab, binding), { code: 'offpage_or_unknown_selection' });
  });
});
