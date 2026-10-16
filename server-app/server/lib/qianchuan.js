const https = require('https');
const { AAVID, GFVERSION, REQUEST_INTERVAL } = require('./config');
const { readCookie, readQcCookie, resolveQcAccount, resolveAavid, resolveAnchorId, getCsrf } = require('./cookie');

// HTTP keep-alive 连接复用，避免每次请求都重新 TCP+TLS 握手
const qcAgent = new https.Agent({ keepAlive: true, maxSockets: 12, keepAliveMsecs: 30000 });

function positiveEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const UPSTREAM_IDLE_TIMEOUT_MS = positiveEnv('QC_UPSTREAM_IDLE_TIMEOUT_MS', 15000);
const UPSTREAM_HARD_TIMEOUT_MS = positiveEnv('QC_UPSTREAM_HARD_TIMEOUT_MS', 20000);
const QUEUE_EXEC_TIMEOUT_MS = positiveEnv('QC_QUEUE_EXEC_TIMEOUT_MS', 45000);   // 从开始执行起算的超时
const QUEUE_WAIT_TIMEOUT_MS = positiveEnv('QC_QUEUE_WAIT_TIMEOUT_MS', 30000);   // 排队等待上限
const STAT_QUERY_TOTAL_TIMEOUT_MS = positiveEnv('QC_STAT_QUERY_TOTAL_TIMEOUT_MS', 40000);
const RATE_LIMIT_RETRY_DELAY_MS = positiveEnv('QC_RATE_LIMIT_RETRY_DELAY_MS', 15000);

function qcError(code, message, options = {}) {
  const err = new Error(message);
  err.code = code;
  err.component = options.component || 'qianchuan_upstream';
  err.retryable = options.retryable === true;
  if (options.statusCode) err.statusCode = options.statusCode;
  if (options.timeoutMs) err.timeoutMs = options.timeoutMs;
  if (options.cause) err.cause = options.cause;
  return err;
}

function abortError(signal, fallback = '请求已取消') {
  if (signal?.reason instanceof Error) return signal.reason;
  return qcError('request_cancelled', fallback, { retryable: true, statusCode: 504 });
}

function linkAbortSignal(signal, controller, onAbort) {
  if (!signal) return () => {};
  const abort = () => {
    if (!controller.signal.aborted) controller.abort(abortError(signal));
    if (onAbort) onAbort();
  };
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  return () => signal.removeEventListener('abort', abort);
}

