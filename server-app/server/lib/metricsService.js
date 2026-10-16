/**
 * server/lib/metricsService.js — 指标口径统一层
 *
 * 收拢追投指标多来源的取舍逻辑（原散落在 liveDashboard 追投段），对外一个函数：
 *   getBoostMetricsToday(account) → 任务级指标 + 汇总 + 额度占用
 *
 * 数据源优先级（任务级 gmv/cost 与 ROI 同口径为准，与千川后台一致）：
 *   1. boost-task-report 今日报表 fetchBoostTaskReport —— 主口径（任务级 + 汇总）
 *   2. 追投素材明细 fetchBoostMaterialDetail —— 直播中才逐任务拉（省 statQuery），拿素材名/ID
 *   3. fetchBoostSummary —— 汇总窄口径兜底（仅使用返回的 ROI，不本地复算）
 *   4. fetchBoostList 的 adStatsMap —— 平台可能缺失，仅作结构兜底
 *
 * 只读聚合，无写操作；所有请求仍走 qianchuanTabs 的限频队列，cookie_expired 向上抛不吞。
 */

const { num, getLocalDateStr, isPassiveStop } = require('./utils');
const { attachRoiGoalContract } = require('./roiBasis');
const { boostTaskContract } = require('./boostTaskContract');
const { finiteNumber: nullable } = require('./dataContract');
const { BoostObservation } = require('./boostObservation');
const { buildBoostFunnel, boostListFunnel } = require('./boostFunnel');
const { readBoostDuration } = require('./boostDuration');
const boostObservation = new BoostObservation();

const BOOST_EFFECT_ROI_BASIS = Object.freeze({
  roi: 'payment',
  net_roi: 'platform_net_1h',
});

// 2026-08-18 提速：追投指标 30s 结果缓存（直播中 dashboard 30s 轮询，千川 3 接口全走限频队列首次 10-20s）
const _boostMetricsCache = new Map(); // account|today|md -> {ts, data}
const _boostMetricsInFlight = new Map();
const _boostMetricsRevision = new Map();
function invalidateBoostMetrics(account) {
  _boostMetricsRevision.set(account, (_boostMetricsRevision.get(account) || 0) + 1);
  for (const key of _boostMetricsCache.keys()) {
    if (key.startsWith(`${account}|`)) _boostMetricsCache.delete(key);
  }
  for (const key of _boostMetricsInFlight.keys()) {
    if (key.startsWith(`${account}|`)) _boostMetricsInFlight.delete(key);
  }
}

/**
 * 拉取某账号今日追投指标（统一口径）。
 *
 * @param {string} account 账号ID
 * @param {object} [opts]
 * @param {Array} [opts.adInfos] 全域计划列表（调用方做日级缓存；不传/空数组则只剩 btr 汇总）
 * @param {boolean} [opts.fetchMaterialDetail] 直播中才传 true：逐任务拉素材明细（素材名/ID）
 * @param {string} [opts.today] YYYY-MM-DD，默认本地今天
 * @returns {Promise<object>} {
 *   tasks: [{ id, assist_aid, primary_ad_id, name, status, smart_bid_type, budget, roi_goal,
 *             cost, gmv, roi, net_roi, net_gmv, order_count, show_cnt, click_cnt, refund_rate,
 *             material_name, material_id }],   // 金额单位：元
 *   summary: { total_cost, total_gmv, total_roi, total_orders, count },
 *   quota: { in_use, paused_deleted_cost },  // 官方额度口径：在投控成本任务预算占用(元) / 已暂停·已删除任务当天消耗(元)
 * }
 */
