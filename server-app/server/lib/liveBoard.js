const { getLocalDateStr, getFileSafeTimestamp } = require('./utils');
/**
 * server/lib/liveBoard.js — 千川直播大屏实时数据(纯 API)
 *
 * 抓包自 board-next 大屏页(tools/capture_live_board_templates.js)，模板存
 * cache/live_board_templates/templates.json。本模块运行时加载模板，替换
 * room_id/anchor_id/时间，并发调 statQuery 拉全量大屏数据。
 *
 * 模块:
 *   init             房间信息(房间名/状态/开播下播时间/优化目标)
 *   commonMetricCard 核心指标(GMV/消耗/ROI/在线人数/观看人数/GPM/订单数/观看成交率)
 *
 * ★ ROI 口径(重要，两个都要，别混):
 *   - total_prepay_and_pay_order_realtime_roi2  = 整体成交金额(含退款) ÷ 整体消耗 = 整体支付ROI(实时)，
 *     与看板"整体支付ROI"口径一致。对应大屏显示的"整体支付ROI"(如 2.70)。
 *   - total_prepay_and_pay_settle_realtime_roi2_1h = 1h结算金额(扣退款) ÷ 消耗 = 净成交ROI(实时)，
 *     更接近真实回款。
 *   GMV 同理两套: total_pay_order_gmv_realtime_for_roi2(含退款) / total_order_settle_amount_realtime_for_roi2_1h(扣退款,净成交)。
 *   消耗 stat_cost_for_roi2 = 整体消耗(基础+追投)。
 *   见 CLAUDE.md 口径坑清单。
 *   totalTrend       5分钟级时序(成交金额/消耗曲线)
 *   funnelModule     流量漏斗(曝光→观看→商品点击→成交)
 *   sourceChannel    渠道来源(各渠道观看/支付)
 *   materialVideo    视频素材(消耗/ROI/GMV/订单/CTR/CVR/热度)
 *   materialLive     直播间素材
 *   materialCarousel 轮播素材
 *
 * 用法: fetchLiveBoard(roomId, anchorId)
 */
const fs = require('fs');
const path = require('path');
const { statQuery } = require('./qianchuan');
const { resolveQcAccount, resolveAavid } = require('./cookie');
const { CACHE_DIR } = require('./config');
const { loadTemplates, buildBody, extract } = require('./liveBoardCore');

const BOARD_CACHE_DIR = path.join(CACHE_DIR, 'live_board');
if (!fs.existsSync(BOARD_CACHE_DIR)) fs.mkdirSync(BOARD_CACHE_DIR, { recursive: true });

// 模板加载已抽取到 liveBoardCore.js，此处不再重复定义 MODULES 外的功能

const MODULES = ['commonMetricCard', 'totalTrend', 'funnelModule', 'sourceChannel', 'materialVideo', 'materialLive', 'materialCarousel'];

/**
 * 用模板构建请求体（委托给 liveBoardCore）
 */
function buildBoardBody(reqFrom, roomId, anchorId, liveStartTime, accountId, liveEndTime) {
  const aavid = resolveAavid(accountId);
  return buildBody(reqFrom, roomId, anchorId, aavid, liveStartTime, liveEndTime);
}

function extractStats(result) {
  const sd = result && result.data && result.data.StatsData;
  return { rows: (sd && sd.Rows) || [], totals: (sd && sd.Totals) || {} };
}

async function fetchBoardModule(reqFrom, roomId, anchorId, liveStartTime, accountId, liveEndTime, signal) {
  const sourceAt = new Date().toISOString();
  const body = buildBoardBody(reqFrom, roomId, anchorId, liveStartTime, accountId, liveEndTime);
  // 核心读数优先排队，仍使用账户原有限流/退避；不另开无限并发通道。
  const r = await statQuery(body, 3, accountId, { signal, priority: ['init', 'commonMetricCard'].includes(reqFrom) ? 1 : 0 });
  const roomFiltered = body.Filters?.Conditions?.some(c => c.Field === 'room_id' && c.Values?.includes(String(roomId)));
  return { reqFrom, ...extractStats(r), source_at: sourceAt, collected_at: new Date().toISOString(),
    total_count: require('./dataContract').finiteNumber(r?.data?.StatsData?.TotalCount),
    page: body.PageParams || null,
    scope_filters: (body.Filters?.Conditions || []).filter(c => !['advertiser_id', 'anchor_id', 'room_id'].includes(c.Field)),
    scope: roomFiltered && liveStartTime ? 'current_session' : 'unknown',
    timestamp_basis: 'request_started_at', window: { start: body.StartTime || null, end: body.EndTime || null } };
}

