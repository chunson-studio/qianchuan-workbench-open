const { createBoostTask } = require('../lib/qianchuan');
const { sendJSON, readJsonBody, requireWriteAuth, handleApiError, checkBodyKeys } = require('../lib/utils');
const { describeResult } = require('../lib/qcErrors');
const opLog = require('../lib/operationLog');
const { executeWithReceipt, normalizedTarget } = require('../lib/writeReceipt');
const { withTargetWriteLock } = require('../lib/targetWriteLock');
const { validateRoiGoalWrite } = require('../lib/roiBasis');

/**
 * POST /api/boost-create
 *
 * 创建追投任务（给素材开追投）。
 *
 * Body:
 *   {
 *     primaryAdId: "<PRIMARY_AD_ID>",      // 全域计划ID
 *     requestId: "<UNIQUE_REQUEST_ID>",    // 可选；不同任务用不同编号，网络重试沿用原编号；相同参数可连续创建
 *     mids: ["<MATERIAL_ID>"],             // 素材ID列表
 *     budget: 100,                         // 预算（元）
 *     name: "追投任务名称",                 // 可选
 *     smartBidType: 0,                     // 0=控成本(默认), 7=放量
 *     ecpRoi2Goal: 1.25,                   // ROI目标（控成本必填）
 *     duration: 7200,                      // 投放时长秒数（放量必填）
 *     marGoal: 1,                          // 可选：2=直播间(默认) 1=商品卡（2026-08-03 启用：官方仅放量形态——必传 duration、禁传 ecpRoi2Goal、无需在播）
 *     bid: 22,                             // 可选：手动出价 元/成交（2026-08-03 探针权威形状）——传了即出价形态，与 ecpRoi2Goal 互斥；护栏：15~35 元、仅 marGoal=2、预算≤300
  * 历史账户专用说明已从试用包移除。
 *     liveFeed: true,                      // 可选：直播间画面，与 mids 互斥；支持放量+duration或手动bid，AggregateCids服务端取值
 *     assistTask: true,                    // 可选：一键起量形态（2026-08-17 探针权威 body）——Scene=1+InterfereType=1+Duration，无素材/ROI/出价维度，预算100~5000元
  * 历史账户专用说明已从试用包移除。
 *   }
 *
 * 返回:
 *   - ok: 是否成功
 *   - task_id: 追投任务ID（成功时）
 *   - raw: 原始响应
 */
