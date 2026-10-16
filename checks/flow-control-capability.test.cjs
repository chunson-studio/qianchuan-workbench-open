'use strict';
require('./setup-runtime.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { runFlowControlBrowserWrite, WRITER_SCRIPT } = require('../server-app/server/lib/flowControlBrowser');
const { executeWithReceipt } = require('../server-app/server/lib/writeReceipt');

const request = { accountId: 'flow_test', primaryAdId: '10001', budgetYuan: 100, durationSeconds: 1800 };
function record(write) {
  return executeWithReceipt({ write, read: async () => ({ active: true }),
    requested: { active: true }, before: { active: false },
    logEntry: { account_id: request.accountId, target_id: request.primaryAdId,
      target_type: 'flow_control', action: 'start_flow_control', source: 'test' } });
}

test('missing flow-control writer rejects before spawn and preserves zero-write proof in the receipt', async () => {
  let spawnCalls = 0;
  const receipt = await record(() => runFlowControlBrowserWrite(request, {
    statSyncImpl: file => {
      assert.equal(file, WRITER_SCRIPT);
      throw Object.assign(new Error('missing fixture'), { code: 'ENOENT' });
    },
    spawnImpl: () => { spawnCalls++; throw new Error('must not spawn'); },
  }));
  assert.equal(spawnCalls, 0);
  assert.equal(receipt.ok, false);
  assert.equal(receipt.code, 'capability_unavailable');
  assert.equal(receipt.http_status, 503);
  assert.equal(receipt.advertising_writes, 0);
  assert.equal(receipt.effect_status, 'rejected');
  assert.equal(receipt.details.next_step, 'restore_and_verify_writer');
  assert.equal(receipt.readback.reason, 'rejected_before_write');
});

test('an available writer failing after dispatch keeps the advertising result unknown', async () => {
  let spawnCalls = 0;
  const receipt = await record(() => runFlowControlBrowserWrite(request, {
    statSyncImpl: () => ({ isFile: () => true }),
    spawnImpl: () => {
      spawnCalls++;
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => {
        child.stderr.emit('data', 'connection lost after submit');
        child.emit('exit', 1);
      });
      return child;
    },
  }));
  assert.equal(spawnCalls, 1);
  assert.equal(receipt.code, 'flow_control_browser_failed');
  assert.equal(receipt.effect_status, 'unconfirmed');
  assert.equal(receipt.advertising_writes, undefined);
  assert.equal(receipt.retry_write, false);
  assert.equal(receipt.readback.verified, false);
});
