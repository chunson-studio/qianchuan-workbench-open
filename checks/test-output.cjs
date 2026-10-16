'use strict';

// Disposable fixtures belong to the system temp directory, never the customer workspace.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
let root;

function isolateLegacyFlowStorage() {
  // This module uses its own paths instead of QC_RUNTIME_DATA_ROOT.
  process.env.FLOW_BASELINE_CACHE_DIR = path.join(root, 'flow-baseline', 'cache');
  process.env.FLOW_BASELINE_REPLAY_DIR = path.join(root, 'flow-baseline', 'replay');
}

function testOutputRoot() {
  if (root) return root;
  if (process.env.QC_TEST_RUN_ROOT) {
    const parent = path.resolve(process.env.QC_TEST_RUN_ROOT);
    const owner = JSON.parse(fs.readFileSync(path.join(parent, '.qc-test-owner.json'), 'utf8'));
    if (path.dirname(parent) !== path.resolve(os.tmpdir()) ||
        !/^qianchuan-tests-[A-Za-z0-9]{6}$/.test(path.basename(parent)) ||
        owner.root !== parent || owner.run_id !== process.env.QC_TEST_RUN_ID ||
        owner.purpose !== 'synthetic_test_output' || fs.lstatSync(parent).isSymbolicLink()) {
      throw new Error('invalid_test_output_owner');
    }
    root = fs.mkdtempSync(path.join(parent, 'suite-'));
    isolateLegacyFlowStorage();
    return root;
  }
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'qianchuan-tests-'));
  isolateLegacyFlowStorage();
  const runId = randomUUID();
  fs.writeFileSync(path.join(root, '.qc-test-owner.json'), JSON.stringify({
    root, run_id: runId, owner_pid: process.pid, purpose: 'synthetic_test_output',
  }), { flag: 'wx' });
  process.once('exit', () => {
    if (process.env.QC_KEEP_TEST_OUTPUT === '1') {
      process.stderr.write(`Test output retained: ${root}\n`);
      return;
    }
    if (process.platform !== 'win32') {
      process.stderr.write(`Recycle cleanup is Windows-only; test output: ${root}\n`);
      return;
    }
    // Direct invocation is best effort; run-tests.cjs waits for cleanup before returning.
    const cleaner = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive',
      '-WindowStyle', 'Hidden', '-File', path.join(__dirname, 'recycle-test-output.ps1'),
      '-RootPath', root, '-OwnerPid', String(process.pid), '-RunId', runId],
    { detached: true, windowsHide: true, stdio: 'ignore' });
    cleaner.on('error', () => {});
    cleaner.unref();
  });
  return root;
}

module.exports = { testOutputRoot };
