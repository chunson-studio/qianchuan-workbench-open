'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const dir = path.resolve(__dirname, '../server-app/server/public/v4');
const source = fs.readFileSync(path.join(dir, 'pages/replay.js'), 'utf8');
const shared = fs.readFileSync(path.join(dir, 'shared.js'), 'utf8');
function slice(text, start, end) {
  const from = text.indexOf(start), to = text.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return text.slice(from, to);
}
function element(tag = 'div', attrs = {}) {
  return { tag, attrs, textContent: '', className: '', style: {}, children: [],
    appendChild(child) { this.children.push(child); return child; },
    setAttribute(key, value) { this.attrs[key] = value; }, addEventListener() {},
    set innerHTML(value) { this.markup = value; this.children = []; this.firstChild = element('svg'); },
  };
}
function harness() {
  const nodes = new Map(), q = key => { if (!nodes.has(key)) nodes.set(key, element()); return nodes.get(key); };
  const V4 = { p2: n => String(n).padStart(2, '0'), WORD: { good: '健康', bad: '待优化', uncalibrated: '待校准' },
    modeOf: (roi, be) => roi >= be ? 'good' : 'bad', breakEven: () => 9,
    PULSE_COLOR: { good: 'green', bad: 'red', uncalibrated: 'gray' }, RM: { matches: true }, emptyBox: text => text };
  const context = vm.createContext({ V4, S: { settleMin: 90 }, q, Date, Number,
    WD: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'],
    odo: (el, value) => { el.textContent = value; }, flip: (el, value) => { el.textContent = value; }, fitV() {},
    fmtM: value => value == null ? '--' : `¥${value}`, esc: value => String(value),
    updateBoardLinks() {}, renderActiveCurve() {}, renderMats() {}, renderAi() {},
    CH: { w: 760, h: 280, pl: 44, pr: 52, pt: 16, pb: 30 }, chartLayout: {},
    document: { createElement: tag => element(tag) }, el: element,
  });
  vm.runInContext(slice(shared, 'V4.parseT = value => {', '  V4.durTxt'), context);
  vm.runInContext(slice(shared, 'V4.fmtCnTime = iso => {', '  const finite'), context);
  vm.runInContext(slice(source, '      const p2 = V4.p2;', '      /* ----- 场次列表 ----- */'), context);
  const detail = vm.runInContext('(' + slice(source, 'function renderDetail(s, d)', '      /* ----- 关键时刻').trim() + ')', context);
  const draw = vm.runInContext('(' + slice(source, 'function drawChart(', '      /* ----- 素材表现表').trim() + ')', context);
  const tools = vm.runInContext('({metricNumber,replayBreakEven,replayMode,pDate,md,hm,fmtD,timeAt,sessionDate,cumSeries})', context);
  const day = vm.runInContext('(' + slice(source, 'function buildDaySeries(', '      async function renderDayCurve').trim() + ')', context);
  const materials = vm.runInContext('(' + slice(source, 'function renderMats(', '      /* ----- 复盘总结').trim() + ')', context);
  vm.runInContext(slice(source, 'function allMats(', '      function renderMats('), context);
  return { q, detail, draw, tools, day, materials };
}
const session = { roomId: 'fixture-room', startTime: '2020-07-30 19:00:00', endTime: '2020-07-30 21:00:00', status: '4' };

test('missing detail values stay unknown and trend totals never impersonate the platform cumulative ROI', () => {
  const h = harness();
  h.detail(session, { thresholds: { break_even_roi: null, ROIt: 5 }, live_metrics: { cost: null, gmvSettle: null, orders: '', gpm: null, roiSettle: null },
    trend: [{ time: '2020-07-30 19:05:00', cost: 100, gmvSettle: 900 }] });
  for (const key of ['roiNum', 'vCost', 'vGmv', 'vOrd', 'vGpm']) assert.equal(h.q(key).textContent, '—', key);
  assert.match(h.q('roiDelta').textContent, /保本线未配置/);
  assert.match(h.q('roiDelta').textContent, /平台1小时净ROI.*非最终结算/);
  assert.doesNotMatch(h.q('roiDelta').textContent, /保本 0|保本 5|保本 9/);
  assert.equal(h.q('stateWord').textContent, '数据待补齐');
  assert.equal(h.q('vGpmS').textContent, 'GPM 数据缺失');
  assert.doesNotMatch(h.q('vCostS').textContent, /终值/);
});

