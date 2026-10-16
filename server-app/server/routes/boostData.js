const { fetchBoostOverview, fetchBoostTrend, fetchBoostMaterialDetail, fetchBoostSupport, fetchBoostOptLog, fetchSuggestedRoi, fetchBoostList } = require('../lib/qianchuanTabs');
const { deleteBoostTask } = require('../lib/qianchuan');
const { sendJSON, readJsonBody, requireWriteAuth, handleApiError, validateDateRange, checkBodyKeys } = require('../lib/utils');
const { describeResult } = require('../lib/qcErrors');
const opLog = require('../lib/operationLog');
const { executeWithReceipt } = require('../lib/writeReceipt');
const { withTargetWriteLock } = require('../lib/targetWriteLock');
const { boostTaskContract } = require('../lib/boostTaskContract');
const { attachRoiGoalContract, inferRoiGoalBasis } = require('../lib/roiBasis');

const BOOST_EFFECT_ROI_BASIS = Object.freeze({
  gmv: 'payment',
  roi: 'payment',
  net_roi: 'platform_net_1h',
});

function metricValueOrNull(cell) {
  if (cell == null) return null;
  if (typeof cell === 'object' && cell.controlType != null && Number(cell.controlType) === 0) return null;
  const value = typeof cell === 'object'
    ? (cell.Value != null ? cell.Value : cell.value != null ? cell.value : cell.ValueStr)
    : cell;
  if (value == null || value === '') return null;
  const number = Number(String(value).replace(/,/g, '').replace(/%$/, ''));
  return Number.isFinite(number) ? number : null;
}

function metricValidity(record) {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, value != null]));
}

/**
 * 追投效果数据路由：
 *
 * GET /api/boost-overview?assistAid=&anchorId=&startDate=&endDate=&account=
 *   追投效果概览（汇总指标 + 昨日环比）
 *
 * GET /api/boost-trend?assistAid=&anchorId=&startDate=&endDate=&account=
 *   追投效果趋势（按小时）
 *
 * GET /api/boost-material-detail?assistAid=&startDate=&endDate=&account=
 *   追投素材明细（每个素材的效果数据）
 *
 * GET /api/boost-support?adId=&startDate=&endDate=&account=
 *   追投流量扶持数据（累计 + 增量）
 *
 * POST /api/boost-delete
 *   删除追投任务 body: { assistTaskId, accountId }
 */
