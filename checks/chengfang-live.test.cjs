'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(require('./test-output.cjs').testOutputRoot(), 'chengfang-live-test-'));
process.env.QC_RUNTIME_CONFIG_ROOT = root;
process.env.QC_RUNTIME_DATA_ROOT = root;
process.env.QC_DISABLE_BACKGROUND = '1';
const { createService, metrics } = require('../server-app/server/lib/chengfangLive')._test;
const { inferRoiGoalBasis } = require('../server-app/server/lib/roiBasis');
const cell = value => ({ value, controlType: 1, valueStr: String(value) });
function row(id, account = '123456') {
  return { id: String(id), advId: account, name: '直播乘方', marGoal: 2, adlabScene: 1,
    ecpRoi2Goal: 5, deepExternalAction: 576, budget: '300000000' };
}
function response(rows, stats = {}) { return { status_code: 0, data: { adInfos: rows, adStatsMap: stats } }; }
function service(request) { return createService({ request, queue: fn => fn(), aavidFor: id => id }); }

test('乘方直播使用实测数据集；并发复用、账号与日期隔离，ROI 不由支付成交重算', async () => {
  const calls = [];
  const api = service(async (method, url, body, account) => {
    calls.push({ method, url, body });
    assert.equal(body.Params.AdFilter.MarGoal, 2);
    assert.equal(body.Params.AdFilter.AdlabScene, 1);
    assert.equal(body.Params.SophonxDataSetKey, 'overall_roi_promotion_list_for_live_v2');
    return response([row('12345', account)], { '12345': { metrics: {
      statCostForOverallRoi2: cell(10), totalPayOrderGmvIncludeCouponForRoi2: cell(200),
      totalPrepayAndPaySettleOverallRoi21H: cell(7), totalOrderSettleCountForRoi21H: cell(0),
    } } });
  });
  const results = await Promise.all(Array.from({ length: 12 }, () => api.getOverview('123456', '2026-09-20', '2026-09-20', '12345')));
  assert.equal(calls.length, 1);
  assert.equal(results[0].summary.roi, 7);
  assert.equal(results[0].summary.orders, 0);
  assert.equal(results[0].summary.net_gmv, null);
  assert.equal(results[0].plans[0].budget, 3000);
  const raw = await api.fetchPlanList('2026-09-20', '2026-09-20', '123456');
  assert.equal(inferRoiGoalBasis(raw.data.adInfos[0]).basis, 'chengfang_comprehensive');
  await api.getOverview('987654', '2026-09-20', '2026-09-20', '12345');
  await api.getOverview('123456', '2026-09-19', '2026-09-19', '12345');
  assert.equal(calls.length, 3);
});

test('平台横杠与受控不可用值保持 null；真正的 0 保留', () => {
  const m = metrics({ totalPrepayAndPaySettleOverallRoi21H: { value: 0, controlType: 0, valueStr: '-' },
    totalOrderSettleAmountForRoi21H: cell(0) });
  assert.equal(m.roi, null);
  assert.equal(m.cost, null);
  assert.equal(m.net_gmv, 0);
});

test('汇总读取平台 totalMetrics，不把计划支付 GMV 比值当综合 ROI', async () => {
  const api = service(async (_method, url, body) => {
    if (url.includes('list-required')) return response([row('12345')]);
    assert.equal(body.AdFilter.MarGoal, 2);
    assert.equal(body.AdFilter.StartTime, '2026-09-19 00:00:00');
    assert.equal(body.AdFilter.EndTime, '2026-09-20 23:59:59');
    return { status_code: 0, data: { totalMetrics: { metrics: {
      statCostForOverallRoi2: cell(25), totalPrepayAndPaySettleOverallRoi21H: cell(3.5),
    } } } };
  });
  const r = await api.getOverview('123456', '2026-09-19', '2026-09-20');
  assert.equal(r.summary.cost, 25);
  assert.equal(r.summary.roi, 3.5);
  assert.equal(r.roi_basis, 'chengfang_comprehensive');
});

test('拒绝错误账户、错误类型和上游失败，失败不缓存为空计划', async () => {
  for (const bad of [response([row('12345', '999999')]), response([{ ...row('12345'), marGoal: 1 }]),
    { status_code: 403, data: { adInfos: [] } }, { status_code: 0, data: {} }]) {
    let calls = 0;
    const api = service(async () => ++calls === 1 ? bad : response([row('12345')]));
    await assert.rejects(api.fetchPlanList('2026-09-20', '2026-09-20', '123456'));
    const good = await api.fetchPlanList('2026-09-20', '2026-09-20', '123456');
    assert.equal(good.data.adInfos.length, 1);
    assert.equal(calls, 2);
  }
});

test('分页合并第二页指标与房间；指定计划不存在返回 404', async () => {
  const api = service(async (_method, _url, body) => {
    const page = body.Params.PageParams.Page;
    const rows = page === 1 ? Array.from({ length: 50 }, (_, i) => row(10000 + i)) : [row('20000')];
    const r = response(rows, { [rows[0].id]: { metrics: { statCostForOverallRoi2: cell(page) } } });
    r.data.adRoomInfoMap = { [rows[0].id]: [{ id: '30000', anchor: { id: '40000' } }] };
    return r;
  });
  const found = await api.getOverview('123456', '2026-09-20', '2026-09-20', '20000');
  assert.equal(found.summary.cost, 2);
  assert.equal(found.plans[0].rooms[0].anchor_id, '40000');
  await assert.rejects(api.getOverview('123456', '2026-09-20', '2026-09-20', '99999'), { statusCode: 404 });
});

test('重复整页不循环查询且不返回貌似完整的数据', async () => {
  let calls = 0;
  const api = service(async () => { calls++; return response(Array.from({ length: 50 }, (_, i) => row(10000 + i))); });
  await assert.rejects(api.fetchPlanList('2026-09-20', '2026-09-20', '123456'), { code: 'chengfang_live_pagination' });
  assert.equal(calls, 2);
});
