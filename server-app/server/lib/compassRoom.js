'use strict';

// 罗盘 Cookie 可能只覆盖同广告户中的一个店铺。先核验目标房间及开播时间，再取经营数据。
const cache = new Map();
const flights = new Map();
const REQUIRED = ['five', 'portrait', 'flow', 'distribution'];
function failure(code, message, statusCode = 409) {
  return Object.assign(new Error(message), { code, statusCode, component: 'compass', retryable: false });
}
function sessionMs(value) {
  const text = String(value || '').replace(' ', 'T');
  return Date.parse(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/.test(text) ? text + '+08:00' : text);
}
function compassError(error) {
  if (error?.code && !String(error.code).startsWith('compass_')) return error;
  const code = error?.code || error?.message;
  const messages = {
    compass_cookie_missing: '此直播间尚未接入罗盘登录文件',
    compass_cookie_expired: '罗盘登录状态已失效，请在本机更新此房间的罗盘 Cookie',
    compass_access_denied: '罗盘拒绝访问；请核对店铺权限，不等同于 Cookie 过期',
    compass_verification_required: '罗盘要求本人在官方网页完成验证',
    compass_request_timeout: '罗盘读取超时，请稍后重试',
  };
  if (!messages[code]) return error;
  const e = failure(code, messages[code], code === 'compass_cookie_expired' ? 401 : code === 'compass_request_timeout' ? 504 : 403);
  e.retryable = code === 'compass_request_timeout';
  return e;
}
async function readRoomScreen(accountId, roomId, options = {}) {
  require('./api-helpers').validateAccount(accountId);
  if (!/^\d{5,30}$/.test(String(roomId || ''))) throw failure('live_room_required', '读取罗盘必须显式指定 room_id', 400);
  if (!Number.isFinite(sessionMs(options.startTime))) throw failure('live_session_required', '读取罗盘必须显式指定 start_time', 400);
  const status = await require('./qianchuanTabs').fetchLiveStatus(accountId, { signal: AbortSignal.timeout(25000), priority: 1 });
  const room = require('./liveRoomContext').selectLiveRoom(status, roomId, options.startTime);
  const key = JSON.stringify([accountId, String(roomId), room.startTime]);
  const hit = cache.get(key);
  if (!options.fresh && hit && Date.now() - hit.at < 30000) return { ...hit.value, cached: true };
  if (flights.has(key)) return flights.get(key);
  const flight = (async () => {
    const direct = require('./compassDirect');
    const checkedAt = new Date().toISOString();
    const result = await direct.fetchCompassDirect(accountId,
      `/compass_api/shop/live/live_screen/live_base_info?room_id=${roomId}`, { roomId });
    if (result.st !== 0) throw failure('compass_room_forbidden', '此罗盘登录态无权读取指定直播间，请导入该店铺的罗盘 Cookie', 403);
    const base = result.data;
    if (!base || base.is_self !== true || Number(base.live_start_ts) * 1000 !== sessionMs(room.startTime)) {
      throw failure('compass_session_mismatch', '罗盘店铺或开播时间与所选场次不一致，本轮数据未展示');
    }
    if (base.live_status !== 2) throw failure('compass_live_ended', '罗盘已显示本场结束，请重新核对直播状态');
    const data = await require('./compassScreen').fetchScreenLive(accountId, roomId);
    const missing = REQUIRED.filter(k => !data.component_times?.[k]?.data_valid);
    if (!data.five?.length && !missing.includes('five')) missing.push('five');
    const value = { ok: true, live: true, account: accountId, account_id: accountId, room_id: String(roomId),
      room: { room_id: String(roomId), start_time: room.startTime, name: base.nickname || null },
      session_key: `${accountId}|${roomId}|${room.startTime}`, source: 'compass_live_screen',
      binding: { verified: true, source: 'qianchuan_live_status_and_compass_live_base_info', checked_at: checkedAt },
      ...data, cached: false, partial: missing.length > 0 || Object.keys(data.errors || {}).length > 0,
      data_valid: missing.length === 0, missing_components: missing,
      platform_time: base.server_cur_ts ? new Date(base.server_cur_ts * 1000).toISOString() : null };
    cache.set(key, { at: Date.now(), value });
    while (cache.size > 100) cache.delete(cache.keys().next().value);
    return value;
  })().catch(e => { cache.delete(key); throw compassError(e); }).finally(() => flights.delete(key));
  flights.set(key, flight);
  return flight;
}

module.exports = { readRoomScreen };
