const { fetchBoostList, fetchBoostSummary, fetchUniPromAdList } = require('../lib/qianchuanTabs');
const { readQcCookie, isCookieProbablyValid } = require('../lib/cookie');
const { sendJSON, getLocalDateStr, isPassiveStop } = require('../lib/utils');
const { handleApiError } = require('../lib/handleApiError');
const { protectionFor, loadRunningStore } = require('../lib/boostGuard');
const { parseTask, metricValueOrNull } = require('../lib/boostTaskContract');

const BOOST_EFFECT_ROI_BASIS = Object.freeze({
  roi: 'payment',
  net_roi: 'platform_net_1h',
});

/**
 * GET /api/boost-list?adId=xxx&account=xxx&start=YYYY-MM-DD&end=YYYY-MM-DD&includeAllStatus=1
 * 不传 adId 时自动拉全部全域计划，再逐个查追投，合并返回。
  * 历史账户专用说明已从试用包移除。
  * 历史账户专用说明已从试用包移除。
 */
// 给任务列表附加人工保护期判定（暂停/删除建议的前置闸）
function attachProtection(tasks, account) {
  const store = loadRunningStore();
  const now = Date.now();
  for (const t of tasks) {
    const aid = t.assistAid || t.assist_aid || t.assist_task_id || t.id;
    try { t.protection = protectionFor({ assistAid: String(aid) }, account, store, now); }
    catch { t.protection = { protected: false, source: 'check_error' }; }
  }
  return tasks;
}
async function handleBoostList(req, res, url) {
  const account = url.searchParams.get('account') || url.searchParams.get('accountId') || undefined;
  const adId = url.searchParams.get('adId');
  const includeAll = url.searchParams.get('includeAllStatus') === '1' || url.searchParams.get('includeAllStatus') === 'true';
  const listOpts = includeAll ? { includeAllStatus: true } : {};
  // marGoal：2=直播间(默认) 1=商品卡（2026-08-03 商品卡追投监测——门票任务挂 mar_goal=1 计划，默认口径看不到）
  const marGoalParam = url.searchParams.get('marGoal');
  if (marGoalParam != null && !['1', '2'].includes(marGoalParam)) {
    return sendJSON(res, { ok: false, error: 'marGoal 只支持 1(商品卡)/2(直播间，默认)' }, 400);
  }
  if (marGoalParam) listOpts.marGoal = parseInt(marGoalParam, 10);

  // 日期范围：支持 start/end 参数，默认近30天
  const today = getLocalDateStr();
  let end = url.searchParams.get('end') || today;
  let start = url.searchParams.get('start');
  if (!start) {
    const d30 = new Date();
    d30.setDate(d30.getDate() - 30);
    start = getLocalDateStr(d30);
  }

  if (!account) {
    return sendJSON(res, { ok: false, error: '缺少 account 参数' }, 400);
  }

  if (!isCookieProbablyValid(readQcCookie(account))) {
    return sendJSON(res, { ok: false, error: 'cookie_expired' }, 401);
  }

  // 不传 adId 时：先拉全部全域计划列表，再逐个查追投
  if (!adId) {
    try {
      const adListResult = await fetchUniPromAdList(start, end, account, listOpts.marGoal ? { marGoal: listOpts.marGoal } : {});
      const code = adListResult?.status_code ?? adListResult?.code;
      if ((code != null && Number(code) !== 0) || !Array.isArray(adListResult?.data?.adInfos)) {
        return sendJSON(res, { ok: false, code: 'plan_list_unavailable', account, data_valid: false, truncated: true,
          error: '主计划列表不可用，不能据此认定追投数量为零' }, 502);
      }
      const adInfos = adListResult.data.adInfos;
      if (adInfos.length === 0) {
        return sendJSON(res, { ok: true, account, date_range: `${start} ~ ${end}`, total_tasks: 0, tasks: [],
          truncated: adListResult.truncated === true, data_valid: adListResult.truncated !== true, message: '未找到任何全域计划' });
      }
      // 逐个计划查追投列表
      const allTasks = [];
      let truncated = adListResult?.truncated === true;
      for (const ad of adInfos) {
        try {
          const listResult = await fetchBoostList(String(ad.id), start, end, account, listOpts);
          const listCode = listResult?.status_code ?? listResult?.code;
          if ((listCode != null && Number(listCode) !== 0) || !Array.isArray(listResult?.data?.adInfos)) { truncated = true; continue; }
          if (listResult.truncated) truncated = true;
          if (listResult && listResult.data && listResult.data.adInfos) {
            for (const task of listResult.data.adInfos) {
              allTasks.push(parseTask(task, ad, listResult, { accountId: account, sourceAt: new Date().toISOString(), start, end }));
            }
          }
        } catch (e) {
          truncated = true;
          if (e.message === 'cookie_expired') throw e;  // 必须向上抛
          console.log(`[boost-list] 计划 ${ad.id} 追投拉取失败: ${e.message}`);
        }
      }
      return sendJSON(res, {
        ok: true,
        account,
        date_range: `${start} ~ ${end}`,
        metric_roi_basis: BOOST_EFFECT_ROI_BASIS,
        total_tasks: allTasks.length,
        truncated,
        data_valid: !truncated,
        tasks: attachProtection(allTasks, account),
        server_time: new Date().toISOString(),
      });
    } catch (e) {
      console.log(`[boost-list] 拉全部计划失败: ${e.message}`);
      return handleApiError(res, e);
    }
  }

  try {
    const [listResult, summaryResult] = await Promise.all([
      fetchBoostList(adId, start, end, account, listOpts),
      fetchBoostSummary(adId, start, end, account, listOpts).catch(e => {
        console.log(`[boost-list] 汇总拉取失败: ${e.message}`);
        return null;
      }),
    ]);

    const listCode = listResult?.status_code ?? listResult?.code;
    if ((listCode != null && Number(listCode) !== 0) || !Array.isArray(listResult?.data?.adInfos)) {
      return sendJSON(res, { ok: false, code: 'boost_list_unavailable', data_valid: false, truncated: true, error: '追投列表不可用，不能据此判断补建数量' }, 502);
    }

    const sourceAt = listResult.source_at || null;
    const tasks = attachProtection(listResult.data.adInfos.map(ad => parseTask(ad, { id: adId }, listResult, { accountId: account, sourceAt, start, end })), account);

    // 状态分组
    const groups = {};
    tasks.forEach(t => {
      const s = t.status || 'unknown';
      if (!groups[s]) groups[s] = [];
      groups[s].push(t);
    });

    // 汇总
    let summary = null;
    if (summaryResult && summaryResult.data) {
      const tm = summaryResult.data.totalMetrics || {};
      const m = tm.metrics || {};
      summary = {
        total_num: summaryResult.data.totalNum || tasks.length,
        total_cost: metricValueOrNull(m.statCostForRoi2Assist),
        total_gmv: metricValueOrNull(m.totalPayOrderGmvForRoi2Assist),
        total_roi: metricValueOrNull(m.totalPrepayAndPayOrderRoi2Assist),
        metric_roi_basis: { total_roi: 'payment' },
      };
    }

    return sendJSON(res, {
      ok: true,
      ad_id: adId,
      account,
      mar_goal: listOpts.marGoal || 2,
      source_at: sourceAt,
      date_range: `${start} ~ ${end}`,
      metric_roi_basis: BOOST_EFFECT_ROI_BASIS,
      total_tasks: tasks.length,
      truncated: listResult.truncated === true,
      data_valid: listResult.truncated !== true,
      status_groups: Object.entries(groups).map(([status, list]) => ({ status, count: list.length })),
      summary,
      tasks,
      server_time: new Date().toISOString(),
    });
  } catch (e) {
    console.log(`[boost-list] ✗ ${e.message}`);
    return handleApiError(res, e);
  }
}

module.exports = handleBoostList;
