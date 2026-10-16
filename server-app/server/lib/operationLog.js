/**
 * server/lib/operationLog.js — 操作日志（审计追踪）
 *
 * 记录所有通过本地 API 执行的千川写操作（暂停/启用/改预算/改ROI/新建追投/删除素材等），
 * 用于投手追溯"谁在什么时间改了什么"。
 *
 * 存储：SQLite（复用 db.js 的 getDB()，同库新建 operation_log 表）
 * 写入：campaignOps 等写操作路由在执行成功后异步写入（不阻塞响应）
 */

const { getDB } = require('./db');

/**
 * 确保 operation_log 表存在（幂等执行）。
 * 2026-08-11 backlog 检修：进程内只执行一次（原每次 log/query/stats 重复 CREATE TABLE + 4 索引 DDL）
 */
let tableEnsured = false;
function ensureTable() {
  if (tableEnsured) return;
  const db = getDB();
  db.exec(`
    CREATE TABLE IF NOT EXISTS operation_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ts          TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      action      TEXT NOT NULL,
      account_id  TEXT,
      primary_ad_id   TEXT,
      assist_task_id  TEXT,
      target_type     TEXT,
      target_id       TEXT,
      params      TEXT,
      result_code INTEGER,
      result_msg  TEXT,
      success     INTEGER DEFAULT 1,
      source      TEXT DEFAULT 'api',
      ip          TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_oplog_ts ON operation_log(ts);
    CREATE INDEX IF NOT EXISTS idx_oplog_action ON operation_log(action);
    CREATE INDEX IF NOT EXISTS idx_oplog_ad_id ON operation_log(primary_ad_id);
    CREATE INDEX IF NOT EXISTS idx_oplog_account_ts ON operation_log(account_id, ts);
  `);
  tableEnsured = true; // exec 成功才置位（失败保持 false，下次重试）
}

/**
 * 写入一条操作日志（异步，不抛错）。
 * @param {object} entry
 * @param {string} entry.action - 操作类型：pause|enable|update_budget|update_roi|create_boost|delete_material
 * @param {string} [entry.account_id]
 * @param {string} [entry.primary_ad_id]
 * @param {string} [entry.assist_task_id]
 * @param {string} [entry.target_type] - plan|material|boost_task
 * @param {string} [entry.target_id]
 * @param {object} [entry.params] - 操作参数（budget/roiGoal/status 等）
 * @param {number} [entry.result_code] - 千川返回的 status_code
 * @param {string} [entry.result_msg]
 * @param {boolean} [entry.success=true]
 * @param {string} [entry.source='api'] - api|agent|e2e|manual
 * @param {string} [entry.ip]
 */
