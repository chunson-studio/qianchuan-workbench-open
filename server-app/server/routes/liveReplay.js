const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fetchLiveBoard } = require('../lib/liveBoard');
const qcTabs = require('../lib/qianchuanTabs'); // 命名空间引用（不解构）：测试可注入 stub
const { assembleRecord } = require('../lib/liveCollector');
const { resolveQcAccount } = require('../lib/cookie');
const { sendJSON, handleApiError, beijingDay } = require('../lib/utils');
const { isValidAccountId, writeJsonAtomic } = require('../lib/api-helpers');
const { normalizeFunnel, normalizeChannels, buildLiveFinancialBasis } = require('../lib/decisionContext');
const { STORAGE_DIR, CACHE_DIR } = require('../lib/config');

function decorateReplayContract(payload, options = {}) {
  if (!payload || typeof payload !== 'object') return payload;
  const sourceAt = payload.fetchedAt || null; // 落盘时间不是上游数据水位。
  const cacheStable = Array.isArray(payload.sessions)
    ? sessionsArchiveStable(payload, payload.date)
    : replaySettled(payload);
  // 旧缓存的账号/多日追投不能重新命名成本场；原始缓存不改写，详情显式请求才暴露。
  const tasks = Array.isArray(payload.boostTasks) ? payload.boostTasks : [];
  const reportWindow = payload.boost_report_window || null;
  const relatedHistory = {
    scope: 'report_date_range_not_session',
    status: payload.boost_report_error ? 'unavailable' : tasks.length || reportWindow ? 'available' : 'not_requested',
    task_count: tasks.length || reportWindow ? tasks.length : null,
    window: reportWindow, source_at: payload.boost_report_source_at || null,
    reason: payload.boost_report_error || (reportWindow ? 'report_window_not_session_attribution' : tasks.length ? 'legacy_report_window_unknown' : 'history_not_loaded'),
    detail_parameter: 'include_boost_history=1',
    ...(options.includeBoostHistory && (tasks.length || reportWindow) ? { tasks } : {}),
  };
  const historicalMaterial = ({ heatStatus, boostTaskName, ...metrics }) => metrics;
  return {
    ...payload,
    ...(payload.materials ? { materials: Object.fromEntries(Object.entries(payload.materials)
      .map(([kind, rows]) => [kind, Array.isArray(rows) ? rows.map(historicalMaterial) : rows])) } : {}),
    ...(Array.isArray(payload.materialsTop) ? { materialsTop: payload.materialsTop.map(historicalMaterial) } : {}),
    boostTasks: [],
    boostTaskMap: {},
    boost_coverage: { scope: 'current_session', data_valid: false, returned: 0,
      reason: 'task_session_attribution_unavailable', empty_means_no_tasks: false },
    related_boost_history: relatedHistory,
    riskAlerts: [],
    decisions: { redList: [], blackList: [], status: 'not_evaluated' },
    thresholds: null,
    policy_evaluation: { status: 'not_evaluated', reason: 'historical_strategy_not_bound',
      legacy_annotations_omitted: (payload.riskAlerts || []).length
        + (payload.decisions?.redList || []).length + (payload.decisions?.blackList || []).length },
    material_state_scope: 'historical_task_state_unavailable',
    financial_basis: payload.financial_basis || buildLiveFinancialBasis(),
    settlement_state: {
      roi_basis: 'platform_net_1h',
      settlement_window: '1h',
      cache_stable: cacheStable,
      final_settlement_available: false,
      note: 'cache_stable 仅表示平台1小时净口径已过缓存稳定窗口，不代表最终结算完成',
    },
    funnel_contract: normalizeFunnel(payload.funnel, { sourceAt, window: 'session_replay' }),
    channels: normalizeChannels(payload.channels || (Array.isArray(payload.source) ? payload.source : []), {
      sourceAt,
      window: 'session_replay',
    }),
  };
}

/**
 * 复盘数据缓存（按 account + roomId + startTime 落盘）。
 * 已结束且过平台1小时净口径缓存稳定窗口（下播 >90 分钟）的场次数据通常不再变，拉取一次后缓存到 storage/replay/，
 * 后续请求直接读文件，避免每次都打千川接口。
  * 历史账户专用说明已从试用包移除。
 * 传入 refresh=1 可强制刷新。
 */
