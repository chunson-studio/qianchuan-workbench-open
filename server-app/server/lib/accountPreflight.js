'use strict';

const { QIANCHUAN_ACCOUNTS } = require('./config');
const { enqueue, requestAPI } = require('./qianchuan');
const { fetchLiveStatus } = require('./qianchuanTabs');
const { fetchLivePlanList } = require('./chengfangLive');
const { extractCandidates } = require('./accountDiscovery');
const { extractPlans } = require('./accountOnboarding');
const { getLocalDateStr } = require('./utils');

function capability(state, reason, extra = {}) {
  return { state, reason, ...extra };
}

function findFirstId(value, keys, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return '';
  seen.add(value);
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'number' && !Number.isSafeInteger(candidate)) continue;
    if (candidate != null && /^\d{5,30}$/.test(String(candidate))) return String(candidate);
  }
  for (const child of Object.values(value)) {
    const found = findFirstId(child, keys, seen);
    if (found) return found;
  }
  return '';
}

function outcome(result, unavailableReason) {
  if (result.status === 'fulfilled' && result.value?.ok !== false && Number(result.value?.status_code ?? result.value?.code ?? 0) === 0) return capability('available', '只读验证通过');
  const error = result.reason || {};
  return capability('unavailable', unavailableReason, { code: /^[a-z_]{1,64}$/.test(error.code || '') ? error.code : 'preflight_failed' });
}

async function preflightAccount(accountId, options = {}) {
  const account = (QIANCHUAN_ACCOUNTS || []).find(value => value.id === accountId);
  if (!account) {
    const error = new Error(`账号 ${accountId} 不在可用列表中`);
    error.code = 'account_not_found'; error.statusCode = 404; throw error;
  }
  const invoke = options.invoke || {
    identity: () => enqueue(() => requestAPI('GET', `/ad/api/v1/account/user/info?aavid=${encodeURIComponent(account.aavid)}`, null, accountId), accountId, { label: 'preflight_identity', timeoutMs: 20000 }),
    live_status: () => fetchLiveStatus(accountId),
    material_read: () => enqueue(() => requestAPI('GET', `/ad/api/data/v1/material/get_material_source_list?aavid=${encodeURIComponent(account.aavid)}`, null, accountId), accountId, { label: 'preflight_material_read', timeoutMs: 20000 }),
    plan_read: () => fetchLivePlanList(getLocalDateStr(), getLocalDateStr(), accountId),
  };
  const [identity, liveStatus, materialRead, planRead] = await Promise.allSettled([
    invoke.identity(), invoke.live_status(), invoke.material_read(), invoke.plan_read(),
  ]);
  const live = liveStatus.status === 'fulfilled' ? liveStatus.value : null;
  const isLive = typeof live?.isLive === 'boolean' ? live.isLive : typeof live?.is_live === 'boolean' ? live.is_live : null;
  const candidate = outcome(identity, '').state === 'available' ? extractCandidates(identity.value).find(a => a.aavid === String(account.aavid)) : null;
  const anchorId = candidate ? candidate.anchor_id || findFirstId(live, ['anchor_id', 'anchorId', 'anchorID']) : '';
  let plans = [], planSchemaValid = false;
  if (candidate && outcome(planRead, '').state === 'available') {
    try { plans = extractPlans(planRead.value, String(account.aavid), new Date().toISOString()); planSchemaValid = true; } catch {}
  }
  // 复用新接入的严格解析：已配置计划必须匹配；多计划不能按列表顺序任选。
  const selected = account.primary_ad_id ? plans.find(p => p.id === String(account.primary_ad_id)) : plans.length === 1 ? plans[0] : null;
  const primaryAdId = selected?.id || '';
  const capabilities = {
    identity: candidate ? capability('available', '账户身份匹配') : capability('unavailable', '未能核验 Cookie 与账户身份', { code: 'identity_unverified' }),
    live_status: isLive !== null ? capability('available', '只读验证通过', { is_live: isLive }) : capability('unknown', '直播状态缺失，不能判定下播', { is_live: null }),
    live_board: isLive && anchorId
      ? capability('unknown', '已在播且已取得主播 ID；大屏将在下一次盯盘读取时验证')
      : capability('unavailable', isLive === null ? '直播状态未知，未发送大屏请求' : isLive ? '缺少主播 ID，无法读取直播大屏' : '当前未在播，未发送大屏请求'),
    material_read: outcome(materialRead, '素材读取失败'),
    plan_read: planSchemaValid ? capability('available', '账户所属计划列表已核验') : capability('unavailable', '账户或计划列表未核验'),
    plan_write: primaryAdId
      ? capability('unknown', '已发现主计划；写权限需在确认 Profile 后由操作前校验判定')
      : capability('unavailable', '未发现主计划 ID，只影响主计划写操作'),
  };
  const discovered = { ...(anchorId ? { anchorId } : {}), ...(primaryAdId ? { primaryAdId } : {}) };
  if (Object.keys(discovered).length && typeof options.persistDiscovered === 'function') await options.persistDiscovered(accountId, discovered);
  const result = {
    account_id: accountId,
    capabilities,
    discovered,
    configured_primary_ad_id: account.primary_ad_id || null,
    plan_candidates: plans,
    // 预检从不尝试写；mode 由账户 Profile 决定，此处仅声明新账号安全默认值。
    mode: 'recommendation_only',
    checked_at: new Date().toISOString(),
  };
  if (typeof options.persistCapabilities === 'function') await options.persistCapabilities(accountId, result);
  return result;
}

module.exports = { findFirstId, preflightAccount };
