// server/lib/intradayStore.js — 盘中临时库（material_intraday）读写层
//
// 历史账户专用说明已从试用包移除。
// 纪律：盘中数据只作参考，严禁判杀（终值才可判）。表与 material_daily(T+1终值) 完全隔离。
const { getDB } = require('./db');

/**
 * 落一条盘中快照（INSERT OR REPLACE，同 snapshot_time 幂等重跑）。
 * @param {object} s { account_id, material_id, stat_date, material_name, status,
 *                    cost, net_gmv_1h, orders, refund_rate, boost_cost, boost_settle_roi,
 *                    shows, clicks, cpc, click_rate, convert_rate, net_data_valid }
 */
function upsertSnapshot(s) {
  if (!s || !s.account_id || !s.material_id) return;
  const db = getDB();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR REPLACE INTO material_intraday
      (account_id, material_id, snapshot_time, stat_date, material_name, status,
       cost, net_gmv_1h, orders, refund_rate, boost_cost, boost_settle_roi,
       shows, clicks, cpc, click_rate, convert_rate, net_data_valid, fetched_at, net_roi_1h)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    s.account_id, String(s.material_id), s.snapshot_time || now, s.stat_date,
    s.material_name || null, s.status || null,
    +s.cost || 0, +s.net_gmv_1h || 0, Math.round(+s.orders || 0),
    +s.refund_rate || 0, +s.boost_cost || 0, +s.boost_settle_roi || 0,
    Math.round(+s.shows || 0), Math.round(+s.clicks || 0), +s.cpc || 0,
    +s.click_rate || 0, +s.convert_rate || 0,
    s.net_data_valid === true || s.net_data_valid === 1 ? 1 : 0, now,
    s.net_roi_1h != null && s.net_roi_1h !== '' && Number.isFinite(Number(s.net_roi_1h)) ? Number(s.net_roi_1h) : null
  );
}

/**
 * 批量落盘（一次采集的多条素材，同 snapshot_time）。
 * 2026-08-11 审查修复：批量包裹显式事务（原逐条隐式事务，高频采集时写放大 + 锁竞争）
 */
function upsertSnapshots(list, snapshotTime) {
  if (!Array.isArray(list) || !list.length) return 0;
  const st = snapshotTime || new Date().toISOString();
  const db = getDB();
  db.exec('BEGIN');
  try {
    for (const s of list) upsertSnapshot({ ...s, snapshot_time: st });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return list.length;
}

/**
 * 某天每个素材的最新一条快照（当天评估参考）。
 * @returns {Array<object>} 每素材一行最新快照
 */
function getLatestSnapshots(accountId, date) {
  const db = getDB();
  return db.prepare(`
    SELECT i.* FROM material_intraday i
    JOIN (
      SELECT material_id, MAX(snapshot_time) AS mt
      FROM material_intraday
      WHERE account_id = ? AND stat_date = ?
      GROUP BY material_id
    ) m ON i.material_id = m.material_id AND i.snapshot_time = m.mt
    WHERE i.account_id = ? AND i.stat_date = ?
    ORDER BY i.cost DESC
  `).all(accountId, date, accountId, date);
}

/**
 * 近 N 天快照序列（对账用）：按素材返回时间序列。
 */
function getReconcileData(accountId, fromDate, toDate) {
  const db = getDB();
  return db.prepare(`
    SELECT account_id, material_id, snapshot_time, stat_date, material_name,
           cost, net_gmv_1h, orders, refund_rate, shows, clicks, cpc, click_rate, convert_rate
    FROM material_intraday
    WHERE account_id = ? AND stat_date BETWEEN ? AND ?
    ORDER BY material_id, snapshot_time
  `).all(accountId, fromDate, toDate);
}

/**
 * 清理 N 天前的快照（防表膨胀，夜间任务每日调）。
 * @returns {number} 删除行数
 */
function prune(days = 7) {
  const db = getDB();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffDate = cutoff.toISOString().slice(0, 10);
  const r = db.prepare('DELETE FROM material_intraday WHERE stat_date < ?').run(cutoffDate);
  return r.changes;
}

/** 今日某账号是否有快照（采集链路自检/冒烟用） */
function hasToday(accountId, date) {
  const db = getDB();
  const r = db.prepare('SELECT COUNT(*) c FROM material_intraday WHERE account_id = ? AND stat_date = ?')
    .get(accountId, date);
  return (r && r.c) > 0;
}

module.exports = { upsertSnapshot, upsertSnapshots, getLatestSnapshots, getReconcileData, prune, hasToday };
