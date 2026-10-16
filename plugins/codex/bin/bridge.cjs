'use strict';
// 本地工作台与浏览器步骤入口。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const PLUGIN = path.resolve(__dirname, '..');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const json = file => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch { throw new Error('local_json_unreadable: ' + path.basename(file)); }
};

function contained(root, name) {
  if (typeof name !== 'string' || name.includes('\\') || name.includes(':') || name.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('invalid_package_path');
  const target = path.resolve(root, name);
  if (!target.startsWith(path.resolve(root) + path.sep)) throw new Error('invalid_package_path');
  let part = root;
  for (const item of name.split('/')) {
    part = path.join(part, item);
    if (fs.existsSync(part) && fs.lstatSync(part).isSymbolicLink()) throw new Error('linked_package_path');
  }
  return target;
}
function settings(env = process.env, plugin = PLUGIN) {
  const manifest = json(path.join(plugin, 'runtime-manifest.json'));
  if (manifest.schema_version !== 1 || !/^[a-f0-9]{64}$/.test(manifest.payload_sha256) || !manifest.files || !Object.keys(manifest.files).length) throw new Error('invalid_runtime_manifest');
  const defaultRoot = process.platform === 'win32'
    ? path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'QianchuanWorkbench')
    : path.join(os.homedir(), '.local', 'share', 'qianchuan-workbench');
  const root = env.QC_PLUGIN_HOME || defaultRoot;
  if (!path.isAbsolute(root)) throw new Error('QC_PLUGIN_HOME must be absolute');
  if (path.resolve(root) === path.resolve(plugin) || path.resolve(root).startsWith(path.resolve(plugin) + path.sep)) throw new Error('runtime_must_be_outside_plugin_cache');
  const app = path.join(root, 'versions', manifest.payload_sha256.slice(0, 20), 'app');
  const configRoot = path.join(root, 'config');
  const dataRoot = path.join(root, 'data');
  const configPath = path.join(configRoot, 'config.json');
  const existing = fs.existsSync(configPath) ? json(configPath) : {};
  const port = Number(env.QC_PLUGIN_PORT || existing.port || 19091);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('invalid_plugin_port');
  return { plugin, manifest, root: path.resolve(root), app, configRoot, dataRoot, configPath, port };
}
function runtimeEnvironment(cfg, env = process.env) {
  const result = { ...env, QC_RUNTIME_CONFIG_ROOT: cfg.configRoot, QC_RUNTIME_DATA_ROOT: cfg.dataRoot,
    QC_PORT: String(cfg.port), QC_HOST: '127.0.0.1', QC_DISABLE_BACKGROUND: '1',
    QC_OFFICIAL_SKILL_DIR: path.join(cfg.app, 'skills', 'qianchuan-ops') };
  delete result.NODE_PATH;
  delete result.QC_TRIAL_READ_ONLY;
  return result;
}
function materialize(cfg) {
  for (const [relative, expected] of Object.entries(cfg.manifest.files)) {
    const source = contained(cfg.plugin, relative);
    const bytes = fs.readFileSync(source);
    if (!/^[a-f0-9]{64}$/.test(expected) || hash(bytes) !== expected) throw new Error('package_hash_mismatch: ' + relative);
    const target = contained(cfg.app, relative);
    if (fs.existsSync(target)) {
      if (hash(fs.readFileSync(target)) !== expected) throw new Error('installed_source_changed: ' + relative);
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes, { flag: 'wx' });
    }
  }
  fs.mkdirSync(cfg.configRoot, { recursive: true });
  fs.mkdirSync(cfg.dataRoot, { recursive: true });
  if (!fs.existsSync(cfg.configPath)) {
    const blank = json(path.join(cfg.app, 'server-app', 'config.example.json'));
    if (['qianchuan_accounts', 'accounts', 'yuntu_accounts'].some(key => blank[key]?.length)) throw new Error('nonempty_account_template');
    blank.port = cfg.port;
    blank.host = '127.0.0.1';
    blank.scheduler = { ...blank.scheduler, enabled: false };
    fs.writeFileSync(cfg.configPath, JSON.stringify(blank, null, 2) + '\n', { flag: 'wx' });
  }
}
function environmentCheck(cfg) {
  const launcher = require(path.join(cfg.app, 'server-app', 'scripts', 'start-workbench.js'));
  const report = launcher.checkEnvironment();
  const appRoot = path.join(cfg.app, 'server-app');
  const missing = [];
  for (const name of ['better-sqlite3', 'playwright-core', 'xlsx']) {
    try {
      const resolved = require.resolve(name, { paths: [appRoot] });
      if (!resolved.startsWith(path.join(appRoot, 'node_modules') + path.sep)) throw new Error('dependency_outside_runtime');
      require(resolved);
    } catch { missing.push(name); }
  }
  let receipt;
  try { receipt = json(path.join(appRoot, '.plugin-install.json')); } catch {}
  const lock = hash(fs.readFileSync(path.join(appRoot, 'package-lock.json')));
  const complete = receipt?.lock_sha256 === lock && receipt?.node_abi === process.versions.modules;
  return { ...report, ok: report.ok && !missing.length && complete, missingDependencies: missing,
    installComplete: complete, failures: [...report.failures, ...missing.map(name => 'missing_runtime_dependency: ' + name), ...(!complete ? ['dependency_install_incomplete'] : [])] };
}
async function installDependencies(cfg) {
  const appRoot = path.join(cfg.app, 'server-app');
  const npmCli = process.env.QC_PLUGIN_NPM_CLI || path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!path.isAbsolute(npmCli) || !fs.existsSync(npmCli)) throw new Error('npm_cli_missing: Agent must install the existing package-lock.json with npm ci in ' + appRoot);
  const args = [npmCli, 'ci', '--omit=dev', '--no-audit', '--no-fund', '--prefer-offline', '--registry=https://registry.npmjs.org', '--fetch-retries=1', '--fetch-timeout=20000'];
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: appRoot, env: runtimeEnvironment(cfg), windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.resume(); // npm diagnostics may include local registry configuration; do not echo them.
    const timer = setTimeout(() => { child.kill(); reject(new Error('dependency_install_timeout')); }, 150000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('dependency_install_failed: exit=' + code + '; Agent should inspect local npm diagnostics')); });
  });
  fs.writeFileSync(path.join(appRoot, '.plugin-install.json'), JSON.stringify({ lock_sha256: hash(fs.readFileSync(path.join(appRoot, 'package-lock.json'))), node_abi: process.versions.modules }) + '\n');
}
async function prepare(cfg, install = true) {
  fs.mkdirSync(cfg.root, { recursive: true });
  const lock = path.join(cfg.root, 'prepare.lock');
  let fd;
  try { fd = fs.openSync(lock, 'wx'); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('plugin_setup_in_progress: retry after the other setup finishes; stale lock requires deployment inspection'); throw error; }
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
    materialize(cfg);
    let check = environmentCheck(cfg);
    if (!check.nodeOk || !check.sqlite) throw new Error(check.failures.join('; '));
    if ((!check.installComplete || check.missingDependencies.length) && install) { await installDependencies(cfg); check = environmentCheck(cfg); }
    if (!check.ok) throw new Error(check.failures.join('; '));
    return check;
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
async function start(cfg) {
  const launcher = require(path.join(cfg.app, 'server-app', 'scripts', 'start-workbench.js'));
  const env = runtimeEnvironment(cfg);
  const service = launcher.settings(path.join(cfg.app, 'server-app'), env);
  const result = await launcher.launch(service, { env });
  fs.writeFileSync(path.join(cfg.root, 'service.json'), JSON.stringify({ ...result, entry: service.entry, payload_sha256: cfg.manifest.payload_sha256, observed_at: new Date().toISOString() }, null, 2) + '\n');
  return { launcher, service, result };
}
function bindFetchIdentity(cfg, started, nativeFetch = globalThis.fetch) {
  return async (address, options) => {
    const url = new URL(typeof address === 'string' || address instanceof URL ? address : address.url);
    if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && Number(url.port) === cfg.port) {
      const observed = await started.launcher.health(started.service.url);
      if (!started.launcher.verifyHealth(observed, started.service.entry, started.result.pid)) throw new Error('plugin_service_identity_changed');
      if (url.protocol !== 'http:') throw new Error('invalid_plugin_service_protocol');
      url.hostname = '127.0.0.1';
      address = typeof address === 'string' || address instanceof URL ? url : new Request(url, address);
    }
    return nativeFetch(address, options);
  };
}
async function main(args = process.argv.slice(2)) {
  const command = args[0] || 'status';
  if (!['setup', 'start', 'status', 'report-import', 'watch-brief','browser-boost'].includes(command)) throw new Error('Usage: node bin/bridge.cjs setup|start|status|report-import|watch-brief|browser-boost');
  const cfg = settings();
  if (command === 'status') {
    const ready = fs.existsSync(path.join(cfg.app, 'server-app', 'scripts', 'start-workbench.js'));
    const report = { ok: ready, installed: ready, runtime_root: cfg.root, payload_sha256: cfg.manifest.payload_sha256, port: cfg.port, account_data: 'not_read' };
    if (ready) {
      const launcher = require(path.join(cfg.app, 'server-app', 'scripts', 'start-workbench.js'));
      report.environment = environmentCheck(cfg);
      report.service = await launcher.healthReport(launcher.settings(path.join(cfg.app, 'server-app'), runtimeEnvironment(cfg)));
      report.ok = report.environment.ok && report.service.ok;
    }
    process.stdout.write(JSON.stringify(report) + '\n');
    return report;
  }
  await prepare(cfg);
  if (command === 'setup') { process.stdout.write(JSON.stringify({ ok: true, runtime_root: cfg.root, app: cfg.app, service_started: false, background_collection: false }) + '\n'); return; }
  Object.assign(process.env, runtimeEnvironment(cfg));
  delete process.env.NODE_PATH;
  delete process.env.QC_TRIAL_READ_ONLY;
  if (command === 'report-import') {
    const result = require(path.join(cfg.app, 'tools', 'import-local-report.cjs')).run(args.slice(1));
    process.stdout.write(JSON.stringify(result) + '\n');
    if (!result.ok) process.exitCode = 1;
    return;
  }
  const started = await start(cfg);
  if (command === 'start') { process.stdout.write(JSON.stringify({ ok: true, ...started.result, background_collection: false }) + '\n'); return; }
  globalThis.fetch = bindFetchIdentity(cfg, started);
  if(command==='browser-boost')return require(path.join(cfg.app,'tools','browser-boost.cjs')).main(args.slice(1));
  if (command === 'watch-brief') {
    const options = {}, allowed = new Set(['--account-id', '--primary-ad-id', '--room-id', '--start-time', '--format']);
    for (let i = 1; i < args.length; i += 2) {
      if (!allowed.has(args[i]) || !args[i + 1] || options[args[i]]) throw new Error('invalid_watch_arguments');
      options[args[i]] = args[i + 1];
    }
    if (['--account-id', '--primary-ad-id', '--room-id', '--start-time'].some(key => !options[key])) throw new Error('required_watch_binding');
    const format = options['--format'] || 'heartbeat';
    if (!['heartbeat', 'json'].includes(format)) throw new Error('invalid_watch_format');
    const watch = require(path.join(cfg.app, 'tools', 'watch-brief.cjs'));
    if (!Number.isFinite(watch.time(options['--start-time']))) throw new Error('invalid_watch_start_time');
    const binding = { account_id: options['--account-id'], primary_ad_id: options['--primary-ad-id'], room_id: options['--room-id'], start_time: options['--start-time'] };
    const result = await watch.collectBrief({ binding, config: cfg.configPath, url: started.service.url });
    const directory = path.join(cfg.dataRoot, 'watch-brief', hash(JSON.stringify(binding)).slice(0, 20));
    fs.mkdirSync(directory, { recursive: true });
    const stem = new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex');
    const rawFile = path.join(directory, stem + '.raw.json'), briefFile = path.join(directory, stem + '.brief.json');
    fs.writeFileSync(rawFile, JSON.stringify(result.raw), { flag: 'wx' });
    result.brief.evidence_file = rawFile;
    fs.writeFileSync(briefFile, JSON.stringify(result.brief), { flag: 'wx' });
    process.stdout.write((format === 'heartbeat' ? watch.formatHeartbeat(result.brief, briefFile) : JSON.stringify(result.brief)) + '\n');
    if (!result.brief.ok) process.exitCode = 2;
    return;
  }

}
if (require.main === module) main().catch(error => { process.stderr.write('[qianchuan-plugin] ' + error.message + '\n'); process.exitCode = 1; });
module.exports = { contained, settings, runtimeEnvironment, materialize, environmentCheck, prepare, start, bindFetchIdentity };
