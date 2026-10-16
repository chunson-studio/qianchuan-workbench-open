const { memoryCache } = require('../lib/cache');
const { readQcCookie, isCookieProbablyValid } = require('../lib/cookie');
const { sendJSON } = require('../lib/utils');
const { PORT, QIANCHUAN_ACCOUNTS, ACCOUNT_PROFILES_DIR } = require('../lib/config');
const { monitorEventLoopDelay } = require('perf_hooks');
const fs = require('fs');
const path = require('path');

const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
eventLoopDelay.enable();

function msFromNs(value) {
  const n = Number(value);
  return Number.isFinite(n) ? +(n / 1e6).toFixed(2) : null;
}

function runtimeStatus() {
  const memory = process.memoryUsage();
  let handles = null;
  try { handles = typeof process._getActiveHandles === 'function' ? process._getActiveHandles().length : null; } catch {}
  let queue = {};
  let collector = {};
  try { queue = require('../lib/qianchuan').getQueueStatus(); } catch (e) { queue = { error: e.message }; }
  try { collector = require('../lib/liveCollector').getCollectorStatus(); } catch (e) { collector = { error: e.message }; }
  const loopDelay = {
    mean: msFromNs(eventLoopDelay.mean),
    p95: msFromNs(eventLoopDelay.percentile(95)),
    max: msFromNs(eventLoopDelay.max),
    window: 'since_last_status_read',
  };
  // lifetime max 会把电脑休眠或一次历史尖峰永久留在健康页，看起来像当前仍在阻塞。
  // 读取后重置，下一次 /api/status 展示最近一个观测窗口，而不是进程全生命周期。
  eventLoopDelay.reset();
  return {
    pid: process.pid,
    uptime_s: Math.floor(process.uptime()),
    memory: {
      rss_bytes: memory.rss,
      heap_used_bytes: memory.heapUsed,
      heap_total_bytes: memory.heapTotal,
      external_bytes: memory.external,
    },
    active_handles: handles,
    event_loop_delay_ms: loopDelay,
    queue,
    collector,
  };
}

function readCapabilities(accountId) {
  const profilePath = path.join(ACCOUNT_PROFILES_DIR, `${accountId}.json`);
  try {
    const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    const preflight = profile && profile.preflight;
    if (!preflight || !preflight.capabilities) {
      return { checked_at: null, values: null, reason: '尚未完成只读预检' };
    }
    return { checked_at: preflight.checked_at || null, values: preflight.capabilities, reason: null };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { checked_at: null, values: null, reason: '尚未建立账户 Profile' };
    return { checked_at: null, values: null, reason: '账户 Profile 无法读取' };
  }
}

function sqliteStatus() {
  try {
    const { getDB } = require('../lib/db');
    const db = getDB();
    // /api/status 是高频只读诊断入口，不能每次同步扫描整库做 PRAGMA quick_check。
    // 完整一致性检查留给维护任务；这里仅验证连接与最小语句可执行。
    const row = db.prepare('SELECT 1 AS ok').get();
    return { state: row && row.ok === 1 ? 'available' : 'degraded', check: 'read_probe' };
  } catch (error) {
    return { state: 'unavailable', code: error.code || 'sqlite_error', error: error.message };
  }
}

function accountStatus(accountId, runtime = runtimeStatus()) {
  const cookieStr = readQcCookie(accountId);
  const cookieValid = isCookieProbablyValid(cookieStr);
  const queue = runtime.queue[accountId] || null;
  const collector = runtime.collector.accounts && runtime.collector.accounts[accountId] || null;
  let dataHealth = null;
  try {
    const health = require('../lib/liveCollector').getCollectorHealth(accountId);
    dataHealth = {
      ready: health.ready === true,
      code: health.code,
      state: health.state,
      retryable: health.retryable === true,
      restart_recommended: health.restart_recommended === true,
      is_live: typeof health.watch?.isLive === 'boolean' ? health.watch.isLive : null,
      live_checked_at: health.watch && health.watch.liveCheckedAt || null,
      fetched_at: health.watch && health.watch.fetchedAt || null,
    };
  } catch (error) {
    dataHealth = { ready: false, code: 'collector_health_error', state: 'unavailable', error: error.message };
  }
  return {
    account: accountId,
    cookie_exists: !!cookieStr,
    cookie_valid: cookieValid,
    cookie_reason: cookieStr ? (cookieValid ? '格式通过本地检查；仍以千川只读响应为准' : '缺少 sessionid/sid_tt/uid_tt') : 'Cookie 文件不存在或不可读',
    has_csrftoken: cookieStr ? /(?:^|;\s*)csrftoken=/.test(cookieStr) : false,
    has_session: cookieStr ? /(?:^|;\s*)sessionid=/.test(cookieStr) : false,
    capabilities: readCapabilities(accountId),
    upstream: {
      state: queue && queue.last_error ? 'degraded' : (queue && queue.last_success_at ? 'available' : 'unknown'),
      last_success_at: queue && queue.last_success_at || null,
      last_error_at: queue && queue.last_error_at || null,
      last_error: queue && queue.last_error || null,
    },
    collector: collector || { state: 'not_started' },
    data_health: dataHealth,
  };
}

function handleStatus(req, res, url) {
  // U10: 支持 ?account=xxx 查询指定账号，否则返回所有账号汇总
  const accounts = QIANCHUAN_ACCOUNTS && QIANCHUAN_ACCOUNTS.length ? QIANCHUAN_ACCOUNTS : [];
  const queryAccount = url ? url.searchParams.get('account') : null;

  const runtime = runtimeStatus();
  const base = {
    ok: true,
    memory_cache_entries: memoryCache.size,
    port: PORT,
    total_accounts: accounts.length,
    // 分层而非单一 healthy：Cookie/429/上游异常只降级相应账户，不能触发 watchdog 重启。
    layers: {
      http: { state: 'available', loopback: `127.0.0.1:${PORT}` },
      sqlite: sqliteStatus(),
      collector: runtime.collector,
      queue: runtime.queue,
      resources: {
        memory: runtime.memory,
        active_handles: runtime.active_handles,
        event_loop_delay_ms: runtime.event_loop_delay_ms,
      },
    },
    runtime,
  };

  if (queryAccount) {
    const acc = accounts.find(a => a.id === queryAccount);
    if (!acc) {
      return sendJSON(res, { ok: false, error: `Account "${queryAccount}" not found`, available: accounts.map(a => a.id) }, 404);
    }
    return sendJSON(res, { ...base, ...accountStatus(acc.id, runtime), account_name: acc.name });
  }

  // 返回所有账号的 cookie 状态汇总
  const allAccounts = accounts.map(acc => ({
    ...accountStatus(acc.id, runtime),
    account_name: acc.name,
  }));

  // 向后兼容：保留默认账号（列表[0]）的字段在顶层，但不把它当成任何写操作默认账号。
  const defaultStatus = allAccounts[0] || {};
  return sendJSON(res, {
    ...base,
    cookie_exists: defaultStatus.cookie_exists || false,
    cookie_valid: defaultStatus.cookie_valid || false,
    has_csrftoken: defaultStatus.has_csrftoken || false,
    has_session: defaultStatus.has_session || false,
    default_account: defaultStatus.account || null,
    accounts: allAccounts,
  });
}

module.exports = handleStatus;
