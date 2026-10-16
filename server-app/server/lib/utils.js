// handleApiError 统一从 handleApiError.js 导入，消除重复定义
// 使用延迟 require 避免循环依赖（handleApiError.js 内部 require utils.js 的 sendJSON）
let _handleApiError = null;
function handleApiError(res, e) {
  if (!_handleApiError) _handleApiError = require('./handleApiError').handleApiError;
  return _handleApiError(res, e);
}

/**
 * 将任意值安全转为数字：去除逗号和百分号，解析失败返回 0。
 * @param {*} v - 输入值（数字、字符串、null 等）
 * @returns {number} 解析后的数字
 */
function num(v) {
  if (typeof v === 'number') return v || 0;
  if (v == null) return 0;
  let s = String(v).replace(/,/g, '');
  if (s.endsWith('%')) s = s.slice(0, -1);
  return parseFloat(s) || 0;
}

/**
 * 获取本地日期字符串（YYYY-MM-DD），不传入则使用当前时间。
 * @param {Date} [d] - 日期对象，默认 new Date()
 * @returns {string} YYYY-MM-DD 格式的日期字符串
 */
function getLocalDateStr(d) {
  const dt = d || new Date();
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(dt);
  } catch {
    const china = new Date(dt.getTime() + (dt.getTimezoneOffset() * 60000) + 8 * 3600000);
    const y = china.getFullYear();
    const m = String(china.getMonth() + 1).padStart(2, '0');
    const day = String(china.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
}

/**
 * 获取给定日期所在周的周一（00:00 本地时间）。
 * @param {Date|string} d - 日期对象或可被 Date 构造的值
 * @returns {Date} 周一的 Date 对象
 */
function getMonday(d) {
  const date = new Date(d);
  const day = date.getDay();
  const diff = (day === 0 ? 6 : day - 1);
  date.setDate(date.getDate() - diff);
  return date;
}

/**
 * 将 Date 对象格式化为 YYYY-MM-DD 字符串。
 * @param {Date} date - 日期对象
 * @returns {string} YYYY-MM-DD 格式的日期字符串
 */
function formatDate(date) {
  return date.getFullYear() + '-' +
    String(date.getMonth() + 1).padStart(2, '0') + '-' +
    String(date.getDate()).padStart(2, '0');
}

/**
 * 从千川字段值对象中提取字符串值（兼容 {ValueStr} / {Value} / 原始值）。
 * @param {*} d - 输入值（对象或原始值）
 * @returns {string} 提取的字符串值
 */
function toVal(d) {
  if (!d) return '';
  if (typeof d === 'object') return d.ValueStr != null ? d.ValueStr : String(d.Value != null ? d.Value : '');
  return String(d);
}

/**
 * 返回 n 天前的本地日期字符串（YYYY-MM-DD）。
 * @param {number} n - 天数偏移
 * @returns {string} YYYY-MM-DD 格式的日期字符串
 */
function daysAgo(n) {
  const d = new Date(Date.now() - n * 86400000);
  return getLocalDateStr(d);
}

/**
 * 返回昨天的本地日期字符串（YYYY-MM-DD）。
 * @returns {string} YYYY-MM-DD 格式的日期字符串
 */
function yesterday() { return daysAgo(1); }

/**
 * 北京自然日（YYYY-MM-DD）：跨天计数/日界判定统一口径。
 * 服务器迁移 UTC（Linux/Docker）后 toDateString/getLocalDateStr 会按 UTC 划日，比北京时间早 8 小时"跨天"，
 * 导致每日熔断计数器在北京中午就清零（2026-08-01 二轮审计 P1，当前 Windows 本机时区一致暂未发作）。
 * @param {Date|string|number} [d] - 缺省为当前时间
 * @returns {string} YYYY-MM-DD（Asia/Shanghai）
 */
function beijingDay(d) {
  const t = d == null ? new Date() : new Date(d);
  return t.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

/**
 * 延时等待指定毫秒数。
 * @param {number} ms - 等待毫秒数
 * @returns {Promise<void>} ms 后 resolve 的 Promise
 */
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * 生成日期范围的缓存键（start~end 格式）。
 * @param {string} start - 起始日期
 * @param {string} end - 结束日期
 * @returns {string} 缓存键字符串
 */
function cacheKey(start, end) { return start + '~' + end; }

/**
 * 向 HTTP 响应写入 JSON 数据并结束响应。
 * @param {import('http').ServerResponse} res - HTTP 响应对象
 * @param {*} data - 要序列化为 JSON 的数据
 * @param {number} [status=200] - HTTP 状态码
 * @returns {void}
 */
function sendJSON(res, data, status = 200) {
  if (res.headersSent) { res.end(); return; }
  if (data && data.ok === false) {
    const defaultCodes = {
      400: 'bad_request', 401: 'unauthorized', 403: 'forbidden', 404: 'not_found',
      409: 'conflict', 423: 'upstream_locked', 429: 'rate_limited',
      500: 'internal_server_error', 502: 'upstream_unavailable', 503: 'db_busy', 504: 'request_timeout',
    };
    data = {
      ...data,
      code: data.code || defaultCodes[status] || 'api_error',
      component: data.component || 'http_api',
      retryable: data.retryable != null ? data.retryable === true : [423, 429, 502, 503, 504].includes(status),
      timeout_ms: data.timeout_ms ?? null,
      partial: data.partial === true,
      errors: Array.isArray(data.errors) ? data.errors : [],
    };
  }
  // CORS 白名单：仅允许配置的合法来源，不回显任意 Origin
  const origin = res.req && res.req.headers && res.req.headers.origin;
  const allowedOrigins = (() => {
    try {
      const config = require('./config');
      if (Array.isArray(config.ALLOWED_ORIGINS)) return config.ALLOWED_ORIGINS;
    } catch {}
    // 默认允许本地开发来源
    return ['http://localhost:18991', 'http://127.0.0.1:18991'];
  })();
  const allowedOrigin = (origin && allowedOrigins.includes(origin)) ? origin : allowedOrigins[0];
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': allowedOrigin,
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-token',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(JSON.stringify(data));
}

/**
 * 读取写入类接口所需的本地令牌（可选）。
 * 配置了 QC_WRITE_TOKEN / config.write_api_token 时，写接口必须携带该令牌。
 * 客户端通过 Authorization: Bearer <token> 或 x-api-token: <token> 头传递。
 */
function getWriteToken(req) {
  const auth = req.headers['authorization'] || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const header = req.headers['x-api-token'];
  return bearer || header || null;
}

/**
 * 返回 n 天前的 Date 对象。
 * @param {number} n - 天数偏移
 * @returns {Date} n 天前的 Date 对象
 */
function daysAgoDate(n) {
  return new Date(Date.now() - n * 86400000);
}

/**
 * 生成文件名安全的时间戳字符串（YYYY-MM-DD_HH-MM-SS）。
 * @param {Date} [date=new Date()] - 日期对象
 * @returns {string} 文件名安全的时间戳字符串
 */
function getFileSafeTimestamp(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${d}_${h}-${min}-${s}`;
}

/**
 * 解析查询档位，返回 [start, end] 格式的日期区间。
 * 支持的档位: today, yesterday, 3days, 7days, 15days, 30days, 90days, thisWeek, thisMonth, lastMonth
 */
function resolveDateRange(rangeStr) {
  const d = new Date();
  let start, end;

  // 统一转成小写进行判断，去掉空格
  const r = (rangeStr || '').trim().toLowerCase();

  switch (r) {
    case 'today':
    case '今日':
      start = getLocalDateStr(d);
      end = getLocalDateStr(d);
      break;
    case 'yesterday':
    case '昨日':
      start = yesterday();
      end = yesterday();
      break;
    case '3days':
    case '近3天':
    case '最近3天':
      start = daysAgo(2); // 今天和过去2天，一共3天
      end = getLocalDateStr(d);
      break;
    case '7days':
    case '近7天':
    case '最近7天':
      start = daysAgo(6);
      end = getLocalDateStr(d);
      break;
    case '15days':
    case '近15天':
    case '最近15天':
      start = daysAgo(14);
      end = getLocalDateStr(d);
      break;
    case '30days':
    case '近30天':
    case '最近30天':
      start = daysAgo(29);
      end = getLocalDateStr(d);
      break;
    case '90days':
    case '近90天':
    case '最近90天':
    case '最近三个月':
      start = daysAgo(89);
      end = getLocalDateStr(d);
      break;
    case 'thisweek':
    case '本周':
      start = getLocalDateStr(getMonday(d));
      end = getLocalDateStr(d);
      break;
    case 'thismonth':
    case '本月':
      start = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
      end = getLocalDateStr(d);
      break;
    case 'lastmonth':
    case '上月':
      const lastMonthEnd = new Date(d.getFullYear(), d.getMonth(), 0);
      const lastMonthStart = new Date(d.getFullYear(), d.getMonth() - 1, 1);
      start = getLocalDateStr(lastMonthStart);
      end = getLocalDateStr(lastMonthEnd);
      break;
    default:
      return null;
  }
  return { start, end };
}

/**
 * 校验日期格式是否为 YYYY-MM-DD 且两个日期都已提供。
 * @param {string} start - 起始日期
 * @param {string} end - 结束日期
 * @returns {boolean} 格式合法且非空返回 true，否则 false
 */
function validateDateRange(start, end) {
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!start || !end || !dateRegex.test(start) || !dateRegex.test(end)) {
    return false;
  }
  // 校验日期合法性（如 02-30 会被 new Date 修正为 03-02，说明原值非法）
  const sd = new Date(start + 'T00:00:00');
  const ed = new Date(end + 'T00:00:00');
  if (isNaN(sd.getTime()) || isNaN(ed.getTime())) return false;
  // 完整比对 年/月/日：02-30 会被 new Date 溢出成 03-02，月对不上即判非法
  if (sd.getFullYear() !== parseInt(start.slice(0,4), 10) ||
      sd.getMonth() + 1 !== parseInt(start.slice(5,7), 10) ||
      sd.getDate() !== parseInt(start.slice(8,10), 10)) return false;
  if (ed.getFullYear() !== parseInt(end.slice(0,4), 10) ||
      ed.getMonth() + 1 !== parseInt(end.slice(5,7), 10) ||
      ed.getDate() !== parseInt(end.slice(8,10), 10)) return false;
  // start 不能晚于 end
  if (sd > ed) return false;
  return true;
}

// 历史账户专用说明已从试用包移除。
// 系统原因强制停 = 任务预算不足 / 计划组超出预算 / 关联直播间未开播——"想跑但跑不了"，agent 必须看见；
// 历史账户专用说明已从试用包移除。
// 账户余额不足/账户预算不足/全域投放已暂停/系统暂停 不特意透出（账户级信号另有渠道，黑名单词先行排除）
const PASSIVE_STOP_RE = /任务预算|计划组|超出预算|未开播|预算不足/;
const PASSIVE_STOP_BLOCK_RE = /账户预算|余额/;
function isPassiveStop(status) {
  const s = String(status || '');
  if (!s || s.includes('投放中') || /删除|完成/.test(s)) return false;
  if (PASSIVE_STOP_BLOCK_RE.test(s)) return false; // 账户级预算/余额问题不算任务级被动停摆
  return PASSIVE_STOP_RE.test(s);
}

module.exports = {
  num,
  getLocalDateStr,
  getMonday,
  formatDate,
  yesterday,
  daysAgo,
  beijingDay,
  daysAgoDate,
  toVal,
  sleep,
  cacheKey,
  sendJSON,
  getFileSafeTimestamp,
  resolveDateRange,
  getWriteToken,
  validateDateRange,
  readJsonBody,
  checkBodyKeys,
  requireWriteAuth,
  requireLocalRecordAuth,
  handleApiError,
  isPassiveStop,
};

/**
 * 读取 POST body 并解析 JSON，带大小限制与错误处理。
 * 统一版本，所有路由文件共用。
 * @param {import('http').IncomingMessage} req
 * @returns {Promise<{data?:object, error?:{status:number, message:string}}>}
 */
function readJsonBody(req) {
  if (req._qcJsonBodyPromise) return req._qcJsonBodyPromise;
  const MAX_BODY_BYTES = 10 * 1024 * 1024;
  req._qcJsonBodyPromise = new Promise((resolve) => {
    let settled = false;
    let aborted = false;
    const done = (v) => { if (settled) return; settled = true; resolve(v); };
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      if (aborted) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        req.destroy();
        done({ error: { status: 413, message: 'Request body too large' } });
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', err => { if (!aborted) done({ error: { status: 400, message: 'Request error: ' + err.message } }); });
    req.on('end', () => {
      if (aborted) return;
      const body = chunks.length > 0 ? Buffer.concat(chunks).toString() : '';
      if (body.length === 0) { done({ data: {} }); return; }
      try { done({ data: JSON.parse(body) }); }
      catch (e) { done({ error: { status: 400, message: 'Invalid JSON body' } }); }
    });
  });
  return req._qcJsonBodyPromise;
}

/**
 * 写操作鉴权：本机回环访问始终放行；非本机（局域网/外部）访问必须配置并携带 WRITE_API_TOKEN。
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @returns {boolean} 鉴权通过返回 true，未通过时已写入响应并返回 false
 */
function requireWriteAuth(req, res) {
  const { WRITE_API_TOKEN } = require('./config');
  // 本机回环进程（K3 决策轮、本地工具）始终放行
  if (isLocalRequest(req)) {
    if (!WRITE_API_TOKEN && process.env.QC_WARN_NO_AUTH !== '0') {
      console.warn('⚠️  [security] WRITE_API_TOKEN 未配置，写操作仅本机放行，非本机访问将被拒绝');
    }
    return true;
  }
  // 非本机访问：必须配置并携带 token（Bearer 或 x-api-token）
  if (!WRITE_API_TOKEN) {
    console.error('🚨 [security] WRITE_API_TOKEN 未配置且非本机访问，拒绝写操作。请在 config.json 配置 write_api_token');
    sendJSON(res, { ok: false, error: 'Server requires write API token for non-localhost access' }, 403);
    return false;
  }
  const token = getWriteToken(req);
  if (!token) {
    sendJSON(res, { ok: false, error: 'Unauthorized: missing write API token' }, 401);
    return false;
  }
  // 恒定时间比较，防止时序攻击
  const crypto = require('crypto');
  const a = Buffer.from(token);
  const b = Buffer.from(WRITE_API_TOKEN);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    sendJSON(res, { ok: false, error: 'Unauthorized: invalid write API token' }, 401);
    return false;
  }
  return true;
}

/**
 * 鉴权本地观察记录写入；操作决策由调用 Agent 负责。
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @returns {boolean} 鉴权通过返回 true，未通过时已写入响应并返回 false
 */
function requireLocalRecordAuth(req, res) {
  const { WRITE_API_TOKEN } = require('./config');
  if (isLocalRequest(req)) return true;
  if (!WRITE_API_TOKEN) {
    sendJSON(res, { ok: false, error: 'Server requires write API token for non-localhost access' }, 403);
    return false;
  }
  const token = getWriteToken(req);
  if (!token) {
    sendJSON(res, { ok: false, error: 'Unauthorized: missing write API token' }, 401);
    return false;
  }
  const crypto = require('crypto');
  const provided = Buffer.from(token);
  const expected = Buffer.from(WRITE_API_TOKEN);
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    sendJSON(res, { ok: false, error: 'Unauthorized: invalid write API token' }, 401);
    return false;
  }
  return true;
}

/**
 * 判断请求是否来自本机回环地址。
 * @param {import('http').IncomingMessage} req
 * @returns {boolean}
 */
function isLocalRequest(req) {
  const addr = req.socket && req.socket.remoteAddress;
  if (!addr) return false;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

/**
  * 历史账户专用说明已从试用包移除。
 * 同型风险：未知 body 字段被静默忽略给"看起来正常的错数据"）。
 * 用法：readJsonBody 成功后、业务校验前调用，违规 400：
 *   const check = checkBodyKeys(data, ['accountId','budget','source'], '/api/boost-create');
 *   if (!check.ok) return sendJSON(res, { ok: false, error: check.error }, 400);
 * accountId 与 account_id 视为同一参数（MCP 工具面参数名下划线，双收兼容）。
 * @param {object} data - 已解析的 body
 * @param {string[]} allowedKeys - 允许的字段名（列 accountId 即双收 account_id）
 * @param {string} route - 路由路径（错误文案用）
 * @returns {{ok: boolean, error?: string}}
 */
function checkBodyKeys(data, allowedKeys, route) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: true };
  const allowed = new Set(allowedKeys);
  if (allowed.has('accountId')) allowed.add('account_id');
  for (const k of Object.keys(data)) {
    if (!allowed.has(k)) {
      return { ok: false, error: `未知参数 ${k}（本接口支持参数：${allowedKeys.join(' / ')}）` };
    }
  }
  return { ok: true };
}
