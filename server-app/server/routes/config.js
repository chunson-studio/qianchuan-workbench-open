const fs = require('fs');
const { sendJSON, readJsonBody, requireWriteAuth, checkBodyKeys } = require('../lib/utils');

/**
 * GET  /api/config                 — 读可调参数（manual_config 白名单）
 * POST /api/config { key, value, account?, room_id? } — 保存一项本地参数
 * POST /api/config { account, room_id, values: { target_roi, target_roi_basis } }
 *   — 原子保存房间目标与口径；不修改平台计划
 *
 * 白名单（其余 config 项一律不接受在线修改）：
 *   gmv_target_monthly     月度考核 GMV 目标（元），经营目标进度分母
 *   break_even_roi         保本 ROI（净口径）
 *   avg_order_price        客单价（阈值体系 P）
 *   live_start_date        开播日期(YYYY-MM-DD)，记录直播间启用时间
 */
const EDITABLE = {
  gmv_target_monthly: { type: 'number', min: 0, label: '月度考核GMV目标(元)' },
  break_even_roi: { type: 'number', min: 0.1, label: '保本ROI(净口径)' },
  target_roi: { type: 'number', min: 0.01, label: '目标ROI' },
  target_roi_basis: { type: 'string', pattern: '^(payment|platform_net_1h|final_settlement|chengfang_comprehensive|unknown)$', label: '目标ROI口径' },
  avg_order_price: { type: 'number', min: 0, label: '客单价(元)' },
  live_start_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', label: '开播日期(YYYY-MM-DD)' },
  system_launch_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', label: '系统上线日期(YYYY-MM-DD，价值看板锚点)' },
};
const { CONFIG_PATH: CONFIG_FILE } = require('../lib/config');
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
function validRoomBinding(account, roomId) {
  return !!account && typeof roomId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(roomId)
    && !['__proto__', 'prototype', 'constructor'].includes(roomId);
}

async function handleConfig(req, res, url) {
  const { manual_config } = require('../lib/config');

  if (req.method === 'GET') {
    const { getAccountParams } = require('../lib/api-helpers');
    const account = url.searchParams.get('account');
    const roomId = url.searchParams.get('room_id');
    if (roomId != null && !validRoomBinding(account, roomId))
      return sendJSON(res, { ok: false, error: '房间参数必须绑定合法 account 和 room_id' }, 400);
    let params;
    try { params = account ? getAccountParams(account, { roomId }) : null; }
    catch (error) { return sendJSON(res, { ok: false, error: error.message }, 400); }
    const out = {};
    for (const k of Object.keys(EDITABLE)) out[k] = manual_config[k] ?? null;
    return sendJSON(res, {
      ok: true,
      editable: Object.fromEntries(Object.entries(EDITABLE).map(([k, v]) => [k, v.label])),
      manual_config: out,
      account_params: params ? { account, room_id: roomId || null, ...params } : null,
    });
  }

  if (req.method !== 'POST') return sendJSON(res, { ok: false, error: 'Method Not Allowed' }, 405);
  if (!requireWriteAuth(req, res)) return;

  const { data, error } = await readJsonBody(req);
  if (error) return sendJSON(res, { ok: false, error: error.message }, error.status);
  // body 参数白名单（2026-08-11 backlog 检修）
  if (!data || typeof data !== 'object' || Array.isArray(data))
    return sendJSON(res, { ok: false, error: '配置请求必须为对象' }, 400);
  const bodyCheck = checkBodyKeys(data, ['key', 'value', 'values', 'account', 'room_id'], '/api/config');
  if (!bodyCheck.ok) return sendJSON(res, { ok: false, error: bodyCheck.error }, 400);

  const { key, value, account, room_id: roomId } = data || {};
  if (roomId != null && !validRoomBinding(account, roomId))
    return sendJSON(res, { ok: false, error: '房间参数必须绑定合法 account 和 room_id' }, 400);
  const grouped = hasOwn(data, 'values');
  if (grouped) {
    const values = data.values;
    if (!validRoomBinding(account, roomId) || hasOwn(data, 'key') || hasOwn(data, 'value')
      || !values || typeof values !== 'object' || Array.isArray(values)
      || Object.keys(values).length !== 2 || !hasOwn(values, 'target_roi') || !hasOwn(values, 'target_roi_basis')) {
      return sendJSON(res, { ok: false, code: 'invalid_room_target', error: 'values 仅用于同时保存指定房间的 target_roi 与 target_roi_basis' }, 400);
    }
    const target = values.target_roi;
    if (target === null ? values.target_roi_basis !== 'unknown'
      : typeof target !== 'number' || !Number.isFinite(target) || target < EDITABLE.target_roi.min || values.target_roi_basis === 'unknown') {
      return sendJSON(res, { ok: false, code: 'invalid_room_target', error: '目标 ROI 必须为正数并指定口径；清空目标时同时提交 null 与 unknown' }, 400);
    }
  }

  const updates = {};
  for (const [field, input] of Object.entries(grouped ? data.values : { [key]: value })) {
    const spec = EDITABLE[field];
    if (!spec) {
      return sendJSON(res, { ok: false, error: `不可编辑的 key: ${field}（白名单：${Object.keys(EDITABLE).join('/')}）` }, 400);
    }
    let v = input;
    if (grouped && field === 'target_roi' && input === null) {
      v = null;
    } else if (spec.type === 'number') {
      v = Number(input);
      if (!Number.isFinite(v) || v < (spec.min ?? 0)) {
        return sendJSON(res, { ok: false, error: `${field} 必须为 ≥${spec.min ?? 0} 的数字` }, 400);
      }
    } else if (spec.type === 'bool') {
      v = input === true || input === 'true' || input === 1 || input === '1';
    } else if (spec.type === 'string') {
      v = String(input == null ? '' : input);
      if (spec.pattern && !(new RegExp(spec.pattern).test(v))) {
        return sendJSON(res, { ok: false, error: `${field} 格式不正确（要求：${spec.label}）` }, 400);
      }
    }
    updates[field] = v;
  }

  // 按账号写入 account_config（如果传了 account），否则写全局 manual_config
  try {
    if (account) {
      // 账号白名单（2026-08-11 审查修复）：拼错账号会写进 account_config 产生幽灵配置
      try { require('../lib/api-helpers').validateAccount(account); } catch (e) {
        return sendJSON(res, { ok: false, error: e.message }, 400);
      }
    }
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (account) {
      if (!raw.account_config) raw.account_config = {};
      if (!raw.account_config[account]) raw.account_config[account] = {};
      let target = raw.account_config[account];
      if (roomId) target = (target.rooms ||= {})[roomId] ||= {};
      Object.assign(target, updates);
    } else {
      raw.manual_config = { ...(raw.manual_config || {}), ...updates };
    }
    require('../lib/api-helpers').writeJsonAtomic(CONFIG_FILE, raw);
    if (account) require('../lib/config').account_config[account] = raw.account_config[account];
    else Object.assign(manual_config, updates);
  } catch (e) {
    return sendJSON(res, { ok: false, error: `配置保存失败: ${e.message}` }, 500);
  }
  return sendJSON(res, { ok: true, ...(grouped ? { values: updates } : { key, value: updates[key] }),
    account: account || null, room_id: roomId || null, manual_config,
    account_params: account ? { account, room_id: roomId || null, ...require('../lib/api-helpers').getAccountParams(account, { roomId }) } : null });
}

module.exports = handleConfig;
