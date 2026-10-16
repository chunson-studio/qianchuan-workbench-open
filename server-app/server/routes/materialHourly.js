
const { statQuery } = require('../lib/qianchuan');
const { resolveAavid } = require('../lib/cookie');
const { sendJSON } = require('../lib/utils');
const { validateAccount } = require('../lib/api-helpers');

const PROMOTION_DS = 'roi2_video_material_analysis_promotion';
const METRICS = [
  'stat_cost_for_roi2',
  'total_prepay_and_pay_order_roi2',
  'total_pay_order_gmv_include_coupon_for_roi2',
  'total_pay_order_count_for_roi2',
  'total_prepay_and_pay_settle_roi2_1h',
  'total_order_settle_amount_for_roi2_1h',
  'total_order_settle_count_for_roi2_1h',
];
const MAX_DAYS = 31;
const PAGE_LIMIT = 200;
const MAX_PAGES = 10;

function num(o, k) {
  const v = o && o[k];
  return v ? parseFloat(String(v.ValueStr ?? v.Value ?? 0)) : 0;
}
function str(o, k) {
  const v = o && o[k];
  return v ? String(v.ValueStr ?? v.Value ?? '') : '';
}

async function handleMaterialHourly(req, res, url) {
  const q = url.searchParams;
  const account = q.get('account') || q.get('accountId');
  const materialId = q.get('material_id') || q.get('materialId') || q.get('id');
  const start = q.get('start') || q.get('startDate');
  const end = q.get('end') || q.get('endDate');
  const name = q.get('name') || null;

  if (!account) return sendJSON(res, { ok: false, error: 'Missing account' }, 400);
  try { validateAccount(account); } catch (e) { return sendJSON(res, { ok: false, error: e.message }, 400); }
  if (!materialId || !/^\d{1,30}$/.test(String(materialId))) {
    return sendJSON(res, { ok: false, error: 'material_id 必须为数字字符串' }, 400);
  }
  if (!start || !end || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    return sendJSON(res, { ok: false, error: 'start/end 必填，格式 YYYY-MM-DD' }, 400);
  }
  if (start > end) return sendJSON(res, { ok: false, error: 'start 不能晚于 end' }, 400);
  const days = Math.round((new Date(end) - new Date(start)) / 86400000) + 1;
  if (days > MAX_DAYS) return sendJSON(res, { ok: false, error: `查询区间最多 ${MAX_DAYS} 天` }, 400);

  const aavid = resolveAavid(account);
  const rawRows = [];
  let offset = 0;
  while (true) {
    const body = {
      DataSetKey: PROMOTION_DS,
      reqFrom: 'roi2_material_list',
      StartTime: start + ' 00:00:00',
      EndTime: end + ' 23:59:59',
      Metrics: METRICS,
      Dimensions: ['stat_time_hour'],
      Filters: { ConditionRelationshipType: 1, Conditions: [
        { Field: 'advertiser_id', Operator: 7, Values: [aavid] },
        { Field: 'marketing_goal', Operator: 7, Values: ['2'] },
        { Field: 'adlab_mode_fork', Operator: 7, Values: ['1'] },
        { Field: 'material_type', Operator: 7, Values: ['3'] },
        { Field: 'material_id', Operator: 7, Values: [String(materialId)] },
      ]},
      PageParams: { Offset: offset, Limit: PAGE_LIMIT },
      OrderBy: [{ Type: 1, Field: 'stat_time_hour' }],
    };
    const r = await statQuery(body, 3, account);
    if (!r) break;
    const sd = r.data && r.data.StatsData;
    if (!sd) break;
    const page = sd.Rows || [];
    rawRows.push(...page);
    const total = parseInt(sd.TotalCount) || page.length;
    offset += PAGE_LIMIT;
    if (page.length === 0 || offset >= total || rawRows.length >= PAGE_LIMIT * MAX_PAGES) break;
  }

  const hours = [];
  for (const row of rawRows) {
    const d = row.Dimensions || {};
    const m = row.Metrics || {};
    const hourRaw = str(d, 'stat_time_hour');
    const cost = num(m, 'stat_cost_for_roi2');
    if (cost <= 0) continue;
    const h = hourRaw.length >= 13 ? parseInt(hourRaw.slice(11, 13)) : null;
    hours.push({
      hour: hourRaw,
      date: hourRaw.slice(0, 10),
      h,
      cost,
      pay_roi: num(m, 'total_prepay_and_pay_order_roi2'),
      gmv: num(m, 'total_pay_order_gmv_include_coupon_for_roi2'),
      net_gmv: num(m, 'total_order_settle_amount_for_roi2_1h'),
      orders: num(m, 'total_pay_order_count_for_roi2'),
      net_orders: num(m, 'total_order_settle_count_for_roi2_1h'),
      roi_1h: num(m, 'total_prepay_and_pay_settle_roi2_1h'),
    });
  }

  const strong=[],weak=[],best=null,bestReliable=null,worst=null;
  const totalCost=hours.reduce((s,x)=>s+x.cost,0),totalNetGmv=hours.reduce((s,x)=>s+x.net_gmv,0),totalOrders=hours.reduce((s,x)=>s+x.orders,0);
  const emptyCost=hours.filter(x=>x.orders===0).reduce((s,x)=>s+x.cost,0);
  const tag='未作策略判定',suggest='本版不包含投放策略',summary=`消耗 ${totalCost} / 净GMV ${totalNetGmv} / ${totalOrders} 单`;

  const table = hours.length
    ? '| 时段 | 消耗 | 单量 | 支付ROI | 净GMV |\n' + hours.map(x =>
        `| ${x.hour} | ${x.cost.toFixed(1)} | ${x.orders} | ${x.pay_roi.toFixed(2)} | ${x.net_gmv.toFixed(0)} |`).join('\n')
    : '（区间内无消耗）';
  const display = [
    `## 素材小时级表现（${start} ~ ${end}）`,
    `**${name || materialId}**：耗 ${totalCost.toFixed(1)} / 净GMV ${totalNetGmv.toFixed(0)} / ${totalOrders} 单`,
    table,
    `**时段画像**：${tag}`,
    `**调度建议**：${suggest}`,
  ].join('\n\n');

  return sendJSON(res, {
    ok: true,
    account,
    material_id: materialId,
    name,
    range: { start, end },
    hours,
    profile: {
      strong_slots: strong,
      weak_slots: weak,
      best_hour: best,
      best_reliable_hour: bestReliable,
      worst_hour: worst,
      total_cost: totalCost,
      total_net_gmv: totalNetGmv,
      total_orders: totalOrders,
      empty_cost: emptyCost,
      tag,
      suggest_schedule: suggest,
      summary,
    },
    display,
  });
}

module.exports = handleMaterialHourly;
