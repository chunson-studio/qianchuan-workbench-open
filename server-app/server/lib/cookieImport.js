'use strict';

const { isCookieProbablyValid } = require('./cookie');
const HOST = 'qianchuan.jinritemai.com';
function fail(code, message) { throw Object.assign(new Error(message), { code, statusCode: 400 }); }

// 只接受 Cookie Editor JSON；不接受聊天中的 Cookie header，也不输出原始值。
function parseCookieEditor(input, now = Date.now(), host = HOST) {
  const site = host === 'compass.jinritemai.com' ? '罗盘' : '千川';
  if (typeof input !== 'string' || Buffer.byteLength(input) > 256 * 1024) fail('cookie_format_invalid', '请选择不超过 256KB 的 Cookie Editor JSON 文件');
  let rows;
  try { rows = JSON.parse(input); } catch { fail('cookie_format_invalid', '不是有效的 JSON 文件'); }
  if (!Array.isArray(rows) || !rows.length) fail('cookie_format_invalid', 'Cookie Editor 导出文件应为非空数组');
  const cookies = new Map();
  let matched = 0;
  for (const row of rows) {
    if (!row || typeof row !== 'object' || typeof row.domain !== 'string') fail('cookie_format_invalid', 'Cookie 缺少网站信息，请重新导出 JSON');
    const domain = row.domain.replace(/^\./, '').toLowerCase();
    const hostOnly = row.hostOnly ?? !row.domain.startsWith('.');
    if (!(domain === host || (!hostOnly && host.endsWith('.' + domain) && domain === 'jinritemai.com'))) continue;
    matched++;
    // 多路径同名凭据不能丢失语义后拼成一个全站 header。
    if ((row.path || '/') !== '/') fail('cookie_path_unsupported', '导出包含非根路径 Cookie，请仅导出千川首页 Cookie');
    if (row.expirationDate != null && !Number.isFinite(Number(row.expirationDate))) fail('cookie_format_invalid', 'Cookie 到期时间无效，请重新导出');
    if (row.expirationDate != null && row.session !== true && Number(row.expirationDate) * 1000 <= now) continue;
    if (typeof row.name !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(row.name)
      || typeof row.value !== 'string' || /[\r\n;\x00-\x20\x7f]/.test(row.value)) fail('cookie_format_invalid', 'Cookie 字段格式无效，请重新导出');
    if (cookies.has(row.name) && cookies.get(row.name) !== row.value) fail('cookie_ambiguous', '存在同名但不同值的 Cookie，请清理后重新导出千川登录页 Cookie');
    cookies.set(row.name, row.value);
  }
  if (!matched) fail('cookie_domain_mismatch', `文件不是${site}网站的 Cookie`);
  const header = [...cookies].map(([key, value]) => `${key}=${value}`).join('; ');
  if (!isCookieProbablyValid(header)) fail('cookie_expired_or_missing', `登录凭据缺失或已过期，请登录${site}后重新导出`);
  return header;
}
module.exports = { parseCookieEditor };
