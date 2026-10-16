const fs = require('fs');
const path = require('path');
const { COOKIE_PATH, ROOT_DIR, SCRIPTS_DIR, QIANCHUAN_ACCOUNTS, AAVID } = require('./config');

// Cookie 文件 mtime 缓存：避免每次 API 请求都做同步磁盘 I/O
const _cookieCache = new Map(); // path → { mtime, content }

/**
 * 读取指定路径的 cookie 文件（带 mtime 缓存，避免每次请求都做同步磁盘 I/O）。
 * 文件 mtime 未变化时返回缓存内容，变化时重新读取并更新缓存。
 * @param {string} filePath - cookie 文件的绝对路径
 * @returns {string|null} cookie 字符串，文件不存在或读取失败返回 null
 */
function readCookieFileCached(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const cached = _cookieCache.get(filePath);
    if (cached && cached.mtime === stat.mtimeMs) {
      return cached.content;
    }
    const content = fs.readFileSync(filePath, 'utf8').trim();
    _cookieCache.set(filePath, { mtime: stat.mtimeMs, content });
    return content;
  } catch (e) {
    _cookieCache.delete(filePath);
    return null;
  }
}

/**
 * 根据账号ID解析千川账号配置。
 * @param {string} accountId - 千川账号ID
 * @returns {object|null} 账号配置对象，未找到或参数为空返回 null
 */
function resolveQcAccount(accountId) {
  if (!accountId) return null;
  const list = QIANCHUAN_ACCOUNTS && QIANCHUAN_ACCOUNTS.length ? QIANCHUAN_ACCOUNTS : [];
  const found = list.find(a => a.id === accountId);
  if (!found) {
    console.error(`[cookie] resolveQcAccount: 未找到账号 "${accountId}"，有效账号: ${list.map(a => a.id).join(', ')}`);
  }
  return found || null;
}

/**
 * 读取默认账号的 cookie 字符串（带 mtime 缓存）。
 * @returns {string|null} cookie 字符串，文件不存在返回 null
 */
function readCookie() {
  return readCookieFileCached(COOKIE_PATH);
}

/**
 * 读取指定账号的 cookie 字符串（带 mtime 缓存）。
 * 不传 accountId 时回退到默认账号 cookie；
 * 显式传入但账号未配置（拼错）时返回 null——绝不回落默认账号
  * 历史账户专用说明已从试用包移除。
 * @param {string} [accountId] - 千川账号ID，不传则读默认账号
 * @returns {string|null} cookie 字符串，文件不存在或账号不存在返回 null
 */
function readQcCookie(accountId) {
  if (!accountId) return readCookie();
  const acc = resolveQcAccount(accountId);
  if (!acc) return null; // 拼错账号不回落（安全失败：调用方按 cookie 缺失处理）
  const resolved = path.resolve(SCRIPTS_DIR, acc.cookieFile);
  if (!resolved.startsWith(SCRIPTS_DIR + path.sep)) return null;
  return readCookieFileCached(resolved);
}

/**
 * 从 cookie 字符串中提取 csrftoken 值。
 * @param {string} cookieStr - 完整的 cookie 字符串
 * @returns {string} csrftoken 值，未找到返回空字符串
 */
function getCsrf(cookieStr) {
  if (!cookieStr) return '';
  const m = cookieStr.match(/(?:^|;\s*)csrftoken=([^;]+)/);
  return m ? m[1] : '';
}

/**
 * 粗略判断 cookie 字符串是否可能有效（包含 sessionid/sid_tt/uid_tt 之一）。
 * @param {string} cookieStr - 完整的 cookie 字符串
 * @returns {boolean} 包含有效标识返回 true，否则 false
 */
function isCookieProbablyValid(cookieStr) {
  return cookieStr && /(?:^|;\s*)(sessionid|sid_tt|uid_tt)=/.test(cookieStr);
}

/**
 * 安全解析账号 aavid：accountId 为空时返回全局默认 AAVID（向后兼容）；
 * 显式传入但账号未配置（拼错）时返回 null——不回落默认账号，
  * 历史账户专用说明已从试用包移除。
 * @param {string} [accountId] - 千川账号ID
 * @returns {string|null} aavid 值，账号不存在返回 null
 */
function resolveAavid(accountId) {
  if (!accountId) return AAVID;
  const acc = resolveQcAccount(accountId);
  if (!acc) return null; // 拼错账号不回落
  return acc.aavid || AAVID;
}

/**
 * 安全解析账号 anchorId。
 * @param {string} [accountId] - 千川账号ID
 * @returns {string|undefined} anchorId，未找到返回 undefined
 */
function resolveAnchorId(accountId) {
  if (!accountId) return undefined;
  const acc = resolveQcAccount(accountId);
  return acc ? acc.anchorId : undefined;
}

module.exports = {
  resolveQcAccount,
  resolveAavid,
  resolveAnchorId,
  readCookieFileCached,
  readCookie,
  readQcCookie,
  getCsrf,
  isCookieProbablyValid,
};
