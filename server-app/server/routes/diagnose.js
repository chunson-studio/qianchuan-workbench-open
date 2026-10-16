/**
 * GET /api/diagnose?account=xxx
 *
 * SOP 自动诊断引擎 — 一次调用完成 Step 1~3 全流程判断
 * 聚合 liveDashboard(阈值/直播/追投/今日汇总) + todaySnapshot(素材明细) → 诊断结果
 */
const { sendJSON } = require('../lib/utils');
const { diagnose } = require('../lib/diagnose');
const { defaultAccountId } = require('../lib/api-helpers');
const { createTTLCache } = require('../lib/cache');

// 诊断结果 30s TTL 缓存（交付版 E2E 实测回流：诊断=快照类输出，30s 陈旧在盯盘节拍内无碍）
const diagCache = createTTLCache(30 * 1000);

function normalizePlanId(value) {
  if (value == null || value === '') return null;
  return String(value);
}

function selectBudgetMainPlanId(adInfos) {
  const plans = Array.isArray(adInfos) ? adInfos : [];
  const main = plans.reduce((best, plan) => {
    if (!plan || plan.id == null) return best;
    if (!best) return plan;
    return Number(plan.budget || 0) > Number(best.budget || 0) ? plan : best;
  }, null);
  return main ? normalizePlanId(main.id) : null;
}

function resolvePlanIdentity({ accountConfig, dashboardPlan, adInfos }) {
  const candidates = {
    live_dashboard: normalizePlanId(dashboardPlan && dashboardPlan.primary_ad_id),
    account_config: normalizePlanId(accountConfig && accountConfig.primary_ad_id),
    upstream_budget_main: selectBudgetMainPlanId(adInfos),
  };
  const source = candidates.live_dashboard
    ? 'live_dashboard'
    : (candidates.account_config ? 'account_config' : (candidates.upstream_budget_main ? 'upstream_budget_main' : null));
  const primaryAdId = source ? candidates[source] : null;
  const distinctIds = [...new Set(Object.values(candidates).filter(Boolean))];
  return {
    primaryAdId,
    source,
    conflict: distinctIds.length > 1,
    candidates,
    conflicting_ids: distinctIds.length > 1 ? distinctIds : [],
  };
}

async function handleDiagnose(req, res, url) {
  const account = url.searchParams.get('account') || defaultAccountId();
  const hit = diagCache.get(account);
  if (hit) return sendJSON(res, hit);
  const config = require('../lib/config');
  const PORT = config.PORT;
  const QIANCHUAN_ACCOUNTS = config.QIANCHUAN_ACCOUNTS || [];

  try {
    // 并行拉2个数据源，任一失败直接报错，不降级
    const fetchJSON = (u) => fetch(u).then(r => r.json());

   const [dashResp, snapResp] = await Promise.all([
     fetchJSON(`http://localhost:${PORT}/api/live-dashboard?account=${account}`),
     fetchJSON(`http://localhost:${PORT}/api/today-snapshot?account=${account}`),
   ]);

   if (!dashResp || !dashResp.ok) {
      const code = (dashResp && dashResp.error === 'cookie_expired') ? 401 : 500;
      return sendJSON(res, { ok: false, error: 'live-dashboard 拉取失败: ' + (dashResp && dashResp.error) }, code);
   }
    if (!snapResp || !snapResp.ok) {
      return sendJSON(res, { ok: false, error: 'today-snapshot 拉取失败: ' + (snapResp && snapResp.error) }, 500);
    }

    const rows = snapResp.rows || [];

    const accConfig = QIANCHUAN_ACCOUNTS.find(a => a.id === account);
    const anchorId = accConfig ? accConfig.anchorId : null;
    let adInfos = [];
    try {
      const { fetchUniPromAdList } = require('../lib/qianchuanTabs');
      const todayStr = new Date().toISOString().slice(0, 10);
      const adList = await fetchUniPromAdList(todayStr, todayStr, account);
      adInfos = (adList && adList.data && adList.data.adInfos) || [];
    } catch (err) {
      console.error('[diagnose] fetch ad list error:', err.message);
    }
    const planIdentity = resolvePlanIdentity({
      accountConfig: accConfig,
      dashboardPlan: dashResp.plan,
      adInfos,
    });

    const result = diagnose({
      rows,
      thresholds: dashResp.thresholds || {},
      today: dashResp.today || snapResp.account || {},
      live: {
        isLive: dashResp.live && dashResp.live.isLive,
        online: dashResp.live_metrics && dashResp.live_metrics.online,
        gpm: dashResp.live_metrics && dashResp.live_metrics.gpm,
        watchUcount: dashResp.live_metrics && dashResp.live_metrics.watchUcount,
      },
      boostTasks: dashResp.boost_tasks || [],
    });

    const payload = {
      ok: true,
      account,
      server_time: new Date().toISOString(),
      primaryAdId: planIdentity.primaryAdId,
      plan_identity: planIdentity,
      objectId: anchorId,
      today: dashResp.today || snapResp.account || {},
      live: { isLive: dashResp.live && dashResp.live.isLive },
     data_source: {
       rows: 'today-snapshot',
       plan: planIdentity.source,
     },
      riskAlerts: snapResp.riskAlerts || [],
     diagnosis: result,
   };
    diagCache.set(account, payload);
    return sendJSON(res, payload);
  } catch (e) {
    console.error('[diagnose] error:', e.message);
    return sendJSON(res, { ok: false, error: e.message }, 500);
  }
}

module.exports = handleDiagnose;
module.exports._internal = { normalizePlanId, selectBudgetMainPlanId, resolvePlanIdentity };