// 已由状态探针核验场次后，只读核心指标；不等待 init、素材、趋势或罗盘。
async function fetchLiveCore(roomId, anchorId, liveStartTime, accountId, options = {}) {
  if (!roomId || !liveStartTime) throw new Error('core_session_required');
  // 新导入账户可能尚未保存主播 ID；从当前房间核验，不能拿 show_id 替代。
  let init = null;
  if (!anchorId) {
    init = await fetchBoardModule('init', roomId, null, null, accountId, null, options.signal);
    anchorId = init.rows?.[0]?.Dimensions?.room_with_anchor_id?.Value;
    if (!anchorId) throw Object.assign(new Error('当前直播间缺少主播 ID'), { code: 'core_anchor_missing' });
  }
  const metrics = await fetchBoardModule('commonMetricCard', roomId, anchorId, liveStartTime, accountId, null, options.signal);
  return { roomId, anchorId, liveStartTime, init, metrics, fetched_at: metrics.source_at,
    core_only: true, dataValid: metrics.rows.length > 0, partial: false, errors: [] };
}

/**
 * 拉取大屏全量数据(所有模块并发)
 * @param {string} roomId 直播间ID
 * @param {string} anchorId 主播ID（从目标账户配置读取）
 * @param {string} [liveStartTime] 开播时间 "YYYY-MM-DD HH:MM:SS"，用于时间窗口；不传则先查 init 拿
 * @param {string} [accountId] 千川账号 id
 * @param {string} [liveEndTime] 下播时间 "YYYY-MM-DD HH:MM:SS"（如果是已结束的直播，传入此值可精确框定范围）
 * @returns {Promise<object>} { roomId, anchorId, fetched_at, init, metrics, trend, funnel, channels, materials }
 */