const REPLAY_STORAGE_DIR = path.join(STORAGE_DIR, 'replay');

// 平台无时区时间属于北京时间；ISO Z/offset 已声明时区，不按宿主时区重解释。
// 只用于比较、缓存键和报表日期，传给上游与返回的原始绑定字段保持原样。
function replayTimeMs(value) {
  const raw = String(value || '').trim().replace(' ', 'T');
  const match = raw.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:?\d{2})?$/i);
  return match ? Date.parse(match[1] + (match[2] || '+08:00')) : NaN;
}

function replayDate(value) {
  const ms = replayTimeMs(value);
  return Number.isFinite(ms) ? beijingDay(ms) : null;
}

function normalizeSessionTime(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const ms = replayTimeMs(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : raw;
}

function replayStoragePath(account, roomId, startTime, baseDir = REPLAY_STORAGE_DIR) {
  // 安全防护：account 和 roomId 只允许安全字符，防止路径遍历
  const safeAccount = isValidAccountId(account) ? account : 'unknown';
  const safeRoomId = /^[a-zA-Z0-9_-]+$/.test(roomId) ? roomId : 'unknown';
  const normalizedStart = normalizeSessionTime(startTime);
  if (!normalizedStart) return path.join(baseDir, `replay_${safeAccount}_${safeRoomId}.json`);
  const startKey = crypto.createHash('sha256').update(normalizedStart).digest('hex').slice(0, 12);
  return path.join(baseDir, `replay_${safeAccount}_${safeRoomId}_${startKey}.json`);
}

function readReplayFile(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    if (!data || data.ok !== true) return null;
    return data;
  } catch {
    return null;
  }
}

function loadReplayStorage(account, roomId, startTime, options = {}) {
  const normalizedStart = normalizeSessionTime(startTime);
  if (!normalizedStart) return null;
  const baseDir = options.baseDir || REPLAY_STORAGE_DIR;
  const canonical = readReplayFile(replayStoragePath(account, roomId, normalizedStart, baseDir));
  if (canonical) {
    const cachedStart = normalizeSessionTime(canonical.room && canonical.room.start_time);
    return cachedStart === normalizedStart ? canonical : null;
  }
  // 升级前旧文件只按 roomId 命名。只有文件内部 start_time 精确匹配才承认归属，
  // 且标为 legacy，调用方必须穿透重拉生成新键，禁止直接当作当前1h净口径稳定值返回。
  const legacy = readReplayFile(replayStoragePath(account, roomId, null, baseDir));
  if (!legacy) return null;
  const legacyStart = normalizeSessionTime(legacy.room && legacy.room.start_time);
  return legacyStart === normalizedStart ? { ...legacy, legacy_cache: true } : null;
}

function saveReplayStorage(account, roomId, startTime, payload) {
  try {
    if (!fs.existsSync(REPLAY_STORAGE_DIR)) fs.mkdirSync(REPLAY_STORAGE_DIR, { recursive: true });
    writeJsonAtomic(replayStoragePath(account, roomId, startTime), payload);
  } catch (e) {
    console.log(`[live-replay] 存储写入失败: ${e.message}`);
  }
}

// 场次列表存储（按 account + date 落盘，永久保存）
function sessionsStoragePath(account, date) {
  const safeAccount = isValidAccountId(account) ? account : 'unknown';
  const safeDate = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : 'unknown';
  return path.join(REPLAY_STORAGE_DIR, `sessions_${safeAccount}_${safeDate}.json`);
}

function loadSessionsStorage(account, date) {
  try {
    const p = sessionsStoragePath(account, date);
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf8');
    const data = JSON.parse(raw);
    if (!data || data.ok !== true) return null;
    return data;
  } catch {
    return null;
  }
}

function saveSessionsStorage(account, date, payload) {
  try {
    // 原子写（临时文件+rename）：采集中断/进程崩溃不会留下残缺 JSON 污染永久存储
    writeJsonAtomic(sessionsStoragePath(account, date), payload);
  } catch (e) {
    console.log(`[live-replay] 场次列表存储失败: ${e.message}`);
  }
}

// 场次快照是否终态：全部场次已结束（无 status=2 在播、均有 endTime）。
// 含在播场次的快照禁止当"永久存储"——2026-07-30 bug：07-28 在播场次被固化，
// 复盘页一直显示"直播中"（时长 44h+），千川上游其实早已结束。
function sessionsFinal(sessions) {
  return (sessions || []).every(s => String(s.status) !== '2' && s.endTime && s.endTime !== '-');
}

