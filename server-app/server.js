process.env.TZ = 'Asia/Shanghai';
const http = require('http');
const fs = require('fs');
const path = require('path');

// 端口优先级：CLI --port > QC_PORT > PORT > config.json；非法值忽略，避免 crash
const cliPortArg = (process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1];
const rawPort = cliPortArg || process.env.QC_PORT || process.env.PORT;
if (rawPort) {
  const p = parseInt(rawPort, 10);
  if (Number.isInteger(p) && p >= 1024 && p <= 65535) {
    process.env.QC_PORT = String(p);
  } else {
    console.log(`[server] 忽略非法 QC_PORT="${rawPort}"，使用默认端口`);
    delete process.env.QC_PORT;
  }
}

const cliHostArg = (process.argv.find(a => a.startsWith('--host=')) || '').split('=')[1];
if (cliHostArg && !process.env.QC_HOST) process.env.QC_HOST = cliHostArg;

const { getLocalDateStr, formatDate } = require('./server/lib/utils');
const { PORT, HOST, CACHE_DIR, QIANCHUAN_ACCOUNTS, REPORTS_DIR, LOGS_DIR, CLEANUP_ENABLED } = require('./server/lib/config');
const setupRoutes = require('./server/routes');
const { isCookieProbablyValid, readCookie, readQcCookie } = require('./server/lib/cookie');
const { startBackfill } = require('./server/lib/backfillQueue');
const decisionLedger = require('./server/lib/decisionLedger');

const server = http.createServer(setupRoutes);
let shuttingDown = false;
let nightTasksRunning = false;
const backgroundTimers = new Set();
const backgroundWork = new Set();

// 统一管理本入口启动的定时任务；模块自己的采集器仍由各自 stop() 关闭。
function runBackground(callback) {
  if (shuttingDown) return;
  try {
    const result = callback();
    if (result && typeof result.then === 'function') {
      const work = Promise.resolve(result);
      backgroundWork.add(work);
      work.then(() => backgroundWork.delete(work), error => {
        backgroundWork.delete(work);
        console.error('[server] 后台任务失败:', error?.message || String(error));
      });
      return work;
    }
  } catch (error) { console.error('[server] 后台任务失败:', error?.message || String(error)); }
}
function backgroundTimeout(callback, delay) {
  if (shuttingDown) return;
  const timer = setTimeout(() => {
    backgroundTimers.delete(timer);
    runBackground(callback);
  }, delay);
  backgroundTimers.add(timer);
  timer.unref?.();
  return timer;
}
function backgroundInterval(callback, delay, { immediate = false } = {}) {
  if (shuttingDown) return;
  let inFlight = false;
  function tick() {
    if (shuttingDown || inFlight) return;
    inFlight = true;
    const work = runBackground(callback);
    if (work && typeof work.then === 'function') {
      work.then(() => { inFlight = false; }, () => { inFlight = false; });
    } else inFlight = false;
  }
  const timer = setInterval(tick, delay);
  backgroundTimers.add(timer);
  timer.unref?.();
  // 首次执行与后续周期共享同一在途状态，慢首轮也不会和下一轮重叠。
  if (immediate) tick();
  return timer;
}

// ===== 磁盘清理：防止缓存/报表无限增长 =====
const DAY = 24 * 60 * 60 * 1000;
const CACHE_FILE_MAX_AGE = 30 * DAY; // cache_*.json / overview_*.json
const TABS_MAX_AGE = 7 * DAY;        // qianchuan_tabs / live_board
const REPORTS_MAX_AGE = 30 * DAY;    // reports/<date>/
const LOGS_MAX_AGE = 7 * DAY;        // probe_records_*.jsonl
const QC_TABS_CACHE_DIR = path.join(CACHE_DIR, 'qianchuan_tabs');
const LIVE_BOARD_DIR = path.join(CACHE_DIR, 'live_board');

