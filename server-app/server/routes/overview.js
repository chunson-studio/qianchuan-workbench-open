const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');
const { CACHE_DIR } = require('../lib/config');
const { runFetchOverview } = require('../lib/browser');
const { sendJSON, getLocalDateStr, resolveDateRange } = require('../lib/utils');
const { isValidAccountId } = require('../lib/api-helpers');

async function handleOverview(req, res, url) {
  let start = url.searchParams.get('start') || '';
  let end = url.searchParams.get('end') || '';
  const dateRange = url.searchParams.get('dateRange');
  const refresh = url.searchParams.get('refresh') === '1';

  if (dateRange) {
    const range = resolveDateRange(dateRange);
    if (range) {
      start = range.start;
      end = range.end;
    }
  }

  if (!start || !end) return sendJSON(res, { ok: false, error: 'missing dates (provide start/end or dateRange)' }, 400);

  // CLAUDE.md 强制要求：接口安全，防止目录穿越，做严格的正则白名单校验
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(start) || !dateRegex.test(end)) {
    return sendJSON(res, { ok: false, error: 'Invalid date format. Must be YYYY-MM-DD' }, 400);
  }

  const account = url.searchParams.get('account');
  // 账号白名单：格式合法但不在 config 里的账号会静默回落默认 cookie，拿错数据（2026-07-25 审查修复）
  if (account) {
    const { validateAccount } = require('../lib/api-helpers');
    try { validateAccount(account); } catch (e) {
      return sendJSON(res, { ok: false, error: e.message + '（合法账号见 config.qianchuan_accounts）' }, 400);
    }
  }
  const safeAccount = (account && isValidAccountId(account)) ? account : 'def';
  const overviewPath = path.join(CACHE_DIR, `overview_${start.replace(/-/g, '')}_${end.replace(/-/g, '')}_${safeAccount}.json`);
  console.log(`[overview] ${start} ~ ${end}${refresh ? ' (refresh)' : ''}`);

  const todayStr = getLocalDateStr();

  // P19: 合并两次 stat 为一次
  let stat;
  try { stat = await fsPromises.stat(overviewPath); } catch { /* 文件不存在 */ }
  if (!refresh && stat) {
    try {
      const cacheMtimeDay = getLocalDateStr(new Date(stat.mtimeMs));
      const isLive = end >= todayStr;
      const ageMs = Date.now() - stat.mtimeMs;
      let hit = false;
      let reason = '';

      if (isLive) {
        if (ageMs < 30 * 1000) { hit = true; reason = `live, ${Math.round(ageMs/1000)}s ago`; }
        else reason = `live expired, ${Math.round(ageMs/1000)}s ago`;
      } else {
        if (cacheMtimeDay >= todayStr) { hit = true; reason = `history, written today`; }
        else reason = `history stale, written ${cacheMtimeDay}`;
      }

      if (hit) {
        const overviewData = JSON.parse(await fsPromises.readFile(overviewPath, 'utf8'));
        console.log(`[overview] ✓ 缓存命中 (${reason})`);
        return sendJSON(res, { ok: true, data: overviewData, from_cache: true, cache_age_ms: ageMs, mode: isLive ? 'live' : 'history', server_time: new Date().toISOString() });
      } else {
        console.log(`[overview] ↻ 缓存失效 (${reason})，重新采集`);
      }
    } catch (e) {
      console.log(`[overview] ✗ 缓存解析失败: ${e.message}，将重新采集`);
    }
  }

  runFetchOverview(start, end, account)
    .then((data) => {
      console.log(`[overview] ✓ 采集完成`);
      return sendJSON(res, { ok: true, data, from_cache: false, server_time: new Date().toISOString() });
    })
    .catch((err) => {
      console.log(`[overview] ✗ 采集失败: ${err.message}`);
      return sendJSON(res, { ok: false, error: 'collection_failed', detail: err.message }, 503);
    });
}

module.exports = handleOverview;