// 历史账户专用说明已从试用包移除。
// 窗口内的"已结束"数据允许落盘但每次请求穿透重拉（覆盖落盘）；过窗后可缓存该口径。
// 取 90 分钟（1h 指标 + 延迟余量）。这不是 final_settlement 的完成判定。
const SETTLE_WINDOW_MS = 90 * 60 * 1000;
const SETTLE_WINDOW_MIN = SETTLE_WINDOW_MS / 60000;

function endMsOf(t) {
  const ms = replayTimeMs(t);
  return Number.isFinite(ms) ? ms : 0;
}

// 场次列表是否已过1h净口径缓存稳定窗口：全终态 且 最晚下播时间距今 > 90 分钟
function sessionsSettled(sessions, nowMs = Date.now()) {
  if (!sessionsFinal(sessions)) return false;
  const latestEnd = Math.max(0, ...(sessions || []).map(s => endMsOf(s.endTime)));
  return latestEnd > 0 && (nowMs - latestEnd) > SETTLE_WINDOW_MS;
}

// Wall-clock age alone cannot turn an early refund-window sample into settled
// data. Require an actual source sample after every session's 90-minute window.
function sessionsArchiveStable(payload, date, nowMs = Date.now()) {
  const sampledAt = replayTimeMs(payload?.fetchedAt);
  return date < beijingDay(nowMs)
    && Number.isFinite(sampledAt) && sampledAt <= nowMs + 60000
    && payload?.data_valid !== false && payload?.dataValid !== false
    && Array.isArray(payload?.sessions) && payload.sessions.every(s => endMsOf(s.endTime) > 0)
    && sessionsSettled(payload.sessions, sampledAt);
}

// 单场复盘也要求实际采样已越过稳定窗口；旧样本不会随墙钟变老而变完整。
// （在播/无结束时间 → 永不直接吃缓存，顺带防"在播场次被旧缓存遮蔽"）
function replaySettled(cached, nowMs = Date.now()) {
  const end = String((cached && cached.room && cached.room.end_time) || '');
  if (!end || end === '-') return false;
  const endMs = endMsOf(end);
  const sampledAt = replayTimeMs(cached?.fetchedAt);
  return cached?.dataValid !== false && cached?.data_valid !== false
    && endMs > 0 && (nowMs - endMs) > SETTLE_WINDOW_MS
    && Number.isFinite(sampledAt) && sampledAt <= nowMs + 60000
    && (sampledAt - endMs) > SETTLE_WINDOW_MS;
}

function sessionDates(start, end, today = beijingDay()) {
  const parse = value => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return NaN;
    const at = Date.parse(value + 'T00:00:00Z');
    return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === value ? at : NaN;
  };
  const first = parse(start), last = parse(end), count = (last - first) / 86400000 + 1;
  if (!Number.isInteger(count) || count < 1 || count > 31 || end > today) return null;
  return Array.from({ length: count }, (_, i) => new Date(last - i * 86400000).toISOString().slice(0, 10));
}

// One local archive read replaces N warm daily HTTP reads. This does not start
// collection: missing/current/settling dates are explicitly returned for the
// caller's existing bounded daily loader. Source timestamps are never refreshed.
function sessionCatalog(account, dates, now = Date.now()) {
  const today = beijingDay(now);
  const days = dates.map(date => {
    const cached = loadSessionsStorage(account, date);
    const identityValid = cached && cached.account === account && cached.date === date
      && Array.isArray(cached.sessions)
      && cached.sessions.every(row => row && (!row.account || row.account === account));
    if (!identityValid) return { date, status: 'missing', source_at: null, session_count: null,
      cache_stable: false, stale: true, reason: cached ? 'archive_identity_unverified' : 'archive_not_found' };
    const sourceAt = cached.fetchedAt || null, age = now - replayTimeMs(sourceAt);
    const timestampKnown = Number.isFinite(age) && age >= -60000;
    const settled = sessionsArchiveStable(cached, date, now);
    const emptyRecent = date < today && cached.sessions.length === 0 && timestampKnown && age < 86400000;
    const fresh = timestampKnown && cached.data_valid !== false && cached.dataValid !== false
      && (settled || emptyRecent || age < 60000);
    return { date, status: fresh ? 'ready' : 'refresh_required', source_at: sourceAt,
      session_count: cached.sessions.length, cache_stable: settled, stale: !fresh,
      // Preserve historical rows for progressive display, explicitly marked stale.
      sessions: cached.sessions,
      ...(!fresh ? { reason: timestampKnown ? 'archive_needs_refresh' : 'archive_source_time_unknown' } : {}) };
  });
  const pending = days.filter(day => day.status !== 'ready').map(day => day.date);
  return { ok: true, mode: 'archive_catalog', account,
    date_range: { start: dates.at(-1), end: dates[0] }, days,
    partial: pending.length > 0, pending_dates: pending,
    settle_window_min: SETTLE_WINDOW_MIN, source_type: 'local_storage',
    generated_at: new Date(now).toISOString(),
    settlement_basis: 'platform_net_1h', final_settlement_available: false };
}