function sleepWithSignal(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const abort = () => finish(() => reject(abortError(signal)));
    function done() { finish(resolve); }
    function finish(fn) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      fn();
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

// 按账号分队列，多账号天然并发，单账号内保持 REQUEST_INTERVAL 间隔
const accountQueues = new Map();

function getAccountQueue(accountId) {
  const key = accountId || '_default';
  let q = accountQueues.get(key);
  if (!q) {
    q = {
      queue: [], processing: false, lastRequestTime: 0, interval: REQUEST_INTERVAL,
      currentLabel: null, currentStartedAt: null,
      currentController: null,
      lastSuccessAt: null, lastErrorAt: null, lastError: null,
    };
    accountQueues.set(key, q);
  }
  return q;
}

// 自适应限频：触发平台限频(status_code=2)时该账号间隔翻倍，封顶 2s；
// 每次成功请求回降 50ms，直至回到配置的 REQUEST_INTERVAL。
// 对应官方频控文档的建议——超限后自行降速，避免持续超限升级到分钟/天级封禁。
const RATE_LIMIT_MAX_INTERVAL = 2000;
const RATE_LIMIT_DECAY_MS = 50;

function reportRateLimit(accountId) {
  const q = getAccountQueue(accountId);
  const next = Math.min(RATE_LIMIT_MAX_INTERVAL, Math.max(REQUEST_INTERVAL * 2, q.interval * 2));
  if (next !== q.interval) {
    console.log(`[queue:${accountId || 'default'}] 触发限频，请求间隔 ${q.interval}ms → ${next}ms`);
    q.interval = next;
  }
}

/**
 * 将一个异步任务加入账号限频队列，保证同一账号内请求间隔 ≥ REQUEST_INTERVAL。
 * @param {() => Promise<any>} fn - 实际执行的异步函数
 * @param {string} [accountId] - 千川账号ID，不传则使用默认队列
 * @param {object} [opts] - 选项 { priority: 0|1 } 0=普通(默认)，1=高优先级（插队）
 * @returns {Promise<any>} fn 的返回值
 */
function enqueue(fn, accountId, opts = {}) {
  return new Promise((resolve, reject) => {
    const q = getAccountQueue(accountId);
    const controller = new AbortController();
    const execTimeoutMs = Number.isFinite(Number(opts.timeoutMs)) && Number(opts.timeoutMs) > 0
      ? Number(opts.timeoutMs)
      : QUEUE_EXEC_TIMEOUT_MS;
    const waitTimeoutMs = Number.isFinite(Number(opts.waitTimeoutMs)) && Number(opts.waitTimeoutMs) > 0
      ? Number(opts.waitTimeoutMs)
      : QUEUE_WAIT_TIMEOUT_MS;
    const enqueuedAt = Date.now();
    const item = {
      fn,
      priority: opts.priority || 0,
      label: opts.label || fn.name || 'anonymous',
      controller,
      enqueuedAt,
      waitDeadlineAt: enqueuedAt + waitTimeoutMs,  // 排队等待截止
      execTimeoutMs,                                // 执行超时（开始执行后才计时）
      settled: false,
      expired: false,
      execTimer: null,
      unlinkExternal: () => {},
      resolve(value) {
        if (item.settled) return;
        item.settled = true;
        clearTimeout(item.waitTimer);
        clearTimeout(item.execTimer);
        item.unlinkExternal();
        resolve(value);
      },
      reject(err) {
        if (item.settled) return;
        item.settled = true;
        clearTimeout(item.waitTimer);
        clearTimeout(item.execTimer);
        item.unlinkExternal();
        reject(err);
      },
    };
    const expire = (reason) => {
      if (item.settled) return;
      item.expired = true;
      const err = reason instanceof Error ? reason : qcError(
        'queue_timeout',
        `账号请求排队等待超过 ${waitTimeoutMs}ms`,
        { retryable: true, statusCode: 504, timeoutMs: waitTimeoutMs },
      );
      if (!controller.signal.aborted) controller.abort(err);
      item.reject(err);
    };
    // 排队等待超时定时器
    item.waitTimer = setTimeout(expire, waitTimeoutMs);
    item.waitTimer.unref?.();
    item.unlinkExternal = linkAbortSignal(opts.signal, controller, () => expire(abortError(opts.signal)));
    if (item.settled) return;
    if (item.priority > 0 && q.processing) {
      // 高优先级：插入到队首（队列第一个位置），但当前正在处理的请求不打断
      q.queue.unshift(item);
    } else {
      q.queue.push(item);
    }
    processQueue(q, accountId).catch(err => {
      console.error('[queue:' + (accountId || 'default') + '] processQueue 异常:', err.message);
    });
  });
}

async function processQueue(q, accountId) {
  if (q.processing || q.queue.length === 0) return;
  q.processing = true;
  try {
    while (q.queue.length > 0) {
      const item = q.queue.shift();
      if (item.settled || item.expired) continue;
      // 排队等待超时检查
      if (Date.now() >= item.waitDeadlineAt) {
        item.reject(qcError('queue_wait_timeout', '账号请求排队等待已过期', {
          retryable: true, statusCode: 504, timeoutMs: item.waitDeadlineAt - item.enqueuedAt,
        }));
        continue;
      }
      // 限频冷却也属于排队等待；截止前不能为赶时间而缩短请求间隔。
      const now = Date.now();
      const wait = Math.max(0, q.interval - (now - q.lastRequestTime));
      if (wait > 0) {
        try { await sleepWithSignal(wait, item.controller.signal); }
        catch (error) { item.reject(error); continue; }
      }
      if (item.settled || item.controller.signal.aborted) continue;
      // 事件循环延迟时定时器可能尚未处理，实际执行前仍须核对绝对截止时间。
      if (Date.now() >= item.waitDeadlineAt) {
        item.reject(qcError('queue_wait_timeout', '账号请求排队等待已过期', {
          retryable: true, statusCode: 504, timeoutMs: item.waitDeadlineAt - item.enqueuedAt,
        }));
        continue;
      }
      clearTimeout(item.waitTimer);
      // 开始执行：启动执行超时定时器
      const execExpire = () => {
        if (item.settled) return;
        item.expired = true;
        const err = qcError('exec_timeout', `账号请求执行超过 ${item.execTimeoutMs}ms`, {
          retryable: true, statusCode: 504, timeoutMs: item.execTimeoutMs,
        });
        if (!item.controller.signal.aborted) item.controller.abort(err);
        item.reject(err);
      };
      item.execTimer = setTimeout(execExpire, item.execTimeoutMs);
      item.execTimer.unref?.();
      q.currentLabel = item.label;
      q.currentStartedAt = Date.now();
      q.currentController = item.controller;
      let rejectOnAbort;
      try {
        const abortPromise = new Promise((_, reject) => {
          rejectOnAbort = () => reject(abortError(item.controller.signal));
          if (item.controller.signal.aborted) rejectOnAbort();
          else item.controller.signal.addEventListener('abort', rejectOnAbort, { once: true });
        });
        const result = await Promise.race([
          Promise.resolve().then(() => item.fn(item.controller.signal)),
          abortPromise,
        ]);
        item.resolve(result);
        q.lastSuccessAt = new Date().toISOString();
        q.lastError = null;
        // 成功请求后逐步回降自适应间隔
        if (q.interval > REQUEST_INTERVAL) {
          q.interval = Math.max(REQUEST_INTERVAL, q.interval - RATE_LIMIT_DECAY_MS);
        }
      } catch (e) {
        item.reject(e);
        q.lastErrorAt = new Date().toISOString();
        q.lastError = { code: e.code || 'upstream_error', message: e.message };
        // Cookie 过期时快速失败该账号剩余排队请求，避免 429 刷屏
        if (e.code === 'cookie_expired' || (e.message && (e.message.includes('cookie_expired') || e.message.includes('401')))) {
          console.log('[queue:' + (accountId || 'default') + '] Cookie 过期，快速失败剩余 ' + q.queue.length + ' 个排队请求');
          while (q.queue.length > 0) {
            const queued = q.queue.shift();
            if (!queued.controller.signal.aborted) queued.controller.abort(e);
            queued.reject(qcError('cookie_expired', 'cookie_expired', { statusCode: 401 }));
          }
        }
      } finally {
        if (rejectOnAbort) item.controller.signal.removeEventListener('abort', rejectOnAbort);
        q.currentLabel = null;
        q.currentStartedAt = null;
        q.currentController = null;
      }
      q.lastRequestTime = Date.now();
    }
  } finally {
    q.processing = false;
  }
}

function cancelAccountQueue(accountId, reason = '账号已移出，已取消该账号排队请求') {
  const q = accountQueues.get(accountId);
  if (!q) return { cancelled: 0, had_in_flight: false };
  const error = qcError('account_archived', reason, { statusCode: 409, retryable: false });
  let cancelled = 0;
  while (q.queue.length) {
    const item = q.queue.shift();
    if (!item.settled) {
      if (!item.controller.signal.aborted) item.controller.abort(error);
      item.reject(error);
      cancelled++;
    }
  }
  const hadInFlight = Boolean(q.currentController && !q.currentController.signal.aborted);
  if (hadInFlight) q.currentController.abort(error);
  return { cancelled, had_in_flight: hadInFlight };
}

function getQueueStatus() {
  const now = Date.now();
  const result = {};
  for (const [accountId, q] of accountQueues.entries()) {
    result[accountId] = {
      length: q.queue.filter(item => !item.settled).length,
      processing: q.processing,
      current_task: q.currentLabel,
      current_task_age_ms: q.currentStartedAt ? now - q.currentStartedAt : null,
      last_success_at: q.lastSuccessAt,
      last_error_at: q.lastErrorAt,
      last_error: q.lastError,
      interval_ms: q.interval,
    };
  }
  return result;
}

/**
 * 向千川 statQuery 端点发送 POST 请求（JSON body）。
 * @param {object} body - 请求体对象（千川 statQuery 参数）
 * @param {string} [accountId] - 千川账号ID，不传则使用默认账号
 * @returns {Promise<object>} 解析后的 JSON 响应
 */
function upstreamHttpError(statusCode, bodyText) {
  const detail = String(bodyText || '').replace(/\s+/g, ' ').slice(0, 180);
  if (statusCode === 400) return qcError('upstream_bad_request', `千川上游拒绝请求${detail ? `：${detail}` : ''}`, { statusCode: 400 });
  if (statusCode === 401) return qcError('cookie_expired', 'cookie_expired', { statusCode: 401 });
  if (statusCode === 403) return qcError('upstream_forbidden', '千川拒绝访问（HTTP 403），请核对官方网页访问状态', { statusCode: 403 });
  if (statusCode === 423) return qcError('upstream_locked', '千川上游资源被锁定', { statusCode: 423, retryable: true });
  if (statusCode === 429) return qcError('rate_limited', '千川上游限流', { statusCode: 429, retryable: true });
  if (statusCode >= 500) return qcError('upstream_unavailable', `千川上游不可用（HTTP ${statusCode}）`, { statusCode: 502, retryable: true });
  return qcError('upstream_http_error', `千川上游 HTTP ${statusCode}`, { statusCode: 502, retryable: statusCode >= 500 });
}

function performRequest(method, apiPath, body, accountId, signal) {
  return new Promise((resolve, reject) => {
    const cookieStr = readQcCookie(accountId);
    if (!cookieStr) return reject(qcError('cookie_expired', 'cookie_expired', { statusCode: 401 }));
    const data = body == null ? null : JSON.stringify(body);
    const options = {
      hostname: 'qianchuan.jinritemai.com',
      path: apiPath,
      method,
      agent: qcAgent,
      headers: {
        'Cookie': cookieStr,
        'x-csrftoken': getCsrf(cookieStr),
        'Origin': 'https://qianchuan.jinritemai.com',
        'Referer': 'https://qianchuan.jinritemai.com/dataV2/roi2-material-analysis',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36',
      },
    };
    if (data) options.headers['Content-Type'] = 'application/json;charset=UTF-8';
    let settled = false;
    let req;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimeout);
      signal?.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve(value);
    };
    const destroyAndFinish = (err) => {
      if (settled) return;
      req?.destroy(err);
      finish(err);
    };
    const hardTimeout = setTimeout(() => {
      destroyAndFinish(qcError('upstream_timeout', `千川上游总期限 ${UPSTREAM_HARD_TIMEOUT_MS}ms`, {
        statusCode: 504, retryable: true, timeoutMs: UPSTREAM_HARD_TIMEOUT_MS,
      }));
    }, UPSTREAM_HARD_TIMEOUT_MS);
    hardTimeout.unref?.();
    const onAbort = () => destroyAndFinish(abortError(signal));
    if (signal?.aborted) {
      clearTimeout(hardTimeout);
      return finish(abortError(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    req = https.request(options, res => {
      let responseBody = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { responseBody += chunk; });
      res.on('end', () => {
        if (settled) return;
        const statusCode = Number(res.statusCode || 0);
        if (statusCode < 200 || statusCode >= 300) return finish(upstreamHttpError(statusCode, responseBody));
        if (responseBody.includes('Forbidden') || responseBody.includes('登录')) {
          return finish(qcError('cookie_expired', 'cookie_expired', { statusCode: 401 }));
        }
        try { finish(null, JSON.parse(responseBody)); }
        catch (e) {
          const preview = responseBody.replace(/\n/g, ' ').slice(0, 300);
          console.log(`  [parse_error] 非JSON响应: ${preview}`);
          finish(qcError('upstream_parse_error', `parse_error: ${preview}`, {
            statusCode: 502, retryable: /bad gateway/i.test(preview), cause: e,
          }));
        }
      });
    });
    req.setTimeout(UPSTREAM_IDLE_TIMEOUT_MS, () => destroyAndFinish(qcError(
      'upstream_timeout',
      `千川上游 ${UPSTREAM_IDLE_TIMEOUT_MS}ms 无网络活动`,
      { statusCode: 504, retryable: true, timeoutMs: UPSTREAM_IDLE_TIMEOUT_MS },
    )));
    req.on('error', e => {
      if (settled) return;
      finish(e.code && String(e.code).startsWith('upstream_') ? e : qcError(
        'upstream_unavailable', e.message || '千川上游连接失败',
        { statusCode: 502, retryable: true, cause: e },
      ));
    });
    if (data) req.write(data);
    req.end();
  });
}

function postJSON(body, accountId, signal) {
  const aavid = resolveAavid(accountId);
  return performRequest(
    'POST',
    `/ad/api/data/v1/common/statQuery?aavid=${aavid}&gfversion=${GFVERSION}`,
    body,
    accountId,
    signal,
  );
}

/**
 * 通用千川 API 请求（非 statQuery 端点，如 material-analysis/*）。
 * 调用方按需用 enqueue(() => requestAPI(...), accountId) 走限频队列。
 * @param {('GET'|'POST')} method - HTTP 方法
 * @param {string} apiPath - 含 query string 的请求路径
 * @param {object} [body] - POST 对象（可选）
 * @param {string} [accountId] - 千川账号ID，不传则使用默认账号
 * @returns {Promise<object>} 解析后的 JSON 响应
 */
async function requestAPI(method, apiPath, body, accountId, signal) {
  const began = Date.now();
  const result = await performRequest(method, apiPath, body, accountId, signal);
  if (result && typeof result === 'object') result.request_timings = { upstream_ms: Date.now() - began, retry_ms: 0, retry_count: 0 };
  return result;
}

/**
 * 创建“一键控量”任务。该工具只限制指定时段内的最大消耗，不修改主计划 ROI。
 * 该端点要求页面动态生成 verifyFp/msToken/a_bogus 与 qc-* 签名；裸 HTTP 会返回 403。
 * 因此通过隔离的浏览器子进程让千川官方页面生成并发送请求，服务端仍负责全部护栏与回读。
 */
function createFlowControlTask(primaryAdId, budgetYuan, durationSeconds, accountId, signal) {
  const { runFlowControlBrowserWrite } = require('./flowControlBrowser');
  return enqueue(() => runFlowControlBrowserWrite({
    accountId,
    primaryAdId: String(primaryAdId),
    budgetYuan: Number(budgetYuan),
    durationSeconds: Math.round(Number(durationSeconds)),
    signal,
  }), accountId, { label: 'flow_control_signed_browser_write', timeoutMs: 120000 });
}

/**
 * 带重试的 statQuery 请求，处理限频(status_code=2)与 cookie 过期(401/40001)。
 * @param {object} body - 千川 statQuery 请求体
 * @param {number} [retries=3] - 最大重试次数
 * @param {string} [accountId] - 千川账号ID，不传则使用默认账号
 * @returns {Promise<object>} status_code=0 时的响应对象
 */
async function runStatQuery(body, accountId, options = {}) {
  const controller = new AbortController();
  const timeoutError = qcError('upstream_timeout', `statQuery 总期限 ${STAT_QUERY_TOTAL_TIMEOUT_MS}ms`, {
    statusCode: 504, retryable: true, timeoutMs: STAT_QUERY_TOTAL_TIMEOUT_MS,
  });
  const totalTimer = setTimeout(() => controller.abort(timeoutError), STAT_QUERY_TOTAL_TIMEOUT_MS);
  totalTimer.unref?.();
  const unlink = linkAbortSignal(options.signal, controller);
  let rateLimitRetried = false;
  try {
    while (true) {
      let result;
      try {
        result = await enqueue(
          queueSignal => postJSON(body, accountId, queueSignal),
          accountId,
          { priority: options.priority || 0, signal: controller.signal, label: 'statQuery' },
        );
      } catch (e) {
        if (e.code !== 'rate_limited' || rateLimitRetried) throw e;
        result = { status_code: 2 };
      }
      const sc = result.status_code ?? result.code ?? 0;
      if (sc === 0) return result;
      if (sc === 2) {
        reportRateLimit(accountId);
        if (rateLimitRetried) {
          throw qcError('rate_limited', '千川 API 连续限流', { statusCode: 429, retryable: true });
        }
        rateLimitRetried = true;
        console.log(`  [限频] status_code=2，等待 ${RATE_LIMIT_RETRY_DELAY_MS}ms 后仅重试一次`);
        await sleepWithSignal(RATE_LIMIT_RETRY_DELAY_MS, controller.signal);
        continue;
      }
      if (sc === 401 || sc === 40001 || (result.message && result.message.includes('登录'))) {
        throw qcError('cookie_expired', 'cookie_expired', { statusCode: 401 });
      }
      throw qcError('upstream_bad_response', `千川API错误 status_code=${sc} msg=${result.message || ''}`, {
        statusCode: 502, retryable: false,
      });
    }
  } finally {
    clearTimeout(totalTimer);
    unlink();
  }
}

async function statQuery(body, _retries = 3, accountId, options = {}) {
  return runStatQuery(body, accountId, options);
}

/**
 * 走 enqueue 高优先级通道的 statQuery。仍然受 REQUEST_INTERVAL 限频保护，
 * 但会插队到该账号队列的队首（当前正在处理的请求不打断）。
 * 用于 today-snapshot 等"想快但不绕过限频"的场景。
 */
async function statQueryDirect(body, _retries = 3, accountId, options = {}) {
  return runStatQuery(body, accountId, { ...options, priority: 1 });
}

/**
 * 更新广告计划的启用/暂停状态。
 * @param {string} primaryAdId - 主广告ID
 * @param {string} [assistTaskId] - 辅助任务ID，存在则操作该任务
 * @param {number|string} status - 状态操作码（如 1=启用, 2=暂停）
 * @param {string} [accountId] - 千川账号ID，不传则使用默认账号
 * @returns {Promise<object>} 千川 API 响应
 */
async function updateCampaignStatus(primaryAdId, assistTaskId, status, accountId) {
  // 运营铁律：禁止暂停/停止主计划（status=2/6 且无 assistTaskId 说明操作的是主计划本身）
  // 暂停/停止追投任务（有 assistTaskId）不受限制；6=停止（2026-08-17 探针确认，一键起量任务停止动作）
  const statusCode = parseInt(status, 10);
  if (isNaN(statusCode) || ![1, 2, 6].includes(statusCode)) {
    const err = new Error('无效的状态码（仅允许 1=启用, 2=暂停, 6=停止）');
    err.statusCode = 400;
    throw err;
  }
  if (!assistTaskId && [2, 6].includes(statusCode)) {
    const err = new Error('禁止暂停/停止主计划（运营铁律：计划不能关闭，只能调整预算/ROI或暂停单个追投任务）');
    err.statusCode = 403;
    throw err;
  }
  const aavid = resolveAavid(accountId);
  const targetId = assistTaskId || primaryAdId;
  // The verified post-live task-pause packet uses these exact capitalized keys.
  // Preserve the existing wire contract for enable/stop and plan operations.
  const body = assistTaskId && statusCode === 2 ? {
    OptType: statusCode,
    Objects: [{ objectID: String(targetId), type: 1 }]
  } : {
    optType: statusCode,
    objects: [{ objectID: String(targetId), type: 1 }]
  };
  return enqueue(() => requestAPI('POST', `/ad/api/pmc/v1/batch_update_operation?aavid=${aavid}`, body, accountId), accountId);
}

/**
 * 删除追投任务（optType=3）。
 * @param {string} assistTaskId - 追投任务ID
 * @param {string} [accountId]
 * @returns {Promise<object>} 千川 API 响应
 */
async function deleteBoostTask(assistTaskId, accountId) {
  const aavid = resolveAavid(accountId);
  const body = {
    optType: 3,
    objects: [{ objectID: String(assistTaskId), type: 1 }]
  };
  return enqueue(() => requestAPI('POST', `/ad/api/pmc/v1/batch_update_operation?aavid=${aavid}`, body, accountId), accountId);
}

/**
 * 更新广告计划的预算与 ROI 目标。
 * 追投单独改预算/时长走 PMC 局部更新；ROI、出价或定向仍沿用整单更新。
 * 时长以原 startTime 加新总秒数生成 EndTime；不以当前时刻重新起算。
 * @param {string} primaryAdId - 主广告ID
 * @param {string} [assistTaskId] - 辅助任务ID，存在则使用 assist-task 接口
 * @param {number|string} [budget] - 新预算金额，不传则不修改
 * @param {number|string} [roiGoal] - ROI 目标值，不传则不修改
 * @param {string} [accountId] - 千川账号ID，不传则使用默认账号
 * @returns {Promise<object>} 千川 API 响应
 */
async function updateCampaignBudgetAndROI(primaryAdId, assistTaskId, budget, roiGoal, accountId, opts = {}) {
  const rejectParameter = (code, message, statusCode = 400, details) => {
    throw Object.assign(new Error(message), { code, statusCode, advertising_writes: 0, skipOpLog: true, details });
  };
  const hasDuration = opts.durationSeconds !== undefined;
  if (hasDuration || opts.expectedDurationSeconds !== undefined) {
    if (!assistTaskId || !primaryAdId || !hasDuration || !Number.isSafeInteger(opts.durationSeconds)
      || opts.durationSeconds < 1800 || opts.durationSeconds > 86400 || opts.durationSeconds % 1800 !== 0
      || !Number.isSafeInteger(opts.expectedDurationSeconds) || opts.expectedDurationSeconds <= 0)
      rejectParameter('invalid_duration', '时长更新需明确追投和主计划、0.5至24小时的半小时步进总秒数及真实旧总秒数');
    if ([budget, roiGoal, opts.bid, opts.audienceTemplate, opts.audience, opts.expectedBudget].some(v => v != null))
      rejectParameter('mixed_duration_update_not_supported', '时长须单独修改');
  }
  const aavid = resolveAavid(accountId);
  const assertExpectedBudget = (currentBudget, { partialWrite = false } = {}) => {
    if (opts.expectedBudget === undefined) return;
    const expected = opts.expectedBudget;
    if (!Number.isFinite(expected) || expected <= 0 || !Number.isFinite(currentBudget) || currentBudget <= 0) {
      const error = new Error(partialWrite
        ? '预算前值不可核验；ROI请求已被上游接受但未回读核验，预算结果未知，请立即只读核验'
        : '预算前值不可核验，本次未写入');
      Object.assign(error, {
        code: partialWrite ? 'budget_verification_failed_after_partial_write' : 'target_parameter_unavailable',
        statusCode: 423,
        ...(partialWrite ? { partial: true, effect_status: 'unconfirmed', upstream_accepted: true, advertising_writes: 1 } : { skipOpLog: true, advertising_writes: 0 }),
        details: { expected_budget: expected, current_budget: currentBudget, requested_budget: budget },
      });
      if (partialWrite) error.partial_effect = error.details.partial_effect = { roi_goal: 'upstream_accepted', budget: 'not_submitted' };
      throw error;
    }
    if (Math.abs(currentBudget - expected) > 0.00001) {
      const error = new Error(partialWrite
        ? '预算已被其他操作修改；ROI上游已接受但未回读核验，预算未提交，请核验后重新判断'
        : '预算已被其他操作修改，本次未写入；重新读取后重新判断');
      Object.assign(error, {
        code: partialWrite ? 'budget_conflict_after_partial_write' : 'budget_conflict', statusCode: 409,
        ...(partialWrite ? { partial: true, effect_status: 'unconfirmed', upstream_accepted: true, advertising_writes: 1 } : { skipOpLog: true, advertising_writes: 0 }),
        details: { expected_budget: expected, current_budget: currentBudget, requested_budget: budget },
      });
      if (partialWrite) error.partial_effect = error.details.partial_effect = { roi_goal: 'upstream_accepted', budget: 'not_submitted' };
      throw error;
    }
  };

  if (assistTaskId) {
    // 追投任务：update-uni-prom-assist-task 是全量更新接口
    // 必须传完整的任务信息（Mids/VideoLegoMids/Name/Audience等），不能只传要改的字段
    // 所以先拉当前追投任务完整信息，再替换要改的字段
    const { GFVERSION } = require('./config');
    const verifyFp = 'verify_mqxv7d1m_24coEPxu_hgMm_4pg4_87gU_WuXGZh8qjfBE';
    const path = `/ad/api/pmc/v1/uni-promotion/ad/update-uni-prom-assist-task?aavid=${aavid}&gfversion=${GFVERSION}&verifyFp=${verifyFp}&fp=${verifyFp}`;

    // 拉当前追投任务完整信息
    const { fetchBoostList, fetchBoostMaterialDetail } = require('./qianchuanTabs');
    const today = new Date();
    const todayStr = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
    // 日期范围扩大到近7天，避免千川数据延迟导致今天查不到任务
    const d7 = new Date();
    d7.setDate(d7.getDate() - 7);
    const d7Str = d7.getFullYear() + '-' + String(d7.getMonth() + 1).padStart(2, '0') + '-' + String(d7.getDate()).padStart(2, '0');
    const boostList = await fetchBoostList(primaryAdId, d7Str, todayStr, accountId, { includeAllStatus: true });
    const adInfos = (boostList && boostList.data && boostList.data.adInfos) || [];
    const task = adInfos.find(ad => String(ad.id) === String(assistTaskId));

    if (!task) {
      throw new Error('追投任务 ' + assistTaskId + ' 不存在');
    }

    const budgetOnly = budget != null && roiGoal == null && opts.bid == null && opts.audienceTemplate == null && opts.audience == null;
    if (hasDuration || budgetOnly) {
      // Verified against the official AdDetailTaskCenterTab on 2026-09-30.
      // These partial updates do not require Mids or replacement of unrelated settings.
      if ((boostList.status_code ?? boostList.code) !== 0 || adInfos.filter(ad => String(ad.id) === String(assistTaskId)).length !== 1)
        rejectParameter('target_verification_failed', '追投归属不可核验，本次未写入', 423);
      if (task.assistTaskInfoMap?.['2']?.operation?.edit?.editable === false)
        rejectParameter('upstream_action_blocked', '千川当前不允许修改该追投', 423);
      let endpoint, change;
      if (hasDuration) {
        const { positiveInteger, readBoostDuration } = require('./boostDuration');
        const start = positiveInteger(task.startTime), end = positiveInteger(task.endTime);
        const current = readBoostDuration(task).duration_seconds;
        if (task.smartBidType == null || Number(task.smartBidType) !== 7)
          rejectParameter('duration_mode_not_supported', '仅支持有限期放量追投修改总时长', 423);
        if (start == null || end == null || current == null || end <= start)
          rejectParameter('duration_unavailable', '追投真实起止秒数不可核验，本次未写入', 423);
        if (current !== opts.expectedDurationSeconds)
          rejectParameter('duration_conflict', '追投总时长已变化，本次未写入', 409, {
            expected_duration_seconds: opts.expectedDurationSeconds, current_duration_seconds: current,
          });
        const endTime = start + opts.durationSeconds;
        if (!Number.isSafeInteger(endTime) || endTime <= Math.floor(Date.now() / 1000))
          rejectParameter('duration_end_in_past', '目标总时长对应的结束时间已过去，本次未写入');
        endpoint = 'batch_update_schedule_type';
        change = { AdId: String(assistTaskId), Schedule: { ScheduleType: 2, EndTime: endTime } };
      } else {
        const parsed = typeof budget === 'number' || (typeof budget === 'string' && budget.trim() !== '') ? Number(budget) : NaN;
        const micro = Math.round(parsed * 100000);
        if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isSafeInteger(micro) || micro <= 0)
          rejectParameter('invalid_budget', '预算必须为可表示的正数金额');
        assertExpectedBudget(Number(task.budget) / 100000);
        endpoint = 'batch_update_budget';
        change = { AdId: String(assistTaskId), AdBudget: micro };
      }
      const result = await enqueue(async () => {
        if (typeof opts.beforeWrite === 'function') await opts.beforeWrite();
        return requestAPI('POST', `/ad/api/pmc/v1/${endpoint}?aavid=${aavid}`, { ForceAsync: false, AdsData: [change] }, accountId);
      }, accountId);
      if ((result?.status_code ?? result?.code) !== 0) return result;
      const items = result.data?.results;
      const item = Array.isArray(items) && items.length === 1 ? items[0] : null;
      if (item?.status === 3) throw Object.assign(new Error(item.error?.errorMessage || '千川拒绝该追投参数修改'), {
        code: 'batch_update_rejected', statusCode: 409, upstream_rejected: true,
        details: { batch_status: item.status },
      });
      if (item?.status !== 2) return { ...result, confirmation_pending: true,
        confirmation_reason: item?.status === 1 ? 'upstream_batch_running' : 'upstream_batch_status_unknown' };
      return result;
    }

    // 从追投素材明细接口拉素材ID列表
    const d30 = new Date();
    d30.setDate(d30.getDate() - 30);
    const d30Str = d30.getFullYear() + '-' + String(d30.getMonth() + 1).padStart(2, '0') + '-' + String(d30.getDate()).padStart(2, '0');
    const matDetail = await fetchBoostMaterialDetail(assistTaskId, d30Str, todayStr, accountId).catch(() => null);
    const matRows = (matDetail && matDetail.data && matDetail.data.StatsData && matDetail.data.StatsData.Rows) || [];
    let mids = matRows.map(r => r.Dimensions && r.Dimensions.material_id ? String(r.Dimensions.material_id.Value) : null).filter(Boolean);

    if (mids.length === 0) {
      throw new Error('追投任务 ' + assistTaskId + ' 无关联素材，无法更新');
    }

    // 构建全量更新请求体
    // Audience 支持更新：若 opts.audienceTemplate / opts.audience 传入则用新定向，否则回传 task.audience
    let targetAudience = task.audience ? structuredClone(task.audience) : null;
    if (opts.audienceTemplate) {
      const { getTemplate } = require('./boostAudienceTemplates');
      const tpl = getTemplate(opts.audienceTemplate);
      if (!tpl) throw Object.assign(new Error('unknown_audience_template'), { code: 'unknown_audience_template', statusCode: 400 });
      targetAudience = structuredClone(tpl);
    } else if (opts.audience && typeof opts.audience === 'object') {
      targetAudience = structuredClone(opts.audience);
    }
    if (!targetAudience || Array.isArray(targetAudience) || !Object.keys(targetAudience).length) {
      throw Object.assign(new Error('target_audience_unavailable：整单更新缺少真实定向，不自动补成不限地区'), { code: 'target_audience_unavailable', statusCode: 423 });
    }
    if (task.smartBidType == null || !Number.isFinite(Number(task.smartBidType))) {
      throw Object.assign(new Error('target_bid_mode_unavailable'), { code: 'target_bid_mode_unavailable', statusCode: 423 });
    }
    // 改预算或出价不改变地域层级；模板中的 CityDivide=0 是有效省级配置。
    const deepAction = task.deepExternalAction;
    if (deepAction == null || (typeof deepAction !== 'number' && typeof deepAction !== 'string') ||
        String(deepAction).trim() === '' || !Number.isInteger(Number(deepAction)) || Number(deepAction) < 0) {
      throw Object.assign(new Error('target_optimization_unavailable：缺少真实优化目标，无法保真更新'), { code: 'target_optimization_unavailable', statusCode: 423 });
    }

    // 出价更新支持：若 opts.bid 传入则更新出价，否则用 task.bid
    const bidValue = opts.bid != null ? parseFloat(opts.bid) : (task.bid ? parseInt(task.bid) / 100000 : null);
    const isManualBid = Number(task.smartBidType) === 0 && bidValue > 0;
    // smartBidType=0 下既有订单出价也有ROI控成本；7为放量，不臆造ROI。
    if (Number(task.smartBidType) === 0 && !isManualBid && !((roiGoal ?? task.ecpRoi2Goal) > 0)) {
      throw Object.assign(new Error('target_bid_value_unavailable'), { code: 'target_bid_value_unavailable', statusCode: 423 });
    }

    // 预算 NaN 防护
    const parsedBudget = budget != null ? parseFloat(budget) : null;
    if (budget != null && isNaN(parsedBudget)) throw new Error('budget 不是有效数字: ' + budget);
    // ROI NaN 防护
    const parsedRoiGoal = roiGoal != null ? parseFloat(roiGoal) : null;
    if (roiGoal != null && isNaN(parsedRoiGoal)) throw new Error('roiGoal 不是有效数字: ' + roiGoal);
    const body = {
      MarGoal: 2,
      PrimaryAID: String(primaryAdId),
      AssistTaskID: String(assistTaskId),
      Scene: 2,
      SmartBidType: Number(task.smartBidType),
      Mids: mids,
      VideoLegoMids: mids,
      ExternalAction: task.externalAction || 169,
      DeepExternalAction: Number(deepAction),
      Budget: budget != null ? Math.round(parseFloat(budget) * 100000) : parseInt(task.budget),
      Name: task.name,
      Audience: targetAudience,
    };
    if (task.aggregateCids) {
      body.AggregateCids = task.aggregateCids;
    }

    // 出价模式不同，传不同字段
    if (isManualBid) {
      // 手动出价模式：传 Bid，不传 EcpRoi2Goal
      if (opts.bid != null) {
        body.Bid = Math.round(parseFloat(opts.bid) * 100000);
      } else if (task.bid) {
        body.Bid = parseInt(task.bid);
      }
    } else {
      // ROI出价模式：传 EcpRoi2Goal
      // roiGoal 未传时用任务当前值，当前值也没有则不传（避免清零）
      if (roiGoal != null) {
        body.EcpRoi2Goal = parseFloat(roiGoal);
      } else if (task.ecpRoi2Goal != null && !isNaN(parseFloat(task.ecpRoi2Goal))) {
        body.EcpRoi2Goal = parseFloat(task.ecpRoi2Goal);
      }
    }

    // 该全量更新接口会用这次读取到的整份任务数据回填未修改字段；
    // 在请求体构造完成、提交前核对本次读到的预算，避免覆盖读取时已变化的值。
    assertExpectedBudget(Number(task.budget) / 100000);

    const result = await enqueue(async () => {
      if (typeof opts.beforeWrite === 'function') await opts.beforeWrite();
      return requestAPI('POST', path, body, accountId);
    }, accountId);

    // 参数/素材校验失败原样返回；不得换出价、换定向或删素材后自动重试。

    return result;
  }

  // 非追投（全域计划本身）：
  // 改ROI走专用接口 update_uni_promotion_roi
  // 改预算走 batch_update_operation (optType=4)
  let finalBudget = budget != null ? parseFloat(budget) : undefined;
  let finalRoi = roiGoal != null ? parseFloat(roiGoal) : undefined;
  if (budget != null && isNaN(finalBudget)) throw new Error('budget 不是有效数字: ' + budget);
  if (roiGoal != null && isNaN(finalRoi)) throw new Error('roiGoal 不是有效数字: ' + roiGoal);

  const { GFVERSION: _gf } = require('./config');
  const verifyFp = 'verify_mqxv7d1m_24coEPxu_hgMm_4pg4_87gU_WuXGZh8qjfBE';
  const roiPath = `/ad/api/pmc/v1/uni-promotion/ad/update_uni_promotion_roi?aavid=${aavid}&gfversion=${_gf}&verifyFp=${verifyFp}&fp=${verifyFp}`;

  // 只改ROI：走全域专用ROI接口
  if (finalRoi !== undefined && finalBudget === undefined) {
    const body = {
      UpdateRoi2Infos: [{
        value: String(finalRoi),
        ID: String(primaryAdId),
        deepExternalAction: 576,  // 净成交ROI
        OverallROICostItems: []
      }]
    };
    return enqueue(() => requestAPI('POST', roiPath, body, accountId), accountId);
  }

  // 改预算（或同时改预算+ROI）：先改ROI（如有），再改预算
  if (finalBudget === undefined) {
    const current = await fetchPlanCurrentValues(primaryAdId, accountId);
    finalBudget = current.budget;
  }
  // 防御：预算为0或负数或NaN时拒绝操作（可能是拉取失败返回0），防止清零计划预算
  if (finalBudget !== undefined && (isNaN(finalBudget) || finalBudget <= 0)) {
    throw new Error('无法获取计划当前预算（返回0），拒绝操作以保护安全');
  }
  // 混合ROI+预算更新会先提交ROI；先核对一次预算，避免明显过期快照造成部分写入。
  if (opts.expectedBudget !== undefined) {
    const current = await fetchPlanCurrentValues(primaryAdId, accountId);
    assertExpectedBudget(current.budget);
  }
  let roiChanged = false;
  if (finalRoi !== undefined) {
    // 同时改预算+ROI：先调ROI接口
    const roiBody = {
      UpdateRoi2Infos: [{
        value: String(finalRoi),
        ID: String(primaryAdId),
        deepExternalAction: 576,
        OverallROICostItems: []
      }]
    };
    try {
      const roiResult = await enqueue(() => requestAPI('POST', roiPath, roiBody, accountId), accountId);
      // 千川业务拒绝（status_code 非 0，如 40002）也算失败，不能误判 roiChanged 继续改预算
      const roiSc = roiResult && (roiResult.status_code ?? roiResult.code);
      if (roiSc != null && roiSc !== 0) {
        throw new Error(`千川拒绝 code=${roiSc}${roiResult.message ? ' ' + roiResult.message : ''}`);
      }
      roiChanged = true;
    } catch (roiErr) {
      if (roiErr.message === 'cookie_expired') throw roiErr;
      // ROI改失败，预算还没改，直接抛错
      throw new Error(`ROI修改失败（预算未修改）: ${roiErr.message}`);
    }
  }

  // 预算写入前最后一次读取计划预算并与调用方快照核对，避免覆盖可观测到的并发修改。
  if (opts.expectedBudget !== undefined) {
    try {
      const current = await fetchPlanCurrentValues(primaryAdId, accountId);
      assertExpectedBudget(current.budget, { partialWrite: roiChanged });
    } catch (error) {
      if (!roiChanged || error.partial_effect) throw error;
      const partial = Object.assign(new Error('预算复核读取失败；ROI上游已接受但未回读核验，预算结果未知，请立即只读核验'), {
        code: 'budget_verification_failed_after_partial_write', statusCode: error.statusCode || 502,
        partial: true, effect_status: 'unconfirmed', upstream_accepted: true, advertising_writes: 1,
        cause: error, details: { expected_budget: opts.expectedBudget, requested_budget: budget,
          partial_effect: { roi_goal: 'upstream_accepted', budget: 'not_submitted' } },
        partial_effect: { roi_goal: 'upstream_accepted', budget: 'not_submitted' },
      });
      throw partial;
    }
  }

  const body = {
    UpdateBudgetInfos: [{
      ID: String(primaryAdId),
      AdId: String(primaryAdId),
      Value: Math.round(finalBudget * 100000),
      AdBudget: Math.round(finalBudget * 100000),
      DeliveryExtra: null
    }],
    AdsData: [{
      ID: String(primaryAdId),
      AdId: String(primaryAdId),
      Value: Math.round(finalBudget * 100000),
      AdBudget: Math.round(finalBudget * 100000),
      DeliveryExtra: null
    }],
    ForceAsync: false
  };
  try {
    const budgetResult = await enqueue(async () => {
      if (typeof opts.beforeWrite === 'function') await opts.beforeWrite();
      return requestAPI('POST', `/ad/api/data/v1/creation/batch_update_budget?aavid=${aavid}&gfversion=${_gf}&verifyFp=${verifyFp}&fp=${verifyFp}`, body, accountId);
    }, accountId);
    const budgetCode = budgetResult && (budgetResult.status_code ?? budgetResult.code);
    if (roiChanged && budgetCode != null && budgetCode !== 0) {
      const error = Object.assign(new Error(`预算被千川拒绝；ROI请求已被上游接受但未回读核验。预算错误 code=${budgetCode}${budgetResult.message ? ` ${budgetResult.message}` : ''}`), {
        code: 'budget_rejected_after_partial_write', statusCode: 409,
        partial: true, effect_status: 'unconfirmed', upstream_accepted: true, advertising_writes: 1,
        upstream_code: budgetCode, upstream_message: budgetResult.message || null,
        details: { requested_budget: budget, upstream_code: budgetCode, upstream_message: budgetResult.message || null,
          partial_effect: { roi_goal: 'upstream_accepted', budget: 'rejected' } },
        partial_effect: { roi_goal: 'upstream_accepted', budget: 'rejected' },
      });
      throw error;
    }
    if (roiChanged && budgetCode !== 0) {
      throw Object.assign(new Error('预算上游响应缺少状态码；ROI请求已被上游接受但未回读核验，预算结果未知，请立即只读核验'), {
        code: 'budget_submission_failed_after_partial_write', statusCode: 502,
        partial: true, effect_status: 'unconfirmed', upstream_accepted: true,
        upstream_code: 'missing_status_code',
        details: { requested_budget: budget, upstream_code: 'missing_status_code',
          partial_effect: { roi_goal: 'upstream_accepted', budget: 'unknown' } },
        partial_effect: { roi_goal: 'upstream_accepted', budget: 'unknown' },
      });
    }
    return budgetResult;
  } catch (budgetErr) {
    if (budgetErr.partial_effect) throw budgetErr;
    if (roiChanged) {
      // ROI仅有上游接受响应、尚未回读；预算提交失败后须明确保留部分/未知状态。
      throw Object.assign(new Error(`预算提交失败；ROI上游已接受但未回读核验，预算结果未知。请先只读核验：${budgetErr.message}`), {
        code: 'budget_submission_failed_after_partial_write', statusCode: budgetErr.statusCode || 502,
        partial: true, effect_status: 'unconfirmed', upstream_accepted: true,
        upstream_code: budgetErr.code || budgetErr.message,
        cause: budgetErr, details: { requested_budget: budget,
          upstream_code: budgetErr.code || budgetErr.message,
          partial_effect: { roi_goal: 'upstream_accepted', budget: 'unknown' } },
        partial_effect: { roi_goal: 'upstream_accepted', budget: 'unknown' },
      });
    }
    throw budgetErr;
  }
}