function cleanupOldFiles(dir, fileRe, maxAgeMs) {
  if (!fs.existsSync(dir)) return 0;
  let files;
  try { files = fs.readdirSync(dir); } catch { return 0; }
  const cutoff = Date.now() - maxAgeMs;
  let n = 0;
  for (const f of files) {
    if (!fileRe.test(f)) continue;
    const fp = path.join(dir, f);
    try { if (fs.statSync(fp).mtimeMs < cutoff) { fs.unlinkSync(fp); n++; } } catch { /* ignore */ }
  }
  return n;
}

function cleanupOldDirs(parentDir, maxAgeMs) {
  if (!fs.existsSync(parentDir)) return 0;
  let dirs;
  try { dirs = fs.readdirSync(parentDir); } catch { return 0; }
  const cutoff = Date.now() - maxAgeMs;
  let n = 0;
  for (const d of dirs) {
    const dp = path.join(parentDir, d);
    try {
      const st = fs.statSync(dp);
      if (st.isDirectory() && st.mtimeMs < cutoff) { fs.rmSync(dp, { recursive: true, force: true }); n++; }
    } catch { /* ignore */ }
  }
  return n;
}

function runCleanup() {
  if (!CLEANUP_ENABLED || shuttingDown) return;
  try {
    let n = 0;
    n += cleanupOldFiles(CACHE_DIR, /^cache_.*\.json$/, CACHE_FILE_MAX_AGE);
    n += cleanupOldFiles(CACHE_DIR, /^overview_.*\.json$/, CACHE_FILE_MAX_AGE);
    n += cleanupOldFiles(QC_TABS_CACHE_DIR, /\.json$/, TABS_MAX_AGE);
    n += cleanupOldFiles(LIVE_BOARD_DIR, /\.json$/, TABS_MAX_AGE);
    n += cleanupOldFiles(LOGS_DIR, /^probe_records_.*\.jsonl$/, LOGS_MAX_AGE);
    n += cleanupOldDirs(REPORTS_DIR, REPORTS_MAX_AGE);
    if (n > 0) console.log(`[cleanup] 已清理 ${n} 个过期文件/目录`);
  } catch (e) {
    console.error('[cleanup] 执行出错:', e.message);
  }
}

let audienceScheduler = null;
let liveCollector = null;
let liveNotifier = null;

