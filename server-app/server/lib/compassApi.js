// server/lib/compassApi.js
// 通用罗盘 API 取数：纯 API 直连（compassDirect，按账号独立 Cookie）。
// 历史账户专用说明已从试用包移除。
// 由调用方决定用陈旧缓存或直接失败，绝不自动拉起浏览器。
const { fetchCompassDirect } = require('./compassDirect');

const { QIANCHUAN_ACCOUNTS } = require('./config');

// 从 config 动态生成店铺名映射，避免硬编码（支持多店铺扩展）
const STORE_MATCH = Object.fromEntries((QIANCHUAN_ACCOUNTS || []).map(a => [a.id, a.name]));

/**
 * 纯 API 调用罗盘接口（每店独立 Cookie，双店隔离已验证）。
 * 失败直接抛错（cookie_missing/cookie_expired/接口 st 错误/网络错误），
 * 调用方自行兜底（如 routes/compass.js 商品榜回落陈旧缓存、doudian 回退直连）。
  * 历史账户专用说明已从试用包移除。
 * @param {string} pathQ 接口路径+query（以 / 开头）
 * @param {object} [opts] { raw: true 时返回 {st,data} 全量信封（doudian 解析器需要） }
 */
async function fetchCompassApi(account, pathQ, opts = {}) {
  if (!STORE_MATCH[account]) throw new Error(`未知账号 ${account}`);
  const j = await fetchCompassDirect(account, pathQ);
  if (j && j.st !== undefined && j.st !== 0) throw new Error(`罗盘接口错误 st=${j.st}: ${j.msg || ''}`);
  if (opts.raw) return j;
  return j.data !== undefined ? j.data : j;
}

/* ---------- compass_general_table 结构解析 ---------- */
// cell 结构: cell_info.pay_amt.pay_amt_index_values.index_values.value.{unit,value}
function cellVal(cell, key) {
  const wrap = cell && cell[key];
  if (!wrap) return null;
  const ivw = wrap.index_values ? wrap : (wrap[Object.keys(wrap)[0]] || {});
  const iv = ivw.index_values || {};
  const v = iv.value;
  if (v == null || v.value == null) return null;
  return v.unit === 3 ? v.value / 100 : v.value; // unit 3 = 分 → 元
}
function infoStr(info, key) {
  const node = info && info[key];
  return node && node.value ? (node.value.value_str || '') : '';
}

/** 商品榜解析：product_list → [{name, image, pay_amt, pay_cnt, net_trans_amt, show_ucnt, click_ucnt}] */
function parseProductList(data) {
  const list = Array.isArray(data) ? data : (data.list || data.data || []);
  return list.map(row => {
    const ci = row.cell_info || row;
    const info = ci.product_info || {};
    return {
      product_id: infoStr(info, 'product_id_value'),
      name: infoStr(info, 'product_name_value'),
      image: infoStr(info, 'product_image_value'),
      pay_amt: cellVal(ci, 'pay_amt'),
      pay_cnt: cellVal(ci, 'pay_cnt'),
      net_trans_amt: cellVal(ci, 'net_trans_amt'),
      receive_amt: cellVal(ci, 'receive_amt'),
      show_ucnt: cellVal(ci, 'product_show_ucnt'),
      click_ucnt: cellVal(ci, 'product_click_ucnt'),
      ad_cost: cellVal(ci, 'ad_costed_amt'),
    };
  }).filter(p => p.name);
}

module.exports = { fetchCompassApi, parseProductList, cellVal, infoStr, resolveStoreMatch: (a) => STORE_MATCH[a] || null };
