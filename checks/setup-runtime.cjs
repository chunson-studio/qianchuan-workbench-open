'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const https = require('node:https');
const parent = require('./test-output.cjs').testOutputRoot();
fs.mkdirSync(parent, { recursive: true });
const root = fs.mkdtempSync(path.join(parent, 'run-'));
Object.assign(process.env, {
  QC_RUNTIME_CONFIG_ROOT: root, QC_RUNTIME_DATA_ROOT: root, AGENT_MEMORY_DIR: path.join(root, 'agent-memory'),
  QC_DISABLE_BACKGROUND: '1', QC_TRIAL_READ_ONLY: '1', QC_TEST_NETWORK_BLOCKED: '1',
});
fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ qianchuan_accounts: [], accounts: [] }));
https.request = () => {
  const req = new EventEmitter();
  req.setTimeout = () => req;
  req.write = () => true;
  req.end = () => queueMicrotask(() => req.emit('error', new Error('test_network_blocked')));
  req.destroy = () => req;
  return req;
};
global.fetch = () => Promise.reject(new Error('test_network_blocked'));
