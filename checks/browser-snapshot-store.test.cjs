'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ingestBrowserSnapshot, getBrowserSnapshot } = require('../server-app/server/lib/browserSnapshotStore');
const ledger = require('../server-app/server/lib/decisionLedger');
const rounds = require('../server-app/server/routes/decisionRounds')._test;
const { normalizeBrowserBoostCapture } = require('../server-app/server/lib/browserBoostSnapshot');
const { main: importBrowserSnapshot } = require('../tools/import-browser-snapshot.cjs');
const { assertCaptureAccountMapping } = require('../server-app/server/routes/browserSnapshot')._test;
const { requireLocalRecordAuth, requireWriteAuth } = require('../server-app/server/lib/utils');

const LOCAL_ACCOUNT = 'account_test_60000005';
const ADVERTISER_ID = '60000005';

function fixture(account = LOCAL_ACCOUNT, advertiserId = ADVERTISER_ID) {
  const from = '2026-09-22';
  const to = '2026-09-23';
  return {
    schema_version: '1.0',
    binding: { account_id: account, advertiser_id: advertiserId, primary_ad_id: 'ad_123', target_ids: ['task_42'] },
    page: {
      account_id: account, advertiser_id: advertiserId, primary_ad_id: 'ad_123', date_range: [from, to],
      url: `https://qianchuan.jinritemai.com/overall-prom/detail?aavid=${advertiserId}&adId=ad_123&dateRange=%5B%22${from}%22%2C%22${to}%22%5D`,
      headers: ['调控任务', '调控状态', '预算', '调控消耗', '调控成交订单数', '调控综合营销ROI'],
      rows: [['追投任务 ID: task_42', '投放中', '100', '35', '2', '2.3']], total_count: 1,
    },
    timing: {
      captured_at: '2026-09-23T02:00:00.000Z',
      refresh_started_at: '2026-09-23T01:59:50.000Z',
      refresh_completed_at: '2026-09-23T02:00:00.000Z',
    },
    snapshot_id: 'caller-controlled-id',
    metrics: { spend: 999999, net_roi: 888 },
    actions: [{ code: 'CHANGE_BUDGET', success: true }],
  };
}

test('ingestion persists a hash-verified browser snapshot idempotently and can bind it to a watch round', t => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-snapshot-'));
  const oldMemoryDir = process.env.AGENT_MEMORY_DIR;
  process.env.AGENT_MEMORY_DIR = baseDir;
  t.after(() => {
    ledger.closeAll();
    if (oldMemoryDir == null) delete process.env.AGENT_MEMORY_DIR;
    else process.env.AGENT_MEMORY_DIR = oldMemoryDir;
    fs.rmSync(baseDir, { recursive: true, force: true });
  });
  const now = Date.parse('2026-09-23T02:00:05.000Z');
  const capture = fixture();
  const first = ingestBrowserSnapshot(capture, { baseDir, now });
  const second = ingestBrowserSnapshot(capture, { baseDir, now });
  assert.equal(first.snapshot_persisted, true);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(first.snapshot_id, second.snapshot_id);
  assert.equal(first.summary.meta.source_type, 'browser_dom');
  assert.deepEqual(first.summary.metrics, {});
  assert.equal(first.summary.boosts[0].cost, 35);
  assert.equal(first.summary.actions, undefined);
  assert.equal(first.summary.snapshot_id, first.snapshot_id);
  assert.equal(ledger.getSnapshot(LOCAL_ACCOUNT, first.snapshot_id, { baseDir }).snapshot_id, first.snapshot_id);

  const bound = rounds.bindTrustedSnapshot(LOCAL_ACCOUNT, { phase: 'offline', snapshot_id: first.snapshot_id });
  assert.equal(bound.snapshot.verified, true);
  const savedRound = ledger.recordRound(LOCAL_ACCOUNT, { ...bound, round_id: 'browser-capture-round', observed_at: '2026-09-23T02:00:05.000Z' }, { baseDir });
  assert.equal(savedRound.round.snapshot.snapshot_id, first.snapshot_id);
  assert.deepEqual(savedRound.round.actions, []);
});

test('normalizer rejects account confusion and caller supplied metrics do not enter trusted metrics', () => {
  const capture = fixture();
  const summary = normalizeBrowserBoostCapture(capture, { now: new Date('2026-09-23T02:00:05.000Z') });
  assert.deepEqual(summary.metrics, {});
  assert.notEqual(summary.snapshot_id, capture.snapshot_id);
  const other = fixture('account_test_other', '60000045');
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-snapshot-mismatch-'));
  try {
    assert.throws(() => ingestBrowserSnapshot(other, { expectedAccount: LOCAL_ACCOUNT, baseDir }), { code: 'account_conflict' });
    assert.throws(() => ingestBrowserSnapshot(fixture(), { expectedAdvertiserId: '1234567890', baseDir }), { code: 'advertiser_mismatch' });
  } finally { fs.rmSync(baseDir, { recursive: true, force: true }); }
});

test('HTTP account binding resolves local account through registry and rejects advertiser id mismatch', () => {
  const capture = fixture();
  const resolver = account => account === LOCAL_ACCOUNT ? { id: account, aavid: ADVERTISER_ID } : null;
  assert.equal(assertCaptureAccountMapping(LOCAL_ACCOUNT, capture, resolver), ADVERTISER_ID);
  assert.throws(() => assertCaptureAccountMapping(LOCAL_ACCOUNT, fixture(LOCAL_ACCOUNT, '1234567890'), resolver), { code: 'advertiser_mismatch' });
  assert.throws(() => assertCaptureAccountMapping('60000005', capture, resolver), { code: 'account_conflict' });
  const pageConflict = fixture();
  pageConflict.page.account_id = 'account_test_other';
  assert.throws(() => assertCaptureAccountMapping(LOCAL_ACCOUNT, pageConflict, resolver), { code: 'account_conflict' });
  const bindingConflict = fixture();
  bindingConflict.binding.accountId = 'account_test_other';
  assert.throws(() => assertCaptureAccountMapping(LOCAL_ACCOUNT, bindingConflict, resolver), { code: 'account_conflict' });
});

