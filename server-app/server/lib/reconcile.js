/**
 * 采集对账：本地 material_daily 汇总 vs 千川账户级汇总（home_cost_uni_prom，独立数据源）。
 *
 * 背景：material_daily 曾出现整段漏采（06-18~07-12），素材累计 ROI 被低估，
 * AI 据此提交了错误的删除素材建议。对账的目的是让"漏采"在 24 小时内暴露，
 * 而不是等到决策出错才被发现。
 *
 * 规则：|本地Σcost − 账户级cost| / 账户级cost > 5% 即异常（含一边为 0 另一边非 0）。
 * 异常处理：console.error + 追加 logs/reconcile.log + 写 cache/reconcile_latest.json
 * （/api/backfill-status 透出，前端系统记录页可见）。
 */
const fs = require('fs');
const path = require('path');
const { getDB } = require('./db');

const DEVIATION_THRESHOLD = 0.05;
const LOGS_DIR = path.join(__dirname, '..', '..', 'logs');
const CACHE_DIR = path.join(__dirname, '..', '..', 'cache');
const LATEST_FILE = path.join(CACHE_DIR, 'reconcile_latest.json');

function localCostSum(date, accountId) {
  const db = getDB();
  // 口径对齐远端 fetchAllData（直播渠道）：排除商品卡（marketing_goal=1，2026-07-30 起双渠道入库），
  // 历史账户专用说明已从试用包移除。
  const row = db.prepare(`
    SELECT ROUND(SUM(cost), 2) AS cost, COUNT(*) AS rows
    FROM material_daily
    WHERE account_id = ? AND stat_date = ? AND material_id != '__EMPTY__' AND marketing_goal = 2
  `).get(accountId, date);
  return { cost: row && row.cost ? +row.cost : 0, rows: row ? row.rows : 0 };
}

function persist(result) {
  let all = {};
  try { all = JSON.parse(fs.readFileSync(LATEST_FILE, 'utf-8')); } catch (e) { /* 首次 */ }
  all[result.accountId] = result;
  try { fs.writeFileSync(LATEST_FILE, JSON.stringify(all, null, 2), 'utf-8'); } catch (e) { /* 非关键 */ }
}

/**
 * 对账某一天。返回 { date, accountId, local_cost, remote_cost, deviation, anomaly, rows, checked_at, error? }
 * 远端拉取失败时 anomaly=false, error 有值（不算漏采，算"无法核验"，下晚再核）。
 */
async function reconcileDate(date, accountId) {
  const local = localCostSum(date, accountId);
  const base = { date, accountId, local_cost: local.cost, rows: local.rows, checked_at: new Date().toISOString() };
  let remoteCost = null;
  try {
    // 同口径远端：与写入端完全相同的查询（fetchAllData 单日），Σ「整体消耗(元)」。
    // 不用 home_cost_uni_prom 账户级口径——它含素材明细覆盖不到的产品线，结构性不一致会误报。
    const { fetchAllData, normalizeApiRows } = require('./data');
    const result = await fetchAllData(date, date, accountId);
    const rows = (result && result.rows) || [];
    const normalized = normalizeApiRows(rows);
    // 与 storeDaily 的 INSERT OR REPLACE 语义对齐：同 素材ID 只计最后一行
    // （AIGC"视频素材集合/素材集合"归一化后是同一 id、同值重复行，不去重会把远端求和虚增一倍）
    const byId = new Map();
    for (const r of normalized) byId.set(String(r['素材ID'] || ''), r);
    remoteCost = +[...byId.values()].reduce((s, r) => s + (parseFloat(String(r['整体消耗(元)'] || '').replace(/[%,]/g, '')) || 0), 0).toFixed(2);
  } catch (e) {
    const result = { ...base, remote_cost: null, deviation: null, anomaly: false, error: e.message };
    console.warn(`[reconcile] ${accountId} ${date} 远端核验失败（不算异常）: ${e.message}`);
    persist(result);
    return result;
  }

  const deviation = remoteCost > 0 ? Math.abs(local.cost - remoteCost) / remoteCost : (local.cost > 0 ? 1 : 0);
  const anomaly = remoteCost > 0 ? deviation > DEVIATION_THRESHOLD : local.cost > 0;
  const result = { ...base, remote_cost: remoteCost, deviation: +deviation.toFixed(4), anomaly };

  const line = JSON.stringify(result);
  if (anomaly) {
    console.error(`🚨 [reconcile] ${accountId} ${date} 对账异常：本地Σcost ${local.cost} vs 账户级 ${remoteCost}（偏差 ${(deviation * 100).toFixed(1)}%，阈值 5%）——疑似漏采，本地库当日数据不可信`);
  } else {
    console.log(`[reconcile] ${accountId} ${date} 对账通过：本地 ${local.cost} vs 账户级 ${remoteCost}（偏差 ${(deviation * 100).toFixed(1)}%）`);
  }
  try { fs.appendFileSync(path.join(LOGS_DIR, 'reconcile.log'), line + '\n', 'utf-8'); } catch (e) { /* 非关键 */ }
  persist(result);
  return result;
}

/** /api/backfill-status 透出用：读最近一次对账结果（cache/reconcile_latest.json） */
function getLatestReconcile(accountId) {
  try {
    const all = JSON.parse(fs.readFileSync(LATEST_FILE, 'utf-8'));
    return accountId ? (all[accountId] || null) : all;
  } catch (e) {
    return accountId ? null : {};
  }
}

module.exports = { reconcileDate, getLatestReconcile, DEVIATION_THRESHOLD };
