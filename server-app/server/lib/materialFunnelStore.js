// SQLite 只读适配：把 T+1 稳定日报与最近一次 30 天深度流失快照组装成素材漏斗。
const { aggregateFunnelRows, evaluateFunnel } = require('./materialFunnel');

function shiftDate(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function percentile(value, sorted) {
  if (value == null || value === '' || !Number.isFinite(+value) || !sorted.length) return null;
  let atOrBelow = 0;
  for (const n of sorted) if (n <= +value) atOrBelow++;
  return atOrBelow / sorted.length;
}

function loadStableFunnelContext(db, accountId, endDate, days = 7, params = {}) {
  const startDate = shiftDate(endDate, -(Math.max(1, days) - 1));
  const rows = db.prepare(`
    SELECT material_id, stat_date, duration, cost, plays, shows, clicks, cpc,
           rate3s, finish_rate, avg_watch_time
    FROM material_daily
    WHERE account_id = ? AND marketing_goal = 2 AND material_id != '__EMPTY__'
      AND stat_date BETWEEN ? AND ?
  `).all(accountId, startDate, endDate);

  const byMaterial = new Map();
  for (const row of rows) {
    const id = String(row.material_id);
    if (!byMaterial.has(id)) byMaterial.set(id, []);
    byMaterial.get(id).push(row);
  }
  const benchmark = aggregateFunnelRows(rows);

  const insights = db.prepare(`
    SELECT i.material_id, i.stat_date, i.click_count, i.drop_count, i.lose_rate_5s, i.fetched_at
    FROM material_insight i
    JOIN (
      SELECT material_id, MAX(stat_date) AS max_date
      FROM material_insight WHERE account_id = ? GROUP BY material_id
    ) latest ON latest.material_id = i.material_id AND latest.max_date = i.stat_date
    WHERE i.account_id = ?
  `).all(accountId, accountId);
  const insightMap = new Map(insights.map(r => [String(r.material_id), r]));
  const dropValues = insights.map(r => +r.drop_count).filter(Number.isFinite).sort((a, b) => a - b);

  const materials = new Map();
  for (const [id, materialRows] of byMaterial) {
    const aggregate = aggregateFunnelRows(materialRows);
    const insight = insightMap.get(id) || {};
    const insightContext = {
      drop_count: Number.isFinite(+insight.drop_count) ? +insight.drop_count : null,
      drop_percentile: percentile(insight.drop_count, dropValues),
    };
    materials.set(id, {
      ...evaluateFunnel(aggregate, benchmark, insightContext, params),
      stable_window: { start: startDate, end: endDate, days },
      insight_window: insight.stat_date ? { end: insight.stat_date, days: 30, fetched_at: insight.fetched_at || null } : null,
      insight: insightContext,
    });
  }

  return { startDate, endDate, benchmark, materials };
}

module.exports = { shiftDate, percentile, loadStableFunnelContext };
