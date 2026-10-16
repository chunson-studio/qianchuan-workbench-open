'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (!args.length) {
  console.error('Usage: node checks/run-tests.cjs <test-file...>');
  process.exitCode = 2;
} else {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qianchuan-tests-'));
  const runId = randomUUID();
  fs.writeFileSync(path.join(root, '.qc-test-owner.json'), JSON.stringify({
    root, run_id: runId, owner_pid: process.pid, purpose: 'synthetic_test_output',
  }), { flag: 'wx' });
  const result = spawnSync(process.execPath, ['--test', ...args], {
    cwd: path.resolve(__dirname, '..'), stdio: 'inherit', windowsHide: true,
    env: { ...process.env, QC_TEST_RUN_ROOT: root, QC_TEST_RUN_ID: runId,
      FLOW_BASELINE_CACHE_DIR: path.join(root, 'flow-baseline', 'cache'),
      FLOW_BASELINE_REPLAY_DIR: path.join(root, 'flow-baseline', 'replay') },
  });
  process.exitCode = result.status ?? 1;
  if (result.error) console.error(result.error.message);
  if (process.env.QC_KEEP_TEST_OUTPUT === '1' || process.platform !== 'win32') {
    console.error(`Test output retained: ${root}`);
  } else {
    const cleanup = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive',
      '-WindowStyle', 'Hidden', '-File', path.join(__dirname, 'recycle-test-output.ps1'),
      '-RootPath', root, '-OwnerPid', String(process.pid), '-RunId', runId, '-Finished'],
    { stdio: 'inherit', windowsHide: true, timeout: 60000 });
    if (cleanup.status !== 0 || fs.existsSync(root)) {
      console.error(`Test output cleanup pending: ${root}`);
      if (process.exitCode === 0) process.exitCode = 2;
    }
  }
}
