/**
  * 历史账户专用说明已从试用包移除。
 *
 * 数据源：
 *   - /api/live-replay 组装后的 payload（liveReplay 路由调用 upsertSession）
 *   - syncAccountDay：夜间任务/手动补采（fetchLiveSessions → 逐场 fetchBoardDetail）
 *   - migrateFromReplayFiles：storage/replay/*.json 存量导库
 * 幂等：三表全部 INSERT OR REPLACE（主键 upsert），重跑安全。
 */
const fs = require('fs');
const path = require('path');
const { getDB } = require('./db');

const REPLAY_DIR = path.join(__dirname, '..', '..', 'storage', 'replay');

function sum(arr, k) { return (arr || []).reduce((s, x) => s + (+x[k] || 0), 0); }

function normalizeSessionTime(value) {
  const raw = String(value || '').trim();
  const ms = Date.parse(raw.replace(' ', 'T'));
  return raw && Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}

/**
 * 单场写入三表（best-effort 由调用方 try/catch；缺段容错：无 trend/无 log 只写能写的）
 * @param {string} account
 * @param {object} payload - /api/live-replay 的 payload（或同构 JSON）
 * @returns {{session:boolean, trend:number, actions:number}}
 */
function upsertSession(account, payload) {
  const db = getDB();
  const room = payload.room || {};
  const roomId = String(payload.roomId || room.room_id || '');
  if (!roomId) throw new Error('payload 缺 roomId');
  const startTime = normalizeSessionTime(room.start_time || payload.startTime);
  if (!startTime) throw new Error('payload 缺有效 startTime，无法隔离直播场次');
  const lm = payload.live_metrics || {};
  // 汇总指标：优先 live_metrics，缺失用 trend_minute 求和兜底
  const trend = payload.trend_minute || [];
  const legacyTrend = payload.trend || [];
  const cost = lm.cost != null ? lm.cost : (trend.length ? sum(trend, 'cost') : sum(legacyTrend, 'cost'));
  const net = lm.gmvSettle != null ? lm.gmvSettle : (trend.length ? sum(trend, 'net_1h') : sum(legacyTrend, 'gmvSettle'));
  const orders = lm.orders != null ? lm.orders : (trend.length ? sum(trend, 'orders') : 0);

  db.prepare(`
    INSERT OR REPLACE INTO live_sessions
      (account_id, room_id, room_name, start_time, end_time, status, cost, gmv, net_gmv, orders, source, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    account, roomId, room.room_name || '', startTime, room.end_time || '',
    String(room.status || ''), +cost || 0, lm.gmv != null ? +lm.gmv : 0, +net || 0, Math.round(+orders || 0),
    (typeof payload.source === 'string' ? payload.source : 'replay'), new Date().toISOString()
  );

  let trendN = 0;
  // 分钟级优先；无 trend_minute 时回退旧 5 分钟 trend（cost/gmvSettle→net_1h，存量 replay 文件兼容）
  const trendRows = trend.length
    ? trend.map(p => ({ t: p.t, cost: p.cost, orders: p.orders, gmv: p.gmv, net_1h: p.net_1h, cost_all: p.cost_all }))
    : legacyTrend.map(p => ({ t: p.time, cost: p.cost, orders: 0, gmv: 0, net_1h: p.gmvSettle, cost_all: 0 }));
  if (trendRows.length) {
    const ins = db.prepare(`
      INSERT OR REPLACE INTO live_session_trend (account_id, room_id, start_time, point_time, cost, orders, gmv, net_1h, cost_all)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    db.exec('BEGIN');
    try {
      for (const p of trendRows) {
        if (!p.t) continue;
        ins.run(account, roomId, startTime, String(p.t), +p.cost || 0, Math.round(+p.orders || 0), +p.gmv || 0, +p.net_1h || 0, +p.cost_all || 0);
        trendN++;
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }

  let actN = 0;
  const logs = payload.roi2_log || [];
  if (logs.length) {
    const ins = db.prepare(`
      INSERT OR REPLACE INTO live_session_actions (account_id, room_id, start_time, action_ts, action_type, action_text, kind)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    db.exec('BEGIN');
    try {
      for (const l of logs) {
        if (!l.ts) continue;
        ins.run(account, roomId, startTime, +l.ts, String(l.type || ''), String(l.text || ''), l.kind || null);
        actN++;
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }

  return { session: true, trend: trendN, actions: actN };
}

/**
 * 存量迁移：storage/replay/replay_<acct>_<roomId>.json 全量导库（幂等）
 * @returns {{files:number, sessions:number, trend:number, actions:number, errors:string[]}}
 */
function migrateFromReplayFiles() {
  const out = { files: 0, sessions: 0, trend: 0, actions: 0, errors: [] };
  if (!fs.existsSync(REPLAY_DIR)) return out;
  for (const f of fs.readdirSync(REPLAY_DIR)) {
    const m = /^replay_([a-z]+)_(.+)\.json$/.exec(f);
    if (!m) continue;
    out.files++;
    try {
      const payload = JSON.parse(fs.readFileSync(path.join(REPLAY_DIR, f), 'utf8'));
      const r = upsertSession(m[1], payload);
      out.sessions++;
      out.trend += r.trend;
      out.actions += r.actions;
    } catch (e) {
      out.errors.push(`${f}: ${e.message}`);
    }
  }
  return out;
}

/**
 * 夜间同步：拉某日全部场次的大屏增强并入库（分钟趋势+调控日志；汇总指标从 replay 缓存/大屏取）
 * @param {string} accountId
 * @param {string} date - YYYY-MM-DD
 * @returns {Promise<{sessions:number, trend:number, actions:number, errors:string[]}>}
 */
async function syncAccountDay(accountId, date) {
  const { fetchLiveSessions } = require('./qianchuanTabs');
  const { fetchBoardDetail } = require('./liveBoardDetail');
  const out = { sessions: 0, trend: 0, actions: 0, errors: [] };
  const r = await fetchLiveSessions(date, { accountId });
  if (r.error) { out.errors.push(`sessions: ${r.error}`); return out; }
  for (const s of r.sessions || []) {
    try {
      const detail = await fetchBoardDetail(s.roomId, s.anchorId, s.startTime, s.endTime !== '-' ? s.endTime : undefined, accountId);
      // 汇总：用 trend_minute 求和（净成交=net_1h 求和为 1h 口径，标注 source）
      const payload = {
        roomId: s.roomId,
        room: { room_id: s.roomId, room_name: s.roomName || '', start_time: s.startTime, end_time: s.endTime, status: s.status },
        live_metrics: {
          cost: sum(detail.trend_minute, 'cost'),
          orders: sum(detail.trend_minute, 'orders'),
          gmvSettle: sum(detail.trend_minute, 'net_1h'),
        },
        trend_minute: detail.trend_minute,
        roi2_log: detail.roi2_log,
        source: 'night-sync',
      };
      const w = upsertSession(accountId, payload);
      out.sessions++;
      out.trend += w.trend;
      out.actions += w.actions;
    } catch (e) {
      out.errors.push(`${s.roomId}: ${e.message}`);
    }
  }
  return out;
}

module.exports = { upsertSession, migrateFromReplayFiles, syncAccountDay, normalizeSessionTime };
