'use strict';
require('./setup-runtime.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const config = require('../server-app/server/lib/config');
config.QIANCHUAN_ACCOUNTS.push({ id: 'catalog_test', aavid: '123', name: 'Catalog Test' },
  { id: 'catalog_other', aavid: '456', name: 'Another Test' });
const tabs = require('../server-app/server/lib/qianchuanTabs');
let upstreamCalls = 0;
tabs.fetchLiveSessions = async () => { upstreamCalls++; throw new Error('unexpected_upstream_read'); };
const route = require('../server-app/server/routes/liveReplay');
const { sessionDates, sessionCatalog } = route._internal;
const storage = path.join(config.STORAGE_DIR, 'replay');
fs.mkdirSync(storage, { recursive: true });
const bytes = value => Buffer.byteLength(JSON.stringify(value));
function save(account, date, payload) {
  fs.writeFileSync(path.join(storage, `sessions_${account}_${date}.json`), JSON.stringify(payload));
}
async function request(query, account = 'catalog_test') {
  let status, payload;
  await route({ method: 'GET' }, { writeHead(s) { status = s; }, end(s) { payload = JSON.parse(s); } },
    new URL(`http://localhost/api/live-replay/sessions?account=${account}&${query}`));
  return { status, payload };
}

test('30 archived dates are returned by one range request with original facts and no upstream requests', async t => {
  const dates = sessionDates('2020-07-01', '2020-07-30');
  for (const [i, date] of dates.entries()) save('catalog_test', date, {
    ok: true, account: 'catalog_test', date, fetchedAt: '2020-07-31T01:00:00Z',
    sessions: [{ account: 'catalog_test', roomId: `room-${i}`, startTime: `${date}T09:00:00+08:00`,
      endTime: `${date}T12:00:00+08:00`, status: '4', cost: i === 0 ? 0 : i * 10,
      netRoi: i === 0 ? null : 4, netGmv: i * 40 }],
  });
  const daily = [];
  for (const date of dates) daily.push((await request(`date=${date}`)).payload);
  const range = await request('start=2020-07-01&end=2020-07-30');
  assert.equal(range.status, 200);
  assert.equal(range.payload.days.length, 30);
  assert.equal(range.payload.partial, false);
  assert.deepEqual(range.payload.pending_dates, []);
  assert.deepEqual(range.payload.days.flatMap(d => d.sessions), daily.flatMap(d => d.sessions));
  assert.ok(range.payload.days.every(d => d.source_at === '2020-07-31T01:00:00Z' && d.cache_stable && !d.stale));
  assert.equal(range.payload.days[0].sessions[0].cost, 0);
  assert.equal(range.payload.days[0].sessions[0].netRoi, null);
  assert.equal(range.payload.final_settlement_available, false);
  assert.equal(upstreamCalls, 0);
  const dailyBytes = daily.reduce((total, item) => total + bytes(item), 0), rangeBytes = bytes(range.payload);
  assert.ok(rangeBytes < dailyBytes * 0.6);
  t.diagnostic(JSON.stringify({ sample: '30 isolated stored session dates', daily_http_requests: 30,
    catalog_http_requests: 1, daily_json_bytes: dailyBytes, catalog_json_bytes: rangeBytes,
    reduction_percent: +(100 * (1 - rangeBytes / dailyBytes)).toFixed(2), upstream_calls: upstreamCalls,
    measure: 'response JSON bytes and invocation count, not live latency or tokens' }));
});

test('missing, unbound, stale live and unknown timestamps remain pending; today freshness stays at 60 seconds', () => {
  const now = Date.parse('2026-09-29T20:00:00+08:00'), date = '2026-09-29';
  const payload = { ok: true, account: 'catalog_test', date,
    sessions: [{ account: 'catalog_test', roomId: 'live-room', status: '2', startTime: date + 'T19:00:00+08:00', endTime: '-' }] };
  for (const age of [0, 59999, 60000, 120000]) {
    save('catalog_test', date, { ...payload, fetchedAt: new Date(now - age).toISOString() });
    const day = sessionCatalog('catalog_test', [date], now).days[0];
    assert.equal(day.status, age < 60000 ? 'ready' : 'refresh_required');
    assert.equal(day.cache_stable, false);
    assert.equal(Array.isArray(day.sessions), true, 'stored rows remain available for explicitly stale display');
  }
  save('catalog_test', date, payload);
  const unknown = sessionCatalog('catalog_test', [date], now);
  assert.deepEqual(unknown.pending_dates, [date]);
  assert.equal(unknown.days[0].reason, 'archive_source_time_unknown');
  assert.equal(unknown.days[0].source_at, null);
  save('catalog_test', date, { ...payload, account: 'catalog_other', fetchedAt: new Date(now).toISOString() });
  const mismatch = sessionCatalog('catalog_test', [date], now).days[0];
  assert.equal(mismatch.status, 'missing');
  assert.equal(mismatch.session_count, null);
  assert.equal(mismatch.sessions, undefined);
  assert.equal(mismatch.reason, 'archive_identity_unverified');
  const missing = sessionCatalog('catalog_other', ['2020-07-01'], now).days[0];
  assert.equal(missing.status, 'missing');
  assert.equal(missing.session_count, null);
  assert.equal(upstreamCalls, 0, 'catalog never starts a background collection');
});

test('invalid ranges and unknown accounts fail before any data collection', async () => {
  for (const query of ['start=2020-07-01&end=2020-08-01', 'start=2020-07-30&end=2020-07-01',
    'start=2020-02-30&end=2020-03-01', 'start=2099-01-01&end=2099-01-02', 'start=2020-07-01',
    'start=2020-07-01&end=2020-07-02&date=2020-07-01', 'start=2020-07-01&end=2020-07-02&refresh=1']) {
    const result = await request(query);
    assert.equal(result.status, 400, query);
    assert.equal(result.payload.code, 'invalid_session_range');
  }
  assert.equal((await request('start=2020-07-01&end=2020-07-02', 'unknown_account')).status, 400);
  assert.equal(upstreamCalls, 0);
});

const pageSource = fs.readFileSync(path.resolve(__dirname, '../server-app/server/public/v4/pages/replay.js'), 'utf8');
function pageHarness(api) {
  const makeNode = () => ({ innerHTML: '', textContent: '', className: '', children: [],
    style: { setProperty() {} }, classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {}, querySelectorAll() { return []; }, insertAdjacentHTML(_where, html) { this.innerHTML += html; } });
  const nodes = new Map();
  const rangeButtons = [7, 14, 30].map(days => ({ ...makeNode(), dataset: { days: String(days) } }));
  nodes.set('rangeTabs', { ...makeNode(), querySelectorAll: () => rangeButtons });
  nodes.set('curveTabs', { ...makeNode(), querySelectorAll: () => [] });
  const view = { innerHTML: '', querySelector(selector) {
    const key = selector.match(/data-q="([^"]+)"/)[1];
    if (!nodes.has(key)) nodes.set(key, makeNode());
    return nodes.get(key);
  } };
  let account = 'catalog_test';
  const V4 = { pages: {}, esc: String, fmtM: String, odo() {}, fitV() {}, flip() {},
    emptyBox: text => text, errBox: e => e.message, breakEven: () => null, acct: () => account,
    p2: value => String(value).padStart(2, '0'), api, touch() {}, poll: () => () => {} };
  vm.runInNewContext(pageSource, { window: { V4 }, console, URLSearchParams, Date });
  const unmount = V4.pages.replay.mount(view);
  return { rangeButtons, nodes, unmount, setAccount: value => { account = value; } };
}
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
function readyCatalog(params, account = 'catalog_test') {
  return { ok: true, mode: 'archive_catalog', account,
    date_range: { start: params.start, end: params.end }, settle_window_min: 90,
    days: sessionDates(params.start, params.end).map(date => ({ date, status: 'ready', stale: false, sessions: [] })) };
}

