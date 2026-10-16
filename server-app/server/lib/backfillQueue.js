const { backfillDates } = require('./fetchDaily');
const { getMissingDates, clearEmptyMarkers } = require('./db');
const { defaultAccountId } = require('./api-helpers');

// 每账号一个回填任务槽，避免不同账号互相阻塞/串结果。
// key 为 accountId，value 为 { start, end, total, completed, current, promise }。
const activeJobs = new Map();
// 每账号最近一次完成结果，供 getProgress 在该账号无活跃任务时返回。
const lastResults = new Map();

function getProgress(accountId) {
  const job = activeJobs.get(accountId);
  if (!job) {
    return lastResults.get(accountId) || { active: false, completed: 0, total: 0, done: true, accountId };
  }
  return {
    active: true,
    accountId,
    start: job.start,
    end: job.end,
    completed: job.completed,
    total: job.total,
    current: job.current,
    done: false,
  };
}

function startBackfill(start, end, accountId = defaultAccountId()) {
  const existing = activeJobs.get(accountId);
  if (existing) {
    if (existing.start === start && existing.end === end) {
      return getProgress(accountId);
    }
    // 该账号已有其他范围任务在跑，不中断，返回当前进度
    return { active: true, busy: true, ...getProgress(accountId) };
  }

  // 先清除范围内的空标记，让之前因cookie失效/限流导致空结果的日期能重新查询
  clearEmptyMarkers(start, end, accountId);
  const missing = getMissingDates(start, end, accountId);
  if (missing.length === 0) {
    const result = { active: false, completed: 0, total: 0, done: true, start, end, accountId };
    lastResults.set(accountId, result);
    return result;
  }

  const job = {
    start,
    end,
    accountId,
    total: missing.length,
    completed: 0,
    current: missing[0],
    promise: null,
  };
  activeJobs.set(accountId, job);

  job.promise = (async () => {
    try {
      await backfillDates(missing, {
        delayMs: 300,
        accountId,
        onProgress: ({ date, index, totalDates }) => {
          job.completed = index + 1;
          job.current = date;
        },
      });
      const result = { active: false, completed: missing.length, total: missing.length, done: true, start, end, accountId };
      lastResults.set(accountId, result);
    } catch (e) {
      console.log(`[backfill-queue] ${accountId} 失败:`, e.message);
      const isCookieExpired = e.message === 'cookie_expired';
      const result = {
        active: false,
        completed: job.completed,
        total: missing.length,
        done: true,
        error: e.message,
        cookieExpired: isCookieExpired,  // 前端可据此提示用户刷新cookie
        start, end, accountId
      };
      lastResults.set(accountId, result);
    } finally {
      activeJobs.delete(accountId);
    }
  })();

  return getProgress(accountId);
}

// 等待指定账号的回填任务完成（或超时）。不传 accountId 时维持旧行为：等所有账号空闲。
async function waitForCompletion(timeoutMs = 120000, accountId) {
  const start = Date.now();
  if (accountId) {
    while (activeJobs.has(accountId)) {
      if (Date.now() - start > timeoutMs) return { timeout: true, ...getProgress(accountId) };
      await new Promise(r => setTimeout(r, 500));
    }
    return getProgress(accountId);
  }
  while (activeJobs.size > 0) {
    if (Date.now() - start > timeoutMs) return { timeout: true, active: true, completed: 0, total: 0, done: false };
    await new Promise(r => setTimeout(r, 500));
  }
  return { active: false, completed: 0, total: 0, done: true };
}

module.exports = {
  startBackfill,
  getProgress,
  waitForCompletion,
};