server.listen(PORT, HOST, () => {
  if (shuttingDown) return;
  console.log(`✓ 千川数据服务启动: http://localhost:${PORT} (监听 ${HOST})`);
  console.log(`  Cookie: ${isCookieProbablyValid(readCookie()) ? '有效' : '无效'}`);
  if (process.env.QC_DISABLE_BACKGROUND === '1') {
    console.log('[server] QC_DISABLE_BACKGROUND=1：仅启动 HTTP 路由，跳过预热/调度/collector/notifier（隔离测试模式）');
    return;
  }

  // 2026-08-18 提速：启动后 3s 后台预热 dashboard 完整路径（追投/余额/计划慢数据），
  // 重启后用户首开作战室即命中热缓存，追投任务秒加载（原机制：fast 请求后才异步刷新，首开要等 40s+）
  backgroundTimeout(async () => {
    for (const acc of QIANCHUAN_ACCOUNTS) {
      if (shuttingDown) return;
      try {
        const accCookie = readQcCookie(acc.id);
        if (!isCookieProbablyValid(accCookie)) continue;
        await fetch(`http://127.0.0.1:${PORT}/api/live-dashboard?account=${acc.id}&full=1`, { signal: AbortSignal.timeout(60000) });
        console.log(`[dashboard-warmup] ${acc.id} 完整路径预热完成`);
      } catch (e) {
        console.log(`[dashboard-warmup] ${acc.id} 预热失败(不阻塞): ${e.message}`);
      }
    }
  }, 3000);

  // 日志、浏览器缓存与备份轮转也遵守同一个清理开关。
  if (CLEANUP_ENABLED) {
    try {
      const { runCleanup: cleanupRuntimeFiles } = require('./scripts/cleanup');
      cleanupRuntimeFiles();
      backgroundInterval(() => {
        const h = new Date();
        if (h.getHours() === 4 && h.getMinutes() < 5) cleanupRuntimeFiles();
      }, 3600000);
    } catch (e) { console.log('[cleanup] 挂载失败(不阻塞):', e.message); }
  }

  // 历史数据回填：每天晚上 23:00 执行一次，回填近30天（不含今天）
  // 千川日数据结算延迟大，需等到晚上22:30以后前一天数据才出全
  // 回填完成后自动执行夜间任务（日报 + AI复盘）
  function scheduleBackfill() {
    const { waitForCompletion } = require('./server/lib/backfillQueue');
    const { runNightTasks } = require('./server/lib/nightTasks');

    async function runBackfillAndNightTasks() {
      if (shuttingDown) return;
      const yesterday = formatDate(new Date(Date.now() - 24 * 60 * 60 * 1000));
      // 近30天缺失自查补：服务停机/重启漏掉的夜晚自动补回（千川T+1数据早已结算）。
      // 必须覆盖 30 天：自愈窗口若只有 7 天，停机超过一周就会产生永久空洞
      // （2026-06-18~07-12 整段漏采、素材 ROI 被低估导致 AI 误删素材的教训）
      const start = formatDate(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));

      // 1. 启动回填
      for (const acc of QIANCHUAN_ACCOUNTS) {
        if (shuttingDown) return;
        const accCookie = readQcCookie(acc.id);
        if (!isCookieProbablyValid(accCookie)) {
          console.log(`[backfill-scheduled] ${acc.id} cookie 无效，跳过`);
          continue;
        }
        console.log(`[backfill-scheduled] ${acc.id} 回填 ${start}~${yesterday}（不含今天）`);
        const progress = startBackfill(start, yesterday, acc.id);
        if (progress.done) {
          console.log(`[backfill-scheduled] ${acc.id} 无需回填（无缺失日期）`);
        } else if (progress.busy) {
          console.log(`[backfill-scheduled] ${acc.id} 已有回填任务在跑，跳过`);
        } else {
          console.log(`[backfill-scheduled] ${acc.id} 回填已启动，共 ${progress.total} 天`);
        }
      }

      // 2. 等待回填完成（最多10分钟），然后执行夜间任务
      for (const acc of QIANCHUAN_ACCOUNTS) {
        if (shuttingDown) return;
        try {
          await waitForCompletion(600000, acc.id);
          console.log(`[backfill-scheduled] ${acc.id} 回填完成`);
        } catch (e) {
          console.log(`[backfill-scheduled] ${acc.id} 等待回填超时: ${e.message}`);
        }
      }

      // 2.5 无条件重写昨天：昨天可能白天被预补过（未结算全），23:00 后数据已出全，
      // 整页 delete+insert 重写一次，保证决策用的永远是最终口径
      for (const acc of QIANCHUAN_ACCOUNTS) {
        if (shuttingDown) return;
        try {
          const accCookie = readQcCookie(acc.id);
          if (!isCookieProbablyValid(accCookie)) continue;
          const { fetchDate } = require('./server/lib/fetchDaily');
          const n = await fetchDate(yesterday, acc.id);
          console.log(`[backfill-scheduled] ${acc.id} 昨日 ${yesterday} 终值重写完成（${n} 条）`);
        } catch (e) {
          console.error(`[backfill-scheduled] ${acc.id} 昨日终值重写失败:`, e.message);
        }
      }

      // 3. 执行夜间任务：日报 + AI复盘（守卫防并发：与启动兜底互斥，2026-08-01 审计 P1）
      try {
        await runNightTasksGuarded(QIANCHUAN_ACCOUNTS);
      } catch (e) {
        console.error('[night-task] 夜间任务执行失败:', e.message);
      }
    }

    // 状态位属于进程入口，关闭流程也必须能读取它。
    async function runNightTasksGuarded(accounts) {
      if (shuttingDown) return;
      if (nightTasksRunning) { console.log('[night-task] 已有夜间任务在跑，跳过并发触发'); return; }
      nightTasksRunning = true;
      try { await runNightTasks(accounts); } finally { nightTasksRunning = false; }
    }

    // 计算到今天/明天 23:00 的毫秒数
    const now = new Date();
    const target = new Date(now);
    target.setHours(23, 0, 0, 0);
    let msToTarget = target.getTime() - now.getTime();
    if (msToTarget < 0) msToTarget += DAY; // 已过23点，排到明天

    console.log(`[backfill-scheduled] 首次回填将在 ${Math.round(msToTarget / 1000 / 60)} 分钟后执行（每天23:00，回填后自动执行夜间任务）`);

    // 启动兜底：开机 90 秒后补采近30天缺失日期，含昨天（开机时刻"昨天"必已在前日22:30结算完毕，采到即终值）。
    // 覆盖"每晚23:00前关机"作息：23:00 夜间回填/重写跑不到时，靠开机兜底补齐，不再依赖首次查询触发。
    backgroundTimeout(() => {
      return (async () => {
        try {
          const yesterday = formatDate(new Date(Date.now() - 24 * 60 * 60 * 1000));
          const healStart = formatDate(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
          for (const acc of QIANCHUAN_ACCOUNTS) {
            if (shuttingDown) return;
            const accCookie = readQcCookie(acc.id);
            if (!isCookieProbablyValid(accCookie)) continue;
            const progress = startBackfill(healStart, yesterday, acc.id);
            if (!progress.done && !progress.busy) {
              console.log(`[backfill-startup] ${acc.id} 启动补采 ${healStart}~${yesterday}，共 ${progress.total} 天`);
            }
          }
          // 启动补跑夜间任务：昨夜 23:00 机器已关机时，备份/日报/复盘会永久缺席（每晚22点关机作息下天天缺席）。
          // 以昨日备份文件为"夜间任务已跑"标记；nightTasks 各组件幂等——备份/复盘按日期文件跳过，日报/缓存/胜率统计覆盖写，对账重跑仅多一行日志。
          const backupMark = require('path').join(__dirname, 'backups', `material_history_${yesterday}.db`);
          if (!require('fs').existsSync(backupMark)) {
            for (const acc of QIANCHUAN_ACCOUNTS) {
              if (shuttingDown) return;
              try { await waitForCompletion(600000, acc.id); } catch (e) { /* 回填超时也继续补跑 */ }
            }
            if (shuttingDown) return;
            console.log('[night-task] 启动补跑（昨夜 23:00 机器已关机）');
            try {
              await runNightTasksGuarded(QIANCHUAN_ACCOUNTS);
            } catch (e) {
              console.error('[night-task] 启动补跑失败:', e.message);
            }
          }
        } catch (e) { console.error('[backfill-startup] 启动补采异常:', e.message); }
      })();
    }, 90 * 1000);

    // 历史账户专用说明已从试用包移除。
    // （PM2 日志实证 2026-08-06 22:51→08:12 空白，8-06 数据漏回填）。
    // 每 60 秒检查"昨天的夜间任务是否已跑"（backups 备份文件为标记），缺则补跑——睡眠唤醒后 60 秒内自动补上。
    // 幂等：备份文件存在即跳过；并发守卫：backfillQueue busy + nightTasksRunning 防重入。
    backgroundInterval(() => {
      return (async () => {
        try {
          const yesterday = formatDate(new Date(Date.now() - 24 * 60 * 60 * 1000));
          const backupMark = require('path').join(__dirname, 'backups', `material_history_${yesterday}.db`);
          if (require('fs').existsSync(backupMark)) return; // 已跑过（含 23:00 正常调度/开机兜底），跳过
          const { getProgress } = require('./server/lib/backfillQueue');
          const anyActive = (QIANCHUAN_ACCOUNTS || []).some(acc => {
            const p = getProgress(acc.id);
            return p && p.active === true;
          });
          if (anyActive || nightTasksRunning) return; // 回填/夜间任务在跑，等下一轮
          console.log(`[backfill-wakeup] 检测到昨日 ${yesterday} 夜间任务缺失（睡眠/停机跨过23:00），补跑回填+夜间任务`);
          await runBackfillAndNightTasks();
        } catch (e) {
          console.error(`[backfill-wakeup] 补跑异常（下轮重试）: ${e.message}`);
        }
      })();
    }, 60 * 1000);

    // 每 30 分钟补齐到期轮次的同场前后事实；不打分、不提炼成功经验。
    backgroundTimeout(() => {
      const runEval = () => {
        try {
          const { evaluatePendingDecisions } = require(path.join(__dirname, 'scripts', 'evaluate_decisions'));
          return evaluatePendingDecisions()
            .then(count => {
              if (count > 0) {
                console.log(`[decision-evidence] 补齐 ${count} 条前后事实记录（不评分、不作因果归因）`);
              }
            })
            .catch(e => console.error('[evaluate-decisions] 后验评估异常:', e.message));
        } catch (e) { console.error('[evaluate-decisions] 脚本引入异常:', e.message); }
      };
      backgroundInterval(runEval, 30 * 60 * 1000, { immediate: true });
    }, 15 * 1000);

    backgroundTimeout(() => {
      backgroundInterval(() => runBackfillAndNightTasks(), DAY, { immediate: true });
    }, msToTarget);
  }
  scheduleBackfill();

  // pending-ops 静默自动执行巡检：delete_material 建议带 auto_execute 时，1小时未处理且复核仍触线→自动删除
  const pendingOps = require('./server/routes/pendingOps');
  backgroundInterval(() => pendingOps.sweepOnce(), 60 * 1000);

  // 开播事件通知直接挂在 HTTP 进程内：单例 timer + in-flight 保护，随 shutdown 停止。
  // 不再 detached/unref 生成无法回收的 watcher 子进程。
  try {
    const { startWatcher } = require('./scripts/notify_agent_on_live');
    liveNotifier = startWatcher({ port: PORT, intervalMs: 30000, timeoutMs: 5000 });
    console.log('[live-notify] 开播事件监听已挂入 HTTP 进程（单例）');
  } catch (e) {
    console.error('[live-notify] 启动失败（不影响主服务）:', e.message);
  }

  // 磁盘清理默认关闭（本地项目通常想长期保留历史）。
  // 在 config.json 设 "cleanup_enabled": true 才启用。
  if (CLEANUP_ENABLED) {
    runCleanup();
    backgroundInterval(runCleanup, DAY);
  } else {
    console.log('[cleanup] 已禁用（config.cleanup_enabled=false），历史缓存/报表将保留');
  }

  // audienceScheduler 已关闭：批量人群画像对实时操盘无价值，需要看单条素材人群时用 /api/material-report 按需拉取
  // try {
  //   const { startAudienceScheduler } = require('./server/lib/audienceScheduler');
  //   audienceScheduler = startAudienceScheduler();
  //   console.log('[audienceScheduler] 已启动');
  // } catch (e) {
  //   console.error('[audienceScheduler] 启动失败:', e.message);
  // }

  // 直播采集调度器：按 SCHEDULER.statusIntervalMs 检测直播状态，在播才采、下播补采终值。
  // 融入 server，复用 liveBoard.fetchLiveBoard（字段映射已验证正确），不再依赖独立常驻进程。
  try {
    const { startLiveCollector } = require('./server/lib/liveCollector');
    liveCollector = startLiveCollector();
  } catch (e) {
    console.error('[liveCollector] 启动失败:', e.message);
  }
});

