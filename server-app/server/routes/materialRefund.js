const { sendJSON, resolveDateRange, yesterday, daysAgo } = require('../lib/utils');
const { fetchVideoFilterWithCost } = require('../lib/qianchuanTabs');

/**
 * GET /api/material-refund?start=&end=&account=&minCost=&dateRange=
 *
 * 素材退款率分析(带消耗)。输出每条素材: 消耗/成交GMV/退款金额/退款单数/退款率/结算率。
 * 退款率 = 退款GMV ÷ 成交GMV。千川"高退款"阈值 1h退款率≥10%，≥20% 危险。
 * 数据来源: video-filter-list × roi2_material_list 关联(video-filter-list 不含消耗)。
 */
async function handleMaterialRefund(req, res, url) {
  let end = url.searchParams.get('end');
  let start = url.searchParams.get('start');
  const dateRange = url.searchParams.get('dateRange');

  if (dateRange) {
    const range = resolveDateRange(dateRange);
    if (range) {
      start = range.start;
      end = range.end;
    }
  }

  // 默认近30天
  if (!end) end = yesterday();
  if (!start) start = daysAgo(30);

  const account = url.searchParams.get('account') || undefined;
  const minCost = parseFloat(url.searchParams.get('minCost') || '0') || 0;
  if (!start || !end) return sendJSON(res, { ok: false, error: 'missing start/end' }, 400);

  try {
    const r = await fetchVideoFilterWithCost(start, end, account);
    let rows = r.rows || [];
    if (minCost > 0) rows = rows.filter(x => x.cost >= minCost);
    // 按退款率降序，高退款在前
    rows.sort((a, b) => b.refundRate - a.refundRate);
    const danger = rows.filter(x => x.refundRate >= 0.2 && x.refundGmv > 0);      // ≥20% 危险
    const warning = rows.filter(x => x.refundRate >= 0.1 && x.refundRate < 0.2 && x.refundGmv > 0); // 10%-20% 警示
    sendJSON(res, {
      ok: true,
      start, end, account: account || 'default',
      count: rows.length,
      dangerCount: danger.length,
      warningCount: warning.length,
      danger,   // 退款率≥20%
      warning,  // 退款率10%-20%
      rows,     // 全部(按退款率降序)
    });
  } catch (e) {
    const code = e.message === 'cookie_expired' ? 401 : 500;
    sendJSON(res, { ok: false, error: e.message }, code);
  }
}

module.exports = handleMaterialRefund;