/**
 * 拉取追投任务当前预算和ROI（用于只改一个值时回填另一个）。
 * @param {string} primaryAdId - 主计划ID
 * @param {string} assistTaskId - 追投任务ID
 * @param {string} [accountId]
 * @returns {Promise<{budget: number, roiGoal: number}>}
 */
async function fetchBoostCurrentValues(primaryAdId, assistTaskId, accountId) {
  const aavid = resolveAavid(accountId);
  const today = new Date();
  const todayStr = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
  const d7 = new Date();
  d7.setDate(d7.getDate() - 7);
  const d7Str = d7.getFullYear() + '-' + String(d7.getMonth() + 1).padStart(2, '0') + '-' + String(d7.getDate()).padStart(2, '0');
  try {
    const { fetchBoostList } = require('./qianchuanTabs');
    const result = await fetchBoostList(primaryAdId, d7Str, todayStr, accountId, { includeAllStatus: true });
    const adInfos = (result && result.data && result.data.adInfos) || [];
    const task = adInfos.find(ad => String(ad.id) === String(assistTaskId));
    if (task) {
      return {
        budget: (parseFloat(task.budget) || 0) / 100000,  // 微转元
        roiGoal: parseFloat(task.ecpRoi2Goal) || 0,
      };
    }
  } catch (e) {
    console.log(`[fetchBoostCurrentValues] 拉取失败: ${e.message}`);
  }
  return { budget: 0, roiGoal: 0 };
}

