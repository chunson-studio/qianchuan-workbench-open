const { sendJSON, resolveDateRange, yesterday, requireWriteAuth } = require('../lib/utils');
const { fetchLiveStatus, fetchLiveSessions } = require('../lib/qianchuanTabs');
const { fetchLiveBoard } = require('../lib/liveBoard');
const fs = require('fs');
const path = require('path');
const { REPORTS_DIR } = require('../lib/config');
const { handleApiError } = require('../lib/handleApiError');

function throwResultError(result, component) {
  const err = new Error(result.error || 'upstream_error');
  err.code = result.code || 'upstream_error';
  err.component = component;
  err.retryable = result.retryable === true;
  if (result.statusCode) err.statusCode = result.statusCode;
  throw err;
}

/**
 * 直播相关路由:
 *   GET /api/live-status              当前在播状态 + 在播房间列表
 *   GET /api/live-sessions?date=&status=  某天所有直播场次(默认今天)
 *   GET /api/live-board?roomId=&anchorId= 某场直播大屏全量数据
 *   POST/GET /api/live-collect?account=&roomId=  手动触发直播采集(在播采/指定roomId补采已结束场次)
 */
async function handleLive(req, res, url) {
  const pathname = url.pathname;
  const account = url.searchParams.get('account') || undefined;

  // 当前在播状态
  if (pathname === '/api/live-status') {
    try {
      const r = await fetchLiveStatus(account, { signal: req.signal });
      if (r.error) throwResultError(r, 'live_status');
      return sendJSON(res, { ok: true, code: null, component: 'live_status', retryable: false, partial: false, errors: [], ...r });
    } catch (e) {
      return handleApiError(res, e);
    }
  }

  // 某天场次列表
  if (pathname === '/api/live-sessions') {
    let date = url.searchParams.get('date');
    const dateRange = url.searchParams.get('dateRange');

    if (dateRange) {
      const range = resolveDateRange(dateRange);
      if (range) {
        date = range.start; // sessions 只查某一天，取 start
      }
    }

    const status = url.searchParams.get('status') || undefined;
    try {
      const opts = status ? { status, accountId: account, signal: req.signal } : { accountId: account, signal: req.signal };
      const r = await fetchLiveSessions(date, opts);
      if (r.error) throwResultError(r, 'live_sessions');
      return sendJSON(res, { ok: true, code: null, component: 'live_sessions', retryable: false, partial: false, errors: [], ...r });
    } catch (e) {
      return handleApiError(res, e);
    }
  }

  // 某场大屏数据(anchorId/endTime 可选, 不传则 fetchLiveBoard 从 init 模块自动取)
  if (pathname === '/api/live-board') {
    const roomId = url.searchParams.get('roomId');
    const anchorId = url.searchParams.get('anchorId') || undefined;
    const endTime = url.searchParams.get('endTime') || undefined;
    if (!roomId) {
      return sendJSON(res, { ok: false, error: '需要 roomId 参数' }, 400);
    }
    try {
      const r = await fetchLiveBoard(roomId, anchorId, undefined, account, endTime, { signal: req.signal });

      // 如果大屏请求成功，顺便把请求结果存入 md/json 的文件夹结构中以便查阅
      // 例如: reports/2026-07-10/2026-07-10_60000031_live_board.json
      if (r.dataValid && !r.partial) {
        const dateStr = r.fetched_at ? r.fetched_at.substring(0, 10) : new Date().toISOString().substring(0, 10);
        const dir = path.join(REPORTS_DIR, dateStr);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const outFile = path.join(dir, `${dateStr}_${roomId}_live_board.json`);
        fs.writeFile(outFile, JSON.stringify(r, null, 2), 'utf8', (err) => {
          if (err) console.error('[live-board] 保存大屏数据到目录失败:', err);
        });
      }

      return sendJSON(res, { ok: true, code: null, component: 'live_board', retryable: false, ...r });
    } catch (e) {
      return handleApiError(res, e);
    }
  }

  // 手动触发直播采集（融入 server 的 liveCollector）
  if (pathname === '/api/live-collect') {
    if (!requireWriteAuth(req, res)) return;
    const accountId = account || (require('../lib/config').QIANCHUAN_ACCOUNTS[0] && require('../lib/config').QIANCHUAN_ACCOUNTS[0].id);
    const roomId = url.searchParams.get('roomId') || undefined;
    try {
      const { collectOnce } = require('../lib/liveCollector');
      const r = await collectOnce(accountId, { roomId });
      return sendJSON(res, r, r.ok ? 200 : 400);
    } catch (e) {
      return handleApiError(res, e);
    }
  }

  // 直播盯盘总览：一次返回所有账号的最新采集指标+操盘建议+风险告警
  if (pathname === '/api/live-watch') {
    try {
      const roomId = url.searchParams.get('room_id') || url.searchParams.get('roomId');
      if (!roomId && url.searchParams.has('start_time')) return sendJSON(res, { ok: false, code: 'invalid_room_scope', error: '场次时间必须绑定 room_id' }, 400);
      if (roomId) {
        const data = await require('../lib/liveRoomContext').readRoomWatch(account, roomId,
          { startTime: url.searchParams.get('start_time') || undefined, signal: req.signal });
        return sendJSON(res, { ok: true, accounts: [data] });
      }
      const { getLatestWatch, ensureLiveWatch } = require('../lib/liveCollector');
      if (account) require('../lib/api-helpers').validateAccount(account);
      const ids = account ? [account] : getLatestWatch().map(a => a.accountId);
      await Promise.all(ids.map(id => require('../lib/liveReadService').readLiveSnapshot(id)));
      const overview = getLatestWatch().filter(a => !account || a.accountId === account);
      const errors = overview.flatMap(a => (a.errors || []).map(e => ({ account: a.accountId, ...e })));
      return sendJSON(res, {
        ok: true,
        component: 'collector',
        background_collection_enabled: process.env.QC_DISABLE_BACKGROUND !== '1',
        partial: errors.length > 0,
        errors,
        accounts: overview,
        fetchedAt: new Date().toISOString(),
      });
    } catch (e) {
      return handleApiError(res, e);
    }
  }

  return sendJSON(res, { ok: false, error: '未知直播接口' }, 404);
}

module.exports = handleLive;
