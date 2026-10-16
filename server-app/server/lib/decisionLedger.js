'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { isValidAccountId } = require('./api-helpers');
const { buildSnapshotId } = require('./dataContract');
const { snapshotEvidence } = require('./watchContract');

const LEDGER_SCHEMA_VERSION = '2.0';
const OUTCOME_SCHEMA_VERSION = '2.0';
const SHADOW_EVALUATION_SCHEMA_VERSION = '1.0';
const MAX_SHADOW_EVALUATION_BYTES = 256 * 1024;
const MAX_SHADOW_EVALUATION_OFFSET = 1_000_000;
const DEFAULT_BASE_DIR = path.join(__dirname, '..', '..', 'agent-memory');
const connections = new Map();
const importedScopes = new Set();

function ledgerError(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function memoryBaseDir() {
  return process.env.AGENT_MEMORY_DIR || DEFAULT_BASE_DIR;
}

function accountDir(accountId, baseDir = memoryBaseDir()) {
  if (!isValidAccountId(accountId)) throw ledgerError('invalid_account', `account_invalid: ${accountId}`, 400);
  return path.join(baseDir, accountId);
}

function dbPath(accountId, baseDir = memoryBaseDir()) {
  return path.join(accountDir(accountId, baseDir), 'decision-ledger.sqlite');
}

function openLedger(accountId, options = {}) {
  const file = dbPath(accountId, options.baseDir);
  if (connections.has(file)) return connections.get(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec('PRAGMA synchronous=FULL;');
  db.exec('PRAGMA busy_timeout=250;');
  db.exec('PRAGMA mmap_size=0;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS decision_rounds (
      round_id TEXT PRIMARY KEY,
      schema_version TEXT NOT NULL,
      account_id TEXT NOT NULL,
      session_key TEXT,
      round_no TEXT,
      phase TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      snapshot_id TEXT,
      payload_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      outcome_json TEXT,
      outcome_evaluated_at TEXT,
      evaluation_after TEXT,
      outcome_version TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_decision_rounds_time
      ON decision_rounds(recorded_at DESC);
    CREATE INDEX IF NOT EXISTS idx_decision_rounds_session
      ON decision_rounds(session_key, recorded_at DESC);
    CREATE TABLE IF NOT EXISTS decision_snapshots (
      snapshot_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      session_key TEXT,
      source_at TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_decision_snapshots_session_time
      ON decision_snapshots(session_key, source_at);
    CREATE TABLE IF NOT EXISTS shadow_evaluations (
      evaluation_id TEXT PRIMARY KEY,
      schema_version TEXT NOT NULL,
      account_id TEXT NOT NULL,
      session_key TEXT NOT NULL,
      window_as_of TEXT NOT NULL,
      source_at TEXT NOT NULL,
      evaluated_at TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      status TEXT,
      state TEXT,
      risk_level TEXT,
      payload_json TEXT NOT NULL,
      UNIQUE (account_id, session_key, window_as_of, input_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_shadow_evaluations_session_window
      ON shadow_evaluations(session_key, window_as_of, recorded_at);
  `);
  // 兼容 1.0 账本：ALTER 重复执行会报 duplicate column，安全忽略；其他错误必须抛出。
  for (const sql of [
    'ALTER TABLE decision_rounds ADD COLUMN evaluation_after TEXT',
    'ALTER TABLE decision_rounds ADD COLUMN outcome_version TEXT',
  ]) {
    try { db.exec(sql); }
    catch (error) { if (!/duplicate column/i.test(error.message || '')) throw error; }
  }
  connections.set(file, db);
  return db;
}

function iso(value, fallback) {
  const ms = value ? Date.parse(value) : NaN;
  if (Number.isFinite(ms)) return new Date(ms).toISOString();
  if (fallback) return iso(fallback);
  return new Date().toISOString();
}

function objectArray(value, fallbackCode) {
  const values = Array.isArray(value) ? value : (value == null || value === '' ? [] : [value]);
  return values.map(item => {
    if (item && typeof item === 'object') return item;
    return { code: fallbackCode, message: String(item) };
  });
}

function evaluationMinutes(input = {}) {
  const candidates = [input.check_after_minutes, input.expected_effect && input.expected_effect.check_after_minutes];
  for (const item of objectArray(input.judgments != null ? input.judgments : input.decisions, 'UNSTRUCTURED_JUDGMENT')) {
    candidates.push(item && item.check_after_minutes);
  }
  const value = candidates.map(Number).find(n => Number.isFinite(n) && n > 0);
  return Math.min(24 * 60, Math.max(5, value || 120));
}

function normalizeRound(accountId, input = {}, options = {}) {
  if (!input || typeof input !== 'object') throw ledgerError('invalid_round', 'round必须是对象', 400);
  const recordedAt = iso(options.recordedAt || input.recorded_at || input.time);
  const hasClientObservedAt = Boolean(input.observed_at || input.time);
  const observedAt = iso(input.observed_at || input.time, recordedAt);
  const sessionKey = input.session_key == null || input.session_key === '' ? null : String(input.session_key);
  const phase = String(input.phase || (sessionKey ? 'live' : (options.legacy ? 'legacy' : 'offline')));
  if (!['pre_live', 'live', 'post_live', 'offline', 'legacy'].includes(phase)) {
    throw ledgerError('invalid_round_phase', `不支持的phase: ${phase}`, 400);
  }
  if (options.strictSession !== false && ['live', 'post_live'].includes(phase) && !sessionKey) {
    throw ledgerError('session_key_required', `${phase}轮次必须绑定session_key`, 400);
  }
  const roundNo = input.round_no != null ? input.round_no : input.round;
  const clientRoundId = input.round_id || input.client_round_id || null;
  const identity = clientRoundId
    ? `${accountId}|client|${clientRoundId}`
    : `${accountId}|${sessionKey || phase}|${roundNo == null ? observedAt : roundNo}|${observedAt.slice(0, 10)}`;
  const roundId = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 24);
  const snapshot = input.snapshot || input.data_snapshot || null;
  const actions = objectArray(input.actions, 'UNSTRUCTURED_ACTION');
  const checkAfterMinutes = evaluationMinutes(input);
  const evaluationAfter = new Date(Date.parse(observedAt) + checkAfterMinutes * 60 * 1000).toISOString();
  const payload = {
    schema_version: LEDGER_SCHEMA_VERSION,
    round_id: roundId,
    client_round_id: clientRoundId == null ? null : String(clientRoundId),
    account_id: String(accountId),
    session_key: sessionKey,
    round_no: roundNo == null ? null : String(roundNo),
    phase,
    observed_at: observedAt,
    observed_at_source: hasClientObservedAt ? 'client' : 'server',
    recorded_at: recordedAt,
    source: {
      agent_platform: input.agent_platform || input.source && input.source.agent_platform || null,
      task_ref: input.task_ref || input.source && input.source.task_ref || null,
      task_ref_verified: false,
    },
    snapshot: snapshot && typeof snapshot === 'object' ? snapshot : (snapshot == null ? null : { raw: snapshot }),
    observations: objectArray(input.observations, 'UNSTRUCTURED_OBSERVATION'),
    judgments: objectArray(input.judgments != null ? input.judgments : input.decisions, 'UNSTRUCTURED_JUDGMENT'),
    recommendations: objectArray(input.recommendations, 'UNSTRUCTURED_RECOMMENDATION'),
    actions,
    summary: input.summary == null ? '' : String(input.summary),
    expected_effect: input.expected_effect == null ? null : input.expected_effect,
    check_after_minutes: checkAfterMinutes,
    evaluation_after: evaluationAfter,
    legacy_unscoped: options.legacyUnscoped === true,
  };
  const json = JSON.stringify(payload);
  if (Buffer.byteLength(json, 'utf8') > 256 * 1024) {
    throw ledgerError('decision_round_too_large', '单轮决策记录不能超过256KB，请保存snapshot_id而不是全量原始数据', 413);
  }
  return payload;
}

function hashPayload(payload) {
  // recorded_at 是服务端接收时间，同一个客户端轮次安全重试时允许不同；
  // 其余业务字段变化仍判冲突，避免幂等键掩盖真实覆盖。
  const { recorded_at: _recordedAt, ...semanticPayload } = payload;
  // 旧 save_memory 调用只传 round，不传观测时间。此时 observed_at 是接收时补的，
  // 不能让同一轮安全重试因为几毫秒差异变成冲突；客户端显式时间仍参与摘要。
  if (semanticPayload.observed_at_source === 'server') {
    delete semanticPayload.observed_at;
    // evaluation_after 由服务端补入的 observed_at 派生，同一轮安全重试时也必须忽略。
    delete semanticPayload.evaluation_after;
  }
  return crypto.createHash('sha256').update(JSON.stringify(semanticPayload)).digest('hex');
}

function recordRound(accountId, input, options = {}) {
  const payload = normalizeRound(accountId, input, options);
  const db = openLedger(accountId, options);
  const payloadHash = hashPayload(payload);
  const existing = db.prepare('SELECT payload_hash, payload_json FROM decision_rounds WHERE round_id = ?').get(payload.round_id);
  if (existing) {
    if (existing.payload_hash === payloadHash) return { ok: true, duplicate: true, round: JSON.parse(existing.payload_json) };
    throw ledgerError('decision_round_conflict', `round_id ${payload.round_id} 已存在且内容不同`, 409);
  }
  db.prepare(`
    INSERT INTO decision_rounds (
      round_id, schema_version, account_id, session_key, round_no, phase,
      observed_at, recorded_at, snapshot_id, payload_hash, payload_json, evaluation_after
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    payload.round_id, payload.schema_version, payload.account_id, payload.session_key,
    payload.round_no, payload.phase, payload.observed_at, payload.recorded_at,
    payload.snapshot && payload.snapshot.snapshot_id || null, payloadHash, JSON.stringify(payload), payload.evaluation_after,
  );
  return { ok: true, duplicate: false, round: payload };
}

function listRounds(accountId, options = {}) {
  const db = openLedger(accountId, options);
  const limit = Math.min(Math.max(parseInt(options.limit || 20, 10) || 20, 1), 500);
  const where = [];
  const params = [];
  if (options.sessionKey) { where.push('session_key = ?'); params.push(String(options.sessionKey)); }
  if (options.before) { where.push('recorded_at < ?'); params.push(iso(options.before)); }
  if (options.pending === true) where.push('outcome_json IS NULL');
  const sql = `SELECT payload_json, outcome_json, outcome_evaluated_at, outcome_version FROM decision_rounds${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY recorded_at DESC LIMIT ?`;
  params.push(limit);
  return db.prepare(sql).all(...params).map(row => {
    const payload = JSON.parse(row.payload_json);
    if (row.outcome_json) payload.outcome = JSON.parse(row.outcome_json);
    if (row.outcome_evaluated_at) payload.outcome_evaluated_at = row.outcome_evaluated_at;
    if (row.outcome_version) payload.outcome_version = row.outcome_version;
    return payload;
  });
}

function listPendingRounds(accountId, options = {}) {
  const db = openLedger(accountId, options);
  const limit = Math.min(Math.max(parseInt(options.limit || 100, 10) || 100, 1), 500);
  const dueBefore = iso(options.dueBefore);
  return db.prepare(`
    SELECT payload_json, outcome_json, outcome_evaluated_at
    FROM decision_rounds
    WHERE outcome_json IS NULL
      AND (evaluation_after IS NULL OR evaluation_after <= ?)
    ORDER BY COALESCE(evaluation_after, observed_at) ASC, recorded_at ASC
    LIMIT ?
  `).all(dueBefore, limit).map(row => JSON.parse(row.payload_json));
}

// Explicit Agent follow-ups reuse observations in the existing round ledger, not a new queue.
function getMaterialWatch(accountId, sessionKey, options = {}) {
  if (!sessionKey) return [];
  const db = openLedger(accountId, options), pending = new Map();
  const rows = db.prepare('SELECT payload_json FROM decision_rounds WHERE session_key = ? ORDER BY recorded_at ASC, rowid ASC').iterate(String(sessionKey));
  for (const row of rows) {
    const round = JSON.parse(row.payload_json);
    for (const item of round.observations || []) {
      if (item.code !== 'MATERIAL_WATCH' || (!item.object_key && !item.material_id)) continue;
      const key = String(item.object_key || `${item.kind || 'video'}:${item.material_id}`);
      if (item.status === 'resolved') pending.delete(key);
      else if (item.status === 'pending') pending.set(key, { object_key: key, material_id: item.material_id || null,
        kind: item.kind || 'video', reason: item.message || null, round_id: round.round_id });
    }
  }
  return [...pending.values()];
}

function recordSnapshot(accountId, summary, options = {}) {
  if (!summary || typeof summary !== 'object') throw ledgerError('invalid_snapshot', '快照必须是对象', 400);
  const meta = summary.meta || {};
  if (String(meta.account_id || '') !== String(accountId)) {
    throw ledgerError('snapshot_account_mismatch', '快照账号与账本账号不一致', 400);
  }
  if (!meta.source_at || !Number.isFinite(Date.parse(meta.source_at))) {
    throw ledgerError('snapshot_source_at_required', '可信快照必须带有效 source_at', 400);
  }
  const sourceAt = iso(meta.source_at);
  const snapshotId = String(summary.snapshot_id || '');
  if (!snapshotId) throw ledgerError('snapshot_id_required', '快照缺 snapshot_id', 400);
  const evidence = meta.schema_version === '2.1' ? snapshotEvidence(summary) : undefined;
  if (buildSnapshotId(meta, summary.metrics || {}, evidence) !== snapshotId) {
    throw ledgerError('snapshot_id_mismatch', 'snapshot_id 与快照内容不一致', 409);
  }
  const canonical = {
    snapshot_id: snapshotId,
    meta: {
      schema_version: meta.schema_version || null,
      account_id: String(accountId),
      session_key: meta.session_key == null ? null : String(meta.session_key),
      source_at: sourceAt,
      freshness: meta.freshness || null,
      data_valid: meta.data_valid === true,
      stale: meta.stale === true,
      partial: meta.partial === true,
      missing: Array.isArray(meta.missing) ? meta.missing : [],
      errors: Array.isArray(meta.errors) ? meta.errors : [],
      source_type: meta.source_type || null,
    },
    metrics: summary.metrics && typeof summary.metrics === 'object' ? summary.metrics : {},
    ...(evidence || {}),
  };
  const db = openLedger(accountId, options);
  const existing = db.prepare('SELECT payload_json FROM decision_snapshots WHERE snapshot_id = ?').get(snapshotId);
  if (existing) return { ok: true, duplicate: true, snapshot: JSON.parse(existing.payload_json) };
  db.prepare(`
    INSERT INTO decision_snapshots (snapshot_id, account_id, session_key, source_at, recorded_at, payload_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(snapshotId, String(accountId), canonical.meta.session_key, sourceAt, iso(options.recordedAt), JSON.stringify(canonical));
  return { ok: true, duplicate: false, snapshot: canonical };
}

function getSnapshot(accountId, snapshotId, options = {}) {
  const db = openLedger(accountId, options);
  const row = db.prepare('SELECT payload_json FROM decision_snapshots WHERE snapshot_id = ?').get(String(snapshotId || ''));
  return row ? JSON.parse(row.payload_json) : null;
}

function findEvaluationSnapshot(accountId, sessionKey, targetAt, options = {}) {
  if (!sessionKey) return null;
  const db = openLedger(accountId, options);
  const target = iso(targetAt);
  const maxLagMs = Number.isFinite(Number(options.maxLagMs)) ? Number(options.maxLagMs) : 45 * 60 * 1000;
  const latest = new Date(Date.parse(target) + Math.max(0, maxLagMs)).toISOString();
  const rows = db.prepare(`
    SELECT payload_json FROM decision_snapshots
    WHERE session_key = ? AND source_at >= ? AND source_at <= ?
    ORDER BY source_at ASC LIMIT 20
  `).all(String(sessionKey), target, latest);
  for (const row of rows) {
    const snapshot = JSON.parse(row.payload_json);
    const meta = snapshot.meta || {};
    if (meta.data_valid === true && meta.stale !== true && meta.partial !== true && meta.freshness === 'fresh') return snapshot;
  }
  return null;
}

function requiredText(value, field, options = {}) {
  const text = typeof value === 'string' ? value.trim() : '';
  const maxLength = Number(options.maxLength) || 512;
  if (!text) throw ledgerError(`shadow_${field}_required`, `${field} 必填`, 400);
  if (text.length > maxLength || /[\u0000-\u001f\u007f]/.test(text)) {
    throw ledgerError(`shadow_${field}_invalid`, `${field} 格式无效`, 400);
  }
  return text;
}

function requiredTime(value, field) {
  if (!value || !Number.isFinite(Date.parse(value))) {
    throw ledgerError(`shadow_${field}_invalid`, `${field} 必须是有效时间`, 400);
  }
  return new Date(Date.parse(value)).toISOString();
}

function optionalLabel(value, field) {
  if (value == null || value === '') return null;
  return requiredText(String(value), field, { maxLength: 128 });
}

/**
 * 保存一次扩量稀释 Shadow 的前向证据。
 *
 * 唯一键故意不包含 evaluated_at/recorded_at：相同账号、场次、窗口和输入证据
 * 无论被多少个座舱请求重复计算，都只保留第一次观测；同一窗口后续发生结算
 * 回填时，调用方必须产生新的 input_hash，因此会追加一条修订而不是覆盖旧证据。
 */
function recordShadowEvaluation(accountId, input = {}, options = {}) {
  // accountDir 同时完成账号格式校验；先校验，避免无效账号进入哈希或错误码不一致。
  accountDir(accountId, options.baseDir || memoryBaseDir());
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw ledgerError('invalid_shadow_evaluation', 'Shadow 前向证据必须是对象', 400);
  }

  const sessionKey = requiredText(input.session_key, 'session_key');
  const inputHash = requiredText(input.input_hash, 'input_hash', { maxLength: 256 });
  const windowAsOf = requiredTime(input.window_as_of, 'window_as_of');
  const sourceAt = requiredTime(input.source_at, 'source_at');
  const evaluatedAt = requiredTime(input.evaluated_at, 'evaluated_at');
  const recordedAt = requiredTime(options.recordedAt || input.recorded_at || new Date().toISOString(), 'recorded_at');

  if (Date.parse(windowAsOf) > Date.parse(evaluatedAt)) {
    throw ledgerError('shadow_window_after_evaluation', 'window_as_of 不能晚于 evaluated_at', 400);
  }
  if (Date.parse(windowAsOf) > Date.parse(sourceAt)) {
    throw ledgerError('shadow_window_after_source', 'window_as_of 不能晚于 source_at', 400);
  }
  if (Date.parse(sourceAt) > Date.parse(evaluatedAt)) {
    throw ledgerError('shadow_source_after_evaluation', 'source_at 不能晚于 evaluated_at', 400);
  }
  if (Date.parse(evaluatedAt) > Date.parse(recordedAt)) {
    throw ledgerError('shadow_evaluation_after_recording', 'evaluated_at 不能晚于 recorded_at', 400);
  }

  const identity = [String(accountId), sessionKey, windowAsOf, inputHash].join('\u0000');
  const evaluationId = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 24);
  const evidencePayload = input.payload == null ? {} : input.payload;
  if (!evidencePayload || typeof evidencePayload !== 'object' || Array.isArray(evidencePayload)) {
    throw ledgerError('shadow_payload_invalid', 'payload 必须是对象', 400);
  }
  const canonical = {
    schema_version: String(input.schema_version || SHADOW_EVALUATION_SCHEMA_VERSION),
    evaluation_id: evaluationId,
    account_id: String(accountId),
    session_key: sessionKey,
    window_as_of: windowAsOf,
    source_at: sourceAt,
    evaluated_at: evaluatedAt,
    recorded_at: recordedAt,
    input_hash: inputHash,
    status: optionalLabel(input.status, 'status'),
    state: optionalLabel(input.state, 'state'),
    risk_level: optionalLabel(input.risk_level, 'risk_level'),
    payload: evidencePayload,
  };
  let json;
  try { json = JSON.stringify(canonical); }
  catch {
    throw ledgerError('shadow_payload_not_serializable', 'Shadow 前向证据无法序列化', 400);
  }
  if (Buffer.byteLength(json, 'utf8') > MAX_SHADOW_EVALUATION_BYTES) {
    throw ledgerError('shadow_evaluation_too_large', '单条 Shadow 前向证据不能超过256KB', 413);
  }

  const db = openLedger(accountId, options);
  const inserted = db.prepare(`
    INSERT INTO shadow_evaluations (
      evaluation_id, schema_version, account_id, session_key, window_as_of,
      source_at, evaluated_at, recorded_at, input_hash, status, state, risk_level, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (account_id, session_key, window_as_of, input_hash) DO NOTHING
  `).run(
    evaluationId, canonical.schema_version, canonical.account_id, canonical.session_key,
    canonical.window_as_of, canonical.source_at, canonical.evaluated_at, canonical.recorded_at,
    canonical.input_hash, canonical.status, canonical.state, canonical.risk_level, json,
  );
  if (!inserted.changes) {
    const existing = db.prepare(`
      SELECT payload_json FROM shadow_evaluations
      WHERE account_id = ? AND session_key = ? AND window_as_of = ? AND input_hash = ?
    `).get(String(accountId), sessionKey, windowAsOf, inputHash);
    if (!existing) {
      throw ledgerError('shadow_evaluation_id_conflict', `evaluation_id ${evaluationId} 已被其他证据占用`, 409);
    }
    return { ok: true, duplicate: true, evaluation: JSON.parse(existing.payload_json) };
  }
  return { ok: true, duplicate: false, evaluation: canonical };
}

function getShadowEvaluation(accountId, evaluationId, options = {}) {
  const id = requiredText(evaluationId, 'evaluation_id', { maxLength: 128 });
  const db = openLedger(accountId, options);
  const row = db.prepare(`
    SELECT payload_json FROM shadow_evaluations
    WHERE evaluation_id = ? AND account_id = ?
  `).get(id, String(accountId));
  return row ? JSON.parse(row.payload_json) : null;
}

function listShadowEvaluations(accountId, options = {}) {
  const db = openLedger(accountId, options);
  const limit = Math.min(Math.max(parseInt(options.limit || 100, 10) || 100, 1), 500);
  const parsedOffset = parseInt(options.offset || 0, 10);
  const offset = Math.min(
    Math.max(Number.isFinite(parsedOffset) ? parsedOffset : 0, 0),
    MAX_SHADOW_EVALUATION_OFFSET,
  );
  const where = ['account_id = ?'];
  const params = [String(accountId)];
  if (options.sessionKey != null) {
    where.push('session_key = ?');
    params.push(requiredText(options.sessionKey, 'session_key'));
  }
  if (options.from != null) {
    where.push('window_as_of >= ?');
    params.push(requiredTime(options.from, 'from'));
  }
  if (options.to != null) {
    where.push('window_as_of <= ?');
    params.push(requiredTime(options.to, 'to'));
  }
  if (options.inputHash != null) {
    where.push('input_hash = ?');
    params.push(requiredText(options.inputHash, 'input_hash', { maxLength: 256 }));
  }
  params.push(limit, offset);
  return db.prepare(`
    SELECT payload_json FROM shadow_evaluations
    WHERE ${where.join(' AND ')}
    ORDER BY window_as_of ASC, recorded_at ASC, evaluation_id ASC
    LIMIT ? OFFSET ?
  `).all(...params).map(row => JSON.parse(row.payload_json));
}

function attachOutcome(accountId, roundId, outcome, options = {}) {
  const db = openLedger(accountId, options);
  const evaluatedAt = iso(options.evaluatedAt);
  const version = String(options.outcomeVersion || OUTCOME_SCHEMA_VERSION);
  const info = db.prepare(`
    UPDATE decision_rounds
    SET outcome_json = ?, outcome_evaluated_at = ?, outcome_version = ?
    WHERE round_id = ? AND outcome_json IS NULL
  `).run(JSON.stringify(outcome == null ? null : outcome), evaluatedAt, version, String(roundId));
  if (!info.changes) {
    const existing = db.prepare('SELECT outcome_json, outcome_evaluated_at FROM decision_rounds WHERE round_id = ?').get(String(roundId));
    if (!existing) throw ledgerError('decision_round_not_found', `决策轮次不存在: ${roundId}`, 404);
    return { ok: true, duplicate: true, round_id: String(roundId), outcome_evaluated_at: existing.outcome_evaluated_at };
  }
  return { ok: true, duplicate: false, round_id: String(roundId), outcome_evaluated_at: evaluatedAt };
}

async function importLegacyDecisions(accountId, options = {}) {
  const baseDir = options.baseDir || memoryBaseDir();
  const scopeKey = `${baseDir}|${accountId}`;
  if (importedScopes.has(scopeKey)) return { imported: 0, skipped_unscoped: 0, cached: true };
  const dirs = [
    { dir: path.join(baseDir, accountId, 'decisions'), scoped: true },
    { dir: path.join(baseDir, 'decisions'), scoped: false },
  ];
  let imported = 0;
  let skippedUnscoped = 0;
  let corrupt = 0;
  for (const source of dirs) {
    let files;
    try { files = await fs.promises.readdir(source.dir); }
    catch (error) {
      if (error && error.code === 'ENOENT') continue;
      throw error;
    }
    for (const file of files.filter(name => name.endsWith('.json'))) {
      try {
        const raw = await fs.promises.readFile(path.join(source.dir, file), 'utf8');
        const record = JSON.parse(raw);
        if (!source.scoped && !record.account) { skippedUnscoped++; continue; }
        if (record.account && String(record.account) !== String(accountId)) continue;
        const result = recordRound(accountId, {
          ...record,
          account: undefined,
          phase: record.phase || (record.session_key ? 'live' : 'legacy'),
        }, {
          baseDir,
          legacy: true,
          strictSession: false,
          recordedAt: record.time,
        });
        if (!result.duplicate) imported++;
      } catch (error) {
        // DB busy 是瞬时故障，不是坏文件。向上抛并且不要缓存“已导入”，
        // 解锁后的下一请求即可恢复，无需重启 HTTP 进程。
        if (error && (error.code === 'SQLITE_BUSY' || /database is locked/i.test(error.message || ''))) throw error;
        if (error.code !== 'decision_round_conflict') corrupt++;
      }
    }
  }
  importedScopes.add(scopeKey);
  return { imported, skipped_unscoped: skippedUnscoped, corrupt, cached: false };
}

function closeAll() {
  for (const db of connections.values()) {
    try { db.close(); } catch { /* best effort */ }
  }
  connections.clear();
  importedScopes.clear();
}

module.exports = {
  LEDGER_SCHEMA_VERSION,
  OUTCOME_SCHEMA_VERSION,
  SHADOW_EVALUATION_SCHEMA_VERSION,
  MAX_SHADOW_EVALUATION_BYTES,
  memoryBaseDir,
  dbPath,
  normalizeRound,
  recordRound,
  listRounds,
  listPendingRounds,
  getMaterialWatch,
  recordSnapshot,
  getSnapshot,
  findEvaluationSnapshot,
  recordShadowEvaluation,
  getShadowEvaluation,
  listShadowEvaluations,
  attachOutcome,
  importLegacyDecisions,
  closeAll,
};