/**
 * 拉取主计划当前预算和ROI（用于只改一个值时回填另一个）。
 * @param {string} primaryAdId - 主计划ID
 * @param {string} [accountId]
 * @returns {Promise<{budget: number, roiGoal: number}>}
 */
async function fetchPlanCurrentValues(primaryAdId, accountId) {
  const aavid = resolveAavid(accountId);
  try {
    const { fetchUniPromAdList } = require('./qianchuanTabs');
    const today = new Date();
    const todayStr = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
    // 双渠道合并查找：mg=2 推直播间 + mg=1 全域商品计划（2026-08-02 修复：商品卡计划查不到当前值→幅度校验拒绝一切调整）
    const [liveRes, productRes] = await Promise.all([
      fetchUniPromAdList(todayStr, todayStr, accountId).catch(() => null),
      fetchUniPromAdList(todayStr, todayStr, accountId, { marGoal: 1 }).catch(() => null),
    ]);
    const adInfos = [
      ...((liveRes && liveRes.data && liveRes.data.adInfos) || []),
      ...((productRes && productRes.data && productRes.data.adInfos) || []),
    ];
    const ad = adInfos.find(a => String(a.id) === String(primaryAdId));
    if (ad) {
      return {
        budget: (parseFloat(ad.budget) || 0) / 100000,  // 微转元
        roiGoal: ad.ecpRoi2Goal == null ? null : Number(ad.ecpRoi2Goal),
        status: ad.status == null ? null : Number(ad.status),
      };
    }
  } catch (e) {
    console.log(`[fetchPlanCurrentValues] 拉取失败: ${e.message}`);
  }
  return { budget: 0, roiGoal: 0 };
}