test('known zeros remain real values without a hardcoded GPM quality judgment', () => {
  const h = harness();
  h.detail(session, { thresholds: { break_even_roi: 3 }, live_metrics: { cost: 0, gmvSettle: 0, orders: 0, gpm: 0, roiSettle: 0 } });
  assert.equal(h.q('roiNum').textContent, '0.00');
  assert.equal(h.q('vCost').textContent, '¥0'); assert.equal(h.q('vGmv').textContent, '¥0');
  assert.equal(h.q('vOrd').textContent, '0'); assert.equal(h.q('vGpm').textContent, '0');
  assert.equal(h.q('vGpmS').textContent, '本场场均值');
  assert.equal(h.q('vCostS').textContent, '本场累计');
  assert.match(h.q('roiDelta').textContent, /保本 3.00/);
});

test('unknown break-even omits the comparison line without breaking the chart; configured lines remain', () => {
  const h = harness();
  const cum = { roi: [3, 4], cost: [100, 200], gmv: [300, 800], times: ['2026-09-29T11:35:00Z', '2026-09-29T11:40:00Z'] };
  const hasBreakEven = () => h.q('chartWrap').firstChild.children.some(el => el.attrs['stroke-dasharray'] === '3 5');
  assert.doesNotThrow(() => h.draw(cum, 'uncalibrated', null, [], []));
  assert.equal(hasBreakEven(), false); assert.equal(h.q('lgBe').textContent, '保本线未配置');
  assert.ok(h.q('chartWrap').firstChild.children.filter(el => el.tag === 'path').every(el => !/NaN/.test(el.attrs.d)));
  h.draw(cum, 'good', 3, [], []);
  assert.equal(hasBreakEven(), true); assert.equal(h.q('lgBe').textContent, '保本 3.00');
});

test('UTC trend and timezone-less platform time share Beijing labels without changing bound source values', () => {
  const { tools: t } = harness();
  const iso = '2026-09-29T11:35:00Z', platform = '2026-09-29 19:35:00';
  assert.equal(t.pDate(iso).getTime(), t.pDate(platform).getTime());
  assert.equal(t.timeAt({ times: [iso] }, 0), '19:35');
  assert.equal(t.hm(t.pDate(platform)), '19:35');
  assert.equal(t.timeAt({ times: [platform] }, 0), '19:35');
  assert.equal(t.sessionDate({ startTime: '2026-09-29T18:35:00Z' }), '2026-09-30');
  assert.equal(iso, '2026-09-29T11:35:00Z'); assert.equal(platform, '2026-09-29 19:35:00');
});

test('missing trend buckets never become zero; day curves retain the actual increments instead of scaling to unrelated totals', () => {
  const h = harness();
  const missing = h.tools.cumSeries([{time:'2026-09-29 19:35:00',cost:10,gmvSettle:null}]);
  assert.equal(missing.dataValid,false); assert.equal(missing.roi.length,0);
  h.draw(missing,'uncalibrated',null,[],[]);
  assert.match(h.q('chartWrap').markup,/指标不完整/);
  const d={live_metrics:{cost:999,gmvSettle:9999},trend:[
    {time:'2026-09-29 19:35:00',cost:10,gmvSettle:30},
    {time:'2026-09-29 19:40:00',cost:0,gmvSettle:0}
  ]};
  const day=h.day([{s:session,d}]);
  assert.deepEqual(Array.from(day.cum.cost),[10,10]);
  assert.deepEqual(Array.from(day.cum.gmv),[30,30]);
  assert.equal(day.totalCost,10);assert.equal(day.totalGmv,30);
});

test('material unknown ROI and orders stay missing while genuine zeros remain', () => {
  const h=harness();
  h.materials({materials:{video:[{name:'未知',cost:1,roiSettle:null,gmvSettle:null,orders:''},{name:'零值',cost:1,roiSettle:0,gmvSettle:0,orders:0}]}},null);
  const rows=h.q('mats').markup.split('</tr>');
  assert.match(rows[0],/--<\/td><td class="num roi ">--/);
  assert.match(rows[1],/>0<\/td><td class="num roi uncalibrated">0\.00/);
});