async function handleSingleBoostCreate(req, res, url) {
  if (req.method !== 'POST') return sendJSON(res, { ok: false, error: 'Method Not Allowed' }, 405);
  if (!requireWriteAuth(req, res)) return;

  const { data, error } = await readJsonBody(req);
  if (error) return sendJSON(res, { ok: false, error: error.message }, error.status);
  // body 参数白名单（2026-08-11 backlog 检修：未知字段 400，绝不静默忽略）
  const bodyCheck = checkBodyKeys(data, ['accountId', 'account_id', 'primaryAdId', 'mids', 'budget', 'name', 'smartBidType', 'ecpRoi2Goal', 'roiBasis', 'roi_basis', 'duration', 'marGoal', 'bid', 'audienceTemplate', 'liveFeed', 'assistTask', 'source'], '/api/boost-create');
  if (!bodyCheck.ok) return sendJSON(res, { ok: false, error: bodyCheck.error }, 400);

  const { primaryAdId, mids, budget, name, smartBidType, ecpRoi2Goal, duration, marGoal, accountId: accountIdCamel, account_id: accountIdSnake, roiBasis: roiBasisCamel, roi_basis: roiBasisSnake, bid, audienceTemplate, liveFeed, assistTask } = data;
  const accountId = accountIdCamel || accountIdSnake; // MCP 工具面参数名 account_id（下划线），双收兼容（2026-08-11 修复）
  const roiBasis = roiBasisCamel != null ? roiBasisCamel : roiBasisSnake;

  // 参数校验
  if (!accountId) return sendJSON(res, { ok: false, error: 'Missing accountId' }, 400);
  // 账号白名单：拼错的账号会回落默认 cookie，对错账号执行写操作（2026-07-25 审查修复）
  try { require('../lib/api-helpers').validateAccount(accountId); } catch (e) {
    return sendJSON(res, { ok: false, error: e.message }, 400);
  }
  if (!primaryAdId) return sendJSON(res, { ok: false, error: 'Missing primaryAdId (全域计划ID)' }, 400);
  const isLiveFeed = liveFeed === true;
  const isAssist = assistTask === true; // 一键起量形态（2026-08-17 探针）：Scene=1+InterfereType=1+Duration，无素材维度
  const midsSafe = (isLiveFeed || isAssist) ? [] : (mids || []);
  if (isLiveFeed) {
    // 历史账户专用说明已从试用包移除。
    if (mids && Array.isArray(mids) && mids.length > 0) {
      return sendJSON(res, { ok: false, error: 'liveFeed=直播间画面形态与视频素材互斥（千川：直播间画面和视频不支持同时选择），请去掉 mids' }, 400);
    }
  } else if (!isAssist && (!mids || !Array.isArray(mids) || mids.length === 0)) {
    return sendJSON(res, { ok: false, error: 'Missing mids (素材ID列表；直播间画面形态传 liveFeed=true)' }, 400);
  }
  if (!isAssist && !isLiveFeed && mids.length > 50) {
    return sendJSON(res, { ok: false, error: 'mids 最多50个素材' }, 400);
  }
  if (!isAssist && !isLiveFeed && !mids.every(id => /^\d{1,30}$/.test(String(id)))) {
    return sendJSON(res, { ok: false, error: 'mids 元素必须为数字字符串' }, 400);
  }
  if (name && String(name).length > 100) {
    return sendJSON(res, { ok: false, error: 'name 长度不能超过100字符' }, 400);
  }
  // 历史账户专用说明已从试用包移除。
  // 千川后台列表一眼区分人机——人工后台建的任务是默认时间戳名，Agent 建的一律带「椿-」标记。
  // 2026-09-29 用户指定：不再使用 AI- 前缀，统一改用「椿」。
  let taskName = name && String(name).trim() ? String(name).trim() : undefined;
  if (taskName && !taskName.startsWith('椿')) taskName = '椿-' + taskName;
  if (budget == null) return sendJSON(res, { ok: false, error: 'Missing budget (预算)' }, 400);

  const budgetNum = parseFloat(budget);
  // 2026-09-20 官方页面成功请求：直播间放量预算 100 元 = 10000000 微。
  const acceptsHundred = isAssist || Number(smartBidType) === 7;
  if (!Number.isFinite(budgetNum) || budgetNum > 10000000 || (acceptsHundred ? budgetNum < 100 : budgetNum <= 100) || (isAssist && budgetNum > 5000)) {
    return sendJSON(res, { ok: false, error: isAssist ? 'budget must be 100~5000 (一键调速预算 100~5000 元)' : acceptsHundred ? 'budget must be between 100 and 10,000,000' : 'budget must be greater than 100 and up to 10,000,000' }, 400);
  }

  // ===== 一键起量形态专属校验（2026-08-17 探针权威 body，references/qianchuan-assist-task-api.md）=====
  // Scene=1+InterfereType=1+Duration：按时长加速，无素材/ROI/出价/定向/控成本概念
  if (isAssist) {
    if (ecpRoi2Goal != null) {
      return sendJSON(res, { ok: false, error: '一键起量(assistTask)无 ROI 目标维度（按 duration 时长加速），请去掉 ecpRoi2Goal' }, 400);
    }
    if (bid != null) {
      return sendJSON(res, { ok: false, error: '一键起量(assistTask)无手动出价维度，请去掉 bid' }, 400);
    }
    if (liveFeed === true) {
      return sendJSON(res, { ok: false, error: '一键起量(assistTask)与直播间画面形态(liveFeed)互斥，请二选一' }, 400);
    }
    if (duration == null) {
      return sendJSON(res, { ok: false, error: '一键起量(assistTask)必须传 duration (投放时长秒数，如 7200=2小时)' }, 400);
    }
    const durVal = parseInt(duration, 10);
    if (!Number.isFinite(durVal) || durVal < 60 || durVal > 86400) {
      return sendJSON(res, { ok: false, error: 'duration must be between 60 and 86400 seconds' }, 400);
    }
  }

  const bidType = smartBidType != null ? parseInt(smartBidType, 10) : 0;
  if (![0, 7].includes(bidType)) {
    return sendJSON(res, { ok: false, error: 'smartBidType must be 0 (控成本) or 7 (放量)' }, 400);
  }

  // 营销目标（2026-08-03 启用商品卡链路）：1=商品卡 2=直播间(默认)
  let marGoalNum = 2;
  if (marGoal != null) {
    marGoalNum = parseInt(marGoal, 10);
    if (![1, 2].includes(marGoalNum)) {
      return sendJSON(res, { ok: false, error: 'marGoal must be 1 (商品卡) or 2 (直播间，默认)' }, 400);
    }
  }
  // 商品卡(marGoal=1)官方仅放量形态（2026-07-30 抓包 references/qianchuan-chengfang-api.md §二十四）：
  // 千川只认 Budget+Duration，无 ROI 目标/控成本字段——带 ecpRoi2Goal 一律 400 防呆（P0 不静默忽略）；
  // 商品卡全天售卖，其放量不做在播检查（下方在播闸仅限 marGoal=2）。
  if (marGoalNum === 1 && ecpRoi2Goal != null) {
    return sendJSON(res, { ok: false, error: '商品卡追投(marGoal=1)不支持 ROI 目标（官方接口无此字段），靠 budget+duration 控制节奏；请去掉 ecpRoi2Goal 并传 duration' }, 400);
  }

  // ===== 手动出价模式（2026-08-03 探针权威形状，references/boost-manual-bid-audience.md）=====
  // 传 bid 即出价形态：Bid+ExternalAction=169+DeepExternalAction=0，与 ecpRoi2Goal 互斥（出价模式无 ROI 目标概念）。
  // 历史账户专用说明已从试用包移除。
  const bidNum = bid != null ? parseFloat(bid) : null;
  if (bid != null) {
    if (!Number.isFinite(bidNum) || bidNum < 15 || bidNum > 35) {
      return sendJSON(res, { ok: false, error: 'bid must be between 15 and 35 (手动出价 15~35 元/成交，护栏范围)' }, 400);
    }
    if (marGoalNum !== 2) {
      return sendJSON(res, { ok: false, error: '手动出价(bid)目前仅验证过直播间(marGoal=2)形态，商品卡(marGoal=1)请勿传 bid' }, 400);
    }
    if (bidType !== 0) {
      return sendJSON(res, { ok: false, error: '手动出价(bid)与放量(smartBidType=7)互斥，请去掉 smartBidType=7' }, 400);
    }
    if (ecpRoi2Goal != null) {
      return sendJSON(res, { ok: false, error: '手动出价(bid)与 ecpRoi2Goal 互斥（出价模式没有 ROI 目标概念），请去掉 ecpRoi2Goal' }, 400);
    }
    if (budgetNum > 300) {
      return sendJSON(res, { ok: false, error: '手动出价模式单笔预算必须 ≤300 元（学习期护栏，跑通后再提额）' }, 400);
    }
    if (audienceTemplate != null && !require('../lib/boostAudienceTemplates').getTemplate(audienceTemplate)) {
      return sendJSON(res, { ok: false, error: `audienceTemplate 未知：${audienceTemplate}（白名单：full_region=全地域；不传不套用定向模板）` }, 400);
    }
  }

  // 历史账户专用说明已从试用包移除。
  if (isLiveFeed && bidNum == null && bidType !== 7) {
    return sendJSON(res, { ok: false, error: '直播间画面需选择放量(smartBidType=7+duration)或已支持的手动出价(bid)' }, 400);
  }

  // 控成本必须传 ROI 目标（商品卡 marGoal=1 与手动出价互斥闸上方已处理，跳过此闸；一键起量形态豁免）
  if (bidType === 0 && marGoalNum !== 1 && bidNum == null && ecpRoi2Goal == null && !isAssist) {
    return sendJSON(res, { ok: false, error: '控成本投放(smartBidType=0)必须传 ecpRoi2Goal (ROI目标)' }, 400);
  }

  // ROI 范围校验
  if (ecpRoi2Goal != null) {
    const roiVal = parseFloat(ecpRoi2Goal);
    if (!Number.isFinite(roiVal) || roiVal < 0.01 || roiVal > 100) {
      return sendJSON(res, { ok: false, error: 'ecpRoi2Goal must be between 0.01 and 100' }, 400);
    }
  }

  // ROI 写入必须先用真实计划优化元数据确认口径。用户参数只用于一致性核对，
  // 不能在计划元数据缺失时替代事实来源。
  return withTargetWriteLock(accountId, primaryAdId, async () => {
  try { require('../lib/boostExecutionOwner').assertBoostExecutionOwner(req, accountId, primaryAdId); }
  catch (error) { return handleApiError(res,error); }
  let roiContract = null;
  if (ecpRoi2Goal != null) {
    const planMetadata = await fetchPlanOptimizationMetadata(accountId, primaryAdId, marGoalNum);
    roiContract = validateRoiGoalWrite({ providedBasis: roiBasis, entity: planMetadata });
    if (!roiContract.ok) {
      const { status, ...payload } = roiContract;
      return sendJSON(res, payload, status || 400);
    }
  }

  // 放量必须传时长（商品卡 marGoal=1 官方仅放量形态，同样必传）
  if ((bidType === 7 || marGoalNum === 1) && duration == null) {
    return sendJSON(res, { ok: false, error: '放量投放(smartBidType=7 或商品卡 marGoal=1)必须传 duration (投放时长秒数)' }, 400);
  }

  // duration 范围校验（60秒 ~ 86400秒=1天）
  if (duration != null) {
    const durVal = parseInt(duration, 10);
    if (!Number.isFinite(durVal) || durVal < 60 || durVal > 86400) {
      return sendJSON(res, { ok: false, error: 'duration must be between 60 and 86400 seconds' }, 400);
    }
  }

  // 放量投放要求直播间正在直播，先检查直播状态（商品卡 marGoal=1 全天售卖，豁免在播闸；一键起量形态豁免——千川终验兜底）
  if (bidType === 7 && marGoalNum !== 1 && !isAssist) {
    try {
      const { fetchLiveStatus } = require('../lib/qianchuanTabs');
      const liveStatus = await fetchLiveStatus(accountId);
      if (!liveStatus.isLive) {
        return sendJSON(res, {
          ok: false,
          error: '放量投放要求直播间正在直播，当前未在播。请先开播或改用控成本(smartBidType=0)',
          live_status: liveStatus,
        }, 400);
      }
    } catch (e) {
      console.log(`[boost-create] 直播状态检查失败: ${e.message}`);
      // 检查失败不阻塞，让千川自己拒绝
    }
  }

  // 历史账户专用说明已从试用包移除。
  // 创建前逐条验证存在性；不存在的直接 400 拒并指明哪条。
  // 创建前核验素材归属，不设置本地创建次数或时间窗口限制。
  // 预检 API 自身故障（限频/cookie）不阻塞创建——千川侧仍有最终校验兜底。
  // 多源回退（2026-08-06 复盘修复：单一 video-library 源会把"在投/出过单"的素材误判死）：
  //   ① video-library（权威源，查无 → ②）
  //   ② 本地库 material_daily（有消耗记录 = 曾真实投放，ID 有效）
  //   ③ 直播大屏内存态（dashboard materials，今日在投/追投暂停）
  //   任一命中即放行；全源查无才 400（千川终验兜底仍在）。
  if (!isLiveFeed && !isAssist) try {
    const cv = require('../lib/creativeVideoLibrary');
    const invalid = [];
    const hitSource = {}; // mid -> 命中来源（错误信息与 op-log 留痕用）
    for (const mid of mids.map(String)) {
      // ① video-library 权威源
      const found = await cv.getByMaterialId(accountId, mid);
      if (found) { hitSource[mid] = 'video-library'; continue; }
      // ② 本地库 material_daily：有消耗/净成交记录 = 曾真实投放
      try {
        const { getDB } = require('../lib/db');
        const row = getDB().prepare(
          'SELECT COUNT(*) c FROM material_daily WHERE account_id = ? AND material_id = ? AND (cost > 0 OR net_gmv_1h > 0)'
        ).get(accountId, mid);
        if (row && row.c > 0) { hitSource[mid] = 'material_daily(本地历史库)'; continue; }
      } catch { /* 本地库不可用不阻塞，继续下一源 */ }
      // ③ 直播大屏内存态（今日在投/追投暂停的素材 = ID 有效）
      try {
        const { getLatestMaterialsAll } = require('../lib/liveCollector');
        const liveMats = getLatestMaterialsAll(accountId) || [];
        if (liveMats.some(m => String(m.material_id) === String(mid))) { hitSource[mid] = 'live-dashboard(今日大屏)'; continue; }
      } catch { /* 大屏内存态不可用不阻塞 */ }
      invalid.push(mid);
    }
    if (invalid.length) {
      opLog.log({
        action: 'create_boost',
        account_id: accountId,
        primary_ad_id: primaryAdId,
        target_type: 'material',
        target_id: midsSafe.join(','),
        params: { mids: midsSafe, budget: budgetNum, smartBidType: bidType, ecpRoi2Goal, roiBasis: roiContract && roiContract.roi_goal_basis, duration, marGoal: marGoalNum, name: taskName, precheck_sources: hitSource },
        success: false,
        result_msg: `素材ID全源未收录: ${invalid.join(',')}`,
        source: opLog.normalizeSource(data.source),
      });
      const hitNote = Object.keys(hitSource).length
        ? `（其余素材命中来源: ${Object.entries(hitSource).map(([m, s]) => `${m}=${s}`).join(', ')}）`
        : '';
      // 历史账户专用说明已从试用包移除。
      // 附上本地库可查名字——区分"查无"与"查有但无消耗"，避免 agent 误判素材已死
      let knownNote = '';
      try {
        const { getDB } = require('../lib/db');
        const known = getDB().prepare(
          'SELECT material_name FROM material_daily WHERE account_id = ? AND material_id = ? AND material_name IS NOT NULL AND material_name != \'\' ORDER BY stat_date DESC LIMIT 1'
        ).get(accountId, invalid[0]);
        if (known && known.material_name) {
          knownNote = `。本地库可查该ID: 「${known.material_name}」（无消耗记录，可能是新上传/未起量素材）`;
        }
      } catch { /* 本地库不可用不附 */ }
      return sendJSON(res, {
        ok: false,
        error: `素材ID在所有数据源均未收录（视频库/本地历史库/今日大屏均无记录，疑似编造或已删除），已拦截：${invalid.join('、')}。请用 get_material mode=search 按素材名查真实ID后重试${hitNote}${knownNote}`,
        invalid_mids: invalid,
        precheck_sources: hitSource,
        blocked: true,
        rule: 'boost_mid_precheck',
      }, 400);
    }
  } catch (e) {
    console.log(`[boost-create] 素材预检失败（不阻塞，千川终验兜底）: ${e.message}`);
  }

  // 主动创建允许相同参数；网络重试由 requestId 持久化去重。
  try {
    // 手动出价形态注入（权威 body 必传字段）；画面形态形状缺件必 400（AggregateCids 必传，缺了千川也是拒）
    const bidExtras = bidNum != null || isLiveFeed ? await resolveBidExtras(accountId, primaryAdId, audienceTemplate, isLiveFeed) : {};
    if (isLiveFeed && (!bidExtras.aggregateCids || !bidExtras.aggregateCids.length)) {
      return sendJSON(res, { ok: false, error: '直播间画面形态取值失败：未拿到主计划 aggregateCid（fetchUniPromAdList），请重试或排查接口' }, 502);
    }
    const receipt = await executeWithReceipt({
      write: () => {
        require('../lib/boostExecutionOwner').assertBoostExecutionOwner(req, accountId, primaryAdId);
        return createBoostTask({
      primaryAdId,
      mids: isLiveFeed ? undefined : mids,
      budget: budgetNum,
      name: taskName,
      smartBidType: bidType,
      ecpRoi2Goal: ecpRoi2Goal != null ? parseFloat(ecpRoi2Goal) : undefined,
      duration: duration != null ? parseInt(duration, 10) : undefined,
      marGoal: marGoalNum,
      bid: bidNum != null ? bidNum : undefined,
      assistTask: isAssist,
      ...bidExtras,
    }, accountId);
      },
      read: async result => {
        if (!result?.data?.id) return null;
        const { fetchBoostList } = require('../lib/qianchuanTabs');
        const today = require('../lib/utils').getLocalDateStr();
        const list = await fetchBoostList(primaryAdId, today, today, accountId, { includeAllStatus: true });
        return normalizedTarget(list?.data?.adInfos?.find(t => String(t.id) === String(result.data.id)));
      },
      before: null,
      requested: result => ({ id: result?.data?.id == null ? null : String(result.data.id), budget: budgetNum, smart_bid_type: bidType,
        // Duration is sent upstream only for time-driven create shapes. The receipt uses
        // an explicit seconds key so it cannot be confused with the UI's hour display.
        ...((isAssist || marGoalNum === 1 || bidType === 7) && duration != null
          ? { duration_seconds: parseInt(duration, 10) } : {}),
        ...(bidNum != null ? { bid: bidNum } : ecpRoi2Goal != null ? { roi_goal: Number(ecpRoi2Goal) } : {}) }),
      logEntry: result => ({
        action: 'create_boost', account_id: accountId, primary_ad_id: primaryAdId,
        assist_task_id: result?.data?.id || null, target_type: 'boost_task', target_id: result?.data?.id || primaryAdId,
        params: { mids: midsSafe, budget: budgetNum, smartBidType: bidType, ecpRoi2Goal, roiBasis: roiContract?.roi_goal_basis,
          duration, marGoal: marGoalNum, name: taskName, task_id: result?.data?.id, bid: bidNum,
          audienceTemplate: bidNum != null ? audienceTemplate : audienceTemplate, liveFeed: isLiveFeed },
        source: opLog.normalizeSource(data.source),
      }),
    });
    const result = receipt.result;
    const taskId = result?.data?.id || null;
    if (!receipt.ok) {
      const errMsg = describeResult(result) || receipt.error;
      return sendJSON(res, { ...receipt, error: errMsg, quota_exceeded: /额度|预算不足|daily.?budget|exceed|超限|不足/i.test(errMsg || '') }, receipt.http_status || 502);
    }

    // The fast dashboard otherwise keeps its old boost count for up to five minutes.
    require('./liveDashboard').invalidatePlanCache(accountId);

    return sendJSON(res, {
      ...receipt,
      task_id: taskId,
      message: receipt.effect_status === 'confirmed' ? `追投任务已创建并核验 (ID: ${taskId})` : receipt.message,
      primary_ad_id: primaryAdId,
      mids: midsSafe,
      live_feed: isLiveFeed || undefined,
      budget: budgetNum,
      smart_bid_type: bidType,
      mar_goal: marGoalNum,
      bid: bidNum != null ? bidNum : undefined,
      audience_template: bidNum != null ? audienceTemplate : undefined,
      roi_goal_basis: roiContract ? roiContract.roi_goal_basis : 'unknown',
      roi_basis_source: roiContract ? roiContract.roi_basis_source : 'not_applicable',
      optimization: roiContract ? roiContract.optimization : null,
      result,
    });
  } catch (e) {
    opLog.log({
      action: 'create_boost',
      account_id: accountId,
      primary_ad_id: primaryAdId,
      target_type: 'material',
      target_id: midsSafe.join(','),
      params: { mids: midsSafe, budget: budgetNum, smartBidType: bidType, ecpRoi2Goal, roiBasis: roiContract && roiContract.roi_goal_basis, duration, marGoal: marGoalNum, liveFeed: isLiveFeed || undefined },
      success: false,
      result_msg: e.message,
      source: opLog.normalizeSource(data.source),
    });
    return handleApiError(res, e);
  }
  });
}

