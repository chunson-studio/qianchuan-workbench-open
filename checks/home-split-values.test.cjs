'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const route = path.resolve('server-app/server/routes/homeSplit.js');
const source = fs.readFileSync(route, 'utf8');
function isolated(raw, seed = {}) {
  const files = new Map(Object.entries(seed));
  let calls = 0;
  const sandbox = { module: { exports: {} }, __dirname: path.dirname(route), console: { error() {} }, AbortSignal };
  sandbox.require = name => {
    if (name === 'path') return path;
    if (name === 'fs') return { existsSync: p => files.has(p), readFileSync: p => {
      if (!files.has(p)) throw Error('absent'); return files.get(p);
    }, writeFileSync: (p, value) => files.set(p, value), mkdirSync() {} };
    if (name === '../lib/config') return { CACHE_DIR: '/isolated', QIANCHUAN_ACCOUNTS: [{ id: 'fixture', aavid: '12345' }] };
    if (name === '../lib/api-helpers') return { defaultAccountId() { throw Error('Explicit account required'); } };
    if (name === '../lib/utils') return { getLocalDateStr: () => '2026-10-02', sendJSON(res, body, status = 200) {
      res.writeHead(status); res.end(JSON.stringify(body));
    } };
    if (name === '../lib/qianchuan') return { statQuery: async () => { calls++; return structuredClone(raw); } };
    throw Error('Unexpected dependency ' + name);
  };
  vm.runInNewContext(source + '\nmodule.exports.values = {querySplit,queryChengfangProduct,mergeSplit,mergeTrend,parseNum};', sandbox);
  const handle = sandbox.module.exports;
  return { ...handle.values, files, calls: () => calls, read: async () => {
    let status, data;
    await handle({ method: 'GET' }, { writeHead: x => { status = x; }, end: x => { data = JSON.parse(x); } },
      new URL('http://localhost/api/home-split?account=fixture&date=2026-09-01'));
    return { status, data };
  } };
}
const cell = ValueStr => ({ Value: 0, ValueStr });
const response = Totals => ({ data: { StatsData: { Totals, Rows: [] } } });
const zero = { cost: 0, gmv: 0, orders: 0, roi: null, settle_rate: null, refund_rate: null };

test('缺失显示值和原始 Value=0 共存时，缺失仍保留 null', async () => {
  const api = isolated(response({ stat_cost_for_roi2: cell('--'), total_prepay_and_pay_settle_roi2_1h: cell('-') }));
  const row = await api.querySplit('2026-09-01', 'fixture');
  for (const key of ['cost', 'gmv', 'orders', 'roi', 'settle_rate', 'refund_rate']) assert.equal(row[key], null);
});
test('有效零值、金额分位、百分比与非法数字不会混淆', () => {
  const { parseNum } = isolated({});
  assert.equal(parseNum('0.00'), 0);
  assert.equal(parseNum('10,420.90'), 10420.9);
  assert.equal(parseNum('82.13%', 'percent'), 82.13);
  for (const value of ['10元', '1万', '1,2', '1e3', '', '-', '10%', true, {}, Infinity]) assert.equal(parseNum(value), null);
  assert.equal(parseNum('1.5', 'orders'), null);
});
test('整个 Totals 缺失、空对象或数组必须返回 unavailable', async () => {
  for (const totals of [undefined, null, {}, [], '0']) {
    const api = isolated(response(totals));
    assert.equal((await api.querySplit('2026-09-01', 'fixture')).unavailable, true);
    assert.equal((await api.queryChengfangProduct('2026-09-01', 'fixture')).unavailable, true);
  }
});
test('两套平台 ROI 分别保留，计算值不冒充平台值，比例不按净金额错误加权', async () => {
  const api = isolated(response({ total_prepay_and_pay_settle_overall_roi2_1h: cell('7.66') }));
  assert.equal((await api.queryChengfangProduct('2026-09-01', 'fixture')).roi, 7.66);
  const merged = api.mergeSplit({ cost: 10, gmv: 200, orders: 2, roi: 19.73, settle_rate: 80, refund_rate: 20 }, zero);
  assert.equal(merged.source_ratios.uni.roi, 19.73);
  assert.equal(merged.source_ratios.chengfang.roi, null);
  assert.equal(merged.roi, 20);
  assert.equal(merged.roi_source, 'derived_net_gmv_div_cost');
  assert.equal(merged.settle_rate, null);
  assert.equal(merged.refund_rate, null);
});
test('单边失败和趋势缺点不被当作零值补齐，重复时点不双算', () => {
  const api = isolated({});
  const missing = api.mergeSplit({ unavailable: true }, zero);
  assert.equal(missing.cost, null); assert.equal(missing.roi, null); assert.equal(missing.base_unavailable, true);
  assert.equal(api.mergeSplit(zero, zero).cost, 0); assert.equal(api.mergeSplit(zero, zero).roi, null);
  const gap = api.mergeTrend([{ time: '01', ...zero }], []);
  assert.equal(gap[0].cost, null); assert.equal(gap[0].cf_unavailable, true);
  const duplicate = api.mergeTrend([{ time: '01', ...zero }, { time: '01', ...zero }], [{ time: '01', ...zero }]);
  assert.equal(duplicate[0].cost, null); assert.equal(duplicate[0].base_unavailable, true);
});
test('新旧缓存位置里的旧解析快照都不能继续作为终值复用', async () => {
  const old = { ok: true, account: 'fixture', date: '2026-09-01', fetched_at: '2026-09-03T23:59:59Z',
    all: { cost: 999 }, product: { cost: 999 }, live: { cost: 999 } };
  const seed = Object.fromEntries([
    path.join('/isolated', 'home-split', 'fixture_2026-09-01.json'),
    path.resolve('server-app/cache/home_split_2026-09-01_fixture.json'),
  ].map(p => [p, JSON.stringify(old)]));
  const api = isolated(response({ stat_cost_for_roi2: cell('10') }), seed);
  const result = await api.read();
  assert.equal(result.status, 200); assert.equal(api.calls(), 4);
  assert.equal(result.data.data_schema_version, 2); assert.equal(result.data.all.cost, 20);
  assert.equal(result.data.all.gmv, null);
});
test('浏览器呈现缺失值为 --，且缓存不能冒充终值', () => {
  const ui = fs.readFileSync(path.resolve('server-app/server/public/v4/pages/warroom.js'), 'utf8');
  const start = ui.indexOf('function renderSplitData(j) {');
  const end = ui.indexOf('let splitFlight = false;', start);
  assert.ok(start > 0 && end > start);
  const box = {}, sandbox = { box, S: {}, apply() {}, $: () => box, esc: String,
    fmtMoney: n => n == null ? '--' : '¥' + n, V4: { stateClass: () => '', errBox: String } };
  vm.runInNewContext(ui.slice(start, end) + '\nrenderSplitData({all:{label:"全部",cost:null,gmv:null,orders:null,roi:null,refund_rate:null,roi_source:"derived_net_gmv_div_cost"},cached:true,finalized:false});', sandbox);
  assert.match(box.innerHTML, /退款 -- · -- 单/);
  assert.match(box.innerHTML, /计算ROI/);
  assert.doesNotMatch(box.innerHTML, /0\.00|0\.0%|终值|NaN/);
});