/**
 * 直播复盘路由
 *
 * GET /api/live-replay/sessions?account=xxx&date=YYYY-MM-DD
 *   获取某天的直播场次列表（用于复盘选场次）
 *
 * GET /api/live-replay?roomId=xxx&account=xxx&startTime=YYYY-MM-DD HH:MM:SS&endTime=YYYY-MM-DD HH:MM:SS
 *   获取精确场次事实；include_boost_history=1 单独展开非本场归因的日期范围报告。
 */
async function handleReplaySource(req, res, url) {
  const pathname = url.pathname;

  // ===== 场次列表 =====
  if (pathname === '/api/live-replay/sessions') {
    if (req.method !== 'GET') return sendJSON(res, { ok: false, error: '只支持 GET' }, 405);
    const account = url.searchParams.get('account');
    if (!account) return sendJSON(res, { ok: false, error: '缺少 account 参数' }, 400);
    const date = url.searchParams.get('date') || beijingDay();
    const refresh = url.searchParams.get('refresh') === '1';
    // 未来日期不查也不落盘：空结果写进"永久存储"会把明天真正到达时的场次永久遮蔽（2026-07-29 审计修复）
    if (date > beijingDay()) {
      return sendJSON(res, { ok: false, error: '日期不能超过今天（未来日期无场次，且空结果落盘会污染永久存储）' }, 400);
    }

    // 场次列表存储：已结束且过1h净口径缓存稳定窗口后，拉一次存文件，后续直接读。
    // 历史账户专用说明已从试用包移除。
    if (!refresh) {
      const cached = loadSessionsStorage(account, date);
      if (cached && sessionsArchiveStable(cached, date)) {
        cached.cached = true;
        return sendJSON(res, decorateReplayContract(cached));
      }
    }

    try {
      const fetchedAt = new Date().toISOString();
      const r = await qcTabs.fetchLiveSessions(date, { accountId: account, signal: req.signal });
      // fetchLiveSessions 内部 catch 后返回 { sessions: [], error }——不检查就会把空结果当稳定值固化，
      // 上游一次抖动就永久遮蔽真数据（2026-07-30 审计：07-19/26 空文件即此路径，巧合是那天真没播）
      if (r.error) {
        return sendJSON(res, { ok: false, error: `场次拉取失败（不落盘，下次重试）: ${r.error}` }, 502);
      }
      // 只返回已结束的场次（复盘用），附上 accountName
      const accName = resolveQcAccount(account)?.name || account;
      const sessions = (r.sessions || []).map(s => ({
        ...s,
        account,
        accountName: accName,
      }));
      const payload = { ok: true, account, accountName: accName, date, sessions, fetchedAt, settle_window_min: SETTLE_WINDOW_MIN };
      // 只有全终态快照才落盘永久存储；含在播场次的快照直接返回不落盘，等终态后再固化
      saveSessionsStorage(account, date, payload); // 活跃场次也保存，读取时按时间后台刷新。
      return sendJSON(res, decorateReplayContract(payload));
    } catch (e) {
      return handleApiError(res, e);
    }
  }

  // ===== 单场复盘看板 =====
  if (pathname === '/api/live-replay') {
    if (req.method !== 'GET') return sendJSON(res, { ok: false, error: '只支持 GET' }, 405);
    const roomId = url.searchParams.get('roomId');
    const account = url.searchParams.get('account');
    if (!account) return sendJSON(res, { ok: false, error: '缺少 account 参数' }, 400);
    const startTime = url.searchParams.get('startTime') || undefined;
    const endTime = url.searchParams.get('endTime') || undefined;
    if (!roomId) return sendJSON(res, { ok: false, error: '需要 roomId 参数' }, 400);
    if (!startTime) {
      return sendJSON(res, {
        ok: false,
        code: 'start_time_required',
        component: 'live_replay',
        retryable: false,
        error: '需要 startTime 参数以隔离同一直播间的不同场次',
      }, 400);
    }

    const acc = resolveQcAccount(account);
    const anchorId = acc ? acc.anchorId : undefined;
    const accountName = acc ? acc.name : account;

    // 稳定历史缓存不再为“追投当前状态”访问平台，也不按素材名回写历史状态。
    const includeBoostHistory = url.searchParams.get('include_boost_history') === '1';
    const refresh = url.searchParams.get('refresh') === '1';
    if (!refresh) {
      const cached = loadReplayStorage(account, roomId, startTime);
      if (cached && !cached.legacy_cache && replaySettled(cached)) {
        return sendJSON(res, decorateReplayContract({ ...cached, cached: true }, { includeBoostHistory }));
      }
    }

    try {
      // 1. 拉大屏全量数据
      const board = await fetchLiveBoard(roomId, anchorId, startTime, account, endTime, { signal: req.signal });
      if (!board) return sendJSON(res, { ok: false, error: '大屏数据为空' }, 502);

      // 2. 构造 room 信息（assembleRecord 需要）
      const initRow = board.init && board.init.rows && board.init.rows[0];
      const initDims = (initRow && initRow.Dimensions) || {};
      const room = {
        room_id: roomId,
        room_name: initDims.room_name?.ValueStr || initDims.room_name?.Value || '',
        start_time: startTime || initDims.room_start_time?.ValueStr || initDims.room_start_time?.Value || '',
        end_time: endTime || initDims.room_end_time?.ValueStr || initDims.room_end_time?.Value || '',
        anchor_id: board.anchorId || anchorId,
        status: initDims.room_status?.Value ?? null,
      };

      // 3. 复用 assembleRecord 解析大屏数据
      const record = assembleRecord(board, { roomId, roomName: room.room_name, startTime: room.start_time, endTime: room.end_time, anchorId: room.anchor_id, status: room.status }, accountName, account);

      // 追投报告只有日期范围归因，不属于精确场次。默认不额外取数；需要历史明细时显式读取。
      let boostTasks = [], boostReportWindow = null, boostReportSourceAt = null, boostReportError = null;
      if (includeBoostHistory) {
        const reportStart = replayDate(room.start_time);
        const reportEnd = replayDate(room.end_time && room.end_time !== '-' ? room.end_time : room.start_time);
        if (!reportStart || !reportEnd) boostReportError = 'boost_report_window_invalid';
        else try {
          boostReportWindow = { start_date: reportStart, end_date: reportEnd };
          const report = await qcTabs.fetchBoostTaskReport(reportStart, reportEnd, account);
          if (!report || report.ok === false || report.error || !Array.isArray(report.tasks)) {
            boostReportError = report?.error || 'boost_report_unavailable';
          } else {
            boostTasks = report.tasks;
            boostReportSourceAt = report.fetched_at || report.source_at || null;
          }
        } catch (error) { boostReportError = error.code || error.message; }
      }

      // 7. materialsTop 兜底：assembleRecord 不返回该字段，从 materials.video 取
      const materialsTop = record.materialsTop || (record.materials && record.materials.video || []).slice(0, 10).map(m => ({
        name: m.name, cost: m.cost, roiSettle: m.roiSettle, orders: m.orders, heatStatus: m.heatStatus,
      }));

      // 7.5 大屏增强（2026-08-02 探针接入）：分钟级趋势 + 调控动作日志 + 素材5分钟趋势
      // best-effort：任一路失败只缺对应段（partial），不阻塞主看板；cookie_expired 上抛
      let boardDetail = { partial: false, errors: [] };
      try {
        const { fetchBoardDetail } = require('../lib/liveBoardDetail');
        const detailStart = room.start_time || startTime;
        const detailEnd = (room.end_time && room.end_time !== '-') ? room.end_time : (endTime || undefined);
        if (detailStart) {
          boardDetail = await fetchBoardDetail(roomId, room.anchor_id, detailStart, detailEnd, account);
        }
      } catch (e) {
        if (e.message === 'cookie_expired') throw e;
        boardDetail = { partial: true, errors: [`fetchBoardDetail: ${e.message}`] };
        console.log(`[live-replay] 大屏增强拉取跳过: ${e.message}`);
      }

      // 8. 返回结果
      const payload = {
        ok: true,
        account,
        accountName,
        roomId,
        session_key: `${account}|${roomId}|${normalizeSessionTime(room.start_time)}`,
        room,
        live_metrics: record.live_metrics,
        dataValid: record.dataValid === true,
        partial: record.partial === true || boardDetail.partial === true,
        errors: [...(record.errors || []), ...(boardDetail.errors || [])],
        trend: record.trend,
        trend_minute: boardDetail.trend_minute || null,
        roi2_log: boardDetail.roi2_log || null,
        material_trends: boardDetail.material_trends || null,
        detail_partial: boardDetail.partial || false,
        source: record.source,
        funnel: record.funnel,
        materialsTop,
        materials: record.materials,
        boostTasks,
        boost_report_window: boostReportWindow,
        boost_report_source_at: boostReportSourceAt,
        boost_report_error: boostReportError,
        riskAlerts: [],
        decisions: { redList: [], blackList: [], status: 'not_evaluated' },
        settle_window_min: SETTLE_WINDOW_MIN, // 兼容字段：1h净口径缓存稳定窗口，不代表最终结算
        fetchedAt: board.fetched_at,
        cached: false,
        cachedAt: new Date().toISOString(),
      };

      // 拉一次即落盘存储（窗口内数据会被后续重拉覆盖，过窗口后可缓存该1h净口径）
      if (payload.dataValid) saveReplayStorage(account, roomId, room.start_time, payload);

      // 历史账户专用说明已从试用包移除。
      try {
        const { upsertSession } = require('../lib/liveSessionStore');
        if (payload.dataValid) upsertSession(account, payload);
      } catch (e) {
        console.log(`[live-replay] 场次入库跳过: ${e.message}`);
      }

      // 新鲜拉取与缓存命中必须返回同一份口径契约，避免刚下播时把平台 1h
      // 净口径误读成最终结算；落盘仍保留原始 payload，由读取路径统一装饰。
      return sendJSON(res, decorateReplayContract(payload, { includeBoostHistory }));
    } catch (e) {
      return handleApiError(res, e);
    }
  }

  return sendJSON(res, { ok: false, error: 'Not Found' }, 404);
}

