const { sendJSON, getLocalDateStr, resolveDateRange } = require('../lib/utils');
const { aggregateByDate } = require('../lib/db');

async function handleSparkline(req, res, url) {
  try {
    // 支持 dateRange 档位（如 today/7days），兼容旧的 days 参数
    const dateRange = url.searchParams.get('dateRange');
    let days;
    if (dateRange) {
      const range = resolveDateRange(dateRange);
      if (range) {
        const d1 = new Date(range.start + 'T00:00:00');
        const d2 = new Date(range.end + 'T00:00:00');
        days = Math.round((d2 - d1) / 86400000) + 1;
      }
    }
    if (!days) {
      const rawDays = parseInt(url.searchParams.get('days') || '7', 10);
      if (isNaN(rawDays)) return sendJSON(res, { ok: false, error: 'days 参数必须为数字' }, 400);
      days = Math.max(1, Math.min(rawDays, 30));
    }
    const account = url.searchParams.get('accountId') || url.searchParams.get('account') || undefined;

    // 计算日期范围
    const dates = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      dates.push(getLocalDateStr(d));
    }
    const start = dates[0];
    const end = dates[dates.length - 1];

    // 一次 SQL 查完所有天的汇总（替代原来的 N 次串行查询）
    const rows = aggregateByDate(start, end, account) || [];
    const rowMap = new Map(rows.map(r => [r.stat_date, r]));

    const cost = [], gmv = [], netAmount = [], mat = [];
    for (const ds of dates) {
      const r = rowMap.get(ds);
      if (r) {
        cost.push(Math.round(r.cost));
        gmv.push(Math.round(r.gmv));
        netAmount.push(Math.round(r.net_gmv));
        mat.push(r.material_count);
      } else {
        cost.push(0); gmv.push(0); netAmount.push(0); mat.push(0);
      }
    }
    const netRoi = cost.map((c, i) => c > 0 ? parseFloat((netAmount[i] / c).toFixed(2)) : 0);
    return sendJSON(res, {
      ok: true, dates, cost, gmv, netAmount, netRoi, mat,
      data_source: 'sqlite_material_daily',
      note: '消耗来自本地已采集素材汇总，可能低于 /api/overview 的账号实时总消耗',
      server_time: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[sparkline] 查询失败:', e.message);
    return sendJSON(res, { ok: false, error: e.message }, 500);
  }
}

module.exports = handleSparkline;