test('browser snapshot reads recalculate age and freshness while preserving the observation evidence', t => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-snapshot-freshness-'));
  t.after(() => { ledger.closeAll(); fs.rmSync(baseDir, { recursive: true, force: true }); });
  const observedAt = Date.parse('2026-09-23T02:00:00.000Z');
  const capture = fixture();
  const ingested = ingestBrowserSnapshot(capture, { baseDir, now: observedAt + 5_000 });
  const snapshotId = ingested.snapshot_id;
  const freshRead = getBrowserSnapshot(LOCAL_ACCOUNT, snapshotId, { baseDir, now: observedAt + 5_000 });
  const staleRead = getBrowserSnapshot(LOCAL_ACCOUNT, snapshotId, { baseDir, now: observedAt + 100_001 });
  const stored = ledger.getSnapshot(LOCAL_ACCOUNT, snapshotId, { baseDir });

  assert.equal(freshRead.meta.age_ms, 5_000);
  assert.equal(freshRead.meta.freshness, 'partial');
  assert.equal(freshRead.meta.stale, false);
  assert.equal(staleRead.meta.age_ms, 100_001);
  assert.equal(staleRead.meta.freshness, 'stale');
  assert.equal(staleRead.meta.stale, true);
  assert.equal(staleRead.meta.source_at, capture.timing.captured_at);
  assert.equal(staleRead.meta.source_at_basis, 'captured_at is local observation time; page updated_at_label is not platform source time');
  assert.equal(staleRead.components.browser_capture.platform_generated_at, null);
  assert.equal(staleRead.components.browser_capture.capture_sha256, freshRead.components.browser_capture.capture_sha256);
  assert.deepEqual(staleRead.components.browser_capture.capture, capture);
  assert.equal(stored.meta.stale, false, 'read-time freshness must not rewrite the ledger record');
});

test('legacy read-only flag does not suppress capabilities; transport auth stays enforced', t => {
  const config = require('../server-app/server/lib/config');
  const originalToken = config.WRITE_API_TOKEN;
  const originalReadOnly = process.env.QC_TRIAL_READ_ONLY;
  process.env.QC_TRIAL_READ_ONLY = '1';
  config.WRITE_API_TOKEN = 'test-write-token';
  t.after(() => {
    config.WRITE_API_TOKEN = originalToken;
    if (originalReadOnly == null) delete process.env.QC_TRIAL_READ_ONLY;
    else process.env.QC_TRIAL_READ_ONLY = originalReadOnly;
  });
  const response = () => ({
    headersSent: false,
    writeHead(status) { this.statusCode = status; },
    end(body) { this.body = body; },
  });

  const localReq = { socket: { remoteAddress: '::ffff:127.0.0.1' }, headers: {} };
  const localRecordResponse = response();
  assert.equal(requireLocalRecordAuth(localReq, localRecordResponse), true);
  const adWriteResponse = response();
  assert.equal(requireWriteAuth(localReq, adWriteResponse), true);

  const remoteReq = { socket: { remoteAddress: '192.0.2.10' }, headers: {} };
  const noTokenResponse = response();
  assert.equal(requireLocalRecordAuth(remoteReq, noTokenResponse), false);
  assert.equal(noTokenResponse.statusCode, 401);
  const validTokenResponse = response();
  assert.equal(requireLocalRecordAuth({ ...remoteReq, headers: { authorization: 'Bearer test-write-token' } }, validTokenResponse), true);
});

test('CLI defaults to preview and supports explicit isolated ledger with same-receipt retry', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-snapshot-cli-'));
  const raw = path.join(root, 'raw.json');
  const receiptPath = path.join(root, 'receipt.json');
  const ledgerDir = path.join(root, 'isolated-ledger');
  const original = JSON.stringify(fixture());
  fs.writeFileSync(raw, original, { flag: 'wx' });
  t.after(() => { ledger.closeAll(); fs.rmSync(root, { recursive: true, force: true }); });

  const preview = importBrowserSnapshot(['--input', raw, '--output', receiptPath]);
  assert.equal(preview.preview, true);
  assert.equal(preview.persisted, false);
  assert.equal(preview.isolated, true);
  assert.equal(preview.registry_used, false);
  assert.equal(fs.existsSync(ledgerDir), false);
  assert.equal(fs.readFileSync(raw, 'utf8'), original);
  fs.unlinkSync(receiptPath);

  const saved = importBrowserSnapshot(['--input', raw, '--output', receiptPath, '--ledger-dir', ledgerDir]);
  assert.equal(saved.persisted, true);
  assert.equal(saved.duplicate, false);
  const retry = importBrowserSnapshot(['--input', raw, '--output', receiptPath, '--ledger-dir', ledgerDir]);
  assert.equal(retry.snapshot_id, saved.snapshot_id);
  assert.equal(fs.readFileSync(raw, 'utf8'), original);

  const childReceipt = path.join(root, 'child-receipt.json');
  const childLedger = path.join(root, 'child-ledger');
  const cliPath = path.resolve(__dirname, '../tools/import-browser-snapshot.cjs');
  const child = spawnSync(process.execPath, [cliPath, '--input', raw, '--output', childReceipt, '--ledger-dir', childLedger], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.match(fs.readFileSync(childReceipt, 'utf8'), /"registry_used": false/);
  assert.doesNotMatch(child.stderr, /已成功加载本地 config\.json/);
});