// 复盘也采用先读存档、后台刷新。刷新按账号+日期/场次去重；失败不覆盖存档。
const replayFlights = new Map();
const replayAttempts = new Map();
function replayKey(url) {
  const q = url.searchParams;
  return JSON.stringify([q.get('account'), url.pathname, q.get('date') || '', q.get('roomId') || '',
    normalizeSessionTime(q.get('startTime')), normalizeSessionTime(q.get('endTime')), q.get('include_boost_history') === '1']);
}
function refreshReplay(url, force = false) {
  const key = replayKey(url);
  if (replayFlights.has(key)) return replayFlights.get(key);
  const previous = replayAttempts.get(key);
  if (!force && previous && Date.now() - previous.at < previous.retryMs) return Promise.resolve(previous.result);
  const target = new URL(url);
  target.searchParams.set('refresh', '1');
  const state = { at: Date.now(), retryMs: 60000, result: null };
  replayAttempts.set(key, state);
  if (replayAttempts.size > 256) replayAttempts.delete(replayAttempts.keys().next().value);
  const flight = (async () => {
    let status = 200, payload;
    await handleReplaySource({ method: 'GET', signal: AbortSignal.timeout(60000) }, {
      writeHead(code) { status = code; }, end(text) { payload = JSON.parse(text); },
    }, target);
    state.result = { status, payload };
    if (status >= 400 || payload?.ok === false) state.retryMs = 30000;
    return state.result;
  })().catch(() => {
    state.retryMs = 30000;
    state.result = { status: 502, payload: { ok: false, error: '复盘更新失败，已保留已有数据' } };
    return state.result;
  }).finally(() => replayFlights.delete(key));
  replayFlights.set(key, flight);
  return flight;
}

