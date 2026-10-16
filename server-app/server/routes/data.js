const { memoryCache } = require('../lib/cache');
const { CACHE_TTL_MS } = require('../lib/config');
const { enrichRows } = require('../lib/data');
const { backfillRange } = require('../lib/fetchDaily');
const { startBackfill, getProgress, waitForCompletion } = require('../lib/backfillQueue');
const { aggregateRange, getMissingDates, invalidateRange, eachDate, getRangeHistory, groupHistoryByMaterial } = require('../lib/db');
const { attachLifecycle } = require('../lib/lifecycle');
const { readQcCookie, isCookieProbablyValid } = require('../lib/cookie');
const { sendJSON, getLocalDateStr, formatDate, validateDateRange } = require('../lib/utils');
const { defaultAccountId } = require('../lib/api-helpers');

const REFRESH_LOOKBACK_DAYS = 90;
const SYNC_BACKFILL_MAX_DAYS = 7;
const BACKFILL_WAIT_MS = 25000;

function activeBackfillCovers(progress, start, end) {
  return Boolean(
    progress
    && progress.active
    && typeof progress.start === 'string'
    && typeof progress.end === 'string'
    && progress.start <= start
    && progress.end >= end
  );
}

function buildResult(aggregated, start, end, accountId) {
  const enriched = enrichRows(aggregated, start, end);
  const activeCount = enriched.filter(r => r['状态'] === '投放中').length;
  const deletedCount = enriched.filter(r => r['状态'] === '已删除').length;

  const historyRows = getRangeHistory(start, end, accountId);
  const histories = groupHistoryByMaterial(historyRows);
  const accountTotals = {
    cost: enriched.reduce((s, r) => s + (Number(r['整体消耗(元)']) || 0), 0),
    gmv: enriched.reduce((s, r) => s + (Number(r['整体成交金额(元)']) || 0), 0),
  };
  attachLifecycle(enriched, histories, start, end, accountTotals);

  return {
    rows: enriched.length,
    meta: {
      total: enriched.length,
      active: activeCount,
      deleted: deletedCount,
      truncated: false,
    },
    data: enriched,
  };
}

async function produceData(start, end, accountId) {
  const aggregated = aggregateRange(start, end, accountId);
  if (!aggregated || aggregated.length === 0) {
    return { ok: false, error: 'no_data', rows: 0, meta: { total: 0, active: 0, deleted: 0, truncated: false }, server_time: new Date().toISOString() };
  }
  const result = buildResult(aggregated, start, end, accountId);
  // Fix 1: 写入缓存带 account 前缀，与读取 key 一致
  const memKey = accountId + '|' + start + '~' + end;
  memoryCache.set(memKey, { ...result, timestamp: Date.now() });
  return { ...result, ok: true, from_cache: 'db', server_time: new Date().toISOString() };
}

