const { fetchCoreIndex, fetchSummaryIndex, fetchContentDetail } = require('../lib/doudian');
const { sendJSON, getLocalDateStr, num } = require('../lib/utils');

/**
  * 历史账户专用说明已从试用包移除。
 * 拉抖店电商罗盘核心指标（全渠道成交/退款/流量）
 */
async function handleDoudianOverview(req, res, url) {
  const today = getLocalDateStr();
  const start = url.searchParams.get('start') || today;
  const end = url.searchParams.get('end') || today;
  const account = url.searchParams.get('account');

  try {
    const data = await fetchCoreIndex(start, end, undefined, account);
    return sendJSON(res, data);
  } catch (e) {
    if (e.message === 'cookie_expired') return sendJSON(res, { ok: false, error: 'cookie_expired' }, 401);
    if (e.message === 'doudian_degraded') return sendJSON(res, { ok: false, error: '罗盘主通道不可用，兜底数据可能串店，已拒绝返回' }, 502);
    return sendJSON(res, { ok: false, error: e.message }, 500);
  }
}

/**
 * GET /api/doudian/summary?start=YYYY-MM-DD&end=YYYY-MM-DD
 * 拉汇总指标（含广告消耗/费效比/佣金）
 */
async function handleDoudianSummary(req, res, url) {
  const today = getLocalDateStr();
  const start = url.searchParams.get('start') || today;
  const end = url.searchParams.get('end') || today;
  const account = url.searchParams.get('account');

  try {
    const data = await fetchSummaryIndex(start, end, undefined, account);
    return sendJSON(res, data);
  } catch (e) {
    if (e.message === 'cookie_expired') return sendJSON(res, { ok: false, error: 'cookie_expired' }, 401);
    return sendJSON(res, { ok: false, error: e.message }, 500);
  }
}

/**
 * GET /api/doudian/content?start=YYYY-MM-DD&end=YYYY-MM-DD&index=pay_ucnt
 * 拉内容明细（直播/短视频/图文/商品卡/其他 拆分）
 */
async function handleDoudianContent(req, res, url) {
  const today = getLocalDateStr();
  const start = url.searchParams.get('start') || today;
  const end = url.searchParams.get('end') || today;
  const index = url.searchParams.get('index') || 'pay_ucnt';
  const account = url.searchParams.get('account');
  try {
    const data = await fetchContentDetail(start, end, index, undefined, account);
    return sendJSON(res, data);
  } catch (e) {
    if (e.message === 'cookie_expired') return sendJSON(res, { ok: false, error: 'cookie_expired' }, 401);
    return sendJSON(res, { ok: false, error: e.message }, 500);
  }
}

// 2026-07-30 审计清理：refund/trend/liverooms/flow 四个 handler 随 lib 函数 7-28 精简删除而下线（调用必 500 死路由）
module.exports = { handleDoudianOverview, handleDoudianSummary, handleDoudianContent };