async function fetchLiveBoard(roomId, anchorId, liveStartTime, accountId, liveEndTime, options = {}) {
  const signal = options.signal;
  // init 先单独跑(拿房间信息+开播时间+主播ID)。init 不按 anchor_id 过滤, anchorId 可空。
  // anchorId 没传就从 init 响应的 room_with_anchor_id 取(支持多账号, 不用提前存 anchorId)。
  // 优化：当调用方已传入 liveStartTime 和 anchorId 时，init 的主要价值（补全这两个值）已满足，
  //       可跳过 init 请求以减少一次 API 调用。代价是失去 room_name / liveEndTime，
  //       但这些字段其他模块不依赖，调用方需时可自行调 fetchBoardModule('init', ...)。
  let initResult = null;
  const canSkipInit = liveStartTime && anchorId;
  if (canSkipInit) {
    initResult = { reqFrom: 'init', skipped: true, reason: 'liveStartTime+anchorId already provided' };
  } else {
    try {
      initResult = await fetchBoardModule('init', roomId, anchorId, null, accountId, null, signal);
      const row = initResult.rows && initResult.rows[0];
      if (row && row.Dimensions) {
        if (!liveStartTime && row.Dimensions.room_start_time) {
          liveStartTime = row.Dimensions.room_start_time.ValueStr || row.Dimensions.room_start_time.Value;
        }
        if (!liveEndTime && row.Dimensions.room_end_time && row.Dimensions.room_end_time.Value !== '-') {
          liveEndTime = row.Dimensions.room_end_time.ValueStr || row.Dimensions.room_end_time.Value;
        }
        if (!anchorId && row.Dimensions.room_with_anchor_id) {
          anchorId = row.Dimensions.room_with_anchor_id.Value;
        }
      }
    } catch (e) {
      // cookie_expired 不能吞掉，必须向上传播
      if (e.code === 'cookie_expired' || e.message === 'cookie_expired') throw e;
      initResult = { reqFrom: 'init', error: e.message, code: e.code || 'upstream_error' };
      console.log(`[liveBoard] init 失败(${e.message})，时间窗口/anchorId 将缺失，其余模块用模板默认`);
    }
  }

  const settled = await Promise.allSettled(MODULES.map(m =>
    fetchBoardModule(m, roomId, anchorId, liveStartTime, accountId, liveEndTime, signal)
  ));
  const results = settled.map((item, index) => {
    if (item.status === 'fulfilled') return item.value;
    const e = item.reason || new Error('unknown upstream failure');
    if (e.code === 'cookie_expired' || e.message === 'cookie_expired') throw e;
    return { reqFrom: MODULES[index], error: e.message, code: e.code || 'upstream_error' };
  });
  const byKey = {};
  results.forEach(r => { byKey[r.reqFrom] = r; });

  const errors = [];
  if (initResult && initResult.error) {
    errors.push({ component: 'init', code: initResult.code || 'upstream_error', error: initResult.error });
  }
  for (const result of results) {
    if (result.error) errors.push({ component: result.reqFrom, code: result.code || 'upstream_error', error: result.error });
  }
  const metricRows = byKey.commonMetricCard && byKey.commonMetricCard.rows;
  const dataValid = Array.isArray(metricRows) && metricRows.length > 0 && !byKey.commonMetricCard.error;

  const out = {
    roomId, anchorId, liveStartTime,
    liveStartTimeMissing: !liveStartTime,
    fetched_at: new Date().toISOString(),
    dataValid,
    partial: errors.length > 0,
    errors,
    init: initResult,
    metrics: byKey.commonMetricCard,
    trend: byKey.totalTrend,
    funnel: byKey.funnelModule,
    channels: byKey.sourceChannel,
    materials: {
      video: byKey.materialVideo,
      live: byKey.materialLive,
      carousel: byKey.materialCarousel,
    },
  };

  // 失败帧只返回给调用方诊断，不覆盖最后成功磁盘缓存。
  if (dataValid && errors.length === 0) {
    const stamp = getFileSafeTimestamp();
    await fs.promises.writeFile(path.join(BOARD_CACHE_DIR, `board_${roomId}_${stamp}.json`), JSON.stringify(out, null, 2), 'utf8');
    await pruneBoardCache(roomId);
  }
  return out;
}

// 缓存清理：每个 roomId 只保留最新 3 份（时间戳文件名字典序即时间序），失败不影响主流程
const BOARD_CACHE_KEEP = 3;
async function pruneBoardCache(roomId) {
  try {
    const prefix = `board_${roomId}_`;
    const files = (await fs.promises.readdir(BOARD_CACHE_DIR))
      .filter(f => f.startsWith(prefix) && f.endsWith('.json'))
      .sort();
    const stale = files.slice(0, Math.max(0, files.length - BOARD_CACHE_KEEP));
    for (const f of stale) {
      await fs.promises.unlink(path.join(BOARD_CACHE_DIR, f)).catch(() => {});
    }
  } catch (e) {
    console.warn(`[liveBoard] 缓存清理失败(room ${roomId}): ${e.message}`);
  }
}

// 素材明细默认仅在投；累计采样必须覆盖全部素材类型和状态，避免暂停后累计回退。
async function fetchFlowTotals(room, accountId, signal) {
  const body = buildBoardBody('materialVideo', room.room_id, room.anchor_id, room.start_time, accountId);
  body.Filters.Conditions = body.Filters.Conditions.filter(c => !['roi2_material_type_v3', 'roi2_material_status'].includes(c.Field));
  body.Dimensions = [];
  body.Metrics = ['stat_cost_for_roi2', 'stat_cost_for_roi2_assist'];
  const result = await statQuery(body, 0, accountId, { signal });
  return extractStats(result).totals;
}

module.exports = { fetchLiveBoard, fetchLiveCore, fetchBoardModule, fetchFlowTotals, loadTemplates, MODULES, BOARD_CACHE_DIR };