/**
 * 获取账户余额（千川通用钱包 + 小钱包 + 共享钱包）。
 * @param {string} [accountId] - 千川账号ID，不传则使用默认账号
 * @returns {Promise<object>} 余额信息
 *   - balanceInfos: { "1": {total, valid, frozen, advBalanceType}, ... }
 *   - advBalanceType: 1=千川通用钱包, 2=小钱包, 9=共享钱包
 *   - 金额单位：微（1元=100000微）
 */
async function getAccountBalance(accountId) {
  const aavid = resolveAavid(accountId);
  return enqueue(() => requestAPI('GET', `/ad/api/v1/account/finance/get-adv-balance?aavid=${aavid}`, null, accountId), accountId);
}

/**
 * 获取账户日预算。
 * @param {string} [accountId]
 * @returns {Promise<object>}
 */
async function getAccountDailyBudget(accountId) {
  const aavid = resolveAavid(accountId);
  return enqueue(() => requestAPI('GET', `/ad/api/v1/account/daily-budget/get-account-budget?aavid=${aavid}`, null, accountId), accountId);
}

/**
 * 直播诊断（POST /ad/api/data/v1/promotion/ad/live_diagnosis）。
 * 返回直播间投放诊断建议（流量/转化/人货场等维度）。
 * @param {object} body - 诊断请求体（通常含 ad_id / room_id 等）
 * @param {string} [accountId]
 * @returns {Promise<object>} 诊断结果
 */