test('mounted page uses 3 catalog reads and one account read for 7→14→30 days, with no duplicate active-tab request', async t => {
  const calls = [];
  const page = pageHarness(async (url, params) => {
    calls.push({ url, params });
    return url === '/api/live-dashboard' ? { account_info: { aavid: '123' } } : readyCatalog(params);
  });
  await flush(); page.rangeButtons[1].onclick(); await flush(); page.rangeButtons[2].onclick(); await flush();
  page.rangeButtons[2].onclick(); await flush();
  assert.equal(calls.filter(c => c.url === '/api/live-replay/sessions').length, 3);
  assert.equal(calls.filter(c => c.url === '/api/live-dashboard').length, 1);
  assert.ok(calls.filter(c => c.url === '/api/live-replay/sessions').every(c => c.params.start && !c.params.date));
  page.unmount();
  t.diagnostic('Mounted-page warm archive sequence: list requests 51→3, account-info requests 3→1; no latency estimate.');
});

test('page supplements only pending dates, falls back on old/foreign catalogs, and ignores results after account switch', async () => {
  for (const mode of ['partial', 'legacy', 'foreign']) {
    const calls = [];
    const page = pageHarness(async (url, params) => {
      calls.push({ url, params });
      if (url === '/api/live-dashboard') return {};
      if (params.date) return { sessions: [], settle_window_min: 90 };
      const result = readyCatalog(params, mode === 'foreign' ? 'catalog_other' : 'catalog_test');
      if (mode === 'legacy') return { sessions: [] };
      if (mode === 'partial') result.days[0] = { date: params.end, status: 'refresh_required', stale: true, session_count: 1 };
      return result;
    });
    await flush();
    assert.equal(calls.filter(c => c.params?.date).length, mode === 'partial' ? 1 : 7, mode);
    assert.ok(calls.filter(c => c.params?.date).every(c => mode === 'partial'
      ? c.params.refresh === '1' : c.params.refresh === undefined), 'legacy fallback must not force-refresh stable history');
    page.unmount();
  }
  let release, requestedRange;
  const calls = [];
  const page = pageHarness((url, params) => {
    calls.push({ url, params });
    if (url === '/api/live-dashboard') return Promise.resolve({});
    requestedRange = params;
    return new Promise(resolve => { release = resolve; });
  });
  const originalSessionHtml = page.nodes.get('sess')?.innerHTML;
  page.setAccount('catalog_other');
  release(readyCatalog(requestedRange)); await flush();
  assert.equal(calls.filter(c => c.params?.date).length, 0);
  assert.equal(page.nodes.get('sess')?.innerHTML, originalSessionHtml);
  page.unmount();
});