function replayPreview(account, roomId, startTime) {
  const collector = require('../lib/liveCollector');
  const watch = collector.getLatestWatch().find(a => a.accountId === account);
  const matches = item => item?.dataValid === true && String(item.room?.room_id) === roomId
    && normalizeSessionTime(item.room?.start_time) === normalizeSessionTime(startTime);
  let record, fetchedAt;
  if (matches(watch)) {
    record = { ...watch, trend: collector.getLatestTrend(account).trend };
    fetchedAt = watch.fetchedAt;
  } else {
    try {
      const saved = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, 'ended-board', `${account}.json`), 'utf8'));
      if (matches(saved.record)) { record = saved.record; fetchedAt = saved.fetchedAt; }
    } catch {}
  }
  if (!record) return null;
  return { ...record, ok: true, account, roomId, fetchedAt, cached: true, replay_preview: true,
    partial: true, detail_partial: true, settle_window_min: SETTLE_WINDOW_MIN,
    missing_components: ['replay_detail'],
    session_key: `${account}|${roomId}|${normalizeSessionTime(startTime)}` };
}

async function handleLiveReplay(req, res, url) {
  if (req.method !== 'GET') return handleReplaySource(req, res, url);
  const q = url.searchParams, account = q.get('account');
  try { require('../lib/api-helpers').validateAccount(account); }
  catch { return sendJSON(res, { ok: false, error: '请选择有效账户' }, 400); }
  const isList = url.pathname === '/api/live-replay/sessions';
  if (isList && (q.has('start') || q.has('end'))) {
    const dates = sessionDates(q.get('start'), q.get('end'));
    if (!dates || q.has('date') || q.has('refresh')) return sendJSON(res, {
      ok: false, code: 'invalid_session_range', error: '请选择不晚于今天、最多31天的起止日期；范围读取不与 date 或 refresh 混用',
    }, 400);
    return sendJSON(res, sessionCatalog(account, dates));
  }
  const date = q.get('date') || beijingDay();
  if (isList && !sessionDates(date, date)) return sendJSON(res, { ok: false, error: '请选择不晚于今天的有效日期' }, 400);
  if (!isList && (!q.get('roomId') || !q.get('startTime'))) return handleReplaySource(req, res, url);
  const includeBoostHistory = q.get('include_boost_history') === '1';
  if (q.get('refresh') !== '1') {
    const cached = isList ? loadSessionsStorage(account, date)
      : loadReplayStorage(account, q.get('roomId'), q.get('startTime')) || replayPreview(account, q.get('roomId'), q.get('startTime'));
    if (cached) {
      const age = Date.now() - replayTimeMs(cached.fetchedAt || (!isList && cached.cachedAt));
      const stable = isList
        ? sessionsArchiveStable(cached, date)
          || (date < beijingDay() && cached.sessions?.length === 0 && age >= -60000 && age < 86400000)
        : !cached.legacy_cache && !cached.replay_preview && replaySettled(cached);
      const historyMissing = includeBoostHistory && !cached.boost_report_window;
      const needsRefresh = !stable || historyMissing;
      if (needsRefresh && (!Number.isFinite(age) || age >= 60000 || cached.replay_preview || historyMissing)) void refreshReplay(url);
      const attempt = replayAttempts.get(replayKey(url));
      return sendJSON(res, decorateReplayContract({ ...cached, cached: true,
        refreshing: replayFlights.has(replayKey(url)),
        stale: needsRefresh && (!Number.isFinite(age) || age >= 60000),
        refresh_error: attempt?.result?.status >= 400 ? attempt.result.payload.error : null,
      }, { includeBoostHistory }));
    }
  }
  const result = await refreshReplay(url, q.get('refresh') === '1');
  return sendJSON(res, result?.payload || { ok: false, error: '复盘正在更新，请稍后重试' }, result?.status || 503);
}

module.exports = handleLiveReplay;
// 测试用内部导出（settled 判定纯函数）
module.exports._internal = {
  sessionsFinal, sessionsSettled, sessionsArchiveStable, replaySettled, normalizeSessionTime,
  replayStoragePath, loadReplayStorage, decorateReplayContract,
  sessionDates, sessionCatalog,
  SETTLE_WINDOW_MS, SETTLE_WINDOW_MIN,
};
