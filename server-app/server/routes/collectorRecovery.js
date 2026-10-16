'use strict';

const { sendJSON, requireWriteAuth } = require('../lib/utils');
const { QIANCHUAN_ACCOUNTS } = require('../lib/config');
const {
  getCollectorHealth,
  getCollectorRoomHealth,
  recoverCollectorAccount,
} = require('../lib/liveCollector');
const { handleApiError } = require('../lib/handleApiError');

function publicWatch(watch) {
  if (!watch) return null;
  return {
    account_id: watch.accountId,
    room_id: watch.room?.room_id || watch.detectedRoomId || null,
    start_time: watch.room?.start_time || watch.detectedRoomStartTime || null,
    status: watch.status || null,
    is_live: watch.isLive === true,
    session_key: watch.session_key || null,
    live_checked_at: watch.liveCheckedAt || null,
    fetched_at: watch.fetchedAt || null,
    live_checked_age_ms: watch.live_checked_age_ms == null ? null : watch.live_checked_age_ms,
    age_ms: watch.age_ms == null ? null : watch.age_ms,
    data_valid: watch.dataValid === true,
    stale: watch.stale === true,
    status_stale: watch.status_stale === true,
    data_stale: watch.data_stale === true,
    collecting: watch.collecting === true,
    cookie_expired: watch.cookieExpired === true,
  };
}

function statusFor(code, ready) {
  if (ready) return 200;
  if (code === 'cookie_expired') return 401;
  if (code === 'rate_limited') return 429;
  if (code === 'upstream_locked') return 423;
  if (code === 'upstream_bad_request') return 400;
  if (code === 'upstream_unavailable') return 502;
  if (['live_room_required', 'live_room_not_found', 'live_session_ambiguous', 'live_session_changed'].includes(code)) return 409;
  if (['session_binding_required', 'invalid_room', 'live_session_invalid'].includes(code)) return 400;
  return 503;
}

function accountFrom(url) {
  const accountId = url.searchParams.get('account') || url.searchParams.get('accountId');
  if (!accountId) return { error: '需要 account 参数' };
  const account = (QIANCHUAN_ACCOUNTS || []).find(item => item.id === accountId);
  if (!account) return { error: `未知账号: ${accountId}` };
  return { accountId, account };
}

async function handleCollectorRecovery(req, res, url) {
  const selected = accountFrom(url);
  if (selected.error) {
    return sendJSON(res, {
      ok: false,
      ready: false,
      code: 'invalid_account',
      component: 'collector',
      retryable: false,
      restart_recommended: false,
      error: selected.error,
    }, 400);
  }

  const roomId = url.searchParams.has('room_id') ? url.searchParams.get('room_id') : undefined;
  const startTime = url.searchParams.has('start_time') ? url.searchParams.get('start_time') : undefined;
  if ((roomId !== undefined || startTime !== undefined) && (!roomId?.trim() || !startTime?.trim())) {
    return sendJSON(res, { ok: false, ready: false, code: 'session_binding_required', component: 'collector',
      retryable: false, restart_recommended: false, error: '指定恢复场次须同时传room_id和start_time' }, 400);
  }
  const selectedHealth = () => roomId
    ? getCollectorRoomHealth(selected.accountId, roomId, { startTime, signal: req.signal })
    : getCollectorHealth(selected.accountId);

  if (url.pathname === '/health/data') {
    let health;
    try { health = await selectedHealth(); }
    catch (error) { return handleApiError(res, error); }
    return sendJSON(res, {
      ok: health.ready,
      ready: health.ready,
      code: health.code,
      component: 'collector',
      state: health.state,
      retryable: health.retryable,
      restart_recommended: health.restart_recommended,
      account_id: selected.accountId,
      ...(roomId ? { room_id: roomId, start_time: startTime } : {}),
      account_name: selected.account.name,
      watch: publicWatch(health.watch),
      checked_at: new Date().toISOString(),
    }, statusFor(health.code, health.ready));
  }

  if (url.pathname === '/api/collector/recover') {
    if (req.method !== 'POST') {
      return sendJSON(res, {
        ok: false,
        code: 'method_not_allowed',
        component: 'collector',
        retryable: false,
        error: '仅支持 POST',
      }, 405);
    }
    if (!requireWriteAuth(req, res)) return;
    try {
      const result = await recoverCollectorAccount(selected.accountId, { force: true,
        ...(roomId ? { roomId, startTime, signal: req.signal } : {}) });
      const health = result.health || await selectedHealth();
      return sendJSON(res, {
        ok: health.ready === true,
        ready: health.ready === true,
        code: health.code,
        component: 'collector',
        state: health.state,
        retryable: health.retryable,
        restart_recommended: health.restart_recommended,
        action: result.action || 'collector_recollect',
        account_id: selected.accountId,
        ...(roomId ? { room_id: roomId, start_time: startTime } : {}),
        watch: publicWatch(result.watch || health.watch),
        recovered_at: new Date().toISOString(),
      }, statusFor(health.code, health.ready === true));
    } catch (error) {
      return handleApiError(res, error, { component: 'collector' });
    }
  }

  return sendJSON(res, { ok: false, code: 'not_found', error: '未知 collector 恢复接口' }, 404);
}

module.exports = handleCollectorRecovery;
module.exports.publicWatch = publicWatch;
module.exports.statusFor = statusFor;