function handleData(req, res, url) {
  // 不传日期时默认全量（90天），从素材上传日起算
  const today = getLocalDateStr();
  const d90 = new Date(); d90.setDate(d90.getDate() - 90);
  const defaultStart = getLocalDateStr(d90);
  const start = url.searchParams.get('start') || defaultStart;
  const end = url.searchParams.get('end') || today;

  // U6: 日期格式校验（仅当用户显式传了 start/end 时才校验，默认值天然合法）
  if (url.searchParams.has('start') || url.searchParams.has('end')) {
    if (!validateDateRange(start, end)) {
      return sendJSON(res, { ok: false, error: 'Invalid date format. Must be YYYY-MM-DD' }, 400);
    }
  }

  const account = url.searchParams.get('account') || url.searchParams.get('accountId') || defaultAccountId();
  // 历史账户专用说明已从试用包移除。
  const { validateAccount } = require('../lib/api-helpers');
  try { validateAccount(account); } catch (e) {
    return sendJSON(res, { ok: false, error: e.message + '（合法账号见 config.qianchuan_accounts）' }, 400);
  }
  const refresh = url.searchParams.get('refresh') === '1' || url.searchParams.get('refresh') === 'true';
  const check = url.searchParams.get('check') === '1' || url.searchParams.get('check') === 'true';

  // memoryCache 按 account 分 key
  const memKey = account + '|' + start + '~' + end;

  console.log(`[query] ${start} ~ ${end}${refresh ? ' (强制刷新)' : ''}${check ? ' (轮询)' : ''} (${account})`);

  (async () => {
    if (!refresh && !check) {
      const mem = memoryCache.get(memKey);
      // P11: 历史数据(end < today)使用更长 TTL，避免频繁重算
      const isHistorical = end < getLocalDateStr();
      const ttl = isHistorical ? 5 * 60 * 1000 : CACHE_TTL_MS;
      if (mem && Date.now() - mem.timestamp <= ttl) {
        console.log(`[query] ✓ 内存缓存命中 ${mem.rows} 条${isHistorical ? ' (历史, TTL=5min)' : ''}`);
        const { timestamp, ...cached } = mem;
        return sendJSON(res, { ...cached, ok: true, from_cache: 'memory', server_time: new Date().toISOString() });
      }
      // Fix 9: 过期条目清理
      if (mem) memoryCache.delete(memKey);
    }

    try {
      // 验证指定账号的 cookie 有效性
      if (!isCookieProbablyValid(readQcCookie(account))) {
        console.log(`[query] Cookie 无效 (${account})，尝试刷新...`);
        return sendJSON(res, { ok: false, error: 'cookie_expired', hint: 'Cookie 已失效，请重新导出 cookie.txt 或运行 qc_cookie_refresher' }, 401);
      }

      // 首次启动会自动补最近 30 天。此时前端常会同时请求其中 7/30 天；
      // 必须复用账号级活动任务，不能先 invalidate 再另起同步 backfill，否则会重复拉取、
      // 放大限流风险，并让本可后台完成的首次打开撞上 55 秒 HTTP 期限。
      const activeProgress = getProgress(account);
      if (activeProgress.active) {
        const coveredByActive = activeBackfillCovers(activeProgress, start, end);
        if (check) {
          return sendJSON(res, {
            ok: true,
            backfilling: true,
            busy: !coveredByActive,
            progress: activeProgress,
            server_time: new Date().toISOString(),
          });
        }

        const waited = await waitForCompletion(BACKFILL_WAIT_MS, account);
        if (waited.error) {
          return sendJSON(res, { ok: false, error: 'backfill_failed', message: waited.error, server_time: new Date().toISOString() }, 500);
        }
        if (waited.timeout) {
          return sendJSON(res, {
            ok: true,
            backfilling: true,
            busy: !coveredByActive,
            progress: getProgress(account),
            message: '该账号已有历史回填任务，当前请求已复用现有任务，请稍候...',
            server_time: new Date().toISOString(),
          });
        }
        if (coveredByActive && waited.done) {
          const result = await produceData(start, end, account);
          console.log(`[query] ✓ 复用账号活动回填后聚合 ${result.rows || 0} 条`);
          return sendJSON(res, result);
        }
        // 账号任务已结束但未覆盖当前请求区间，下面再按当前请求正常补采。
      }

      // 强制刷新时，清空最近 N 天数据，让它们重新拉取
      if (refresh) {
        const now = new Date();
        const lookbackStart = new Date(now);
        lookbackStart.setDate(now.getDate() - REFRESH_LOOKBACK_DAYS);
        const refreshStart = start >= formatDate(lookbackStart) ? start : formatDate(lookbackStart);
        const removed = invalidateRange(refreshStart, end, account);
        console.log(`[query] 强制刷新，已清理 ${removed} 条 ${refreshStart}~${end} 的缓存`);
      }

      // 补缺失日期
      const missing = getMissingDates(start, end, account);

      if (missing.length === 0) {
        console.log(`[query] 日期范围 ${start}~${end} 数据完整`);
        const result = await produceData(start, end, account);
        console.log(`[query] ✓ SQLite 聚合 ${result.rows || 0} 条`);
        return sendJSON(res, result);
      }

      if (missing.length <= SYNC_BACKFILL_MAX_DAYS) {
        console.log(`[query] 同步补 ${missing.length} 天:`, missing.join(', '));
        try {
          await backfillRange(start, end, { accountId: account });
        } catch (e) {
          console.log(`[query] ⚠️ 同步补数据异常: ${e.message}，继续聚合已有数据`);
        }
        const result = await produceData(start, end, account);
        console.log(`[query] ✓ SQLite 聚合 ${result.rows || 0} 条`);
        return sendJSON(res, result);
      }

      // 缺失日期较多，走后台回填
      console.log(`[query] 缺失 ${missing.length} 天，启动后台回填`);
      const started = startBackfill(start, end, account);
      if (started.error) {
        return sendJSON(res, { ok: false, error: 'backfill_failed', message: started.error, server_time: new Date().toISOString() }, 500);
      }
      if (started.done) {
        const result = await produceData(start, end, account);
        console.log(`[query] ✓ 后台回填完成后聚合 ${result.rows || 0} 条`);
        return sendJSON(res, result);
      }

      // 尝试等待一小段时间，很多情况下几十秒内就能完成
      const waited = await waitForCompletion(BACKFILL_WAIT_MS, account);
      if (waited.error) {
        return sendJSON(res, { ok: false, error: 'backfill_failed', message: waited.error, server_time: new Date().toISOString() }, 500);
      }
      if (!waited.timeout && waited.done) {
        const result = await produceData(start, end, account);
        console.log(`[query] ✓ 后台回填完成后聚合 ${result.rows || 0} 条`);
        return sendJSON(res, result);
      }

      return sendJSON(res, {
        ok: true,
        backfilling: true,
        progress: getProgress(account),
        message: `正在补 ${missing.length} 天历史数据，请稍候...`,
        server_time: new Date().toISOString(),
      });
    } catch (e) {
      if (e.message === 'cookie_expired') {
        console.log(`[query] Cookie 过期 (${account})，尝试刷新...`);
        return sendJSON(res, { ok: false, error: 'cookie_expired', hint: 'Cookie 已失效，请重新导出 cookie.txt 或运行 qc_cookie_refresher' }, 401);
      }
      console.log('[query] ✗', e.message);
      console.log(e.stack);
      sendJSON(res, { ok: false, error: e.message }, 500);
    }
  })().catch(err => {
    console.error(`[query] 未捕获异常: ${err.message}`, err);
    if (!res.headersSent) sendJSON(res, { ok: false, error: 'internal_server_error', message: err.message }, 500);
  });
}

module.exports = handleData;
module.exports.activeBackfillCovers = activeBackfillCovers;