async function getLiveDiagnosis(body, accountId) {
  const aavid = resolveAavid(accountId);
  return enqueue(() => requestAPI('POST', `/ad/api/data/v1/promotion/ad/live_diagnosis?aavid=${aavid}`, body, accountId), accountId);
}

/**
 * 首页统计（GET /ad/api/data/v1/home/get-recently-stat）。
 * 返回千川首页最近统计数据（消耗/ROI/成交等汇总）。
 * @param {string} [accountId]
 * @returns {Promise<object>} 首页统计
 */
async function getHomeStat(accountId) {
  const aavid = resolveAavid(accountId);
  return enqueue(() => requestAPI('GET', `/ad/api/data/v1/home/get-recently-stat?aavid=${aavid}`, null, accountId), accountId);
}

/**
 * 全域升级乘方查询（GET /ad/api/pmc/v1/ad/get_overall_marketing_upgrade_ad）。
 * 返回当前账号是否有全域计划可升级为乘方计划。
 * @param {string} [accountId]
 * @returns {Promise<object>} 升级乘方信息
 */
async function getUpgradeAd(accountId) {
  const aavid = resolveAavid(accountId);
  return enqueue(() => requestAPI('GET', `/ad/api/pmc/v1/ad/get_overall_marketing_upgrade_ad?aavid=${aavid}`, null, accountId), accountId);
}