// 端口占用等启动错误处理
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[server] 端口 ${PORT} 已被占用，请先关闭已运行的服务再启动。`);
  } else {
    console.error('[server] 启动失败:', err.message);
  }
  process.exit(1);
});

// 优雅关闭：停止调度、关闭 HTTP 服务，并释放本进程缓存的 CDP 连接。
function closeLocalStores() {
  try { decisionLedger.closeAll(); } catch (e) { console.error('[server] decision ledger close error:', e.message); }
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] 收到 ${signal}，正在优雅关闭...`);
  for (const timer of backgroundTimers) { clearTimeout(timer); clearInterval(timer); }
  backgroundTimers.clear();
  if (audienceScheduler && typeof audienceScheduler.stop === 'function') {
    try { audienceScheduler.stop(); } catch (e) { console.error('[server] scheduler stop error:', e.message); }
  }
  if (liveCollector && typeof liveCollector.stop === 'function') {
    try { liveCollector.stop(); } catch (e) { console.error('[server] liveCollector stop error:', e.message); }
  }
  if (liveNotifier && typeof liveNotifier.stop === 'function') {
    try { liveNotifier.stop(); } catch (e) { console.error('[server] liveNotifier stop error:', e.message); }
  }

  let progressErrorReported = false;
  function hasActiveWork() {
    if (nightTasksRunning || backgroundWork.size) return true;
    try {
      const { getProgress } = require('./server/lib/backfillQueue');
      return QIANCHUAN_ACCOUNTS.some(acc => getProgress(acc.id)?.active === true);
    } catch (error) {
      if (!progressErrorReported) console.error('[server] 回填状态未核验，保留退出宽限期:', error.message);
      progressErrorReported = true;
      return true;
    }
  }
  const graceMs = hasActiveWork() ? 15000 : 5000;
  let httpClosed = false, finished = false, pollTimer, deadlineTimer;
  function finish() {
    if (finished) return;
    finished = true;
    clearInterval(pollTimer); clearTimeout(deadlineTimer);
    closeLocalStores();
    process.exit(0);
  }
  function checkFinished() { if (httpClosed && !hasActiveWork()) finish(); }
  // 先停止接收新请求，等待已开始的请求和后台工作结束。
  server.close(() => {
    Promise.resolve(require('./server/routes/browserBoost').service.close())
      .catch(error => console.error('[server] browser transport close error:', error.message))
      .finally(() => { httpClosed = true; checkFinished(); });
  });
  if (!finished) {
    console.log(`[server] 等待已开始的任务与 HTTP 请求结束，最多 ${graceMs / 1000} 秒`);
    pollTimer = setInterval(checkFinished, 100);
    pollTimer.unref?.();
    deadlineTimer = setTimeout(() => {
      console.error('[server] 退出宽限期已到；未完成工作的结果须在下次启动后核验');
      finish();
    }, graceMs);
    // 保持宽限期存活，避免只剩未决 Promise 时 Node 提前自然退出。
  }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// 全局兜底（2026-08-01 审计 P0 修正取舍）：uncaughtException 后进程状态不可信（Node 官方铁律）——
// 原"仅记录不退出"会让损坏的堆栈继续写库（数据错乱）且废掉 pm2 崩溃自愈。改为记录后退出，由 pm2 拉起干净实例。
// unhandledRejection 多数不致命（限频/单请求失败），保持记录不退出。
process.on('uncaughtException', (err) => {
  const msg = `[${new Date().toISOString()}] [uncaughtException] ${err && err.stack ? err.stack : err}\n`;
  console.error(msg);
  // 写崩溃日志到独立文件，方便定位间歇自停根因
  try {
    const crashLog = require('path').join(__dirname, 'logs', 'crash.log');
    require('fs').mkdirSync(require('path').join(__dirname, 'logs'), { recursive: true });
    require('fs').appendFileSync(crashLog, msg);
  } catch { /* 日志写不进去不阻塞退出 */ }
  setTimeout(() => process.exit(1), 500).unref(); // 给日志 flush 半秒
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason && reason.stack ? reason.stack : reason);
});
