/**
  * 历史账户专用说明已从试用包移除。
 *
 * 覆盖：
 *   1. 探针抓包日志：根 logs/probe_*.jsonl >7 天 或 单文件 >50MB 直接删
 *   2. 服务日志轮转：logs/server.out.log >10MB 轮转为 .1（保留最近 2 份）
 *   3. 探针浏览器 profile 缓存：3 个 profile 的 Cache/Code Cache/GPUCache 等（登录态 Cookies 保留）
 *   4. server-app/tmp 调试残留：已知调试文件模式防御性清理（bus 目录不动）
 *   5. 数据库备份：7 份保留策略已在 nightTasks.backupDatabase，此处兜底再扫一遍
 *
 * 调用：server.js 启动时跑一次 + 每日 04:00 定时（setInterval 挂载）
 * 幂等安全：只删明确模式的缓存/日志/临时文件，不碰数据文件
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..'); // server-app 上级 = skill 根
const SAPP = path.join(ROOT, 'server-app');
const DAY = 86400000;

function log(msg) { console.log(`[cleanup] ${msg}`); }

function cleanProbeLogs() {
  const logDir = path.join(ROOT, 'logs');
  if (!fs.existsSync(logDir)) return;
  const cutoff = Date.now() - 7 * DAY;
  let n = 0, freed = 0;
  for (const f of fs.readdirSync(logDir)) {
    if (!/^probe_.*\.jsonl$/.test(f)) continue;
    const p = path.join(logDir, f);
    try {
      const st = fs.statSync(p);
      if (st.mtimeMs < cutoff || st.size > 50 * 1024 * 1024) {
        freed += st.size;
        fs.unlinkSync(p);
        n++;
      }
    } catch {}
  }
  if (n) log(`探针日志清理 ${n} 个（释放 ${(freed / 1048576).toFixed(1)}MB）`);
}

function rotateServerLog() {
  const p = path.join(SAPP, 'logs', 'server.out.log');
  try {
    if (!fs.existsSync(p)) return;
    const size = fs.statSync(p).size;
    if (size <= 10 * 1024 * 1024) return;
    const p1 = p + '.1', p2 = p + '.2';
    if (fs.existsSync(p1)) {
      if (fs.existsSync(p2)) fs.unlinkSync(p2);
      fs.renameSync(p1, p2);
    }
    fs.renameSync(p, p1);
    log(`服务日志轮转（原 ${(size / 1048576).toFixed(1)}MB → .1）`);
  } catch (e) { log('日志轮转失败: ' + e.message); }
}

const PROFILE_CACHE_SUBS = ['Default/Cache', 'Default/Code Cache', 'Default/GPUCache', 'Default/Service Worker',
  'optimization_guide_model_store', 'component_crx_cache', 'GrShaderCache', 'WasmTtsEngine'];

function cleanProbeProfiles() {
  const profiles = [
    path.join(ROOT, 'cache', 'chrome-probe-profile'),
    path.join(SAPP, 'cache', 'chrome-probe-profile'),
    path.join(SAPP, 'cache', 'chrome-compass-profile'),
  ];
  let freed = 0;
  for (const prof of profiles) {
    for (const sub of PROFILE_CACHE_SUBS) {
      const p = path.join(prof, sub);
      try {
        if (fs.existsSync(p)) {
          const size = fs.statSync(p).size || 0;
          fs.rmSync(p, { recursive: true, force: true });
          freed += size;
        }
      } catch {}
    }
  }
  if (freed) log(`探针 profile 缓存清理（释放 ${(freed / 1048576).toFixed(1)}MB，登录态保留）`);
}

function cleanTmpDebris() {
  const tmpDir = path.join(SAPP, 'tmp');
  if (!fs.existsSync(tmpDir)) return;
  // 已知调试残留模式（bus 目录是会话通道，绝不动）
  const patterns = [/^async_refresh_.*\.txt$/, /^fast_path_.*\.txt$/, /^capture_.*\.json$/, /^capture_result\.json$/,
    /^claim_result\.json$/, /^crowd_probe.*\.json$/, /^chrome_doc.*/, /^chrome_tabs\.json$/, /^cdp_cap_doc\.txt$/, /^browsers_list\.json$/];
  let n = 0;
  for (const f of fs.readdirSync(tmpDir)) {
    if (patterns.some(r => r.test(f))) {
      try { fs.unlinkSync(path.join(tmpDir, f)); n++; } catch {}
    }
  }
  if (n) log(`tmp 调试残留清理 ${n} 个`);
}

function cleanBackups() {
  const bkDir = path.join(SAPP, 'backups');
  try {
    const files = fs.readdirSync(bkDir)
      .filter(f => /^material_history_\d{4}-\d{2}-\d{2}\.db$/.test(f))
      .sort().reverse();
    if (files.length > 7) {
      for (const old of files.slice(7)) fs.unlinkSync(path.join(bkDir, old));
      log(`备份清理 ${files.length - 7} 个（保留 7 份）`);
    }
  } catch (e) { log('备份清理失败: ' + e.message); }
}

function runCleanup() {
  try {
    cleanProbeLogs();
    rotateServerLog();
    cleanProbeProfiles();
    cleanTmpDebris();
    cleanBackups();
  } catch (e) {
    console.error('[cleanup] 异常:', e.message);
  }
}

module.exports = { runCleanup };

// 独立执行：node scripts/cleanup.js
if (require.main === module) runCleanup();