/**
 * 删除全域投放计划下的素材（逆向自 set-opt 接口）。
 *
 * 千川前端删除素材走3步：
 *   1. 预检查 batch_get_uni_porm_material_delete_notice（检查能否删除）
 *   2. 埋点 send-opt-log（前端行为日志，非必须）
 *   3. 实际删除 set-opt（optType=delete）
 *
 * 本函数只做第3步（实际删除），预检查由路由层调用 checkMaterialDeleteNotice 完成。
 *
 * @param {string} adId - 全域计划ID（AggregateAID）
 * @param {string[]} legoMids - 素材ID列表（LegoMid）
 * @param {string[]} [vids] - 视频ID列表（Vids，与LegoMids对应）
 * @param {string} [accountId]
 * @returns {Promise<object>} 千川 API 响应
 */
async function deleteMaterial(adId, legoMids, vids, accountId) {
  const aavid = resolveAavid(accountId);
  const midList = Array.isArray(legoMids) ? legoMids.map(String) : [String(legoMids)];
  const vidList = vids ? (Array.isArray(vids) ? vids : [vids]) : [];

  const body = {
    optType: 'delete',
    params: {
      AdID: String(adId),
      Vids: vidList,
      LegoMids: midList,
      UseLegoMid: true,
    }
  };
  return enqueue(() => requestAPI('POST', `/ad/api/pmc/v1/uni-promotion/material/set-opt?aavid=${aavid}`, body, accountId), accountId);
}

/**
 * 预检查：素材能否删除（删除前的前置确认）。
 * 返回素材信息 + 是否可删除。投手需确认这个返回结果后才执行实际删除。
 *
 * @param {string} objectId - 主播ID（anchor_id）
 * @param {string[]} legoMids - 素材ID列表
 * @param {string} [accountId]
 * @returns {Promise<object>} 千川 API 响应（含 uniPormMaterialDeleteNoticeInfos）
 */
async function checkMaterialDeleteNotice(objectId, legoMids, accountId) {
  const aavid = resolveAavid(accountId);
  const midList = Array.isArray(legoMids) ? legoMids.map(String) : [String(legoMids)];
  const body = {
    objectID: String(objectId),
    objectType: 1,
    legoMidList: midList,
    materialType: 3,
    smartBidType: 0,
  };
  return enqueue(() => requestAPI('POST', `/ad/api/pmc/v1/batch_get_uni_porm_material_delete_notice?aavid=${aavid}`, body, accountId), accountId);
}

/**
 * 创建追投任务（逆向自 create-uni-prom-assist-task 接口）。
 *
 * 2026-07-14 抓包确认：
 *   - 控成本投放（SmartBidType=0）：需传 EcpRoi2Goal + ExternalAction + DeepExternalAction
 *   - 放量投放（SmartBidType=7）：不传 ROI，传 Duration（投放时长秒数）
 *   - Budget 单位：微（100元 = 10000000微）
 *   - 返回 data.id = 追投任务ID
 *
 * @param {object} opts
 * @param {string} opts.primaryAdId - 全域计划ID
 * @param {string[]} opts.mids - 素材ID列表（LegoMid）
 * @param {number} opts.budget - 预算（元，函数内转分）
 * @param {string} [opts.name] - 追投任务名称
 * @param {number} [opts.smartBidType=0] - 0=控成本, 7=放量
 * @param {number} [opts.ecpRoi2Goal] - ROI目标（控成本必填）
 * @param {number} [opts.externalAction=169] - 转化目标（169=直播间支付）
 * @param {number} [opts.deepExternalAction=576] - 深度目标（576=净成交ROI）
 * @param {number} [opts.duration] - 投放时长秒数（放量必填，如7200=2小时；商品卡 marGoal=1 控成本也必填，默认 3600）
 * @param {number} [opts.bid] - 手动出价（元/成交，仅直播间 marGoal=2 + smartBidType=0）。传了即出手动出价形态：
 *   Bid(元→微) + ExternalAction=169 + DeepExternalAction=0，不传 EcpRoi2Goal（2026-08-03 探针权威 body，
 *   见 references/boost-manual-bid-audience.md）。与 ecpRoi2Goal 互斥。
 * @param {object} [opts.audience] - 定向对象（⚠️ 必须 PascalCase，用 boostAudienceTemplates.getTemplate，禁回拷接口 camelCase）
 * @param {string[]} [opts.aggregateCids] - 主计划 aggregateCid 数组（权威 body 必传，route 层从 fetchUniPromAdList 取）
 * @param {string} [opts.guestShopId] - 店铺ID（权威 body 字段，route 层从 fetchBoostList 任务对象取）
 * @param {number} [opts.marGoal=2] - 营销目标：2=直播间成交（全域），1=商品卡（乘方/全域商品计划）。
  * 历史账户专用说明已从试用包移除。
 * @param {string} [accountId]
 * @returns {Promise<object>} 千川 API 响应（成功时 data.id = 追投任务ID）
 */
async function createBoostTask(opts, accountId) {
  if (!opts || !opts.primaryAdId) throw new Error('createBoostTask: primaryAdId 不能为空');
  // 历史账户专用说明已从试用包移除。
  // 与视频形态互斥（同传 3001「直播间画面和视频不支持同时选择」实测）
  const isLiveFeed = Array.isArray(opts.aggregateCids) && opts.aggregateCids.length > 0;
  if (!opts.assistTask && !isLiveFeed && (!opts.mids || !opts.mids.length)) throw new Error('createBoostTask: mids 不能为空（直播间画面形态改传 aggregateCids）');
  const parsedBudget = parseFloat(opts.budget);
  if (isNaN(parsedBudget)) throw new Error('createBoostTask: budget 不是有效数字');

  const aavid = resolveAavid(accountId);
  const smartBidType = opts.smartBidType != null ? opts.smartBidType : 0;

  const body = {
    MarGoal: opts.marGoal != null ? opts.marGoal : 2,
    PrimaryAID: String(opts.primaryAdId),
    Scene: 2,
    SmartBidType: smartBidType,
    Budget: Math.round(parsedBudget * 100000),  // 元转微
    Name: opts.name || `椿-追投_${new Date().toLocaleString('zh-CN', {hour12:false})}`,   // 历史账户专用说明已从试用包移除。
  };

  // 一键起量形态（2026-08-17 探针权威 body，references/qianchuan-assist-task-api.md）：
  // Scene=1 + InterfereType=1 + Duration，作用于主计划直播加速，无素材/ROI/出价/控成本维度（DeepExternalAction=0）
  if (opts.assistTask) {
    body.Scene = 1;
    body.InterfereType = 1;
    body.Duration = opts.duration || 7200;
    body.ExternalAction = opts.externalAction || 169;
    body.DeepExternalAction = 0;
    delete body.SmartBidType;
    delete body.Mids;
    delete body.VideoLegoMids;
    return enqueue(() => requestAPI('POST', `/ad/api/pmc/v1/uni-promotion/ad/create-uni-prom-assist-task?aavid=${aavid}`, body, accountId), accountId);
  }

  if (isLiveFeed) {
    body.AggregateCids = opts.aggregateCids.map(String);
    if (opts.guestShopId) body.GuestShopID = String(opts.guestShopId);
  } else {
    body.Mids = (opts.mids || []).map(String);
    body.VideoLegoMids = (opts.mids || []).map(String);
  }

  if (body.MarGoal === 1) {
    // 商品卡/推商品追投：官方页面仅放量形态（2026-07-30 抓包 references/qianchuan-chengfang-api.md §二十四——
    // 无 SmartBidType/EcpRoi2Goal/ExternalAction/DeepExternalAction，仅 Budget+Duration+Name）；
    // 控成本形状(SmartBidType=0+ROI目标)被千川 3026「素材追投任务 duration 必填」拒绝（2026-08-03 三轮实测）。
    delete body.SmartBidType;
    body.Duration = opts.duration || 86400;
  } else if (smartBidType === 0 && opts.bid != null) {
    // 手动出价（仅直播间 marGoal=2，2026-08-03 探针权威 body，references/boost-manual-bid-audience.md）：
    // Bid(元→微) + ExternalAction=169 + DeepExternalAction=0，不传 EcpRoi2Goal；
    // Audience 必须 PascalCase（接口返回是 camelCase，克隆禁回拷——模板见 boostAudienceTemplates）；
    // AggregateCids=主计划 aggregateCid、GuestShopID=店铺ID（权威 body 字段，route 层负责取值注入）。
    const parsedBid = parseFloat(opts.bid);
    if (isNaN(parsedBid) || parsedBid <= 0) throw new Error('createBoostTask: 手动出价模式必须传有效 bid（元/成交）');
    body.ExternalAction = opts.externalAction || 169;
    body.DeepExternalAction = 0;
    body.Bid = Math.round(parsedBid * 100000);
    if (opts.audience) body.Audience = opts.audience;
  } else if (smartBidType === 0) {
    // 控成本（仅直播间 marGoal=2）：需 ROI 目标 + 转化目标
    body.ExternalAction = opts.externalAction || 169;
    body.DeepExternalAction = opts.deepExternalAction || 576;
    const parsedRoi = parseFloat(opts.ecpRoi2Goal);
    if (isNaN(parsedRoi)) throw new Error('createBoostTask: 控成本模式必须传有效的 ecpRoi2Goal');
    body.EcpRoi2Goal = parsedRoi;
  } else {
    // 放量：需投放时长
    body.Duration = opts.duration || 7200;
  }

  return enqueue(() => requestAPI('POST', `/ad/api/pmc/v1/uni-promotion/ad/create-uni-prom-assist-task?aavid=${aavid}`, body, accountId), accountId);
}

