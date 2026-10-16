// server/lib/compassDirect.js
// 罗盘纯 API 调用模块：使用 compass_cookie_sync 导出的完整 Cookie，直接 HTTPS 调用罗盘 API
// 浏览器仅用于低频同步 Cookie，日常取数不再依赖 WebBridge/Playwright 常驻
// 2026-07-29：签名风控端点（白名单 SIGNED_PATHS）先经 abogusSign 本地算 a_bogus 再发，
// 签名模块故障自动降级为不签名直发（行为=空数据，无回归）
const https = require('https');
const fs = require('fs');
const path = require('path');
const { signUrl, SIGN_UA } = require('./abogusSign');

const ROOT = path.join(__dirname, '..', '..');
const { SCRIPTS_DIR } = require('./config');
const HOST = 'compass.jinritemai.com';
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

// 签名风控端点白名单：命中才走 abogusSign（实测 five_min_data/product 必拦，其余端点不验签）
// 2026-08-18 实测 live_order 也验签（裸调 st=11001，签名后 st=0）
const SIGNED_PATHS = ['/compass_api/content_live/shop/live_screen/five_min_data', '/compass_api/shop/live/live_screen/product', '/compass_api/content_live/shop_official/live_screen/live_order'];

function getCookiePath(accountId, roomId) {
  if (roomId != null) {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(String(accountId || '')) || !/^\d{5,30}$/.test(String(roomId))) throw new Error('compass_scope_invalid');
    const scoped = path.join(SCRIPTS_DIR, `compass_cookie_${accountId}_room_${roomId}.txt`);
    if (fs.existsSync(scoped)) return scoped;
  }
  return path.join(SCRIPTS_DIR, `compass_cookie_${accountId || 'default'}.txt`);
}

function readCookie(accountId, roomId) {
  const p = getCookiePath(accountId, roomId);
  if (!fs.existsSync(p)) throw new Error('compass_cookie_missing');
  const c = fs.readFileSync(p, 'utf8').trim();
  if (!c) throw new Error('compass_cookie_missing');
  return c;
}

function getCookieMeta(accountId) {
  const metaFile = path.join(SCRIPTS_DIR, 'compass_cookie_sync_meta.json');
  try {
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    return meta[accountId || 'default'] || null;
  } catch {
    return null;
  }
}

function isCookieStale(accountId, maxAgeHours = 24) {
  const meta = getCookieMeta(accountId);
  if (!meta || !meta.synced_at) return true;
  const ageMs = Date.now() - new Date(meta.synced_at).getTime();
  return ageMs > maxAgeHours * 3600 * 1000;
}

/**
 * 纯 API 调用罗盘接口
  * 历史账户专用说明已从试用包移除。
 * @param {string} apiPath 接口路径（含 query string）
 * @param {object} [opts] 额外选项
 * @param {string} [opts.referer] Referer，默认 https://compass.jinritemai.com/shop
 * @returns {Promise<object>} 罗盘 JSON 响应
 */
async function fetchCompassDirect(accountId, apiPath, opts = {}) {
  const cookie = readCookie(accountId, opts.roomId);
  const referer = opts.referer || `https://${HOST}/shop`;

  // 签名白名单端点：本地算 a_bogus 追加到 URL（失败降级不签名）
  let path = apiPath;
  let ua = DEFAULT_UA;
  if (SIGNED_PATHS.some(p => apiPath.startsWith(p))) {
    const signed = signUrl(`https://${HOST}${apiPath}`);
    if (signed) {
      path = new URL(signed).pathname + new URL(signed).search;
      ua = SIGN_UA; // 请求 UA 必须与签名 UA 一致
    }
  }

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: HOST,
      path,
      method: 'GET',
      headers: {
        'Cookie': cookie,
        'Accept': 'application/json, text/plain, */*',
        'Referer': referer,
        'User-Agent': ua,
      },
    }, res => {
      // TCP 分块可能截断一个汉字；收齐字节后再解码，避免把同一渠道拆成乱码名称。
      const chunks = [];
      res.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on('end', () => {
        const d = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode === 403) {
          return reject(Object.assign(new Error('compass_access_denied'), { code: 'compass_access_denied', retryable: false }));
        }
        if (res.statusCode === 401) {
          return reject(new Error('compass_cookie_expired'));
        }
        let j;
        try {
          j = JSON.parse(d);
        } catch (e) {
          // 2026-08-01 审计 P1：Cookie 过期时罗盘可能返回 HTTP 200 + HTML 登录页——JSON.parse 失败时
          // 先识别登录页特征按过期抛出（原一律 compass_parse_error，上层无法区分"过期"与"解析故障"，重登/告警不触发）
          if (/captcha|验证码|安全验证/i.test(d)) return reject(new Error('compass_verification_required'));
          if (typeof d === 'string' && (/未登录|登录页|login/i.test(d))) {
            return reject(new Error('compass_cookie_expired'));
          }
          return reject(new Error('compass_parse_error'));
        }
        if (j.st === 10005 || j.st === 10012) {
          return reject(new Error('compass_cookie_expired'));
        }
        resolve(j);
      });
    });
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('compass_request_timeout'));
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * 拉核心人群（core_crowd）
 * @param {string} accountId
 * @param {object} params
 * @param {number} params.date_type 21=近7天 23=近30天
 * @param {number} [params.begin_date] unix 秒，默认当天零点
 */
async function fetchCoreCrowd(accountId, params = {}) {
  const dateType = params.date_type || 23;
  const begin = params.begin_date || Math.floor(Date.now() / 1000);
  const path = `/business_api/shop/user_ans/core_crowd?pay_account_type=all&fans_account_type=official&index_selected=product_show&date_type=${dateType}&begin_date=${begin}`;
  return fetchCompassDirect(accountId, path);
}

/**
 * 拉核心指标（core_index_v3）
 * @param {string} accountId
 * @param {object} params
 * @param {string} params.begin_date 格式 2026/07/27 00:00:00
 * @param {string} params.end_date 格式 2026/07/27 00:00:00
 * @param {string} [params.index_selected] 逗号分隔指标名
 */
async function fetchCoreIndex(accountId, params = {}) {
  const indices = params.index_selected || 'per_usr_pay_amt';
  const path = `/compass_api/shop/common/homepage/core_index_v3?begin_date=${encodeURIComponent(params.begin_date)}&end_date=${encodeURIComponent(params.end_date)}&date_type=1&activity_id=&index_selected=${indices}`;
  return fetchCompassDirect(accountId, path);
}

module.exports = {
  fetchCompassDirect,
  fetchCoreCrowd,
  fetchCoreIndex,
  getCookieMeta,
  isCookieStale,
};
