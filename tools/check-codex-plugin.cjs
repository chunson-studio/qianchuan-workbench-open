'use strict';
// Isolated, synthetic acceptance. Never load the developer's live configuration.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const candidate = path.resolve(process.argv[2]);
const codex = path.resolve(process.argv[3]);
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const build = read(path.join(candidate, 'build.json'));
const marketplace = path.join(candidate, 'extracted', 'qianchuan-local');
const codexHome = path.join(candidate, 'test-codex-home');
const runtime = path.join(candidate, 'test-runtime');
const cwd = path.join(candidate, 'test-workspace');
for (const dir of [codexHome, cwd]) fs.mkdirSync(dir, { recursive: true });
const env = { ...process.env, CODEX_HOME: codexHome, QC_PLUGIN_HOME: runtime, QC_PLUGIN_PORT: '19391' };
delete env.NODE_PATH;
const checks = [], ownedPids = [];
const check = (name, value = true) => { assert.ok(value, name); checks.push(name); };
const run = (exe, args, extra = {}) => execFileSync(exe, args, { env, cwd, encoding: 'utf8', timeout: 180000, maxBuffer: 1e6, windowsHide: true, ...extra });
async function main() {
  const evidence = { schema_version: 1, started_at: new Date().toISOString(), source_archive_sha256: build.source_archive_sha256, installer_sha256: build.installer_sha256, real_accounts: false, advertising_calls: 0, checks };
  let servicePid, configBytes, configPath;
  try {
    check('actual_installer_sha', hash(fs.readFileSync(build.installer_archive)) === build.installer_sha256);
    const extractedPlugin = path.join(marketplace, 'plugins', 'qianchuan-workbench');
    const inventory = read(path.join(extractedPlugin, 'PLUGIN_MANIFEST.json'));
    for (const [name, digest] of Object.entries(inventory.files)) assert.equal(hash(fs.readFileSync(path.join(extractedPlugin, name))), digest);
    check('all_extracted_plugin_hashes', true);
    evidence.marketplace = JSON.parse(run(codex, ['plugin', 'marketplace', 'add', marketplace, '--json']));
    evidence.install = JSON.parse(run(codex, ['plugin', 'add', 'qianchuan-workbench@qianchuan-local', '--json']));
    check('isolated_codex_install', evidence.install.installedPath.startsWith(codexHome));
    const list = JSON.parse(run(codex, ['plugin', 'list', '--json']));
    check('codex_plugin_enabled', list.installed.some(p => p.pluginId === 'qianchuan-workbench@qianchuan-local' && p.enabled));
    const installed = evidence.install.installedPath;
    const entry = path.join(installed, 'bin', 'bridge.cjs');
    const adapter = require(entry);
    const cfg = adapter.settings(env, installed);
    check('data_outside_cache', !runtime.startsWith(installed));
    assert.throws(() => adapter.contained(installed, '../config.json')); check('traversal_rejected');
    assert.throws(() => adapter.settings({ ...env, QC_PLUGIN_HOME: installed }, installed), /runtime_must_be_outside/); check('cache_runtime_rejected');
    check('runtime_environment_bound', adapter.runtimeEnvironment(cfg, { NODE_PATH: 'bad', QC_PORT: '18991' }).QC_PORT === '19391' && !adapter.runtimeEnvironment(cfg, { NODE_PATH: 'bad' }).NODE_PATH);
    const setup = JSON.parse(run(process.execPath, [entry, 'setup']));
    check('setup_without_service', setup.ok && !setup.service_started);
    const firstStatus = JSON.parse(run(process.execPath, [entry, 'status']));
    check('offline_status_not_ok', !firstStatus.ok && firstStatus.environment.ok && !firstStatus.service.ok);
    configBytes = fs.readFileSync(cfg.configPath); configPath = cfg.configPath;
    run(process.execPath, [entry, 'setup']);
    check('repeat_setup_preserves_config', fs.readFileSync(cfg.configPath).equals(configBytes));
    const lockFile = path.join(cfg.app, 'server-app', '.plugin-install.json');
    const completion = fs.readFileSync(lockFile); fs.writeFileSync(lockFile, '{}');
    check('incomplete_dependencies_detected', !adapter.environmentCheck(cfg).installComplete);
    fs.writeFileSync(lockFile, completion);
    fs.writeFileSync(cfg.configPath, '{"sensitive":"synthetic-do-not-echo",');
    assert.throws(() => adapter.settings(env, installed), error => error.message === 'local_json_unreadable: config.json');
    check('invalid_config_no_content_echo'); fs.writeFileSync(cfg.configPath, configBytes);
    let routed;
    const fake = { launcher: { health: async () => ({ ok: true }), verifyHealth: () => true }, service: { url: 'http://127.0.0.1:19391', entry: 'test' }, result: { pid: 1 } };
    await adapter.bindFetchIdentity(cfg, fake, async address => { routed = String(address); })('http://localhost:19391/api/onboarding');
    check('verified_ipv4_endpoint_used', routed === 'http://127.0.0.1:19391/api/onboarding');
    fake.launcher.verifyHealth = () => false;
    await assert.rejects(adapter.bindFetchIdentity(cfg, fake, async () => { throw new Error('must_not_reach'); })('http://localhost:19391/api/onboarding'), /identity_changed/);
    check('identity_mismatch_blocks_business_request');
    const launcher = require(path.join(cfg.app, 'server-app', 'scripts', 'start-workbench.js'));
    await assert.rejects(launcher.launch(launcher.settings(path.join(cfg.app, 'server-app'), adapter.runtimeEnvironment(cfg)), { read: async () => ({ ok: true, pid: 1, component: 'http_process', entrypoint_id: 'wrong' }), start: () => { throw new Error('must_not_spawn'); } }), /已有其他或旧版/);
    check('occupied_foreign_port_rejected');
    run(process.execPath, [entry, 'start']);
    check('no_mcp_registration', !fs.existsSync(path.join(extractedPlugin, 'mcp.json')));
    const status = JSON.parse(run(process.execPath, [entry, 'status']));
    servicePid = status.service.pid; ownedPids.push(servicePid);
    check('live_service_identity', status.ok && status.service.ok && Number.isInteger(servicePid)); evidence.service = status.service;
    const page = await fetch(status.service.url + '/v4/'); check('workbench_http_200', page.status === 200 && (await page.text()).includes('<html'));
    // Synthetic configured account exists solely in this isolated test root.
    const synthetic = JSON.parse(configBytes); synthetic.qianchuan_accounts = [{ id: 'plugin-synthetic', name: 'Synthetic', aavid: '60000003' }];
    fs.writeFileSync(cfg.configPath, JSON.stringify(synthetic));
    const csv = path.join(candidate, 'synthetic-report.csv');
    fs.writeFileSync(csv, '\uFEFF日期,整体消耗,整体成交订单数,整体成交金额\n2026-09-29,10,2,100\n');
    const preview = JSON.parse(run(process.execPath, [entry, 'report-import', '--file', csv, '--account-id', 'plugin-synthetic', '--start', '2026-09-29', '--end', '2026-09-29']));
    evidence.report_preview = preview;
    check('cli_preview_uses_plugin_configuration', preview.ok && preview.status === 'preview' && preview.account_id === 'plugin-synthetic' && !preview.database_write_attempted);
    fs.writeFileSync(cfg.configPath, configBytes);
    evidence.ok = true;
  } catch (error) { evidence.ok = false; evidence.error = error.message; process.exitCode = 1; }
  finally {
    if (configBytes && configPath) fs.writeFileSync(configPath, configBytes);
    if (!servicePid) {
      try {
        const receipt = read(path.join(runtime, 'service.json'));
        if (!receipt.reused && receipt.entry.startsWith(runtime + path.sep)) {
          const health = await fetch(receipt.url.replace(/\/v4$/, '') + '/health/live').then(r => r.json());
          if (health.pid === receipt.pid && health.entrypoint_id === hash(process.platform === 'win32' ? receipt.entry.toLowerCase() : receipt.entry)) servicePid = receipt.pid;
        }
      } catch {}
    }
    if (servicePid) { try { process.kill(servicePid); } catch {} }
    evidence.owned_pids = ownedPids;
    evidence.finished_at = new Date().toISOString();
    fs.writeFileSync(path.join(candidate, 'acceptance.json'), JSON.stringify(evidence, null, 2) + '\n');
    process.stdout.write(JSON.stringify({ ok: evidence.ok, passed: checks.length, error: evidence.error, evidence: path.join(candidate, 'acceptance.json') }) + '\n');
  }
}
main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
