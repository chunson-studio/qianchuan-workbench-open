'use strict';

const { sendJSON } = require('../lib/utils');
const { validateAccount } = require('../lib/api-helpers');
const ledger = require('../lib/decisionLedger');
const { publicOutcome } = require('../lib/decisionEvidence');
const { toPublicText } = require('../lib/productLanguage');

function firstMessage(list) {
  const item = Array.isArray(list) ? list[0] : null;
  if (!item) return '';
  return toPublicText(item.message || item.reason || item.description || item.code || '');
}

function cutAtBoundary(value, max) {
  const text = toPublicText(value || '').trim();
  if (text.length <= max) return text;
  const segment = text.slice(0, max);
  const boundary = Math.max(segment.lastIndexOf('；'), segment.lastIndexOf(';'), segment.lastIndexOf('，'), segment.lastIndexOf(','));
  return (boundary >= max * 0.5 ? segment.slice(0, boundary) : segment) + '…';
}

function timelineItem(round) {
  const actions = Array.isArray(round.actions) ? round.actions : [];
  const judgments = Array.isArray(round.judgments) ? round.judgments : [];
  const actionText = actions.map(item => item.description || item.message || item.action || item.code || '').filter(Boolean).join('；');
  const summary = toPublicText(round.summary || '');
  const body = summary || actionText || firstMessage(judgments);
  const attentionCodes = new Set(['PAUSE', 'BRAKE_RECOMMEND', 'STOP_LOSS', 'MATERIAL_HIGH_SPEND_LOW_RETURN']);
  const needsAttention = actions.some(item => attentionCodes.has(String(item.code || item.action || '').toUpperCase())) ||
    judgments.some(item => attentionCodes.has(String(item.code || '').toUpperCase()));
  const hasExecutedAction = actions.some(item => ['executed', 'success', 'external_detected'].includes(String(item.status || '').toLowerCase()));
  return {
    round_id: round.round_id,
    session_key: round.session_key,
    phase: round.phase,
    time: round.observed_at,
    recorded_at: round.recorded_at,
    round: round.round_no,
    account: round.account_id,
    type: needsAttention ? 'attention' : (hasExecutedAction ? 'action' : 'normal'),
    title: cutAtBoundary(summary || firstMessage(judgments) || actionText, 42),
    desc: cutAtBoundary(body, 800),
    summary,
    snapshot: round.snapshot,
    judgments,
    recommendations: round.recommendations || [],
    actions,
    expected_effect: round.expected_effect,
    outcome: publicOutcome(round.outcome),
    outcome_evaluated_at: round.outcome_evaluated_at || null,
    source: round.source || null,
  };
}

async function handleAgentRounds(req, res, url) {
  if (req.method !== 'GET') return sendJSON(res, { ok: false, code: 'method_not_allowed', error: 'Method Not Allowed' }, 405);
  try {
    const rawAccount = url.searchParams.get('account') || url.searchParams.get('accountId');
    if (!rawAccount) return sendJSON(res, { ok: false, code: 'account_required', error: 'account必填，禁止混合返回多个账号的决策记录' }, 400);
    const account = validateAccount(rawAccount);
    const migration = await ledger.importLegacyDecisions(account);
    const rounds = ledger.listRounds(account, {
      limit: url.searchParams.get('limit') || 20,
      sessionKey: url.searchParams.get('session_key') || null,
      before: url.searchParams.get('before') || null,
    }).map(timelineItem);
    return sendJSON(res, { ok: true, schema_version: ledger.LEDGER_SCHEMA_VERSION, account_id: account, rounds, legacy_migration: migration });
  } catch (error) {
    if (error && (error.code === 'SQLITE_BUSY' || /database is locked/i.test(error.message || ''))) {
      return sendJSON(res, { ok: false, code: 'db_busy', component: 'decision_ledger', retryable: true, error: '决策账本暂时繁忙' }, 503);
    }
    const status = error.statusCode || 500;
    return sendJSON(res, { ok: false, code: error.code || 'decision_rounds_error', error: status >= 500 ? 'internal_server_error' : error.message }, status);
  }
}

module.exports = handleAgentRounds;
module.exports._test = { timelineItem, cutAtBoundary };
