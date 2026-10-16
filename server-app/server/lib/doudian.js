/**
 * server/lib/doudian.js — 抖店电商罗盘取数模块（纯 API）
 *
 * 数据源：compass.jinritemai.com（抖店电商罗盘）
 * Cookie：与千川共用（巨量引擎系同登录态）
 *
 * 能拉到的数据（2026-07-28 精简后）：
 *   - fetchCoreIndex: 核心指标（成交/支付/退款/曝光/点击/客单价/订单数）
 *   - fetchSummaryIndex: 汇总指标（含广告消耗/广告效率比/退款率）
 *   - fetchAvgOrderPrice: 客单价（liveCollector 经营计算依赖）
 *   - fetchContentDetail: 内容明细（直播/短视频/图文/商品卡拆分，素材方法论备用）
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const COOKIE_PATH = path.join(__dirname, '..', '..', 'scripts', 'doudian_cookie.txt');
const FALLBACK_COOKIE_PATH = path.join(__dirname, '..', '..', 'scripts', 'cookie.txt');
const HOST = 'compass.jinritemai.com';

function readCookie(accountId) {
  // 1. 如果传入了 accountId，优先从 config.json 找对应的 cookieFile
  if (accountId) {
    try {
      const { qianchuan_accounts = [] } = require('./config');
      const acc = qianchuan_accounts.find(a => a.id === accountId);
      // 历史账户专用说明已从试用包移除。
      if (!acc) throw new Error('account_not_found');
      if (acc.cookieFile) {
        const specPath = path.join(__dirname, '..', '..', 'scripts', acc.cookieFile);
        if (fs.existsSync(specPath)) {
          const c = fs.readFileSync(specPath, 'utf8').trim();
          if (c) return c;
        }
      }
    } catch (e) { /* ignore */ }
  }

  // 2. 否则降级：优先读抖店专用 cookie，不存在则用千川主 cookie
  const cookiePath = fs.existsSync(COOKIE_PATH) ? COOKIE_PATH : FALLBACK_COOKIE_PATH;
  if (!fs.existsSync(cookiePath)) throw new Error('cookie_expired');
  const c = fs.readFileSync(cookiePath, 'utf8').trim();
  if (!c) throw new Error('cookie_expired');
  return c;
}

/**
 * 通用 GET 请求抖店罗盘接口。
 * 通道选择（2026-07-29 纯 API 化）：
 *   双店账号的"当前店铺"是登录会话的服务端状态，x-shop-id 头被忽略（实测两账号返回一模一样）；
 *   按账号独立 Cookie 直连（compassApi→compassDirect），双店隔离已由每店 Cookie 保证；
 *   主通道失败时回退 fetchDoudianDirect（同为纯 API 直连，读抖店/千川 cookie，可能串店，仅兜底）。
  * 历史账户专用说明已从试用包移除。
 * 响应缓存 10 分钟（按 accountId+path）：罗盘页轮询/内部客单价调用都受益。
 * @param {string} apiPath - 接口路径（含query string）
 * @param {string} [shopId] - 抖店 shopId（已废弃，仅兼容旧调用）
  * 历史账户专用说明已从试用包移除。
 * @returns {Promise<object>} JSON响应
 */
const responseCache = new Map(); // `${accountId}|${apiPath}` -> { ts, data }
const RESPONSE_CACHE_TTL = 10 * 60 * 1000;

async function fetchDoudian(apiPath, shopId, accountId) {
  const key = (accountId || '') + '|' + apiPath;
  const hit = responseCache.get(key);
  if (hit && Date.now() - hit.ts < RESPONSE_CACHE_TTL) return hit.data;

  let data = null, trusted = false;
  if (accountId) {
    try {
      const { fetchCompassApi } = require('./compassApi');
      data = await fetchCompassApi(accountId, apiPath, { raw: true });
      trusted = true; // 纯 API 主通道：按账号独立 Cookie，店铺隔离可信
    } catch (e) { /* 主通道失败，回退直连兜底 */ }
  }
  if (!data) {
    data = await fetchDoudianDirect(apiPath, shopId, accountId);
    // 审核团（2026-07-25）：直连兜底在双店账号下可能拿到隔壁店数据（x-shop-id 无效实测），
    // 打 degraded 标且不写缓存——错店数据缓存 10 分钟再扩散到 3h 客单价缓存，会污染止损阈值
    if (accountId && data && typeof data === 'object') data.__degraded = true;
  }
  // 只有主通道（按账号 Cookie 直连）且业务成功（st=0 或无 st 信封）才写缓存；错误体缓存会粘 10 分钟
  const cacheable = trusted && data && (data.st === 0 || data.st === undefined);
  if (cacheable) responseCache.set(key, { ts: Date.now(), data });
  return data;
}