test('early samples do not become settled through wall-clock age; catalog and daily reads retain rows while refreshing', async () => {
  const date = '2020-08-01', now = Date.parse('2020-08-02T12:00:00+08:00');
  const cached = { ok: true, account: 'catalog_test', date, fetchedAt: date + 'T12:10:00+08:00',
    sessions: [{ account: 'catalog_test', roomId: 'early', status: '4', cost: 30,
      startTime: date + 'T09:00:00+08:00', endTime: date + 'T12:00:00+08:00' }] };
  save('catalog_test', date, cached);
  const day = sessionCatalog('catalog_test', [date], now).days[0];
  assert.equal(day.cache_stable, false);
  assert.equal(day.status, 'refresh_required');
  assert.equal(day.source_at, cached.fetchedAt);
  assert.deepEqual(day.sessions, cached.sessions);
  assert.equal(route._internal.decorateReplayContract(cached).settlement_state.cache_stable, false);
  let calls = 0, release;
  tabs.fetchLiveSessions = async () => {
    calls++;
    await new Promise(resolve => { release = resolve; });
    return { sessions: [{ ...cached.sessions[0], cost: 45 }] };
  };
  const original = await request('date=' + date);
  assert.equal(original.payload.sessions[0].cost, 30);
  assert.equal(original.payload.stale, true);
  assert.equal(original.payload.refreshing, true);
  assert.equal(original.payload.fetchedAt, cached.fetchedAt);
  assert.equal(calls, 1, 'an early historical sample must trigger a fresh read');
  release(); await flush();
  const updated = await request('date=' + date);
  assert.equal(updated.payload.sessions[0].cost, 45);
  assert.equal(updated.payload.stale, false);
  assert.equal(updated.payload.settlement_state.cache_stable, true);
  assert.equal(calls, 1, 'the completed post-window sample may be reused');
});

test('cold dates remain at most two concurrent requests and failed dates are not rendered as an empty complete range', async () => {
  let active = 0, peak = 0, dailyReads = 0;
  const page = pageHarness(async (url, params) => {
    if (url === '/api/live-dashboard') return {};
    if (params.start) {
      const result = readyCatalog(params);
      result.days = result.days.map(day => ({ date: day.date, status: 'missing', session_count: null }));
      return result;
    }
    dailyReads++; active++; peak = Math.max(peak, active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    if (dailyReads === 7) throw new Error('temporary_test_failure');
    return { sessions: [] };
  });
  await flush();
  assert.equal(dailyReads, 7);
  assert.equal(peak, 2);
  assert.match(page.nodes.get('roiDelta').textContent, /尚未完整/);
  assert.match(page.nodes.get('chartWrap').innerHTML, /待补齐/);
  page.unmount();
});
