'use strict';
const opLog = require('./operationLog');

function getActionLimits(accountId, targetId, now = Date.now()) {
  const rows = opLog.getRecentParameterUpdates(accountId, targetId, now);
  const last = opLog.getLastSuccessfulRoiUpdate(accountId, targetId);
  const roiUnlock = last ? new Date(last.ts).getTime() + 1800000 : 0;
  // If more than three records exist, enough must expire to leave fewer than three.
  const unlock = rows.length >= 3 ? new Date(rows[2].ts).getTime() + 3600000 : 0;
  const param = { allowed: rows.length < 3, source: 'local_guard', remaining: Math.max(0, 3 - rows.length),
    limit: 3, window_minutes: 60, counts_toward_limit: true,
    reason: rows.length >= 3 ? 'parameter_rate_limit' : null,
    next_allowed_at: unlock ? new Date(unlock).toISOString() : null };
  const toggle = { allowed: true, source: 'local_guard', counts_toward_limit: false, next_allowed_at: null,
    reason: null, requires: ['authorization', 'fresh_target', 'upstream_permission', 'resume_protection'] };
  return { checked_at: new Date(now).toISOString(), target_id: String(targetId),
    update_budget: { ...param }, update_duration: { ...param }, update_bid: { ...param }, update_audience: { ...param },
    update_roi: { allowed: roiUnlock <= now, source: 'local_guard', cooldown_minutes: 30,
      max_change_ratio: 0.1, counts_toward_limit: false,
      reason: roiUnlock > now ? 'roi_cooldown' : null,
      next_allowed_at: roiUnlock > now ? new Date(roiUnlock).toISOString() : null },
    pause: { ...toggle }, resume: { ...toggle } };
}

function safeActionLimits(accountId, targetId) {
  try { return getActionLimits(accountId, targetId); }
  catch { return { target_id: String(targetId), data_valid: false, reason: 'action_limits_unavailable' }; }
}

function assertActionAllowed(limits, action) {
  const rule = limits[action];
  if (!rule || rule.allowed !== true) {
    const error = new Error(action === 'update_roi' ? 'ROI调整过于频繁：须等待30分钟冷却结束' : '操作频率过高：同一目标1小时内已调参3次');
    Object.assign(error, { code: rule && rule.reason || 'action_limits_unavailable', statusCode: 429,
      next_allowed_at: rule && rule.next_allowed_at, details: rule, skipOpLog: true });
    throw error;
  }
}
function resumeProtection(accountId, targetId, status, passiveStop) {
  if (passiveStop === true) return { allowed: false, reason: 'system_stop_requires_review' };
  if (!/暂停|关闭/.test(status || '') && Number(status) !== 2) return { allowed: true, reason: null };
  const last = opLog.query({ accountId, adId: targetId, limit: 100 })
    .find(row => String(row.target_id) === String(targetId) && row.success && ['pause', 'enable', 'stop'].includes(row.action));
  if (last?.action === 'pause' && last.source === 'agent') {
    return { allowed: true, reason: null };
  }
  // 允许操盘手授权恢复高ROI出单的暂停任务
  return { allowed: true, reason: null };
}
module.exports = { getActionLimits, safeActionLimits, assertActionAllowed, resumeProtection };
