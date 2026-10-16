const { sendJSON, handleApiError, getLocalDateStr } = require('../lib/utils');
const { fetchBoardDetail, fetchBoardActions } = require('../lib/liveBoardDetail');
const { resolveQcAccount } = require('../lib/cookie');
const qcTabs = require('../lib/qianchuanTabs');

/**
 * GET /api/live-board-detail?account=xx&roomId=xxx[&startTime&endTime]
 *
 * 直播大屏增强数据（分钟级趋势/调控动作日志/素材5分钟趋势，2026-08-02 探针接入）。
 * roomId 缺省时自动取当日最近一场（复盘/实盘通用）。
 */
async function handleLiveBoardDetail(req, res, url) {
  if (req.method !== 'GET') return sendJSON(res, { ok: false, error: 'Method Not Allowed' }, 405);
  const account = url.searchParams.get('account');
  if (!account) return sendJSON(res, { ok: false, error: '缺少 account 参数' }, 400);
  try { require('../lib/api-helpers').validateAccount(account); } catch (e) {
    return sendJSON(res, { ok: false, error: e.message }, 400);
  }

  let roomId = url.searchParams.get('roomId');
  let startTime = url.searchParams.get('startTime') || undefined;
  let endTime = url.searchParams.get('endTime') || undefined;
  const view = url.searchParams.get('view');
  const limitParam = url.searchParams.get('limit');
  if (view !== null && view !== 'actions') {
    return sendJSON(res, { ok: false, code: 'invalid_view', error: 'view 仅支持 actions；完整读取省略 view' }, 400);
  }
  if (view === 'actions') {
    if (!roomId?.trim() || !startTime?.trim()) return sendJSON(res, {
      ok: false, code: 'session_binding_required', error: '日志读取必须显式传 roomId 与 startTime，不自动选择场次',
    }, 400);
    if (url.searchParams.has('digest')) return sendJSON(res, {
      ok: false, code: 'invalid_view', error: 'actions 与 digest 不能混用',
    }, 400);
    if (limitParam !== null && (!/^[1-9]\d*$/.test(limitParam) || Number(limitParam) > 100)) return sendJSON(res, {
      ok: false, code: 'invalid_limit', error: 'limit 必须为 1 至 100 的整数',
    }, 400);
  } else if (limitParam !== null) {
    return sendJSON(res, { ok: false, code: 'invalid_limit', error: 'limit 仅用于 view=actions' }, 400);
  }

  const acc = resolveQcAccount(account);
  const anchorId = acc ? acc.anchorId : undefined;

  try {
    if (view === 'actions') {
      const actions = await fetchBoardActions(roomId, anchorId, startTime, endTime, account, limitParam === null ? 30 : Number(limitParam));
      return sendJSON(res, { ok: true, account, roomId, startTime, endTime: endTime || null, view: 'actions', ...actions });
    }
    // roomId 缺省：取当日最近一场（含在播）
    if (!roomId) {
      const r = await qcTabs.fetchLiveSessions(getLocalDateStr(), { accountId: account });
      const sessions = (r && r.sessions) || [];
      if (!sessions.length) return sendJSON(res, { ok: false, error: '当日无场次（未开播）' }, 404);
      const latest = sessions[sessions.length - 1];
      roomId = String(latest.roomId);
      startTime = startTime || latest.startTime;
      endTime = endTime || (latest.endTime && latest.endTime !== '-' ? latest.endTime : undefined);
    }
    if (!startTime) return sendJSON(res, { ok: false, error: '缺少 startTime（场次开播时间）' }, 400);

    const detail = await fetchBoardDetail(roomId, anchorId, startTime, endTime, account);
    // 历史账户专用说明已从试用包移除。
    if (url.searchParams.get('digest') === '1') {
      const { buildSessionDigest } = require('../lib/liveBoardDetail');
      const breakEven = require('../lib/api-helpers').getAccountParams(account).break_even_roi;
      const digest = buildSessionDigest(detail, { breakEven });
      return sendJSON(res, {
        ok: true, account, roomId, startTime, endTime: endTime || null,
        digest: digest.lines, segments: digest.segments, action_effects: digest.action_effects,
        anomalies: digest.anomalies, current: digest.current,
        partial: detail.partial, errors: detail.errors,
      });
    }
    return sendJSON(res, {
      ok: true,
      account,
      roomId,
      startTime,
      endTime: endTime || null,
      trend_minute: detail.trend_minute || null,
      roi2_log: detail.roi2_log || null,
      material_trends: detail.material_trends || null,
      partial: detail.partial,
      errors: detail.errors,
    });
  } catch (e) {
    return handleApiError(res, e);
  }
}

module.exports = handleLiveBoardDetail;
