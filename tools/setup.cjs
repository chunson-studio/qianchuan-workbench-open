'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SERVER_APP = path.join(ROOT, 'server-app');


function defaultEnv(root = ROOT, port = 18991) {
  const runtime = path.join(root, 'private-runtime');
  return {
    NODE_PATH: '',
    QC_PORT: String(port),
    QC_HOST: '127.0.0.1',
    QC_RUNTIME_CONFIG_ROOT: runtime,
    QC_RUNTIME_DATA_ROOT: runtime,
    QC_OFFICIAL_SKILL_DIR: path.join(root, 'skills', 'qianchuan-ops'),
    QC_DISABLE_BACKGROUND: '1',
    AGENT_MEMORY_DIR: path.join(runtime, 'agent-memory'),
    FLOW_BASELINE_CACHE_DIR: path.join(runtime, 'cache'),
  };
}

function canListen(port, host = '127.0.0.1') {
  return new Promise(resolve => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

async function inspectPort(port, options = {}) {
  if (await (options.canListen || canListen)(port)) return 'free';
  const launcher = options.launcher || require('../server-app/scripts/start-workbench');
  const url = `http://127.0.0.1:${port}`;
  try {
    const value = await (options.health || launcher.health)(url);
    return launcher.verifyHealth(value, path.join(SERVER_APP, 'server.js')) ? 'ours' : 'occupied';
  } catch { return 'occupied'; }
}

async function selectPort(preferred, options = {}) {
  const first = await (options.inspect || inspectPort)(preferred, options);
  if (first === 'free' || first === 'ours') return { port: preferred, state: first };
  if (options.fixed) throw new Error(`端口 ${preferred} 已有其他或旧版服务；未连接、未停止，也未改写现有端口配置。`);
  for (let port = 19096; port <= 65535; port += 1) {
    const state = await (options.inspect || inspectPort)(port, options);
    if (state === 'free' || state === 'ours') return { port, state };
  }
  throw new Error('从 19096 起未找到可用本机端口；未修改配置。');
}

function serviceEnvironment(root = ROOT, source = process.env) {
  const env = { ...defaultEnv(root), ...Object.fromEntries(Object.entries(source).filter(([key]) => /^(QC_|AGENT_MEMORY_DIR$|FLOW_BASELINE_CACHE_DIR$)/.test(key))) };
  if (!source.QC_RUNTIME_CONFIG_ROOT && fs.existsSync(path.join(root, 'server-app', 'config.json'))) env.QC_RUNTIME_CONFIG_ROOT = path.join(root, 'server-app');
  env.QC_DISABLE_BACKGROUND = '1';
  delete env.QC_TRIAL_READ_ONLY;
  return env;
}

function outputShape(report, root, extra = {}) {
  return { ...report, skill_entry: path.join(root, 'skills', 'qianchuan-ops', 'SKILL.md'),
    agent_start: path.join(root, 'AGENT_START.md'),
    next_step: '读取项目 Skill；直播间通过浏览器插件接续。', ...extra };
}

function installDependencies(options = {}) {
  const runner = options.spawnSync || spawnSync;
  // Windows 不能用 shell:false 直接执行 .cmd；固定命令经 cmd 启动，不拼接用户输入。
  const windows = process.platform === 'win32';
  const command = windows ? (process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe') : 'npm';
  const args = windows ? ['/d', '/s', '/c', 'npm install --no-audit --no-fund'] : ['install', '--no-audit', '--no-fund'];
  const result = runner(command, args, {
    cwd: options.serverApp || SERVER_APP, shell: false, windowsHide: true,
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw new Error(`npm install 无法启动：${result.error.message}`);
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim().split(/\r?\n/).slice(-3).join(' ');
    throw new Error(`npm install 未完成${detail ? `：${detail}` : '。'}`);
  }
}

async function run(options = {}) {
  const root = options.root || ROOT;
  const args = options.args || process.argv.slice(2);
  const checkOnly = args.includes('--check');
  const launcher = options.launcher || require('../server-app/scripts/start-workbench');
  let environment = launcher.checkEnvironment(options.environmentOptions);
  if (!checkOnly && !environment.ok && environment.missingDependencies.length && environment.nodeOk && environment.sqlite) {
    installDependencies(options);
    environment = launcher.checkEnvironment(options.environmentOptions);
  }
  const env = { ...process.env, ...serviceEnvironment(root, options.env || process.env) };
  let config = null, configError = null;
  try { config = launcher.settings(options.serverApp || path.join(root, 'server-app'), env); } catch (error) { configError = error; }
  const report = launcher.checkReport(environment, config, configError);
  if (checkOnly || !report.ok) return { result: outputShape(report, root, { mode: 'check', config_changed: false }), exitCode: report.ok ? 0 : 1 };
  const launched = await launcher.launch(config, { env, ...(options.launchOptions || {}) });
  return { result: outputShape(report, root, { ok: true, service_online: true, url: launched.url,
    onboarding_url: config.url + '/v4#/onboarding', config_changed: false,
    service: { reused: launched.reused, pid: launched.pid } }), exitCode: 0 };
}

async function main() {
  const json = process.argv.includes('--json');
  try {
    const { result, exitCode } = await run();
    if (json) console.log(JSON.stringify(result));
    else console.log(result.ok ? `工作台已就绪：${result.url}` : result.failures.map(item => item.message).join('\n'));
    if (exitCode === 0 && result.service_online === true && process.argv.includes('--open')) {
      const command = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'rundll32.exe') : (process.platform === 'darwin' ? 'open' : 'xdg-open');
      const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', result.onboarding_url] : [result.onboarding_url];
      const child = spawn(command, args, { shell: false, windowsHide: true, stdio: 'ignore' });
      child.on('error', () => process.stderr.write('请在浏览器中打开上方工作台地址。\n'));
      child.unref();
    }
    process.exitCode = exitCode;
  } catch (error) {
    const result = { ok: false, error: { code: 'setup_failed', message: error.message } };
    if (json) console.log(JSON.stringify(result)); else console.error(`初始化未完成：${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();
module.exports = { defaultEnv, serviceEnvironment, selectPort, installDependencies, run };