function log(entry) {
  try {
    ensureTable();
    const db = getDB();
    const result = db.prepare(`
      INSERT INTO operation_log
        (action, account_id, primary_ad_id, assist_task_id, target_type, target_id,
         params, result_code, result_msg, success, source, ip)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.action || 'unknown',
      entry.account_id || null,
      entry.primary_ad_id || null,
      entry.assist_task_id || null,
      entry.target_type || null,
      entry.target_id || null,
      entry.params ? JSON.stringify(entry.params) : null,
      entry.result_code ?? null,
      entry.result_msg || null,
      entry.success !== false ? 1 : 0,
      entry.source || 'api',
      entry.ip || null
    );
    return Number(result.lastInsertRowid);
  } catch (e) {
    console.error('[operationLog] 写入失败:', e.message);
    return null;
  }
}

/**
 * 归一化写操作来源标记：只放行已知来源，其余一律记为 'api'（投手）。
 * 'agent' = K3/回环 AI 决策；'e2e' = 测试写操作（后验/胜率统计可排除）。
 * @param {string} [s]
 * @returns {'api'|'agent'|'e2e'}
 */
function normalizeSource(s) {
  return s === 'agent' || s === 'e2e' ? s : 'api';
}

/**
 * 查询操作日志。
 * @param {object} [opts]
 * @param {string} [opts.startDate] - 起始日期 YYYY-MM-DD
 * @param {string} [opts.endDate] - 结束日期 YYYY-MM-DD
 * @param {string} [opts.action] - 操作类型过滤
 * @param {string} [opts.accountId] - 账号过滤
 * @param {string} [opts.adId] - 计划ID过滤
 * @param {string[]} [opts.excludeSources] - 排除指定来源（如 ['e2e'] 过滤测试数据），默认不过滤
 * @param {number} [opts.limit=100]
 * @param {number} [opts.offset=0]
 * @returns {object[]} 日志记录数组
 */
function query(opts = {}) {
  try {
    ensureTable();
    const db = getDB();
    const conditions = [];
    const params = [];

    if (opts.startDate) {
      conditions.push("ts >= ?");
      params.push(opts.startDate + ' 00:00:00');
    }
    if (opts.endDate) {
      conditions.push("ts <= ?");
      params.push(opts.endDate + ' 23:59:59');
    }
    if (opts.action) {
      conditions.push("action = ?");
      params.push(opts.action);
    }
    if (opts.accountId) {
      conditions.push("account_id = ?");
      params.push(opts.accountId);
    }
    if (opts.adId) {
      // target_id 可能是逗号拼接串（如追投/删素材存 "MID1,MID2"），
      // 两端补逗号后 LIKE 匹配，可命中子项且不会误匹配（查 MID1 不会命中 MID10）
      conditions.push("(primary_ad_id = ? OR ',' || target_id || ',' LIKE ?)");
      params.push(opts.adId, '%,' + opts.adId + ',%');
    }
    if (opts.effectStatus) {
      // New receipt rows keep the final state under receipt.effect_status;
      // the top-level value is the safe provisional state for older/incomplete rows.
      conditions.push("json_valid(params) AND COALESCE(json_extract(params, '$.receipt.effect_status'), json_extract(params, '$.effect_status')) = ?");
      params.push(String(opts.effectStatus));
    }
    if (Array.isArray(opts.excludeSources) && opts.excludeSources.length) {
      // 排除指定来源（典型：后验/胜率统计排除 e2e 测试数据）；NULL 视为未知来源不排除
      const ph = opts.excludeSources.map(() => '?').join(',');
      conditions.push(`(source IS NULL OR source NOT IN (${ph}))`);
      params.push(...opts.excludeSources);
    }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const limit = Math.min(opts.limit || 100, 500);
    const offset = opts.offset || 0;

    const stmt = db.prepare(`
      SELECT * FROM operation_log
      ${where}
      ORDER BY ts DESC
      LIMIT ? OFFSET ?
    `);
    const rows = stmt.all(...params, limit, offset);

    // 解析 params JSON（容错：损坏的JSON返回原始字符串）
    return rows.map(r => {
      let params = null;
      if (r.params) { try { params = JSON.parse(r.params); } catch { params = r.params; } }
      return { ...r, params, success: r.success === 1 };
    });
  } catch (e) {
    // 2026-08-11 事故复盘：DB 损坏时 opLog.query 抛错会让写操作路由直接 500（熔断/幂等查询失败）；
    // 降级返回空数组（= 熔断/幂等记录查不到，放行侧），并告警——绝不让审计查询阻塞主业务写操作
    console.error('[opLog] query 异常（DB 不可用?），降级返回空数组:', e.message);
    return [];
  }
}

/**
 * 硬护栏专用：读取某目标最后一次成功 ROI 调整。
 * 与 query() 不同，本函数故意不吞 DB 异常；调用方必须 fail-closed，避免审计库故障时绕过冷却。
 */
function getLastSuccessfulRoiUpdate(accountId, targetId) {
  ensureTable();
  const db = getDB();
  const row = db.prepare(`
    SELECT *
    FROM operation_log
    WHERE account_id = ?
      AND success = 1
      AND (action IN ('update_roi', 'update_budget_roi') OR
        (action IN ('update_bid','update_audience') AND json_valid(params)
          AND json_extract(params, '$.roiGoal') IS NOT NULL))
      AND (target_id = ? OR (target_id IS NULL AND assist_task_id IS NULL AND primary_ad_id = ?))
    ORDER BY ts DESC, id DESC
    LIMIT 1
  `).get(accountId, String(targetId), String(targetId));
  if (!row) return null;
  let params = null;
  if (row.params) { try { params = JSON.parse(row.params); } catch { params = row.params; } }
  return { ...row, params, success: true };
}

/** 按主键读取单条操作回执；用于决策账本验真，不吞 DB 异常。 */
function getById(id) {
  const operationId = Number(id);
  if (!Number.isInteger(operationId) || operationId <= 0) return null;
  ensureTable();
  const row = getDB().prepare('SELECT * FROM operation_log WHERE id = ?').get(operationId);
  if (!row) return null;
  let params = null;
  if (row.params) { try { params = JSON.parse(row.params); } catch { params = row.params; } }
  return { ...row, params, success: row.success === 1 };
}

/**
 * 统计某时间段内的操作次数（按 action 分组）。
 * @param {string} [startDate]
 * @param {string} [endDate]
 * @returns {object[]} [{action, count, success_count, fail_count}]
 */
function stats(startDate, endDate) {
  ensureTable();
  const db = getDB();
  const conditions = [];
  const params = [];
  if (startDate) { conditions.push("ts >= ?"); params.push(startDate + ' 00:00:00'); }
  if (endDate) { conditions.push("ts <= ?"); params.push(endDate + ' 23:59:59'); }
  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  const stmt = db.prepare(`
    SELECT action,
           COUNT(*) as count,
           SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as success_count,
           SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as fail_count
    FROM operation_log
    ${where}
    GROUP BY action
    ORDER BY count DESC
  `);
  return stmt.all(...params);
}

module.exports = {
  ensureTable,
  log,
  query,
  getLastSuccessfulRoiUpdate,
  getById,
  stats,
  normalizeSource,
  getRecentParameterUpdates,
  attachReceipt,
};

// Guard queries must not swallow database errors or include sibling tasks/suggestions.
function getRecentParameterUpdates(accountId, targetId, now = Date.now()) {
  ensureTable();
  const local = new Date(now - 3600000);
  const pad = n => String(n).padStart(2, '0');
  const since = `${local.getFullYear()}-${pad(local.getMonth()+1)}-${pad(local.getDate())} ${pad(local.getHours())}:${pad(local.getMinutes())}:${pad(local.getSeconds())}`;
  return getDB().prepare(`SELECT id, ts, action FROM operation_log
    WHERE account_id = ? AND target_id = ? AND success = 1 AND ts > ?
      AND action IN ('update_budget','update_duration','update_bid','update_audience','update_budget_roi')
      AND NOT (action = 'update_budget_roi' AND json_valid(params)
        AND COALESCE(json_extract(params, '$.partial_effect.budget'), '') IN ('not_submitted', 'rejected'))
    ORDER BY ts DESC, id DESC`).all(String(accountId), String(targetId), since);
}

function attachReceipt(id, receipt) {
  if (!id) return;
  const row = getById(id);
  if (!row) return;
  getDB().prepare('UPDATE operation_log SET params = ? WHERE id = ?')
    .run(JSON.stringify({ ...(row.params || {}), receipt }), Number(id));
}

// 数量护栏不能使用 query() 的吞错空列表；存储失败必须阻断增加投放。
// 2026-09-30：新增可选 options.sinceTs（本地 'YYYY-MM-DD HH:MM:SS'）。
// 背景：create_boost 的回读永远无法确认 duration_seconds（平台列表不返回该字段），
// 于是历史场次会留下永久 unconfirmed 的行；这些行的任务早已不在任何列表窗口内，
// 会让该主计划的新建/恢复被永久阻断。收窄到本场后，本场自身的未回读请求仍然阻断（防重复提交）。
function getUnconfirmedBoostExposure(accountId, primaryAdId, options = {}) {
  ensureTable();
  const since = options && options.sinceTs ? String(options.sinceTs) : null;
  return getDB().prepare(`SELECT id, ts, assist_task_id AS target_id FROM operation_log
    WHERE account_id = ? AND primary_ad_id = ? AND target_type = 'boost_task'
      AND action IN ('create_boost', 'enable') AND json_valid(params)
      AND COALESCE(json_extract(params, '$.receipt.effect_status'), json_extract(params, '$.effect_status')) = 'unconfirmed'
      AND (? IS NULL OR ts >= ?)
    ORDER BY id`).all(String(accountId), String(primaryAdId), since, since);
}
module.exports.getUnconfirmedBoostExposure = getUnconfirmedBoostExposure;
