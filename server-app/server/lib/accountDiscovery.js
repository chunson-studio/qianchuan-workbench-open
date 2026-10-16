'use strict';

// Cookie 发现是一个短生命周期、纯内存的接入前流程：Cookie 绝不写日志、响应或磁盘。
const crypto = require('crypto');
const https = require('https');
const { getCsrf, isCookieProbablyValid } = require('./cookie');

const DISCOVERY_TTL_MS = 5 * 60 * 1000;
const DISCOVERY_TIMEOUT_MS = 20 * 1000;
const pending = new Map();

function discoveryError(code, message, statusCode = 400, retryable = false) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.retryable = retryable;
  return error;
}

function cleanExpired(now = Date.now()) {
  for (const [id, value] of pending) {
    if (value.expiresAt <= now) pending.delete(id);
  }
}

function requestAccountInfo(cookie, options = {}) {
  if (options.aavid != null && typeof options.aavid !== 'string') {
    return Promise.reject(discoveryError('invalid_account_id', '当前账户 ID 应为数字字符串', 400));
  }
  const aavid = options.aavid == null ? '' : String(options.aavid).trim();
  if (options.aavid != null && !/^\d{5,30}$/.test(aavid)) {
    return Promise.reject(discoveryError('invalid_account_id', '当前账户 ID 应为 5～30 位数字', 400));
  }
  const timeoutMs = Math.min(Number(options.timeoutMs) || DISCOVERY_TIMEOUT_MS, DISCOVERY_TIMEOUT_MS);
  const request = options.request || https.request;
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref?.();
    const finish = (error, value) => {
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(value);
    };
    const req = request({
      hostname: 'qianchuan.jinritemai.com',
      path: `/ad/api/v1/account/user/info${aavid ? `?aavid=${encodeURIComponent(aavid)}` : ''}`,
      method: 'GET',
      headers: {
        Cookie: cookie,
        'x-csrftoken': getCsrf(cookie),
        Origin: 'https://qianchuan.jinritemai.com',
        Referer: 'https://qianchuan.jinritemai.com/home',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36',
      },
    }, res => {
      let body = '';
      res.setEncoding?.('utf8');
      res.on('data', chunk => {
        body += chunk;
        if (Buffer.byteLength(body) > 2 * 1024 * 1024) {
          finish(discoveryError('schema_changed', '账户发现返回过大，已停止接入', 502));
          req.destroy();
        }
      });
      res.on('end', () => {
        const status = Number(res.statusCode || 0);
        if (status === 401) return finish(discoveryError('cookie_expired', 'Cookie 已失效，请重新复制登录态', 401));
        if (status === 403) return finish(discoveryError('forbidden', 'Cookie 没有账户发现权限或已失效', 403));
        if (status === 423) return finish(discoveryError('rate_limited', '千川暂时限制了账户发现，请稍后重试', 429, true));
        if (status === 429) return finish(discoveryError('rate_limited', '千川请求过于频繁，请稍后重试', 429, true));
        if (status < 200 || status >= 300) return finish(discoveryError('upstream_timeout', `账户发现上游返回 HTTP ${status}`, 502, status >= 500));
        try { return finish(null, JSON.parse(body)); }
        catch { return finish(discoveryError('schema_changed', '账户发现接口返回格式无法解析，已停止接入', 502)); }
      });
    });
    req.on('error', error => {
      if (controller.signal.aborted) return finish(discoveryError('upstream_timeout', '账户发现超过 20 秒未完成', 504, true));
      finish(discoveryError('upstream_timeout', '账户发现连接失败，请稍后重试', 502, true));
    });
    controller.signal.addEventListener('abort', () => {
      finish(discoveryError('upstream_timeout', '账户发现超时，请稍后重试', 504, true));
      req.destroy();
    }, { once: true });
    req.end();
  });
}

function firstText(value, keys) {
  for (const key of keys) {
    const item = value && value[key];
    if (typeof item === 'number' && !Number.isSafeInteger(item)) continue;
    if (item != null && String(item).trim()) return String(item).trim();
  }
  return '';
}

function extractCandidates(payload) {
  const candidates = new Map();
  const seen = new Set();
  const visit = value => {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) return value.forEach(visit);
    const aavid = firstText(value, ['aavid', 'advertiser_id', 'advertiserId', 'advertiserID']);
    if (/^\d{5,30}$/.test(aavid)) {
      const name = firstText(value, ['name', 'advertiser_name', 'advertiserName', 'account_name', 'accountName', 'company_name']) || `千川账户 ${aavid}`;
      const anchorId = firstText(value, ['anchor_id', 'anchorId', 'live_anchor_id']);
      candidates.set(aavid, { candidate_id: aavid, aavid, name, ...( /^\d{5,30}$/.test(anchorId) ? { anchor_id: anchorId } : {}) });
    }
    for (const child of Object.values(value)) visit(child);
  };
  const accountInfo = payload?.data?.accountInfo;
  if (accountInfo && typeof accountInfo === 'object' && !Array.isArray(accountInfo)) {
    const aavid = firstText(accountInfo, ['advId']);
    if (/^\d{5,30}$/.test(aavid)) {
      const name = firstText(accountInfo, ['advName']) || `千川账户 ${aavid}`;
      candidates.set(aavid, { candidate_id: aavid, aavid, name });
    }
  }
  visit(payload && (payload.data || payload));
  return [...candidates.values()];
}

async function discoverAccount(cookie, options = {}) {
  const safeCookie = String(cookie || '').trim();
  if (!isCookieProbablyValid(safeCookie)) throw discoveryError('cookie_invalid', 'Cookie 缺少可识别的登录态字段', 400);
  const payload = await requestAccountInfo(safeCookie, options);
  const code = payload && (payload.status_code ?? payload.code ?? 0);
  if (Number(code) === 997) throw discoveryError('account_selection_required', '千川返回多个直客账户，请提供当前账户 ID 后重试', 409);
  if (Number(code) !== 0) throw discoveryError('cookie_rejected', '千川未通过登录验证，请重新登录后导出 Cookie', 401);
  let candidates = extractCandidates(payload);
  if (options.aavid != null) {
    const requested = String(options.aavid).trim();
    candidates = candidates.filter(candidate => candidate.aavid === requested);
    if (!candidates.length) throw discoveryError('account_identity_mismatch', '返回的账户与所选账户 ID 不匹配，未保存 Cookie', 409);
  }
  if (!candidates.length) throw discoveryError('schema_changed', '账户发现未找到可确认的账户候选，未保存 Cookie', 502);
  cleanExpired();
  const discoveryId = crypto.randomUUID();
  pending.set(discoveryId, { cookie: safeCookie, candidates, expiresAt: Date.now() + DISCOVERY_TTL_MS });
  return { discovery_id: discoveryId, expires_at: new Date(Date.now() + DISCOVERY_TTL_MS).toISOString(), candidates };
}

function consumeCandidate(discoveryId, candidateId, keep = false) {
  cleanExpired();
  const item = pending.get(String(discoveryId || ''));
  if (!item) throw discoveryError('discovery_expired', '账户发现结果已过期，请重新导入 Cookie 文件', 410);
  const candidate = item.candidates.find(value => value.candidate_id === String(candidateId || ''));
  if (!candidate) throw discoveryError('candidate_not_found', '所选账户不在本次发现结果中', 400);
  if (!keep) pending.delete(String(discoveryId));
  return { candidate: { ...candidate }, cookie: item.cookie };
}

module.exports = { DISCOVERY_TIMEOUT_MS, DISCOVERY_TTL_MS, cleanExpired, consumeCandidate, discoverAccount, extractCandidates, requestAccountInfo };
