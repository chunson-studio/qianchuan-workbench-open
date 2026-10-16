'use strict';
require('./setup-runtime.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const opLog = require('../server-app/server/lib/operationLog');
const { executeWithReceipt } = require('../server-app/server/lib/writeReceipt');
const base = id => ({ before: { duration_seconds: 21600 }, requested: { duration_seconds: 23400 },
  logEntry: { action: 'update_duration', account_id: 'batch-receipt-test', target_id: id, params: {} },
  read: async () => ({ duration_seconds: 23400 }) });

test('batch still running cannot confirm even when a matching value is observed, but occupies cooldown', async () => {
  const result = await executeWithReceipt({ ...base('71'), write: async () => ({ status_code: 0,
    confirmation_pending: true, confirmation_reason: 'upstream_batch_running', data: { results: [{ status: 1 }] } }) });
  assert.equal(result.ok, true);
  assert.equal(result.effect_status, 'unconfirmed');
  assert.equal(result.readback.verified, false);
  assert.equal(result.readback.reason, 'upstream_batch_running');
  assert.equal(result.retry_write, false);
  assert.equal(opLog.getById(result.operation_id).success, true);
  assert.equal(opLog.getById(result.operation_id).params.receipt.effect_status, 'unconfirmed');
});

test('explicit per-item rejection is rejected without pretending that no request was sent', async () => {
  let reads = 0;
  const result = await executeWithReceipt({ ...base('72'), write: async () => { throw Object.assign(new Error('预算低于已消耗'), {
    code: 'batch_update_rejected', statusCode: 409, upstream_rejected: true,
  }); }, read: async () => { reads++; } });
  assert.equal(result.ok, false);
  assert.equal(result.effect_status, 'rejected');
  assert.equal(result.advertising_writes, undefined);
  assert.equal(result.error, '预算低于已消耗');
  assert.equal(result.code, 'batch_update_rejected');
  assert.equal(reads, 0);
  assert.equal(opLog.getById(result.operation_id).success, false);
});

test('successful batch plus actual value and durable receipt confirms duration', async () => {
  const result = await executeWithReceipt({ ...base('73'), write: async () => ({ status_code: 0, data: { results: [{ status: 2 }] } }) });
  assert.equal(result.effect_status, 'confirmed');
  assert.equal(result.actual.duration_seconds, 23400);
  assert.equal(opLog.getById(result.operation_id).params.receipt.readback.verified, true);
});
