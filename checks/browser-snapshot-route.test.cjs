'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const config = require('../server-app/server/lib/config');
const ledger = require('../server-app/server/lib/decisionLedger');
const handleBrowserSnapshot = require('../server-app/server/routes/browserSnapshot');

const LOCAL_ACCOUNT = 'account_route_test_60000005';
const OTHER_ACCOUNT = 'account_route_test_other';
const ADVERTISER_ID = '60000005';
const OTHER_ADVERTISER_ID = '60000045';

function fixture(account = LOCAL_ACCOUNT, advertiserId = ADVERTISER_ID) {
  const from = '2026-09-22';
  const to = '2026-09-23';
  const capturedAt = new Date(Date.now() - 2_000).toISOString();
  const refreshStartedAt = new Date(Date.parse(capturedAt) - 500).toISOString();
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
      captured_at: capturedAt,
      refresh_started_at: refreshStartedAt,
      refresh_completed_at: capturedAt,
    },
  };
}

function requestJson(port, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, method, path: pathname,
      headers: body == null ? {} : { 'Content-Type': 'application/json' } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        try {
          resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        } catch (error) { reject(error); }
      });
    });
    request.on('error', reject);
    if (body != null) request.write(JSON.stringify(body));
    request.end();
  });
}

test('isolated HTTP route ingests, rereads, and isolates browser snapshots under trial read-only mode', async t => {
  const oldReadOnly = process.env.QC_TRIAL_READ_ONLY;
  const oldMemoryDir = process.env.AGENT_MEMORY_DIR;
  const oldAccounts = config.QIANCHUAN_ACCOUNTS.slice();
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-snapshot-route-'));
  process.env.QC_TRIAL_READ_ONLY = '1';
  process.env.AGENT_MEMORY_DIR = memoryDir;
  config.QIANCHUAN_ACCOUNTS.splice(0, config.QIANCHUAN_ACCOUNTS.length,
    { id: LOCAL_ACCOUNT, aavid: ADVERTISER_ID },
    { id: OTHER_ACCOUNT, aavid: OTHER_ADVERTISER_ID },
  );
  const server = http.createServer((req, res) => handleBrowserSnapshot(req, res, new URL(req.url, 'http://127.0.0.1')));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    ledger.closeAll();
    config.QIANCHUAN_ACCOUNTS.splice(0, config.QIANCHUAN_ACCOUNTS.length, ...oldAccounts);
    if (oldReadOnly == null) delete process.env.QC_TRIAL_READ_ONLY;
    else process.env.QC_TRIAL_READ_ONLY = oldReadOnly;
    if (oldMemoryDir == null) delete process.env.AGENT_MEMORY_DIR;
    else process.env.AGENT_MEMORY_DIR = oldMemoryDir;
    fs.rmSync(memoryDir, { recursive: true, force: true });
  });

  const capture = fixture();
  const query = `?account=${LOCAL_ACCOUNT}`;
  const first = await requestJson(port, 'POST', `/api/browser-snapshot${query}`, { account_id: LOCAL_ACCOUNT, capture });
  assert.equal(first.status, 201);
  assert.equal(first.body.ok, true);
  assert.equal(first.body.snapshot_persisted, true);
  assert.equal(first.body.duplicate, false);
  assert.equal(first.body.summary.meta.source_type, 'browser_dom');
  assert.equal(first.body.summary.meta.freshness, 'partial');

  const duplicate = await requestJson(port, 'POST', `/api/browser-snapshot${query}`, { account_id: LOCAL_ACCOUNT, capture });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.duplicate, true);
  assert.equal(duplicate.body.snapshot_id, first.body.snapshot_id);

  const readPath = `/api/browser-snapshot${query}&snapshot_id=${first.body.snapshot_id}`;
  const read = await requestJson(port, 'GET', readPath);
  assert.equal(read.status, 200);
  assert.equal(read.body.snapshot.snapshot_id, first.body.snapshot_id);
  assert.equal(read.body.snapshot.meta.source_at, capture.timing.captured_at);
  assert.equal(read.body.snapshot.meta.stale, false);
  assert.equal(read.body.snapshot.meta.source_at_basis, 'captured_at is local observation time; page updated_at_label is not platform source time');
  assert.deepEqual(read.body.snapshot.components.browser_capture.capture, capture);

  const queryBodyConflict = await requestJson(port, 'POST', `/api/browser-snapshot${query}`, {
    account_id: OTHER_ACCOUNT, capture,
  });
  assert.equal(queryBodyConflict.status, 400);
  assert.equal(queryBodyConflict.body.ok, false);
  assert.equal(queryBodyConflict.body.code, 'account_conflict');

  const pageAccountConflictCapture = fixture();
  pageAccountConflictCapture.page.account_id = OTHER_ACCOUNT;
  const pageAccountConflict = await requestJson(port, 'POST', `/api/browser-snapshot${query}`, {
    account_id: LOCAL_ACCOUNT, capture: pageAccountConflictCapture,
  });
  assert.equal(pageAccountConflict.status, 400);
  assert.equal(pageAccountConflict.body.code, 'account_conflict');
  assert.equal(pageAccountConflict.body.snapshot_persisted, undefined);

  const bindingConflictCapture = fixture();
  bindingConflictCapture.binding.accountId = OTHER_ACCOUNT;
  const bindingConflict = await requestJson(port, 'POST', `/api/browser-snapshot${query}`, {
    account_id: LOCAL_ACCOUNT, capture: bindingConflictCapture,
  });
  assert.equal(bindingConflict.status, 400);
  assert.equal(bindingConflict.body.code, 'account_conflict');

  const advertiserMismatch = await requestJson(port, 'POST', `/api/browser-snapshot${query}`, {
    account_id: LOCAL_ACCOUNT, capture: fixture(LOCAL_ACCOUNT, '60000003'),
  });
  assert.equal(advertiserMismatch.status, 400);
  assert.equal(advertiserMismatch.body.ok, false);
  assert.equal(advertiserMismatch.body.code, 'advertiser_mismatch');

  const otherAccountRead = await requestJson(port, 'GET', `/api/browser-snapshot?account=${OTHER_ACCOUNT}&snapshot_id=${first.body.snapshot_id}`);
  assert.equal(otherAccountRead.status, 404);
  assert.equal(otherAccountRead.body.code, 'snapshot_not_found');

  const localRegistration = config.QIANCHUAN_ACCOUNTS.find(account => account.id === LOCAL_ACCOUNT);
  const registeredAdvertiser = localRegistration.aavid;
  localRegistration.aavid = OTHER_ADVERTISER_ID;
  const changedMappingRead = await requestJson(port, 'GET', readPath);
  localRegistration.aavid = registeredAdvertiser;
  assert.equal(changedMappingRead.status, 400);
  assert.equal(changedMappingRead.body.code, 'advertiser_mismatch');
});
