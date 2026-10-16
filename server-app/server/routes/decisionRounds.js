'use strict';

const { sendJSON, readJsonBody, requireLocalRecordAuth } = require('../lib/utils');
const { validateAccount } = require('../lib/api-helpers');
const ledger = require('../lib/decisionLedger');
const { publicRound } = require('../lib/decisionEvidence');
const agentMemory = require('./agentMemory');
const operationLog = require('../lib/operationLog');

function mapError(res, error) {
  if (error && (error.code === 'SQLITE_BUSY' || /database is locked/i.test(error.message || ''))) {
    return sendJSON(res, { ok: false, code: 'db_busy', component: 'decision_ledger', retryable: true, error: '决策账本暂时繁忙，请稍后重试' }, 503);
  }
  const status = error && error.statusCode || 500;
  return sendJSON(res, {
    ok: false,
    code: error && error.code || 'decision_ledger_error',
    component: 'decision_ledger',
    retryable: false,
    error: status >= 500 ? 'internal_server_error' : error.message,
  }, status);
}

function resolveRoundAccount(url, data = {}) {
  const fail = (code, message) => { throw Object.assign(new Error(message), { code, statusCode: 400 }); };
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail('invalid_round', '决策轮次必须是 JSON 对象');
  if (data.round != null && (typeof data.round !== 'object' || Array.isArray(data.round))) fail('invalid_round', 'round 必须是 JSON 对象');
  const candidates = [url.searchParams.get('account'), url.searchParams.get('accountId'),
    data.account_id, data.accountId, data.round?.account_id, data.round?.accountId].filter(value => value != null && value !== '');
  const account = validateAccount(candidates[0]);
  if (candidates.some(value => value !== account)) fail('account_conflict', '决策记录的账户参数不一致，未写入任何账户');
  return account;
}

function bindTrustedSnapshot(account, input) {
  const round = { ...(input || {}) };
  const requestedId = round.snapshot && round.snapshot.snapshot_id || round.snapshot_id || null;
  if (!requestedId) {
    if (round.snapshot) round.snapshot = { verified: false, reason: 'snapshot_id_required' };
    return round;
  }
  const trusted = ledger.getSnapshot(account, requestedId);
  if (!trusted) {
    round.snapshot = { snapshot_id: String(requestedId), verified: false, reason: 'snapshot_not_found' };
    return round;
  }
  const snapshotSession = trusted.meta && trusted.meta.session_key || null;
  const roundSession = round.session_key || null;
  if (roundSession && String(snapshotSession || '') !== String(roundSession)) {
    const error = new Error('快照场次与决策轮次不一致');
    error.code = 'snapshot_session_mismatch';
    error.statusCode = 409;
    throw error;
  }
  // 忽略调用方自报的 metrics/可信标记，只保存服务端账本里同 snapshot_id 的规范快照。
  round.snapshot = { ...trusted, verified: true };
  return round;
}

function bindVerifiedActions(account, input) {
  const round = { ...(input || {}) };
  const actions = Array.isArray(round.actions) ? round.actions : (round.actions == null ? [] : [round.actions]);
  round.actions = actions.map(action => {
    const submitted = action && typeof action === 'object' ? action : { code: 'UNSTRUCTURED_ACTION', message: String(action) };
    const operationId = submitted.operation_id || submitted.op_log_id || null;
    const receipt = operationId ? operationLog.getById(operationId) : null;
    const owned = receipt && String(receipt.account_id || '') === String(account);
    const effect = owned && receipt.params?.receipt;
    const verified = !!(owned && receipt.success === true && (!effect || effect.effect_status === 'confirmed' && effect.readback?.verified === true));
    if (!verified) return { ...submitted, operation_id: operationId, verified: false,
      effect_status: effect?.effect_status || 'unconfirmed', ...(effect ? { receipt: effect } : {}) };
    return {
      code: receipt.action || submitted.code || submitted.action || 'UNKNOWN_ACTION',
      operation_id: receipt.id,
      verified: true,
      success: true,
      executed_at: receipt.ts,
      target_type: receipt.target_type || submitted.target_type || null,
      target_id: receipt.target_id || submitted.target_id || null,
      primary_ad_id: receipt.primary_ad_id || null,
      assist_task_id: receipt.assist_task_id || null,
      source: receipt.source || null,
      ...(effect ? { effect_status: effect.effect_status, receipt: effect } : {}),
    };
  });
  return round;
}

async function handleDecisionRounds(req, res, url) {
  try {
    if (req.method === 'GET') {
      const account = resolveRoundAccount(url);
      const migration = await ledger.importLegacyDecisions(account);
      const rounds = ledger.listRounds(account, {
        limit: url.searchParams.get('limit') || 20,
        sessionKey: url.searchParams.get('session_key') || null,
        before: url.searchParams.get('before') || null,
      });
      return sendJSON(res, {
        ok: true,
        schema_version: ledger.LEDGER_SCHEMA_VERSION,
        account_id: account,
        count: rounds.length,
        rounds: rounds.map(publicRound),
        legacy_migration: migration,
      });
    }

    if (req.method === 'POST') {
      // 只保存观察和经 op-log 验证的事实，不执行广告；与广告写入开关分离。
      if (!requireLocalRecordAuth(req, res)) return;
      const { data, error } = await readJsonBody(req);
      if (error) return sendJSON(res, { ok: false, code: 'invalid_json', error: error.message }, error.status);
      const account = resolveRoundAccount(url, data);
      const submittedRound = data.round && typeof data.round === 'object' ? data.round : data;
      const round = bindVerifiedActions(account, bindTrustedSnapshot(account, submittedRound));
      const hits = agentMemory.checkCrossAccountWords(account, round);
      if (hits && hits.length) {
        return sendJSON(res, {
          ok: false,
          code: 'cross_account_content',
          error: `跨账号特征词命中，拒绝写入（写入账号 ${account}，命中 ${hits.length} 个其他账号专属词）`,
          hits,
        }, 400);
      }
      const result = ledger.recordRound(account, round);
      return sendJSON(res, {
        ok: true,
        duplicate: result.duplicate,
        account_id: account,
        round_id: result.round.round_id,
        session_key: result.round.session_key,
        recorded_at: result.round.recorded_at,
        snapshot_verified: result.round.snapshot && result.round.snapshot.verified === true,
      }, result.duplicate ? 200 : 201);
    }

    return sendJSON(res, { ok: false, code: 'method_not_allowed', error: 'Method Not Allowed' }, 405);
  } catch (error) {
    return mapError(res, error);
  }
}

module.exports = handleDecisionRounds;
module.exports._test = { mapError, bindTrustedSnapshot, bindVerifiedActions, resolveRoundAccount };
