'use strict';

const { PORT } = require('../lib/config');
const { validateAccount } = require('../lib/api-helpers');
const { sendJSON } = require('../lib/utils');
const { buildLiveSummary } = require('../lib/mcpClean');
const ledger = require('../lib/decisionLedger');

async function fetchDashboard(account, options = {}) {
  const timeoutMs = Number(options.timeoutMs) || 50000;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const baseUrl = options.baseUrl || `http://127.0.0.1:${PORT}`;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;
  let response;
  try {
    const scopeQuery = (options.roomId ? `&room_id=${encodeURIComponent(options.roomId)}` : '') +
      (options.startTime ? `&start_time=${encodeURIComponent(options.startTime)}` : '');
    response = await fetchImpl(`${baseUrl}/api/live-dashboard?account=${encodeURIComponent(account)}&slim=1${scopeQuery}`, {
      signal,
    });
  } catch (error) {
    const callerAborted = options.signal && options.signal.aborted;
    const timedOut = timeoutSignal.aborted && !callerAborted;
    const reason = callerAborted && options.signal.reason;
    const wrapped = new Error(timedOut
      ? `可信快照取数超过 ${timeoutMs}ms`
      : (reason && reason.message || error.message || '可信快照取数失败'));
    wrapped.code = timedOut ? 'timeout' : (reason && reason.code || error.code || 'upstream_unavailable');
    wrapped.statusCode = timedOut ? 504 : (reason && reason.statusCode || 502);
    wrapped.retryable = true;
    wrapped.timeoutMs = timedOut ? timeoutMs : null;
    throw wrapped;
  }
  let body;
  try { body = await response.json(); }
  catch {
    const error = new Error('live-dashboard 返回非 JSON');
    error.code = 'upstream_parse_error'; error.statusCode = 502; error.retryable = true;
    throw error;
  }
  if (!response.ok || !body || body.ok === false) {
    const error = new Error(body && (body.error || body.message) || `HTTP ${response.status}`);
    error.code = body && body.code || `http_${response.status}`;
    error.statusCode = response.status >= 400 ? response.status : 502;
    error.retryable = body && body.retryable === true || response.status >= 500;
    throw error;
  }
  return body;
}

function buildAndPersist(account, dashboard, options = {}) {
  let materialChanges;
  try {
    materialChanges = (options.getMaterialChanges || require('../lib/liveCollector').getLatestMaterialChanges)(account, {
      sessionKey: dashboard.session_key, boosts: dashboard.boost_tasks || [],
      pending: ledger.getMaterialWatch(account, dashboard.session_key, { baseDir: options.baseDir }),
      alerts: [...(dashboard.riskAlerts || []), ...(dashboard.suggestions || [])],
      now: options.generatedAt ? Date.parse(options.generatedAt) : Date.now(),
    });
  } catch (error) {
    materialChanges = { source: 'collector_material_modules', source_at: null, missing_components: ['material_changes'],
      error: { code: error.code || 'material_changes_unavailable' }, top: [], exceptions: [], not_observed: [],
      follow_up: { tool: 'get_live_view', level: 'dashboard', note: '组件恢复后重读摘要；不把缺失解释为没有素材。' } };
  }
  const summary = buildLiveSummary({ ...dashboard, material_changes: materialChanges }, { accountId: account, generatedAt: options.generatedAt || new Date().toISOString() });
  let snapshotPersisted = false;
  let snapshotError = null;
  try {
    ledger.recordSnapshot(account, summary, { baseDir: options.baseDir, recordedAt: options.recordedAt });
    snapshotPersisted = true;
  } catch (error) {
    snapshotError = { code: error.code || 'snapshot_store_failed', component: 'decision_ledger', retryable: error.code === 'SQLITE_BUSY' };
  }
  return { ...summary, snapshot_persisted: snapshotPersisted, ...(snapshotError ? { snapshot_error: snapshotError } : {}) };
}

// The complete summary is persisted first; omission only changes the HTTP projection.
function projectSummary(summary, includeBoosts = true) {
  if (includeBoosts) return summary;
  const { boosts, ...out } = summary;
  return { ...out, boosts_omitted: true };
}

async function handleLiveSummary(req, res, url) {
  if (req.method !== 'GET') return sendJSON(res, { ok: false, code: 'method_not_allowed', error: 'Method Not Allowed' }, 405);
  const includeBoosts = url.searchParams.get('include_boosts');
  if (includeBoosts !== null && !['0', '1'].includes(includeBoosts))
    return sendJSON(res, { ok: false, code: 'invalid_include_boosts', component: 'live_summary', retryable: false,
      error: 'include_boosts 仅支持 0 或 1' }, 400);
  let account;
  try { account = validateAccount(url.searchParams.get('account') || url.searchParams.get('accountId')); }
  catch (error) { return sendJSON(res, { ok: false, code: 'invalid_account', component: 'live_summary', retryable: false, error: error.message }, 400); }
  try {
    const dashboard = await fetchDashboard(account, { signal: req.signal,
      roomId: url.searchParams.get('room_id'), startTime: url.searchParams.get('start_time') });
    return sendJSON(res, projectSummary(buildAndPersist(account, dashboard), includeBoosts !== '0'));
  } catch (error) {
    return sendJSON(res, {
      ok: false,
      code: error.code || 'live_summary_failed',
      component: 'live_summary',
      retryable: error.retryable === true,
      ...(error.timeoutMs ? { timeout_ms: error.timeoutMs } : {}),
      error: error.message || '可信快照生成失败',
    }, error.statusCode || 502);
  }
}

module.exports = handleLiveSummary;
module.exports._test = { fetchDashboard, buildAndPersist, projectSummary };
