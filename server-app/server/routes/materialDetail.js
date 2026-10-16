const { fetchMaterialDetail } = require('../lib/qianchuanTabs');
const { sendJSON, daysAgo, yesterday, resolveDateRange } = require('../lib/utils');

/**
 * GET /api/material-detail?id=xxx&start=YYYY-MM-DD&end=YYYY-MM-DD&account=xxx
 * 也支持 dateRange 枚举参数，如 &dateRange=7days, today, thisMonth 等。
 *
 * 终极素材透视接口：聚合素材的每日生命周期、秒级留存曲线、人群画像、AI剧本分析。
 * 面向智能体优化（Agent-Friendly）：
 * - 参数智能默认：不传时间则默认拉取近30天（截止昨天）。
 * - 携带自解释 _meta，帮助大模型理解各指标的业务口径。
 */
async function handleMaterialDetail(req, res, url) {
  const materialId = url.searchParams.get('id');
  if (!materialId) {
    return sendJSON(res, { error: 'missing material id (id=xxx is required)' }, 400);
  }

  let start = url.searchParams.get('start');
  let end = url.searchParams.get('end');
  const dateRange = url.searchParams.get('dateRange');

  // 解析智能枚举词（覆盖手动 start/end）
  if (dateRange) {
    const range = resolveDateRange(dateRange);
    if (range) {
      start = range.start;
      end = range.end;
    }
  }

  const yestStr = yesterday();
  if (!end) end = yestStr;
  if (!start) start = daysAgo(30);

  if (end > yestStr) end = yestStr; // 钳制到昨天（画像T+1）

  // 严格安全校验
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(start) || !dateRegex.test(end)) {
    return sendJSON(res, { error: 'Invalid date format. Must be YYYY-MM-DD' }, 400);
  }

  const account = url.searchParams.get('account') || undefined;

  try {
    const detail = await fetchMaterialDetail(materialId, start, end, account);

    // 组装带自解释字段的数据
    const payload = {
      _meta: {
        agent_instruction: "这是素材的深度聚合数据。请综合利用 dailyTrend 判断爆发日，利用 retention 分析高光帧，利用 audience 和 creative_tags 总结爆款方法论。",
        dictionary: {
          "total_pay_order_gmv_include_coupon_for_roi2": "整体成交金额（含退款的账面 GMV）",
          "total_prepay_and_pay_settle_roi2_1h": "1h结算ROI（扣除退款的净成交ROI，用来判断真实盈亏）",
          "live_watch_count_for_roi2_v2": "观看次数",
          "retention": "每一秒的留存人数，用来分析视频钩子（Hook）质量",
          "churnRate5s": "前5秒流失率，数值越低前三秒越吸引人",
          "creative_tags": "千川系统给视频打的【创意标签】，如'多人情景剧'、'用户痛点'"
        }
      },
      ...detail
    };

    return sendJSON(res, { ok: true, data: payload });
  } catch (e) {
    if (e.message === 'cookie_expired') {
      return sendJSON(res, { ok: false, error: 'cookie_expired' }, 401);
    }
    console.error(`[material-detail] 获取素材 ${materialId} 详情失败: ${e.message}`);
    return sendJSON(res, { ok: false, error: e.message }, 500);
  }
}

module.exports = handleMaterialDetail;