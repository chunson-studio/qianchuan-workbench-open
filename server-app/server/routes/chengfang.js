/**
 * server/routes/chengfang.js
 * 乘方（全域升级版·推商品）只读数据路由（2026-07-30 盲区接入）。
 *
 *   GET /api/chengfang/overview?account=xx&date=YYYY-MM-DD
 *     → 自选+托管计划列表、今日汇总、单计划官方ROI建议值/今日成本保障、服务费减免（60s 缓存）
 *   GET /api/chengfang/products?account=xx&ad_id=xx&date=YYYY-MM-DD
 *     → 单计划商品粒度归因 Top10（消耗降序）
 *
 * 接口依据 references/qianchuan-chengfang-api.md；只读不含写操作。
 */
const { getOverview, getProductsTop, getUniProductOverview, buildDashboardSection, buildUniProductSection } = require('../lib/chengfang');
const { sendJSON, getLocalDateStr } = require('../lib/utils');
const { validateAccount } = require('../lib/api-helpers');
const chengfangLive = require('../lib/chengfangLive');

async function handleChengfang(req, res, url) {
  try {
    const account = validateAccount(url.searchParams.get('account'));
    const date = url.searchParams.get('date');
    // 2026-08-13 区间支持：start/end（兼容旧 date 单日；白名单已加 start/end）
    const start = url.searchParams.get('start') || date || getLocalDateStr();
    const end = url.searchParams.get('end') || date || start;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
      return sendJSON(res, { ok: false, error: 'date/start/end 格式须为 YYYY-MM-DD' }, 400);
    }
    if (start > end) return sendJSON(res, { ok: false, error: 'start 不能晚于 end' }, 400);
    const goal = url.searchParams.get('mar_goal');
    if (goal != null && !['1', '2'].includes(goal)) {
      return sendJSON(res, { ok: false, error: 'mar_goal 只支持 1（商品）或 2（直播）' }, 400);
    }
    if (url.pathname === '/api/chengfang/live' || goal === '2') {
      if (!['/api/chengfang/live', '/api/chengfang/overview'].includes(url.pathname)) {
        return sendJSON(res, { ok: false, error: '乘方直播请使用 /api/chengfang/live' }, 400);
      }
      const adId = url.searchParams.get('ad_id');
      if (adId != null && !/^\d+$/.test(adId)) return sendJSON(res, { ok: false, error: 'ad_id 须为数字' }, 400);
      return sendJSON(res, { ok: true, ...await chengfangLive.getOverview(account, start, end, adId) });
    }

    // 商品卡只在工作台展开低频诊断时读取，不占用直播盘面的刷新队列。
    if (url.pathname === '/api/chengfang/dashboard') {
      const section = url.searchParams.get('section');
      if (section === 'chengfang') {
        return sendJSON(res, { ok: true, ...buildDashboardSection(await getOverview(account, start, end)) });
      }
      if (section === 'uni_product') {
        return sendJSON(res, { ok: true, ...buildUniProductSection(await getUniProductOverview(account, start)) });
      }
      return sendJSON(res, { ok: false, error: 'section 须为 chengfang 或 uni_product' }, 400);
    }

    if (url.pathname === '/api/chengfang/products') {
      const adId = url.searchParams.get('ad_id');
      if (!adId || !/^\d+$/.test(adId)) {
        return sendJSON(res, { ok: false, error: 'ad_id 必填且须为数字' }, 400);
      }
      const products = await getProductsTop(account, adId, start);
      return sendJSON(res, { ok: true, account, date: start, ad_id: adId, count: products.length, products });
    }

    // /api/chengfang/overview
    const overview = await getOverview(account, start, end);
    return sendJSON(res, { ok: true, ...overview });
  } catch (e) {
    if (e.statusCode) return sendJSON(res, { ok: false, code: e.code, error: e.message }, e.statusCode);
    console.error('[chengfang] 查询失败:', e.message);
    return sendJSON(res, { ok: false, error: '乘方数据查询失败: ' + e.message }, 500);
  }
}

module.exports = handleChengfang;
