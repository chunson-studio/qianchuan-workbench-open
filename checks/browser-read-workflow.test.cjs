'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const workflow = import(pathToFileURL(path.resolve(__dirname, '../tools/codex-qc-read-workflow.mjs')).href);
const cfg = { account_id: 'test_account', advertiser_id: 'adv', primary_ad_id: 'plan', date: '2026-09-23' };
async function runRoot() {
  const parent = require('./test-output.cjs').testOutputRoot();
  await fs.mkdir(parent, { recursive: true });
  return fs.mkdtemp(path.join(parent, 'read-workflow-'));
}
function invalidTab(url) {
  return { playwright: {}, url: url || (async () => 'https://example.com/'),
    reload: async () => { throw new Error('must not refresh a wrong identity'); }, getAXState: async () => '' };
}

test('identity failure saves a fresh failure record, never a receipt or old success', async () => {
  const { runQianchuanReadWorkflow } = await workflow;
  const root = await runRoot();
  const first = await runQianchuanReadWorkflow(invalidTab(), cfg, { run_root: root });
  const second = await runQianchuanReadWorkflow(invalidTab(), cfg, { run_root: root });
  assert.notEqual(first.run_dir, second.run_dir);
  for (const result of [first, second]) {
    assert.equal(result.ok, false);
    assert.equal(result.stage, 'capture');
    assert.equal(result.persistence, 'not_started');
    assert.equal(result.advertising_writes, 0);
    const failure = JSON.parse(await fs.readFile(path.join(result.run_dir, 'workflow-failure.json'), 'utf8'));
    assert.deepEqual(failure, result);
    assert.equal((await fs.readdir(result.run_dir)).includes('receipt.json'), false);
  }
});

test('rejects overlapping reads of the same tab and releases the guard after failure', async () => {
  const { runQianchuanReadWorkflow } = await workflow;
  const root = await runRoot();
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const tab = invalidTab(async () => { entered(); await pending; return 'https://example.com/'; });
  const options = { run_root: root, tab_key: 'browser-test:tab-1' };
  const first = runQianchuanReadWorkflow(tab, cfg, options);
  await started;
  await assert.rejects(runQianchuanReadWorkflow(invalidTab(), cfg, options), /正在读取/);
  release();
  assert.equal((await first).ok, false);
  const retry = await runQianchuanReadWorkflow(invalidTab(), cfg, options);
  assert.equal(retry.stage, 'capture');
  assert.equal((await fs.readdir(root)).length, 2);
});

test('requires explicit binding before making files or touching the browser', async () => {
  const { runQianchuanReadWorkflow } = await workflow;
  await assert.rejects(runQianchuanReadWorkflow(invalidTab(), { advertiser_id: 'adv' }), /必须显式绑定/);
});

test('rejects CDP adapters before connecting or making a CUA run', async () => {
  const { runQianchuanReadWorkflow } = await workflow;
  const root = await runRoot();
  let connected = false;
  const adapter = { async connect() { connected = true; } };
  await assert.rejects(runQianchuanReadWorkflow(undefined, cfg, {
    browser_adapter: adapter, run_root: root,
  }), /read_boost_table/);
  assert.equal(connected, false);
  assert.deepEqual(await fs.readdir(root), []);
});

test('CDP identity and registry cannot be passed through the CUA entry', async () => {
  const { runQianchuanReadWorkflow } = await workflow;
  for (const options of [
    { playwright_bindings_file: 'must-not-be-read.json' },
    { browser_identity: { browserType: 'playwright-cdp' } },
  ]) {
    await assert.rejects(runQianchuanReadWorkflow(invalidTab(), cfg, options), /read_boost_table/);
  }
});

test('records the verified Chrome Profile binding on a read failure', async () => {
  const { runQianchuanReadWorkflow } = await workflow;
  const root = await runRoot();
  const bindingsFile = path.join(root, 'browser-bindings.json');
  await fs.writeFile(bindingsFile, JSON.stringify({
    schema_version: 1,
    bindings: [{
      account_id: cfg.account_id,
      advertiser_id: cfg.advertiser_id,
      primary_ad_id: cfg.primary_ad_id,
      browser_type: 'extension',
      extension_instance_id: 'extension-test',
      profile_name: 'Profile Test',
      status: 'active',
    }],
  }));
  const result = await runQianchuanReadWorkflow(invalidTab(), cfg, {
    run_root: root,
    profile_bindings_file: bindingsFile,
    browser_identity: {
      browserId: 'runtime-test',
      browserType: 'extension',
      profileName: 'Profile Test',
      metadata: { extensionInstanceId: 'extension-test' },
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.registry_used, true);
  assert.equal(result.browser_binding.profile_name, 'Profile Test');
  assert.equal(result.browser_binding.evidence.browser_id_scope, 'runtime_only');
  assert.equal(result.advertising_writes, 0);
});
