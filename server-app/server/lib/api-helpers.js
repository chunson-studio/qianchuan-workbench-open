/**
 * 公共 API 工具函数 — 消除各路由/lib 中重复的金额转换、账号解析、错误处理代码。
 */

const fs = require('fs');
const path = require('path');
const { resolveQcAccount } = require('./cookie');
const { AAVID, QIANCHUAN_ACCOUNTS } = require('./config');

/**
 * 金额换算：微 → 元（千川内部单位 1元=100000微）
 * @param {number|string} micro - 微值
 * @returns {number} 元值，保留两位小数
 */
function convertMicroToYuan(micro) {
  const n = parseFloat(micro) || 0;
  return +(n / 100000).toFixed(2);
}

/**
 * 金额换算：元 → 微（千川内部单位 1元=100000微）
 * @param {number|string} yuan - 元值
 * @returns {number} 微值（整数）
 */
function convertYuanToMicro(yuan) {
  const n = parseFloat(yuan) || 0;
  return Math.round(n * 100000);
}

/**
 * 包装 resolveQcAccount + null 检查，找不到账号时抛出可读错误。
 * @param {string} accountId - 千川账号ID
 * @returns {object} 账号配置对象
 * @throws {Error} account_not_found 错误
 */
function resolveAccountOrThrow(accountId) {
  const acc = resolveQcAccount(accountId);
  if (!acc) {
    const err = new Error(`account_not_found: ${accountId}`);
    err.statusCode = 400;
    throw err;
  }
  return acc;
}

/**
 * 安全的账号 aavid 解析：找不到返回默认 AAVID 而非崩溃。
 * 等价于 resolveAavid()，作为公共导出的快捷方式。
 * @param {string} [accountId] - 千川账号ID
 * @returns {string} aavid 值
 */
function safeAavid(accountId) {
  const acc = resolveQcAccount(accountId);
  return acc ? (acc.aavid || AAVID) : AAVID;
}

/**
 * 判断错误是否为 cookie 过期/缺失。
 * @param {Error} e
 * @returns {boolean}
 */
function isCookieError(e) {
  return e.message === 'cookie_expired' || e.message === 'cookie_not_found';
}

/**
 * 返回默认千川账号ID（QIANCHUAN_ACCOUNTS 第一个账号的 id）。
  * 历史账户专用说明已从试用包移除。
 * @returns {string} 默认账号ID，未配置返回空字符串
 */
function defaultAccountId() {
  return '';
}

/**
 * 原子写入 JSON 文件（临时文件 + rename）。
 * 防止写入中断导致缓存文件损坏。
 * @param {string} filePath - 目标文件绝对路径
 * @param {*} data - 要序列化的数据
 * @returns {void}
 */
function writeJsonAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

/**
 * 验证 account 参数格式（防止路径遍历和注入）。
 * 只允许字母、数字、下划线、短横线，长度 1-50。
 * @param {string} accountId
 * @returns {boolean} 格式合法返回 true
 */
function isValidAccountId(accountId) {
  if (!accountId || typeof accountId !== 'string') return false;
  return /^[a-zA-Z0-9_-]{1,50}$/.test(accountId);
}

/**
 * 验证并规范化 account 参数。
 * 不传或为空时返回默认账号；传入无效账号 ID 时抛出 400 错误。
 * 同时阻止路径遍历字符（../ 等）。
 * @param {string|undefined|null} accountId
 * @returns {string} 合法的账号 ID
 * @throws {Error} account_not_found 或 account_invalid（含 statusCode=400）
 */
function validateAccount(accountId) {
  if (!accountId) { const err = new Error('account_required'); err.statusCode = 400; throw err; }
  if (!isValidAccountId(accountId)) {
    const err = new Error(`account_invalid: ${accountId}`);
    err.statusCode = 400;
    throw err;
  }
  if (!resolveQcAccount(accountId)) {
    const err = new Error(`account_not_found: ${accountId}`);
    err.statusCode = 400;
    throw err;
  }
  return accountId;
}

/**
 * 获取账号参数（保本线/GMV目标/客单价），支持按账号差异化。
 * 显式房间只读取该房间的参数；未知项保持 null，不继承账户或全局业务阈值。
 * @param {string} accountId - 千川账号ID
 * @returns {object} { break_even_roi, gmv_target_monthly, avg_order_price, live_start_date }
 *   live_start_date: 开播日期(YYYY-MM-DD)；未配置返回 null
  * 历史账户专用说明已从试用包移除。
 *   界面/判断出现 2.36/2.82 即 bug）
 */
function getAccountParams(accountId, { roomId } = {}) {
  const { account_config } = require('./config');
  validateAccount(accountId);
  const account = account_config?.[accountId] || {};
  const accCfg = roomId ? account.rooms?.[String(roomId)] || {} : account;
  return {
    break_even_roi: accCfg.break_even_roi ?? null,
    target_roi: accCfg.target_roi ?? null,
    target_roi_basis: accCfg.target_roi_basis ?? 'unknown',
    gmv_target_monthly: accCfg.gmv_target_monthly ?? null,
    avg_order_price: accCfg.avg_order_price ?? null,
    live_start_date: accCfg.live_start_date ?? null,
  };
}

module.exports = {
  convertMicroToYuan,
  convertYuanToMicro,
  resolveAccountOrThrow,
  safeAavid,
  isCookieError,
  defaultAccountId,
  writeJsonAtomic,
  validateAccount,
  isValidAccountId,
  getAccountParams,
};