async function handleBoostData(req, res, url) {
  const pathname = url.pathname;

  // ===== GET 接口 =====
  if (req.method === 'GET') {
    const account = url.searchParams.get('account') || undefined;

    // 追投效果概览
    if (pathname === '/api/boost-overview') {
      const assistAid = url.searchParams.get('assistAid');
      const anchorId = url.searchParams.get('anchorId');
      if (!assistAid || !anchorId) return sendJSON(res, { ok: false, error: 'Missing assistAid or anchorId' }, 400);
      const startDate = url.searchParams.get('start') || url.searchParams.get('startDate') || getToday();
      const endDate = url.searchParams.get('end') || url.searchParams.get('endDate') || getToday();
      try {
        const result = await fetchBoostOverview(assistAid, anchorId, startDate, endDate, account);
        return sendJSON(res, {
          ok: true, assistAid, startDate, endDate,
          metric_roi_basis: { default: 'unknown' },
          data: result && result.data,
        });
      } catch (e) {
        return handleApiError(res, e);
      }
    }

    // 追投效果趋势
    if (pathname === '/api/boost-trend') {
      const assistAid = url.searchParams.get('assistAid');
      const anchorId = url.searchParams.get('anchorId');
      if (!assistAid || !anchorId) return sendJSON(res, { ok: false, error: 'Missing assistAid or anchorId' }, 400);
      const startDate = url.searchParams.get('start') || url.searchParams.get('startDate') || getToday();
      const endDate = url.searchParams.get('end') || url.searchParams.get('endDate') || getToday();
      try {
        const result = await fetchBoostTrend(assistAid, anchorId, startDate, endDate, account);
        return sendJSON(res, {
          ok: true, assistAid, startDate, endDate,
          metric_roi_basis: { default: 'unknown' },
          data: result && result.data,
        });
      } catch (e) {
        return handleApiError(res, e);
      }
    }

    // 追投素材明细
    if (pathname === '/api/boost-material-detail') {
      const assistAid = url.searchParams.get('assistAid');
      if (!assistAid) return sendJSON(res, { ok: false, error: 'Missing assistAid' }, 400);
      const primaryAdId = url.searchParams.get('primaryAdId') || url.searchParams.get('adId');
      const startDate = url.searchParams.get('start') || url.searchParams.get('startDate') || getToday();
      const endDate = url.searchParams.get('end') || url.searchParams.get('endDate') || getToday();
      const slim = url.searchParams.get('slim') === '1';
      const sessionKey = url.searchParams.get('session_key') || null;
      try {
        const result = await fetchBoostMaterialDetail(assistAid, startDate, endDate, account);
        // 素材明细响应通常只有 StatsData。调用方同时给出主计划 ID 时，额外用真实
        // 追投列表回读优化元数据；回读失败时保持 unknown，不猜口径也不影响只读明细。
        let optimizationEntity = result && result.data && (
          result.data.adInfo || result.data.taskInfo || result.data.assistTaskInfo || result.data
        );
        if (primaryAdId) {
          try {
            const listResult = await fetchBoostList(primaryAdId, startDate, endDate, account, { includeAllStatus: true });
            const tasks = (listResult && listResult.data && listResult.data.adInfos) || [];
            optimizationEntity = tasks.find(task => String(task.id) === String(assistAid)) || optimizationEntity;
          } catch (readbackError) {
            console.log(`[boost-material-detail] ROI 口径回读失败: ${readbackError.message}`);
          }
        }
        const roiContract = attachRoiGoalContract(optimizationEntity);
        const task_contract = boostTaskContract(optimizationEntity || {}, {
          id: String(assistAid), status: optimizationEntity?.adDeliveryName,
          start_time: optimizationEntity?.startTime || optimizationEntity?.createTime || null,
          budget: optimizationEntity?.budget == null ? null : Number(optimizationEntity.budget) / 100000,
          roi_goal: optimizationEntity?.ecpRoi2Goal, passive_stop: require('../lib/utils').isPassiveStop(optimizationEntity?.adDeliveryName),
        }, { accountId: account, sourceAt: result?.source_at || null, start: startDate, end: endDate, sessionKey });
        if (slim) {
          // 历史账户专用说明已从试用包移除。
          // 盯盘轮筛选优秀素材一次拿全，不再拉全量明细
          const stats = result && result.data && result.data.StatsData;
          const materials = (stats && Array.isArray(stats.Rows) ? stats.Rows : []).map(m => {
            const d = m.Dimensions || {};
            const mt = m.Metrics || {};
            const metrics = {
              cost: metricValueOrNull(mt.stat_cost_for_roi2_assist),
              show_cnt: metricValueOrNull(mt.show_cnt_for_roi2_assist),
              click_cnt: metricValueOrNull(mt.click_cnt_for_roi2_assist),
              ctr: metricValueOrNull(mt.ctr_for_roi2_assist),
              clicks: metricValueOrNull(mt.click_cnt_for_roi2_assist),
              cpc: (() => { const cost = metricValueOrNull(mt.stat_cost_for_roi2_assist); const clicks = metricValueOrNull(mt.click_cnt_for_roi2_assist); return cost != null && clicks > 0 ? +(cost / clicks).toFixed(4) : null; })(),
              clickRate: metricValueOrNull(mt.ctr_for_roi2_assist),
              orders: metricValueOrNull(mt.total_pay_order_count_for_roi2_assist),
              gmv: metricValueOrNull(mt.total_pay_order_gmv_for_roi2_assist),
              roi: metricValueOrNull(mt.total_prepay_and_pay_order_roi2_assist),
              net_roi: metricValueOrNull(mt.total_prepay_and_pay_settle_roi2_1h_assist),
            };
            return {
              name: (d.assist_material_name && d.assist_material_name.Value) || '',
              material_id: (d.material_id && d.material_id.Value) || '',
              ...metrics,
              field_validity: metricValidity(metrics),
              metric_roi_basis: BOOST_EFFECT_ROI_BASIS,
            };
          }).sort((a, b) => (b.cost == null ? -Infinity : b.cost) - (a.cost == null ? -Infinity : a.cost));
          const t = (stats && stats.Totals) || {};
          const totalMetrics = {
            cost: metricValueOrNull(t.stat_cost_for_roi2_assist),
            show_cnt: metricValueOrNull(t.show_cnt_for_roi2_assist),
            click_cnt: metricValueOrNull(t.click_cnt_for_roi2_assist),
            ctr: metricValueOrNull(t.ctr_for_roi2_assist),
            clicks: metricValueOrNull(t.click_cnt_for_roi2_assist),
            cpc: (() => { const cost = metricValueOrNull(t.stat_cost_for_roi2_assist); const clicks = metricValueOrNull(t.click_cnt_for_roi2_assist); return cost != null && clicks > 0 ? +(cost / clicks).toFixed(4) : null; })(),
            clickRate: metricValueOrNull(t.ctr_for_roi2_assist),
            orders: metricValueOrNull(t.total_pay_order_count_for_roi2_assist),
            gmv: metricValueOrNull(t.total_pay_order_gmv_for_roi2_assist),
            roi: metricValueOrNull(t.total_prepay_and_pay_order_roi2_assist),
            net_roi: metricValueOrNull(t.total_prepay_and_pay_settle_roi2_1h_assist),
          };
          const totals = {
            ...totalMetrics,
            field_validity: metricValidity(totalMetrics),
            metric_roi_basis: BOOST_EFFECT_ROI_BASIS,
          };
          return sendJSON(res, {
            ok: true, assistAid, primary_ad_id: primaryAdId || null, startDate, endDate, session_key: sessionKey, slim: true,
            ...roiContract, task_contract,
            metric_roi_basis: BOOST_EFFECT_ROI_BASIS,
            settlement_window: { net_roi: '1h' },
            data: { materials, totals },
          });
        }
        return sendJSON(res, {
          ok: true, assistAid, primary_ad_id: primaryAdId || null, startDate, endDate, session_key: sessionKey,
          ...roiContract, task_contract,
          metric_roi_basis: BOOST_EFFECT_ROI_BASIS,
          settlement_window: { net_roi: '1h' },
          data: result && result.data,
        });
      } catch (e) {
        return handleApiError(res, e);
      }
    }

    // 追投流量扶持
    if (pathname === '/api/boost-support') {
      const adId = url.searchParams.get('adId');
      if (!adId) return sendJSON(res, { ok: false, error: 'Missing adId' }, 400);
      const startDate = url.searchParams.get('start') || url.searchParams.get('startDate') || getToday();
      const endDate = url.searchParams.get('end') || url.searchParams.get('endDate') || getToday();
      try {
        const result = await fetchBoostSupport(adId, startDate, endDate, account);
        return sendJSON(res, {
          ok: true, adId, startDate, endDate,
          metric_roi_basis: { default: 'unknown' },
          data: result,
        });
      } catch (e) {
        return handleApiError(res, e);
      }
    }

    // 追投ROI操作日志
    if (pathname === '/api/boost-opt-log') {
      const aggAid = url.searchParams.get('aggAid');
      if (!aggAid) return sendJSON(res, { ok: false, error: 'Missing aggAid (全域计划ID)' }, 400);
      const startDate = url.searchParams.get('start') || url.searchParams.get('startDate') || getToday();
      const endDate = url.searchParams.get('end') || url.searchParams.get('endDate') || getToday();
      try {
        const result = await fetchBoostOptLog(aggAid, startDate, endDate, account);
        const optLogs = result && result.data && result.data.optLogs ? result.data.optLogs : [];
        return sendJSON(res, {
          ok: true,
          aggAid,
          startDate,
          endDate,
          count: optLogs.length,
          hasPurePayRoi: result && result.data ? result.data.hasPurePayRoi : null,
          hasOverallRoi: result && result.data ? result.data.hasOverallRoi : null,
          logs: optLogs.map(log => ({
            modify_ts: log.modifyTs,
            modify_time: log.modifyTs ? new Date(parseInt(log.modifyTs) * 1000).toLocaleString('zh-CN', { hour12: false }) : null,
            before_roi: log.beforeEcpRoi2Goal,
            after_roi: log.afterEcpRoi2Goal,
            before_roi_basis: inferRoiGoalBasis({ deepExternalAction: log.beforeDeepEa }).basis,
            after_roi_basis: inferRoiGoalBasis({ deepExternalAction: log.afterDeepEa }).basis,
            before_deep_action: log.beforeDeepEa,
            after_deep_action: log.afterDeepEa,
            before_type: log.beforeType,
            after_type: log.afterType,
            before_cost_items: log.beforeOverallRoiCostItems,
            after_cost_items: log.afterOverallRoiCostItems,
            before_adlab_scene: log.beforeAdlabScene,
            after_adlab_scene: log.afterAdlabScene,
          })),
        });
      } catch (e) {
        return handleApiError(res, e);
      }
    }

    // 追投建议ROI目标
    if (pathname === '/api/boost-suggest-roi') {
      const adId = url.searchParams.get('adId');       // 追投任务ID
      const primaryAdId = url.searchParams.get('primaryAdId'); // 全域计划ID
      const anchorId = url.searchParams.get('anchorId');      // 主播ID
      if (!adId || !primaryAdId || !anchorId) {
        return sendJSON(res, { ok: false, error: 'Missing adId, primaryAdId, or anchorId' }, 400);
      }
      try {
        const result = await fetchSuggestedRoi(adId, primaryAdId, anchorId, account);
        const outputs = result && result.data && result.data.getSuggestedRoiGoalOutputs ? result.data.getSuggestedRoiGoalOutputs : [];
        return sendJSON(res, {
          ok: true,
          adId,
          primaryAdId,
          anchorId,
          suggestions: outputs.map((s, i) => {
            const deepExternalAction = i === 0 ? 326 : 576;
            return {
              deep_external_action: deepExternalAction,
              action_name: i === 0 ? '直播间支付' : '净成交ROI',
              roi_basis: inferRoiGoalBasis({ deepExternalAction }).basis,
              suggested_roi: s.ecpRoi2Goal,
              roi_lower_bound: s.roi2LowerBound,
              roi_upper_bound: s.roi2UpperBound,
              roi_high: s.roi2High,
              order_pay_rate: s.orderPayRate,
              is_accepted: s.isAccepted,
            };
          }),
        });
      } catch (e) {
        return handleApiError(res, e);
      }
    }

    return sendJSON(res, { ok: false, error: 'Not Found' }, 404);
  }

  // ===== POST: 删除追投任务 =====
  if (pathname === '/api/boost-delete' && req.method === 'POST') {
    if (!requireWriteAuth(req, res)) return;
    const { data, error } = await readJsonBody(req);
    if (error) return sendJSON(res, { ok: false, error: error.message }, error.status);
    // body 参数白名单（2026-08-11 backlog 检修）
    const bodyCheck = checkBodyKeys(data, ['accountId', 'primaryAdId', 'assistTaskId', 'source'], '/api/boost-delete');
    if (!bodyCheck.ok) return sendJSON(res, { ok: false, error: bodyCheck.error }, 400);

    const { assistTaskId, accountId: accountIdCamel, account_id: accountIdSnake } = data;
    const accountId = accountIdCamel || accountIdSnake; // MCP 工具面参数名 account_id（下划线），双收兼容（2026-08-11 修复）
    const boundPlan = req._qcWriteAuthorization?.binding?.primary_ad_id;
    const primaryAdId = data.primaryAdId || (Array.isArray(boundPlan) ? (boundPlan.length === 1 ? boundPlan[0] : null) : boundPlan);
    if (!assistTaskId) return sendJSON(res, { ok: false, error: 'Missing assistTaskId' }, 400);
    if (!accountId) return sendJSON(res, { ok: false, error: 'Missing accountId' }, 400);
    if (!primaryAdId) return sendJSON(res, { ok: false, code: 'primary_plan_required', error: '删除追投必须指定唯一主计划', advertising_writes: 0, effect_status: 'rejected' }, 400);
    // 账号白名单：拼错的账号会回落默认 cookie，对错账号执行写操作（2026-07-25 审查修复）
    try { require('../lib/api-helpers').validateAccount(accountId); } catch (e) {
      return sendJSON(res, { ok: false, error: e.message }, 400);
    }

    return withTargetWriteLock(accountId, assistTaskId, async () => {
    try { require('../lib/boostExecutionOwner').assertBoostExecutionOwner(req, accountId, primaryAdId); }
    catch (error) { return handleApiError(res,error); }
    // 2026-09-22：按用户明确要求移除「删除频率熔断」（原 2026-07-25 审查补闸）。
    // 原逻辑：同目标 1 小时内成功删除 ≥3 次即返回 429 blocked / boost_delete_rate_limit。
    // 移除理由：经复核该闸在本流程中从未触发（每目标每场仅删除 1 次），用户明确要求
    // 删除动作不受此闸限制。仍然保留的护栏：withTargetWriteLock 写锁、requireWriteAuth、
    // 账号白名单校验、onboardingGuard 场次与动作校验、旧值落盘、executeWithReceipt 写后回读。

    try {
      // 无论是否配置额外 scope，均须在请求账户与主计划下找到真实目标。
      // 列表缺项只表示归属无法核验，不能据此删除或绕过另一主计划的执行归属。
      let list;
      try {
        list = await fetchBoostList(String(primaryAdId), getToday(), getToday(), accountId, { includeAllStatus: true });
      } catch (e) {
        throw Object.assign(e, { advertising_writes: 0 });
      }
      if ((list?.status_code ?? list?.code) !== 0 || !Array.isArray(list.data?.adInfos))
        throw Object.assign(new Error('追投归属暂不可核验，本次未写入'), { code: 'target_verification_failed', statusCode: 502, advertising_writes: 0 });
      const t = list.data.adInfos.find(x => String(x.id) === String(assistTaskId));
      if (!t) throw Object.assign(new Error('当前主计划列表未找到该任务，先只读核对归属，本次未写入'), { code: 'target_not_in_list', statusCode: 403, advertising_writes: 0 });
      const oldValue = { budget: Number(t.budget) / 100000, roi_goal: t.ecpRoi2Goal || null, status: t.adDeliveryName, name: t.name, smart_bid_type: t.smartBidType };

      const receipt = await executeWithReceipt({
        write: async () => {
          // 回读旧值可能耗时；提交删除前再核对一次，迟到成交不能被旧快照误删。
          if (req._qcWriteAuthorization) await require('../lib/onboardingGuard').verifyBoostScope(req._qcWriteAuthorization, data);
          require('../lib/boostExecutionOwner').assertBoostExecutionOwner(req, accountId, primaryAdId);
          return deleteBoostTask(assistTaskId, accountId);
        },
        read: async () => {
          const list = await fetchBoostList(String(primaryAdId), getToday(), getToday(), accountId, { includeAllStatus: true });
          if ((list.status_code ?? list.code) !== 0) throw new Error('readback_list_failed');
          const task = list.data?.adInfos?.find(t => String(t.id) === String(assistTaskId));
          // An absent row is not deletion proof (pagination/filter/latency can hide it).
          return task ? { deleted: /已删除/.test(task.adDeliveryName || ''), status: task.adDeliveryName } : null;
        },
        before: oldValue, requested: { deleted: true },
        logEntry: { action: 'delete_boost', account_id: accountId, target_type: 'boost_task', target_id: assistTaskId,
          params: { assistTaskId, old_value: oldValue }, source: opLog.normalizeSource(data.source) },
      });
      if (receipt.ok) require('./liveDashboard').invalidatePlanCache(accountId);
      return sendJSON(res, receipt, receipt.ok ? 200 : (receipt.http_status || 502));
    } catch (e) {
      opLog.log({ action: 'delete_boost', account_id: accountId, target_type: 'boost_task', target_id: assistTaskId, success: false, result_msg: e.message, source: opLog.normalizeSource(data.source) });
      return handleApiError(res, e);
    }
    });
  }

  return sendJSON(res, { ok: false, error: 'Not Found' }, 404);
}

function getToday() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

module.exports = handleBoostData;