/**
 * 追投调控额度查询（2026-07-29 探针逆向自 uni-prom/detail 页面）。
 * 接口：GET /ad/api/pmc/v1/uni-promotion/ad/get-assist-task-total-budget
 * 返回 budgetUpperLimit（今日调控总预算，微）+ assistTaskTotalBudgeDetails（按 scene 的在投占用/已删消耗），
 * 官方口径：当日剩余 = 每日总预算 − 在投任务占用预算 − 已暂停/已删除任务当天消耗。
 * @param {string} primaryAdId - 全域主计划ID（额度为直播间/计划维度）
 * @param {string} [accountId]
 * @param {object} [opts] - { scene=2（素材追投）, marGoal=2 }
 * @returns {Promise<{total,left,in_use,deleted_cost,current_budget,current_cost,raw}>} 金额均为元
 */
async function fetchBoostQuota(primaryAdId, accountId, opts = {}) {
  const aavid = resolveAavid(accountId);
  const verifyFp = 'verify_mqxv7d1m_24coEPxu_hgMm_4pg4_87gU_WuXGZh8qjfBE';
  const scene = opts.scene || 2;
  const marGoal = opts.marGoal || 2;
  const path = `/ad/api/pmc/v1/uni-promotion/ad/get-assist-task-total-budget?aavid=${aavid}`
    + `&PrimaryAID=${primaryAdId}&AssistTaskScene=${scene}&MarGoal=${marGoal}`
    + `&gfversion=${GFVERSION}&verifyFp=${verifyFp}&fp=${verifyFp}`;
  const j = await enqueue(() => requestAPI('GET', path, null, accountId), accountId);
  const d = j && j.data;
  if (!d || d.budgetUpperLimit == null) throw new Error('quota_unavailable');
  const micro = v => (+v || 0) / 100000;
  const details = Array.isArray(d.assistTaskTotalBudgeDetails) ? d.assistTaskTotalBudgeDetails : [];
  const sum = k => details.reduce((s, x) => s + micro(x[k]), 0);
  const total = micro(d.budgetUpperLimit);
  const inUse = sum('unfinishBudget');
  const deletedCost = sum('deleteCost');
  return {
    total: +total.toFixed(2),
    left: +Math.max(0, total - inUse - deletedCost).toFixed(2),
    in_use: +inUse.toFixed(2),
    deleted_cost: +deletedCost.toFixed(2),
    current_budget: +sum('currentBudget').toFixed(2),
    current_cost: +sum('currentCost').toFixed(2),
    raw: d,
  };
}

/**
 * 预检查：素材是否已在计划里（添加素材前防重复）。
 * 逆向自创意管理"从视频库添加"抽屉（2026-08-02 探针，references/qianchuan-add-material-api.md）。
 *
 * @param {string} adId - 全域计划ID（AggregateAID）
 * @param {string} productId - 商品ID
 * @param {string[]} videoIds - 视频ID列表（itemId，v0 开头的 vid）
 * @param {string} [accountId]
 * @returns {Promise<object>} { inUseMaterialMap: { [videoId]: boolean } }
 */
async function checkAdMaterialUsage(adId, productId, videoIds, accountId) {
  const aavid = resolveAavid(accountId);
  const vidList = Array.isArray(videoIds) ? videoIds.map(String) : [String(videoIds)];
  // 2026-08-11 探针实测：全域计划（productId=哨兵"2"）官方预检不带 productId；商品卡（真实商品ID）必须带
  const pid = String(productId || '');
  const productParam = pid === '2' ? '' : `productId=${encodeURIComponent(pid)}&`;
  const qs = `adId=${encodeURIComponent(String(adId))}&${productParam}materialObjectIds=${encodeURIComponent(vidList.join(','))}&aavid=${aavid}`;
  return enqueue(() => requestAPI('GET', `/ad/api/pmc/v1/uni-promotion/material/check-ad-material-usage?${qs}`, null, accountId), accountId);
}

/**
 * 给全域计划添加素材（逆向自 add-uni-prom-materials，2026-08-02 探针实测 status_code:0 + list-required 回读确认）。
 *
 * videoMaterial 单条结构（字段全部由 video-list 原始条目映射，签名 URL 有时效必须现拉现用）：
 *   { coverImage: { webUrl, webUri, width, height }, videoId, imageMode, materialID, productId, teaParams: { uri } }
 *
 * @param {string} adId - 全域计划ID（AggregateAID）
 * @param {string} productId - 商品ID
 * @param {object[]} videoMaterials - 上方结构的素材对象数组
 * @param {string} [accountId]
 * @returns {Promise<object>} 千川 API 响应
 */
async function addUniPromMaterials(adId, productId, videoMaterials, accountId) {
  const aavid = resolveAavid(accountId);
  const pid = String(productId);
  const videoMaterialsWithPid = videoMaterials.map(v => ({ ...v, productId: pid }));
  // 2026-08-11 探针实测（账户与计划 ID 已脱敏）：
  // 直播间计划(marGoal=2)用扁平结构 + productId="2"（计划商品位哨兵值）；
  // 历史账户专用说明已从试用包移除。
  const body = pid === '2'
    ? { aggregateAID: String(adId), proceduralCreative: { videoMaterial: videoMaterialsWithPid } }
    : {
        aggregateAID: String(adId),
        createMultiProductsCreative: [{
          productId: pid,
          createCreativeInfo: { proceduralCreative: { videoMaterial: videoMaterialsWithPid } },
        }],
      };
  return enqueue(() => requestAPI('POST', `/ad/api/pmc/v1/uni-promotion/material/add-uni-prom-materials?aavid=${aavid}`, body, accountId), accountId);
}

module.exports = {
  statQueryDirect,
  updateCampaignStatus,
  updateCampaignBudgetAndROI,
  fetchPlanCurrentValues,
  getAccountBalance,
  getAccountDailyBudget,
  getLiveDiagnosis,
  getHomeStat,
  getUpgradeAd,
  deleteMaterial,
  checkMaterialDeleteNotice,
  checkAdMaterialUsage,
  addUniPromMaterials,
  createBoostTask,
  deleteBoostTask,
  fetchBoostQuota,
  enqueue,
  postJSON,
  reportRateLimit,
  getQueueStatus,
  cancelAccountQueue,
  qcError,
  upstreamHttpError,
  requestAPI,
  createFlowControlTask,
  statQuery,
};
