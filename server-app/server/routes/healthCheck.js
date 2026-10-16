/**
 * GET /api/health-check —— 投手"早晨第一眼"体检（只读）
 *
 * 聚合：服务 uptime / 各账号 cookie 有效性 / 余额（走 60s 缓存回环，零额外直拉）
 *       / 近 30 天回填空洞（直播+商品卡双渠道）/ DB 备份状态 / 昨日日报存在性。
  * 历史账户专用说明已从试用包移除。
 */
const { sendJSON } = require('../lib/utils');
const { QIANCHUAN_ACCOUNTS, PORT, CACHE_DIR } = require('../lib/config');
const { readQcCookie, isCookieProbablyValid } = require('../lib/cookie');
const { getMissingDates, getMissingProductDates } = require('../lib/db');

function dstr(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function readBalance(accountId, options = {}) {
  const deadline = AbortSignal.timeout(options.timeoutMs || 5000);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  try {
    const response = await (options.fetchImpl || globalThis.fetch)(
      `http://127.0.0.1:${PORT}/api/balance?account=${encodeURIComponent(accountId)}`, { signal });
    const body = await response.json();
    if (!response.ok || body?.ok !== true) {
      return { value: null, error: { component: 'balance', code: body?.code ||
        (response.ok ? 'balance_unavailable' : `balance_http_${response.status}`) } };
    }
    const value = body.total_balance_yuan;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return { value: null, error: { component: 'balance', code: 'balance_value_missing' } };
    }
    return { value, error: null };
  } catch (error) {
    return { value: null, error: { component: 'balance', code: options.signal?.aborted
      ? 'request_cancelled' : deadline.aborted ? 'balance_timeout' : error.code || 'balance_unavailable' } };
  }
}

async function checkAccount(acc, start, end, options = {}) {
  const cookieStr = readQcCookie(acc.id);
  const cookieOk = isCookieProbablyValid(cookieStr);
  const balance = await readBalance(acc.id, options);
  const errors = balance.error ? [balance.error] : [];
  const getMissing = (query, component) => {
    try {
      const dates = query(start, end, acc.id);
      if (!Array.isArray(dates)) throw new Error('backfill_result_invalid');
      return dates;
    } catch (error) {
      errors.push({ component, code: error.code || 'backfill_check_failed' });
      return null;
    }
  };
  const missingLive = getMissing(options.getMissingDates || getMissingDates, 'backfill_live');
  const missingProduct = getMissing(options.getMissingProductDates || getMissingProductDates, 'backfill_product');
  return {
    id: acc.id, name: acc.name, cookie_valid: cookieOk,
    cookie_check: 'local_format_only', balance_yuan: balance.value,
    partial: errors.length > 0, errors,
    backfill: {
      missing_live_days: missingLive?.length ?? null,
      missing_product_days: missingProduct?.length ?? null,
      recent_missing_live: missingLive?.slice(-3) ?? null,
    },
  };
}

async function handleHealthCheck(req, res) {
  if (req.method !== 'GET') return sendJSON(res, { ok: false, error: 'Method Not Allowed' }, 405);
  try {
    const now = new Date();
    const yesterday = dstr(new Date(now.getTime() - 86400000));
    const start30 = dstr(new Date(now.getTime() - 30 * 86400000));

    // 各账户并行，余额请求含响应体最多等 5 秒；失败子项显式标缺失。
    const accounts = await Promise.all((QIANCHUAN_ACCOUNTS || []).map(acc =>
      checkAccount(acc, start30, yesterday, { signal: req.signal })));

    // DB 备份状态（nightTasks.backupDatabase 写 cache/backup_state.json）
    let backup = null;
    try {
      const fs = require('fs');
      const bp = require('path').join(CACHE_DIR, 'backup_state.json');
      if (fs.existsSync(bp)) backup = JSON.parse(fs.readFileSync(bp, 'utf8'));
    } catch {}

    // 昨日日报存在性（夜间任务产物：agent-memory/reports/daily_<acc>_<date>.json + insights_<acc>_<date>.json）
    const nightly = { yesterday, per_account: {} };
    for (const acc of (QIANCHUAN_ACCOUNTS || [])) {
      try {
        const fs = require('fs');
        const base = require('path').join(process.env.AGENT_MEMORY_DIR ||
          require('path').join(CACHE_DIR, '..', 'agent-memory'), 'reports');
        nightly.per_account[acc.id] = {
          daily: fs.existsSync(require('path').join(base, `daily_${acc.id}_${yesterday}.json`)),
          insights: fs.existsSync(require('path').join(base, `insights_${acc.id}_${yesterday}.json`)),
        };
      } catch {
        nightly.per_account[acc.id] = { daily: false, insights: false };
      }
    }

    // 本地 Cookie 格式检查不代表上游鉴权成功；任何检查失败都不能冒充 healthy。
    const degraded = accounts.filter(a =>
      !a.cookie_valid || a.partial || a.backfill.missing_live_days > 0 || a.backfill.missing_product_days > 0);
    return sendJSON(res, {
      ok: true,
      server_time: now.toISOString(),
      uptime_sec: Math.floor(process.uptime()),
      health: degraded.length ? 'degraded' : 'healthy',
      partial: accounts.some(a => a.partial),
      degraded_accounts: degraded.map(a => a.id),
      accounts,
      backup,
      nightly,
    });
  } catch (e) {
    return sendJSON(res, { ok: false, error: e.message }, 500);
  }
}

module.exports = handleHealthCheck;
module.exports._test = { readBalance, checkAccount };