async function getBoostMetricsToday(account, opts = {}) {
  const today = opts.today || getLocalDateStr();
  // Different plan sets or live states cannot share a result, even within one account/session.
  const plans = (opts.adInfos || []).map(ad => String(ad.id)).sort();
  const ck = `${account}|${today}|${opts.sessionKey || 'unknown'}|${opts.fetchMaterialDetail ? 1 : 0}|${opts.isLive ?? 'unknown'}|${JSON.stringify(plans)}`;
  const hit = _boostMetricsCache.get(ck);
  if (hit && Date.now() - hit.ts < 30000) return hit.data;
  const pending = _boostMetricsInFlight.get(ck);
  if (pending) return pending;
  const revision = _boostMetricsRevision.get(account) || 0;
  const flight = collectBoostMetricsToday(account, { ...opts, today }).then(data => {
    // A read begun before a write/invalidation may finish later; it must not refill the cache.
    if ((_boostMetricsRevision.get(account) || 0) === revision) _boostMetricsCache.set(ck, { ts: Date.now(), data });
    return data;
  });
  _boostMetricsInFlight.set(ck, flight);
  try { return await flight; }
  finally { if (_boostMetricsInFlight.get(ck) === flight) _boostMetricsInFlight.delete(ck); }
}

async function collectBoostMetricsToday(account, opts = {}) {
  const { fetchBoostList, fetchBoostSummary, fetchBoostMaterialDetail, fetchBoostTaskReport } = require('./qianchuanTabs');
  const adInfos = opts.adInfos || [];
  // 直播中才拉追投素材明细（非直播跳过，省 statQuery）
  const shouldFetchMaterialDetail = !!opts.fetchMaterialDetail;
  const today = opts.today || getLocalDateStr();

  // 追投今日报表：任务级 gmv/roi/订单与汇总以此为准（gmv/cost 与 ROI 同口径；
  // fetchBoostSummary 与素材明细里的 total_pay_order_gmv_for_roi2_assist 口径偏窄，用它算综合ROI会低估，仅作兜底）
  const btrToday = await fetchBoostTaskReport(today, today, account).catch(e => { if (e.message === 'cookie_expired') throw e; return null; });
  const reportSourceAt = btrToday ? btrToday.source_at || new Date().toISOString() : null;
  const collectedTimes = reportSourceAt ? [reportSourceAt] : [];
  if (btrToday && btrToday.truncated) {
    console.warn(`[metricsService] 告警: ${account} ${today} 的追投任务列表被截断(超 MAX_PAGES)，可能丢失部分任务数据`);
  }
  const btrById = {};
  if (btrToday && btrToday.tasks) for (const t of btrToday.tasks) btrById[String(t.assistAid)] = t;

  const tasks = [];
  const excluded = [];
  const summary = {
    total_cost: 0,
    total_gmv: 0,
    total_roi: null,
    total_orders: 0,
    count: 0,
    metric_roi_basis: { total_roi: 'payment' },
  };
  // 官方额度口径累计：当日剩余 = 每日总额度 − 在投控成本任务预算 − 已暂停/已删除任务当天消耗
  let quotaInUseBudget = 0;
  let quotaPausedDeletedCost = 0;
  let tasksComplete = adInfos.length > 0;

  for (const ad of adInfos) {
    const adId = String(ad.id);
    // fetchBoostList 只拿任务结构（id/name/budget/roi_goal/status），不依赖 adStatsMap
    // 历史账户专用说明已从试用包移除。
    // "计划组超出预算/任务预算不足/关联直播间未开播"等系统强停任务被滤掉，dashboard/盯盘轮完全看不见
    const [listResult, summaryResult] = await Promise.all([
      fetchBoostList(adId, today, today, account, { includeAllStatus: true }).catch(e => { if (e.message === 'cookie_expired') throw e; return null; }),
      fetchBoostSummary(adId, today, today, account).catch(e => { if (e.message === 'cookie_expired') throw e; return null; }),
    ]);
    const taskSourceAt = listResult ? listResult.source_at || new Date().toISOString() : null;
    if (taskSourceAt) collectedTimes.push(taskSourceAt);

    if (!Array.isArray(listResult?.data?.adInfos) || listResult?.truncated) tasksComplete = false;
    if (listResult && listResult.data && listResult.data.adInfos) {
      for (const task of listResult.data.adInfos) {
        const status = task.adDeliveryName || '';

        // adStatsMap 的 key 是任务ID，value 里 metrics 用驼峰格式
        const stats = (listResult.data.adStatsMap && listResult.data.adStatsMap[task.id] && listResult.data.adStatsMap[task.id].metrics) || {};
        // adStatsMap 可能缺失，消耗兜底用今日报表 btrById 的真实 cost
        const taskCostToday = nullable(stats.statCostForRoi2Assist && stats.statCostForRoi2Assist.value)
          ?? nullable(btrById[String(task.id)] && btrById[String(task.id)].cost);

        // 历史账户专用说明已从试用包移除。
        //   已删除/已完成：计当天消耗，不进看板（原行为）
        // 历史账户专用说明已从试用包移除。
        // 历史账户专用说明已从试用包移除。
        //   被动停摆（任务预算不足/计划组超出预算/关联直播间未开播）：计当天消耗，**进看板**——agent 必须看见"想跑但跑不了"的任务
        //   下播等待态（未开播+未在播）：2026-07-31 实证为正常等待态（千川下播统一刷状态）——原按手动暂停过滤；
        // 历史账户专用说明已从试用包移除。
        if (status.includes('已完成') || status.includes('素材删除') || status.includes('已删除')) {
          quotaPausedDeletedCost += taskCostToday || 0;
          excluded.push({ id: String(task.id), status, reason: 'platform_terminal_status' });
          continue;
        }
        // 被动停摆优先判定（系统强停的状态名可能带"暂停"二字，必须先于手动暂停分支拦截）
        let passiveStop = isPassiveStop(status);
        const offlineWait = passiveStop && !opts.isLive && status.includes('未开播'); // 下播等待态：可见但不告警
        if (offlineWait) passiveStop = false;
        let manualPaused = false;
        if (!passiveStop && !offlineWait && status.includes('暂停')) {
          quotaPausedDeletedCost += taskCostToday || 0;
          if (taskCostToday === 0) {
            excluded.push({ id: String(task.id), status, reason: 'paused_without_period_spend' });
            continue;
          }
          manualPaused = true; // 今日有消耗的手动暂停：进看板
        }
        if (passiveStop || offlineWait) quotaPausedDeletedCost += taskCostToday || 0;
        else if (!manualPaused && (task.smartBidType ?? 0) === 0) quotaInUseBudget += num(task.budget) / 100000;

        const taskInfo = {
          id: String(task.id),
          assist_aid: String(task.id),
          primary_ad_id: adId,
          name: task.name,
          status: task.adDeliveryName,
          passive_stop: passiveStop, // 系统强停标记（dashboard 告警/前端着色/agent 识别用）
          board_group: passiveStop ? 'passive_stop' : offlineWait ? 'offline_wait' : manualPaused ? 'manual_paused' : 'active', // 2026-08-03 前端分组渲染用
          smart_bid_type: task.smartBidType,
          create_time: task.createTime || null,
          start_time: btrById[String(task.id)]?.startTime || task.createTime || null,
          budget: nullable(task.budget) == null ? null : nullable(task.budget) / 100000,
          ...readBoostDuration(task),
          roi_goal: nullable(task.ecpRoi2Goal),
          // 目标 ROI 口径和效果 ROI 口径是两件事：前者来自真实优化元数据，
          // 后者由当前指标字段定义，Agent 不得互相替代。
          ...attachRoiGoalContract({ ...(ad || {}), ...(task || {}) }),
          cost: taskCostToday,
          gmv: nullable(stats.totalPayOrderGmvForRoi2Assist && stats.totalPayOrderGmvForRoi2Assist.value),
          roi: nullable(stats.totalPrepayAndPayOrderRoi2Assist && stats.totalPrepayAndPayOrderRoi2Assist.value),
          net_roi: nullable(stats.totalPrepayAndPaySettleRoi21HAssist && stats.totalPrepayAndPaySettleRoi21HAssist.value),
          net_gmv: nullable(stats.totalOrderSettleAmountForRoi21HAssist && stats.totalOrderSettleAmountForRoi21HAssist.value),
          order_count: nullable(stats.totalPayOrderCountForRoi2Assist && stats.totalPayOrderCountForRoi2Assist.value),
          show_cnt: nullable(stats.showCntForRoi2Assist && stats.showCntForRoi2Assist.value),
          click_cnt: nullable(stats.clickCntForRoi2Assist && stats.clickCntForRoi2Assist.value),
          refund_rate: nullable(stats.totalRefundOrderGmvForRoi21HRateAssist && stats.totalRefundOrderGmvForRoi21HRateAssist.value),
          metric_roi_basis: BOOST_EFFECT_ROI_BASIS,
          settlement_window: { net_roi: '1h' },
          material_name: null,
          material_id: null,
          material_ids: btrById[String(task.id)]?.material_ids || [],
          material_link_complete: btrById[String(task.id)]?.material_link_complete === true,
          material_link_source: btrById[String(task.id)]?.material_link_source || null,
        };

        // 今日报表口径修正（最后应用，优先级最高）：gmv/cost 与 ROI 同口径（千川后台一致），
        // 覆盖 adStatsMap/素材明细的窄口径值
        const btrT = btrById[String(task.id)];
        taskInfo.funnel = btrT
          ? buildBoostFunnel({ show_cnt: btrT.showCnt, click_cnt: btrT.clickCnt, ctr: btrT.ctr, cvr: btrT.convertRate },
            { start: today, end: today, scope: 'daily', sourceType: 'boost_task_report', collectedAt: reportSourceAt })
          : boostListFunnel(stats, { start: today, end: today, scope: 'daily', sourceAt: taskSourceAt });
        taskInfo.show_cnt = taskInfo.funnel.show_cnt;
        taskInfo.click_cnt = taskInfo.funnel.click_cnt;
        if (btrT) {
          // One financial group from one report; missing cells cannot inherit another window/coupon scope.
          taskInfo.cost = nullable(btrT.cost);
          taskInfo.gmv = nullable(btrT.gmv);
          taskInfo.roi = nullable(btrT.payRoi);
          taskInfo.net_roi = nullable(btrT.netRoi);
          taskInfo.net_gmv = nullable(btrT.settleAmount ?? btrT.netGmv);
          taskInfo.payment_gmv_excluding_coupon = nullable(btrT.paymentGmv);
          taskInfo.metric_sources = btrToday.metric_sources || null;
          taskInfo.order_count = nullable(btrT.orderCount);
          taskInfo.metrics_freshness_override = { value: 'unknown', age_ms: null, reason: 'upstream_report_delay_unknown' };
        }

        Object.assign(taskInfo, boostTaskContract(task, taskInfo, { accountId: account,
          sourceAt: [taskSourceAt, btrT && reportSourceAt].filter(Boolean).sort()[0] || null, start: today, end: today, sessionKey: opts.sessionKey }));
        taskInfo.parameters_source_at = taskSourceAt;
        taskInfo.metrics_source_at = btrT ? reportSourceAt : taskSourceAt;
        taskInfo.window.scope = 'daily';
        taskInfo.daily_metrics = taskInfo.period_metrics;
        delete taskInfo.period_metrics;
        tasks.push(taskInfo);
      }
    }

    // 汇总消耗从 fetchBoostSummary 拿（这个有数据）
    if (summaryResult && summaryResult.data && summaryResult.data.totalMetrics) {
      const m = summaryResult.data.totalMetrics.metrics || {};
      summary.total_cost += m.statCostForRoi2Assist ? num(m.statCostForRoi2Assist.value) : 0;
      summary.total_gmv += m.totalPayOrderGmvForRoi2Assist ? num(m.totalPayOrderGmvForRoi2Assist.value) : 0;
      summary.total_orders += m.totalPayOrderCountForRoi2Assist ? num(m.totalPayOrderCountForRoi2Assist.value) : 0;
      // 只有单计划汇总可直接使用该计划的 ROI；多计划不能相加、平均或自行复算。
      if (adInfos.length === 1) summary.total_roi = nullable(m.totalPrepayAndPayOrderRoi2Assist?.value);
    }
  }

  // Detail totals are real-time evidence, but the legacy GMV field is not the
  // report's coupon-inclusive GMV. Keep this source separate from the coherent
  // daily financial group; never splice a different source/window into it.
  if (shouldFetchMaterialDetail) {
    const active = tasks.filter(t => t.board_group === 'active').slice(0, 3);
    let nextDetail = 0;
    await Promise.all(Array.from({ length: Math.min(2, active.length) }, async () => {
      while (nextDetail < active.length) {
        const taskInfo = active[nextDetail++];
        try {
          const detail = await fetchBoostMaterialDetail(taskInfo.id, today, today, account);
          const totals = detail?.data?.StatsData?.Totals || {};
          const cell = value => {
            const raw = value && typeof value === 'object' ? (value.Value ?? value.value ?? value.ValueStr) : value;
            if (raw == null || String(raw).trim() === '') return null;
            const parsed = Number(String(raw).trim().replace(/,/g, '').replace(/%$/, ''));
            return Number.isFinite(parsed) ? parsed : null;
          };
          const fields = {
            cost: cell(totals.stat_cost_for_roi2_assist),
            gmv_include_coupon: cell(totals.total_pay_order_gmv_include_coupon_for_roi2_assist),
            payment_gmv_excluding_coupon: cell(totals.total_pay_order_gmv_for_roi2_assist),
            roi: cell(totals.total_prepay_and_pay_order_roi2_assist),
            net_roi: cell(totals.total_prepay_and_pay_settle_roi2_1h_assist),
            net_gmv: cell(totals.total_order_settle_amount_for_roi2_1h_assist),
            order_count: cell(totals.total_pay_order_count_for_roi2_assist),
            show_cnt: cell(totals.show_cnt_for_roi2_assist),
            click_cnt: cell(totals.click_cnt_for_roi2_assist),
          };
          const detailAt = detail?.source_at || null;
          const detailCollectedAt = new Date().toISOString();
          taskInfo.realtime_detail = {
            source_at: detailAt,
            collected_at: detailCollectedAt,
            field_data_available: Object.values(fields).some(value => value != null),
            data_valid: detailAt != null && Object.values(fields).some(value => value != null),
            financial_group_complete: ['cost', 'gmv_include_coupon', 'roi', 'net_gmv', 'net_roi', 'order_count']
              .every(key => fields[key] != null),
            reason: Object.values(fields).some(value => value != null)
              ? 'detail_totals_not_merged_with_daily_financial_group'
              : 'detail_totals_unavailable',
            values: fields,
          };
          // BTR remains the only coherent daily financial group. Leave its source_at
          // unchanged: the caller must not mistake a partial detail call as fresh.
          taskInfo.metric_sources = { ...(taskInfo.metric_sources || {}), realtime_detail: 'boost_material_detail_totals' };
          taskInfo.realtime_detail_freshness = detailAt && taskInfo.realtime_detail.financial_group_complete
            ? 'fresh_separate_detail' : detailAt ? 'partial_detail' : 'source_time_unavailable';
        } catch (e) {
          if (e.message === 'cookie_expired') throw e;
          taskInfo.realtime_detail = { source_at: null, collected_at: new Date().toISOString(), field_data_available: false, data_valid: false, financial_group_complete: false,
            reason: 'detail_request_failed', values: {} };
          taskInfo.realtime_detail_freshness = 'daily_report_or_detail_unavailable';
        }
      }
    }));
  }
  // 汇总优先用今日报表 totals（gmv/cost 与 ROI 同口径，与千川后台一致）；fetchBoostSummary 窄口径仅兜底
  summary.count = tasks.length; // 任务数与汇总走哪个分支无关，兜底分支也要给（契约字段语义一致）
  if (btrToday && btrToday.totals) {
    summary.total_cost = num(btrToday.totals.cost);
    summary.total_gmv = num(btrToday.totals.gmv);
    summary.total_roi = nullable(btrToday.totals.payRoi);
    summary.total_orders = num(btrToday.totals.orderCount);
  }

  const out = {
    source_at: collectedTimes.sort()[0] || null,
    window: { start: today, end: today, scope: 'daily' },
    data_valid: !!btrToday && !btrToday.truncated && tasksComplete,
    tasks,
    summary,
    quota: { in_use: quotaInUseBudget, paused_deleted_cost: quotaPausedDeletedCost },
    truncated: !tasksComplete || (btrToday ? !!btrToday.truncated : false)
  };
  out.coverage = boostObservation.enrich(account, tasks, { sessionKey: opts.sessionKey || null, complete: !out.truncated, excluded });
  return out;
}

module.exports = { getBoostMetricsToday, invalidateBoostMetrics };
