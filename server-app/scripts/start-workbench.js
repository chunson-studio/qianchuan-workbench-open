'use strict';
process.env.TZ = 'Asia/Shanghai';
// 本地工作台入口：只读取本地配置、检查回环服务、启动本项目的 Node 进程。
// 不下载代码、不执行远程响应、不调用 PowerShell、不修改安全设置。
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const PROJECT = path.resolve(__dirname, '..');
const REQUIRED_MODULES = [
  'better-sqlite3', 'playwright-core', 'xlsx',
];

function entryIdentity(entry) {
  const absolute = path.resolve(entry);
  return crypto.createHash('sha256').update(process.platform === 'win32' ? absolute.toLowerCase() : absolute).digest('hex');
}
function settings(root = PROJECT, env = process.env) {
  const configRoot = path.resolve(env.QC_RUNTIME_CONFIG_ROOT || root);
  const configPath = path.join(configRoot, 'config.json');
  let config = {};
  if (fs.existsSync(configPath)) {
    try { config = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '')); }
    catch { throw new Error('配置文件无法读取，请联系部署人员检查 config.json。'); }
  }
  const rawPort = env.QC_PORT || env.PORT || config.port || 18991;
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('服务端口应为 1024～65535 的整数。');
  const host = env.QC_HOST || config.host || '127.0.0.1';
  if (!['127.0.0.1', 'localhost', '0.0.0.0', '::', '::1'].includes(host)) {
    throw new Error('快捷启动用于本机工作台；自定义网络地址请由部署人员使用 npm start。');
  }
  const connectHost = host === '::' || host === '::1' ? '::1' : '127.0.0.1';
  const url = `http://${connectHost === '::1' ? '[::1]' : connectHost}:${port}`;
  return { root, configRoot, port, host, url, entry: path.join(root, 'server.js'),
    logs: path.join(path.resolve(env.QC_RUNTIME_DATA_ROOT || configRoot), 'logs') };
}
function health(url, timeout = 1000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url + '/health/live', { timeout }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        text += chunk;
        if (text.length > 16384) req.destroy(new Error('本机健康检查响应异常。'));
      });
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) throw new Error('本机健康检查未成功。');
          resolve(JSON.parse(text));
        } catch { reject(new Error('端口上的服务无法识别，请核对后重试。')); }
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('本机健康检查超时。')));
    req.on('error', reject);
  });
}
function verifyHealth(value, entry, pid) {
  return value?.ok === true && value.component === 'http_process' &&
    value.entrypoint_id === entryIdentity(entry) && Number.isInteger(value.pid) &&
    (pid == null || value.pid === pid);
}
function checkEnvironment(options = {}) {
  const resolve = options.resolve || ((moduleName) => require.resolve(moduleName, { paths: [PROJECT] }));
  const failures = [];
  const version = process.versions.node.split('.').map(Number);
  const nodeOk = version[0] > 22 || (version[0] === 22 && version[1] >= 5);
  if (!nodeOk) {
    failures.push('需要 Node.js 22.5 或更新版本。');
  }
  try {
    const { DatabaseSync } = require('node:sqlite');
    const database = new DatabaseSync(':memory:');
    database.exec('CREATE TABLE workbench_check (ok INTEGER)');
    database.close();
  } catch {
    failures.push('Node 内置 SQLite 不可用；请使用带 node:sqlite 的 Node.js 22.5+，再重试环境检查。');
  }
  const missing = [];
  for (const moduleName of REQUIRED_MODULES) {
    try { resolve(moduleName); } catch { missing.push(moduleName); }
  }
  if (missing.length) {
    failures.push(`工作台依赖无法从项目解析：${missing.join('、')}；请由部署人员在 server-app 目录执行 npm install 后重试。`);
  }
  const sqlite = !failures.some(message => message.startsWith('Node 内置 SQLite'));
  return { ok: failures.length === 0, node: process.versions.node, nodeOk, sqlite, missingDependencies: missing, failures };
}
function checkReport(environment, config, configError) {
  const failures = environment.failures.map(message => ({
    code: message.startsWith('工作台依赖') ? 'missing_dependency' :
      message.startsWith('Node 内置 SQLite') ? 'sqlite_unavailable' : 'node_version',
    message,
    next: message.startsWith('工作台依赖') ? '请由部署人员在 server-app 目录执行 npm install 后重试。' : '请修复该环境问题后重试。',
  }));
  if (configError) failures.push({ code: 'invalid_config', message: configError.message, next: '请修正 config.json 或 QC_PORT/QC_HOST 后重试。' });
  return {
    ok: environment.ok && !configError,
    environment_ready: environment.ok,
    account_ready: 'not_checked',
    service_online: 'not_checked',
    checks: {
      node: { ok: environment.nodeOk, version: environment.node },
      sqlite: { ok: environment.sqlite },
      dependencies: { ok: environment.missingDependencies.length === 0, missing: environment.missingDependencies },
      config: { ok: !configError },
    },
    failures,
    next_steps: failures.map(item => item.next),
    ...(config && environment.ok && !configError ? { url: config.url + '/v4' } : {}),
  };
}
function jsonCheck() {
  const environment = checkEnvironment();
  let config = null, configError = null;
  try { config = settings(); } catch (error) { configError = error; }
  const report = checkReport(environment, config, configError);
  console.log(JSON.stringify(report));
  if (!report.ok) process.exitCode = 1;
  return report;
}
async function launch(config, options = {}) {
  const read = options.read || health;
  const start = options.start || spawn;
  let existing, occupied = true;
  try { existing = await read(config.url); }
  catch (error) {
    if (error.code !== 'ECONNREFUSED') throw error;
    occupied = false;
  }
  if (occupied) {
    if (!verifyHealth(existing, config.entry)) throw new Error(`端口 ${config.port} 已有其他或旧版服务，请核对后再启动；没有停止任何进程。`);
    return { url: config.url + '/v4', pid: existing.pid, reused: true };
  }
  fs.mkdirSync(config.logs, { recursive: true });
  const out = fs.openSync(path.join(config.logs, 'server_runtime.log'), 'a');
  const err = fs.openSync(path.join(config.logs, 'server_runtime.err.log'), 'a');
  let child, launchError;
  try {
    const childEnv = { ...(options.env || process.env), QC_DISABLE_BACKGROUND: '1' };
    delete childEnv.QC_TRIAL_READ_ONLY; // Retired execution mode; decisions belong to the Agent.
    child = start(process.execPath, [config.entry, `--port=${config.port}`], {
      cwd: config.root, windowsHide: true, detached: true, shell: false,
      stdio: ['ignore', out, err], env: childEnv,
    });
    child.on('error', error => { launchError = error; });
    child.unref();
  } finally { fs.closeSync(out); fs.closeSync(err); }
  const deadline = Date.now() + (options.readyTimeout || 15000);
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    try {
      const value = await read(config.url);
      if (verifyHealth(value, config.entry, child.pid)) return { url: config.url + '/v4', pid: child.pid, reused: false };
    } catch { /* 等待本次启动的进程就绪，响应仅解析 JSON。 */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`服务尚未就绪，请联系部署人员检查 ${path.join(config.logs, 'server_runtime.err.log')}。`);
}
async function healthReport(config = settings(), read = health) {
  const observed_at = new Date().toISOString();
  try {
    const value = await read(config.url);
    const ok = verifyHealth(value, config.entry);
    return { ok, code: ok ? 'service_healthy' : 'service_identity_mismatch', service_online: ok, observed_at, url: config.url, ...(ok ? { pid: value.pid } : {}) };
  } catch { return { ok: false, code: 'service_unreachable', service_online: false, observed_at, url: config.url }; }
}