async function fetchPlanOptimizationMetadata(accountId, primaryAdId, marGoal) {
  try {
    const { fetchUniPromAdList } = require('../lib/qianchuanTabs');
    if (typeof fetchUniPromAdList !== 'function') return null;
    const end = new Date();
    const start = new Date(end.getTime() - 90 * 86400000);
    const fmt = date => date.toISOString().slice(0, 10);
    const result = await fetchUniPromAdList(fmt(start), fmt(end), accountId, { marGoal });
    const plans = (result && result.data && (result.data.adInfos || result.data.adList || result.data.list)) || [];
    return plans.find(plan => String(plan.id) === String(primaryAdId)) || null;
  } catch (error) {
    console.log(`[boost-create] ROI 口径元数据读取失败: ${error.message}`);
    return null;
  }
}

// ===== 手动出价形态取值注入（2026-08-03 探针+实测）=====
// Audience = 定向模板（PascalCase，默认 core_region）。
// 视频形态：⚠️ AggregateCids 不传（它是"直播间画面"聚合创意，与 Mids 互斥——同传 3001 实测）。
// 画面形态（liveFeed）：AggregateCids=主计划 aggregateCid（fetchUniPromAdList 取，必传）+
// 历史账户专用说明已从试用包移除。
// 取值结果 10 分钟缓存；画面形态取值失败必须 400（形状缺件建了也是千川拒），视频形态失败不阻塞。
const _bidExtraCache = new Map(); // key=`${accountId}:${primaryAdId}` -> { ts, aggregateCid?, guestShopId? }
async function resolveBidExtras(accountId, primaryAdId, audienceTemplate, liveFeed) {
  const extras = {};
  const tpl = audienceTemplate ? require('../lib/boostAudienceTemplates').getTemplate(audienceTemplate) : null;
  if (tpl) extras.audience = tpl;
  if (!liveFeed) return extras; // 视频形态：AggregateCids/GuestShopID 一律不传（实测三坑）

  const key = `${accountId}:${primaryAdId}`;
  const hit = _bidExtraCache.get(key);
  if (hit && Date.now() - hit.ts < 600000) {
    if (hit.aggregateCid) extras.aggregateCids = [hit.aggregateCid];
    if (hit.guestShopId) extras.guestShopId = hit.guestShopId;
    return extras;
  }
  const rec = { ts: Date.now() };
  const tabs = require('../lib/qianchuanTabs');
  const fmt = d => d.toISOString().slice(0, 10);
  const today = fmt(new Date());
  try {
    const r = await require('../lib/chengfangLive').fetchLivePlanList(fmt(new Date(Date.now() - 90 * 86400000)), today, accountId);
    const list = (r && r.data && (r.data.adInfos || r.data.adList || r.data.list)) || [];
    const plan = list.find(x => String(x.id) === String(primaryAdId));
    if (plan && plan.aggregateCid) rec.aggregateCid = String(plan.aggregateCid);
  } catch (e) {
    console.log(`[boost-create] aggregateCid 取值失败: ${e.message}`);
  }
  try {
    const r = await tabs.fetchBoostList(String(primaryAdId), fmt(new Date(Date.now() - 7 * 86400000)), today, accountId, { includeAllStatus: true });
    const ads = (r && r.data && r.data.adInfos) || [];
    const withShop = ads.find(a => a.guestShopId);
    if (withShop) rec.guestShopId = String(withShop.guestShopId);
  } catch (e) {
    console.log(`[boost-create] guestShopId 取值失败: ${e.message}`);
  }
  _bidExtraCache.set(key, rec);
  if (rec.aggregateCid) extras.aggregateCids = [rec.aggregateCid];
  if (rec.guestShopId) extras.guestShopId = rec.guestShopId;
  return extras;
}

async function handleBoostCreate(req, res, url) {
  if (req.method !== 'POST') return handleSingleBoostCreate(req, res, url);
  if (!requireWriteAuth(req, res)) return;
  const parsed = await readJsonBody(req);
  if (parsed.error) return sendJSON(res, { ok: false, error: parsed.error.message }, parsed.error.status);
  if (parsed.data.requestId == null) return handleSingleBoostCreate(req, res, url);
  const { requestId, ...payload } = parsed.data;
  try {
    const result = await require('../lib/createRequest').runCreateRequest(require('../lib/db').getDB(),
      payload.accountId || payload.account_id, requestId, payload, async () => {
        let status = 200, body;
        const response = { writeHead(code) { status = code; }, end(text) { body = JSON.parse(text); } };
        const child = Object.create(req);
        child._qcJsonBodyPromise = Promise.resolve({ data: payload });
        await handleSingleBoostCreate(child, response, url);
        if (!body) throw new Error('创建接口未返回结果，请先核验，禁止重复提交');
        return { status, body };
      });
    return sendJSON(res, result.body, result.status);
  } catch (error) { return handleApiError(res, error); }
}
module.exports = handleBoostCreate;