function fetchDoudianDirect(apiPath, shopId, accountId) {
  return new Promise((resolve, reject) => {
    const cookieStr = readCookie(accountId);
    // shop-id 头对罗盘接口无效（店铺由会话服务端状态决定），保留仅为兼容旧行为
    if (!shopId && accountId) {
      try {
        const { qianchuan_accounts = [] } = require('./config');
        const acc = qianchuan_accounts.find(a => a.id === accountId);
        if (acc && acc.shopId) shopId = acc.shopId;
      } catch (e) { /* 找不到就不带 */ }
    }
    const headers = {
      'Cookie': cookieStr,
      'Accept': 'application/json, text/plain, */*',
      'Referer': `https://${HOST}/shop`,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36',
    };
    // 多店铺需要指定当前店铺ID
    if (shopId) {
      headers['x-shop-id'] = shopId;
      headers['shop-id'] = shopId;
    }
    let settled = false;
    const req = https.request({
      hostname: HOST,
      path: apiPath,
      method: 'GET',
      headers,
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (settled) return;
        if (res.statusCode === 401 || res.statusCode === 403 || d.includes('未登录') || d.includes('login')) {
          settled = true;
          return reject(new Error('cookie_expired'));
        }
        try { settled = true; resolve(JSON.parse(d)); }
        catch (e) { settled = true; reject(new Error('parse_error: ' + d.slice(0, 200))); }
      });
    });
    req.setTimeout(15000, () => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(new Error('抖店罗盘请求超时'));
    });
    req.on('error', e => {
      if (settled) return;
      settled = true;
      reject(e);
    });
    req.end();
  });
}

/**
 * 格式化日期为罗盘需要的格式：2026/07/15 00:00:00
 */
function fmtDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}/${m}/${d} 00:00:00`;
}

function encodeURIComponentDoudian(s) {
  return encodeURIComponent(s);
}

/**
 * 提取指标值（从罗盘的嵌套结构中提取）
 * 罗盘返回格式：{ data: { module_data: { homepage_core_index: { compass_general_multi_index_card_value: { data: [{ index_name: { index_value: { value: { unit, value } } } } ] } } } } }
 */
function extractIndex(j, indexName) {
  try {
    const card = j.data?.module_data?.homepage_core_index?.compass_general_multi_index_card_value;
    if (!card) return null;
    const item = card.data?.find(d => d[indexName]);
    if (!item) return null;
    const val = item[indexName].index_value?.value || item[indexName].index_values?.value;
    if (!val) return null;
    // 抖店罗盘 unit_code: 3=金额(分), 4=比例(0-1小数), 5=数量
    let value = val.value;
    const unitCode = val.unit;
    if (unitCode === 3) value = value / 100;        // 分转元
    if (unitCode === 4) value = value * 100;         // 小数转百分比
    return {
      value: unitCode === 4 ? +value.toFixed(2) : +value.toFixed(2),
      unit: unitCode === 3 ? '元' : (unitCode === 4 ? '%' : ''),
      unit_code: unitCode,
    };
  } catch { return null; }
}

/**
 * 拉核心指标（成交/支付/退款/曝光/点击/客单价/订单数）
 * @param {string} startDate YYYY-MM-DD
 * @param {string} endDate YYYY-MM-DD
 * @returns {Promise<object>} 核心指标
 */
async function fetchCoreIndex(startDate, endDate, shopId, accountId) {
  const indices = [
    'income_amt', 'pay_amt', 'settlement_amt_pay_time', 'pay_cnt',
    'product_show_ucnt', 'product_click_ucnt', 'per_usr_pay_amt', 'pay_ucnt',
    'rfndsuc_amt', 'rfndsuc_amt_pay_time', 'refund_amt_rate', 'refund_amt',
    'refund_order_cnt', 'refund_order_cnt_pay_time',
    'product_show_click_ucnt_ratio', 'product_click_pay_ucnt_ratio',
  ].join(',');

  const s = fmtDate(new Date(startDate));
  const e = fmtDate(new Date(endDate));
  const path = `/compass_api/shop/common/homepage/core_index_v3?begin_date=${encodeURIComponentDoudian(s)}&end_date=${encodeURIComponentDoudian(e)}&date_type=1&activity_id=&index_selected=${indices}`;

  const raw = await fetchDoudian(path, shopId, accountId);
  if (!raw || raw.st !== 0) return { ok: false, error: raw.msg || '接口返回异常', raw };
  // 兜底直连通道（共享 Cookie）数据可能串店（审核团 2026-07-25 定调宁缺毋滥）：
  // 显式抛错由路由层映射 502，不把降级数据当正常数据返回
  if (raw.__degraded) throw new Error('doudian_degraded');

  const result = {
    ok: true,
    date_range: `${startDate} ~ ${endDate}`,
    // 成交
    income_amt: extractIndex(raw, 'income_amt'),           // 成交金额(元)
    pay_amt: extractIndex(raw, 'pay_amt'),                 // 用户支付金额(元)
    settlement_amt_pay_time: extractIndex(raw, 'settlement_amt_pay_time'), // 结算金额(元)
    pay_cnt: extractIndex(raw, 'pay_cnt'),                 // 成交订单数
    pay_ucnt: extractIndex(raw, 'pay_ucnt'),               // 成交人数
    per_usr_pay_amt: extractIndex(raw, 'per_usr_pay_amt'), // 客单价(元)
    // 流量
    product_show_ucnt: extractIndex(raw, 'product_show_ucnt'),     // 商品曝光人数
    product_click_ucnt: extractIndex(raw, 'product_click_ucnt'),   // 商品点击人数
    product_show_click_ucnt_ratio: extractIndex(raw, 'product_show_click_ucnt_ratio'), // 曝光点击率
    product_click_pay_ucnt_ratio: extractIndex(raw, 'product_click_pay_ucnt_ratio'), // 点击转化率
    // 退款
    refund_amt_rate: extractIndex(raw, 'refund_amt_rate'),         // 退款率
    refund_amt: extractIndex(raw, 'refund_amt'),                   // 退款金额(元)
    refund_order_cnt: extractIndex(raw, 'refund_order_cnt'),       // 退款订单数
    rfndsuc_amt: extractIndex(raw, 'rfndsuc_amt'),                 // 退款成功金额
    rfndsuc_amt_pay_time: extractIndex(raw, 'rfndsuc_amt_pay_time'), // 按支付时间退款金额
    refund_order_cnt_pay_time: extractIndex(raw, 'refund_order_cnt_pay_time'), // 按支付时间退款订单
    raw: null, // 不返回原始数据，太大了
  };

  // 清理null
  for (const k of Object.keys(result)) {
    if (result[k] === null) delete result[k];
  }

  return result;
}

/**
 * 只拉客单价（实时盯盘场景唯一需要的罗盘指标）
 * 千川拿不到全渠道客单价原始值，只能从罗盘 per_usr_pay_amt 取。
 * 只请求1个指标，response body 最小，延迟最低。
 * @param {string} startDate YYYY-MM-DD
 * @param {string} endDate YYYY-MM-DD
 * @param {string} [shopId] 多店铺ID
 * @returns {Promise<{ok, avg_order_price, source}>}
 */
async function fetchAvgOrderPrice(startDate, endDate, shopId, accountId) {
  const s = fmtDate(new Date(startDate));
  const e = fmtDate(new Date(endDate));
  const path = `/compass_api/shop/common/homepage/core_index_v3?begin_date=${encodeURIComponentDoudian(s)}&end_date=${encodeURIComponentDoudian(e)}&date_type=1&activity_id=&index_selected=per_usr_pay_amt`;

  try {
    const raw = await fetchDoudian(path, shopId, accountId);
    if (!raw || raw.st !== 0) return { ok: false, error: raw.msg || '接口返回异常' };
    const val = extractIndex(raw, 'per_usr_pay_amt');
    if (!val) return { ok: false, error: '客单价数据为空' };
    return { ok: true, avg_order_price: val.value, source: raw.__degraded ? 'doudian_degraded' : 'doudian', degraded: !!raw.__degraded };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 按千川账号ID解析对应的抖店 shopId（多店铺隔离）。
 * 配置位于 config.json 的 qianchuan_accounts[].shopId。
 * 未配置时返回 undefined → fetchDoudian 不加 x-shop-id 头（沿用当前登录店铺，向后兼容）。
 * @param {string} [accountId]
 * @returns {string|undefined}
 */
function resolveShopId(accountId) {
  if (!accountId) return undefined;
  try {
    const { qianchuan_accounts = [] } = require('./config');
    const acc = qianchuan_accounts.find(a => a.id === accountId);
    return acc && acc.shopId ? String(acc.shopId) : undefined;
  } catch { return undefined; }
}

// ===== 客单价缓存（3小时 TTL）=====
// 客单价一天内波动不大，不需要每次看板（15分钟）都拉。
// 优先拉「当天实时客单价」，3小时刷新一次；当天暂无成交时回落最近7天均值兜底。
const AVG_PRICE_TTL_MS = 3 * 60 * 60 * 1000; // 3小时
const _cachedAvgPriceMap = new Map(); // account -> { value, ts, source }

function _localDateStr(d = new Date()) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/**
 * 同步读客单价内存缓存（不发请求）。liveDashboard 等异步调用会先暖缓存，
 * 同步场景（如 getLatestWatch）可直接复用，未命中返回 null。
 */
function peekAvgOrderPriceCache(accountId) {
  const cached = _cachedAvgPriceMap.get(accountId || '_default');
  if (cached && (Date.now() - cached.ts) < AVG_PRICE_TTL_MS && cached.value > 0) {
    return { value: cached.value, source: cached.source };
  }
  return null;
}

/**
 * 获取客单价（3小时缓存，按账号隔离）
 * 优先拉当天实时客单价；当天无有效值时回落最近7天（不含今天）均值。
 * @param {string} [accountId] - 千川账号ID，用于多账号隔离
 * @returns {Promise<{ok, avg_order_price, source, cached}>}
 *   source: doudian_today（当天实时）| doudian_7d_avg（7天兜底）
 */
async function getCachedAvgOrderPrice(accountId) {
  const key = accountId || '_default';
  const nowTs = Date.now();
  const shopId = resolveShopId(accountId); // 多店铺隔离：透传抖店 shopId

  // 3小时内命中缓存直接返回
  const cached = _cachedAvgPriceMap.get(key);
  if (cached && (nowTs - cached.ts) < AVG_PRICE_TTL_MS) {
    return { ok: true, avg_order_price: cached.value, source: cached.source, cached: true };
  }

  // 1. 优先拉当天实时客单价（degraded=错店兜底数据，宁缺毋滥，不用不缓存）
  const today = _localDateStr();
  try {
    const r = await fetchAvgOrderPrice(today, today, shopId, accountId);
    if (r && r.ok && r.avg_order_price > 0 && !r.degraded) {
      _cachedAvgPriceMap.set(key, { value: r.avg_order_price, ts: nowTs, source: 'doudian_today' });
      return { ok: true, avg_order_price: r.avg_order_price, source: 'doudian_today', cached: false };
    }
  } catch (e) { /* 当天拉取失败，走7天兜底 */ }

  // 2. 当天无有效值（如凌晨还没成交）→ 回落最近7天（不含今天）均值
  const end = new Date(); end.setDate(end.getDate() - 1);
  const start = new Date(); start.setDate(start.getDate() - 7);
  try {
    const r = await fetchAvgOrderPrice(_localDateStr(start), _localDateStr(end), shopId, accountId);
    if (r && r.ok && r.avg_order_price > 0 && !r.degraded) {
      _cachedAvgPriceMap.set(key, { value: r.avg_order_price, ts: nowTs, source: 'doudian_7d_avg' });
      return { ok: true, avg_order_price: r.avg_order_price, source: 'doudian_7d_avg', cached: false };
    }
    return { ok: false, error: r ? r.error : '客单价数据为空' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 拉汇总指标（含广告消耗/广告费效比/佣金/总成本）
 * @param {string} startDate YYYY-MM-DD
 * @param {string} endDate YYYY-MM-DD
 * @returns {Promise<object>} 汇总指标
 */
async function fetchSummaryIndex(startDate, endDate, shopId, accountId) {
  const s = fmtDate(new Date(startDate));
  const e = fmtDate(new Date(endDate));
  const path = `/compass_api/shop/common/homepage/summary_core_index_v3?begin_date=${encodeURIComponentDoudian(s)}&end_date=${encodeURIComponentDoudian(e)}&date_type=1&activity_id=&select_ad_exp`;

  try {
    const raw = await fetchDoudian(path, shopId, accountId);
    if (raw && raw.__degraded) return { ok: false, error: 'doudian_degraded', degraded: true }; // 2026-08-01 审计P0：共享Cookie兜底会拿隔壁店数据（x-shop-id无效实测），宁缺毋滥不当本店返回
    if (!raw || raw.st !== 0) return { ok: false, error: raw.msg };

    const result = {
      ok: true,
      date_range: `${startDate} ~ ${endDate}`,
    };

    // 提取关键指标
    const indices = ['income_amt', 'pay_amt', 'cost_amt', 'ad_costed_amt', 'real_commission', 'shop_serv_amt', 'ad_costed_expense_ratio_with_refund', 'refund_amt_rate', 'settlement_amt_pay_time'];
    for (const idx of indices) {
      const val = extractIndex(raw, idx);
      if (val) result[idx] = val;
    }

    return result;
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 拉内容明细（按内容形态拆成交笔数：直播/短视频/图文/商品卡/其他）
 * @param {string} startDate YYYY-MM-DD
 * @param {string} endDate YYYY-MM-DD
 * @param {string} indexName 指标名（pay_ucnt=成交人数/pay_amt=支付金额等）
 * @returns {Promise<{ok, index_name, contents:{live,video,artc_video,product_card,other_content}}>}
 */
async function fetchContentDetail(startDate, endDate, indexName = 'pay_ucnt', shopId, accountId) {
  const s = fmtDate(new Date(startDate));
  const e = fmtDate(new Date(endDate));
  const path = `/compass_api/shop/common/homepage/content_detail_v3?begin_date=${encodeURIComponentDoudian(s)}&end_date=${encodeURIComponentDoudian(e)}&date_type=1&activity_id=&index_name=${indexName}&operate_type=0`;
  try {
    const raw = await fetchDoudian(path, shopId, accountId);
    if (raw && raw.__degraded) return { ok: false, error: 'doudian_degraded', degraded: true }; // 2026-08-01 审计P0：共享Cookie兜底会拿隔壁店数据，宁缺毋滥
    if (!raw || raw.st !== 0) return { ok: false, error: (raw && raw.msg) || '接口返回异常' };
    const d = raw.data?.module_data?.homepage_core_index?.compass_general_multi_index_card_value?.data?.[0];
    if (!d) return { ok: false, error: '无内容明细数据' };
    const pick = (name) => {
      const iv = d[name] && d[name].index_value;
      if (!iv) return null;
      const cur = iv.value && iv.value.value;
      const last = iv.last_value && iv.last_value.value;
      const ratio = iv.value_ratio && iv.value_ratio.value; // 占比(0-1)
      const chg = iv.out_period_ratio && iv.out_period_ratio.value; // 环比(0-1)
      return {
        value: cur != null ? cur : null,
        last_value: last != null ? last : null,
        ratio: ratio != null ? +(ratio * 100).toFixed(2) : null,      // 占比%
        change_ratio: chg != null ? +(chg * 100).toFixed(2) : null,   // 环比%
      };
    };
    return {
      ok: true,
      index_name: indexName,
      date_range: `${startDate} ~ ${endDate}`,
      contents: {
        live: pick('live'),                     // 直播
        video: pick('video'),                   // 短视频
        artc_video: pick('artc_video'),         // 图文
        product_card: pick('product_card'),     // 商品卡
        other_content: pick('other_content'),   // 其他
      },
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  fetchDoudian,
  fetchCoreIndex,
  fetchSummaryIndex,
  fetchAvgOrderPrice,
  getCachedAvgOrderPrice,
  peekAvgOrderPriceCache,
  fetchContentDetail,
  extractIndex,
};
