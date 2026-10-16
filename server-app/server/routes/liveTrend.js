const { sendJSON } = require('../lib/utils');
const { FLOW_CONTRACT, withFlowRole } = require('../lib/flowContract');

function buildMarginalSlices(account, getSlice) {
  return [5, 15, 30, 60].reduce((out, minutes) => {
    out[`m${minutes}`] = withFlowRole(getSlice(account, minutes), minutes);
    return out;
  }, {});
}

/**
 * GET /api/live-trend?account=xxx
 *
 * 当前/最近场次的 5 分钟粒度净 ROI 趋势（作战室主图）。
 * 数据源：liveCollector 内存态；关闭后台采集时按需补取趋势，同场复用一分钟。
 * 下播后保留最近场次记录（回流补采会刷新终值），前端可直接画"当日盘中曲线"。
 *
 * 返回：{ ok, account, trend: [{ time, cost, gmvSettle, roi }], room, session, fetchedAt }
 *   roi = gmvSettle / cost（净成交口径），cost=0 时 roi=0
 *   无数据时 trend 为空数组，不报错
 */
async function handleLiveTrend(req, res, url) {
  if (req.method !== 'GET') return sendJSON(res, { ok: false, error: 'Method Not Allowed' }, 405);
  try {
    const account = url.searchParams.get('account') || url.searchParams.get('accountId') || null;
    if (!account) return sendJSON(res, { ok: false, error: '缺少 account 参数' }, 400);
    const { getLatestTrend, ensureLiveTrend, ensureLiveFlow, ensureLiveInsights } = require('../lib/liveCollector');
    require('../lib/api-helpers').validateAccount(account);
    await require('../lib/liveReadService').readLiveSnapshot(account);
    void ensureLiveInsights(account).catch(() => {});
    const previous = getLatestTrend(account);
    const refresh = Promise.allSettled([ensureLiveTrend(account), ensureLiveFlow(account)]);
    if (!previous.fetchedAt) await refresh;
    const { getMarginalSliceFromDB } = require('./liveCockpit');
    const data = getLatestTrend(account);
    const marginal = buildMarginalSlices(account, getMarginalSliceFromDB);
    const { flowSamples: _internalFlowSamples, ...publicData } = data;
    return sendJSON(res, { ok: true, account, ...publicData, flow_contract: FLOW_CONTRACT, marginal });
  } catch (e) {
    console.error('[live-trend] 异常:', e.message);
    return sendJSON(res, { ok: false, error: 'internal_server_error' }, 500);
  }
}

module.exports = handleLiveTrend;
module.exports._test = { buildMarginalSlices, FLOW_CONTRACT };
