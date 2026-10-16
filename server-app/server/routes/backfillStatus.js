const fs = require('fs');
const path = require('path');
const { sendJSON } = require('../lib/utils');
const { QIANCHUAN_ACCOUNTS } = require('../lib/config');

const LOGS_DIR = path.join(__dirname, '..', '..', 'logs');

// 读日志尾部（最多 tailBytes），返回按行数组（倒序：最新在前）
function readLogTail(file, tailBytes = 48 * 1024, maxLines = 15) {
  try {
    const fp = path.join(LOGS_DIR, file);
    if (!fs.existsSync(fp)) return { lines: [], mtime: null };
    const st = fs.statSync(fp);
    const start = Math.max(0, st.size - tailBytes);
    const fd = fs.openSync(fp, 'r');
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    const lines = buf.toString('utf-8')
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(Boolean)
      .slice(-maxLines)
      .reverse();
    return { lines, mtime: st.mtimeMs };
  } catch (e) {
    return { lines: [], mtime: null };
  }
}

/**
 * GET /api/backfill-status[?account=xxx]
 *
 * 回填监控独立只读端点（系统记录页用，此前只有 /api/data 触发回填时才附带进度）。
 * 返回：{ ok, accounts: [{ account, account_name, active, busy?, completed, total, current, done,
 *                          log_tail: [最近日志行，最新在前], log_mtime }] }
 */
function handleBackfillStatus(req, res, url) {
  if (req.method !== 'GET') return sendJSON(res, { ok: false, error: 'Method Not Allowed' }, 405);
  try {
    const { getProgress } = require('../lib/backfillQueue');
    const { getLatestReconcile } = require('../lib/reconcile');
    const only = url.searchParams.get('account') || url.searchParams.get('accountId') || null;
    const list = (QIANCHUAN_ACCOUNTS || []).filter(a => !only || a.id === only);
    const accounts = list.map(a => {
      let progress = { active: false, completed: 0, total: 0, done: true };
      try { progress = getProgress(a.id); } catch (e) { /* 队列不可用时给零值 */ }
      const { lines, mtime } = readLogTail(`rebackfill_${a.id}.log`);
      return {
        account: a.id,
        account_name: a.name,
        active: !!progress.active,
        busy: !!progress.busy,
        completed: progress.completed || 0,
        total: progress.total || 0,
        current: progress.current || null,
        done: progress.done !== false && !progress.active,
        reconcile: getLatestReconcile(a.id),
        log_tail: lines,
        log_mtime: mtime,
      };
    });
    return sendJSON(res, { ok: true, accounts, reconcile_threshold: 0.05 });
  } catch (e) {
    console.error('[backfill-status] 异常:', e.message);
    return sendJSON(res, { ok: false, error: 'internal_server_error' }, 500);
  }
}

module.exports = handleBackfillStatus;