async function main(args = process.argv.slice(2)) {
  if (args.includes('--health')) {
    const result = await healthReport();
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
    return result;
  }
  if (args.includes('--check') && args.includes('--json')) return jsonCheck();
  const environment = checkEnvironment();
  if (!environment.ok) throw new Error(`环境检查未通过：\n- ${environment.failures.join('\n- ')}`);
  const config = settings();
  if (args.includes('--check') || args.includes('-CheckOnly')) {
    console.log(`环境检查通过：Node.js ${environment.node}\nSQLite：可用\n工作台依赖：可解析\n工作台地址：${config.url}/v4\n未启动服务。`);
    return;
  }
  const result = await launch(config);
  console.log(`${result.reused ? '工作台已在运行' : '工作台已就绪'}：${result.url}\n服务在后台运行，关闭此窗口不会停止服务。`);
  if (args.includes('--open') || args.includes('-OpenBrowser')) {
    if (process.platform === 'win32') {
      const opener = spawn(path.join(process.env.SystemRoot || '', 'System32', 'rundll32.exe'), ['url.dll,FileProtocolHandler', result.url], { shell: false, windowsHide: true, stdio: 'ignore' });
      opener.on('error', () => console.error('请在浏览器中打开上面的工作台地址。'));
      opener.unref();
    } else console.log('请在浏览器中打开上面的工作台地址。');
  }
}
if (require.main === module) main().catch(error => { console.error('启动未完成：' + error.message); process.exitCode = 1; });
module.exports = { settings, entryIdentity, health, verifyHealth, checkEnvironment, checkReport, jsonCheck, launch, healthReport };
