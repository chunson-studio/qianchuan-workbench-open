'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');

function parseArgs(args = process.argv.slice(2)) {
  const valued = new Set(['--interval-seconds', '--max-rounds', '--account-id']);
  const flags = new Set(['--once', '--loop', '--json']);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (flags.has(arg)) continue;
    if (!valued.has(arg)) throw new Error(`不支持的参数：${arg}`);
    if (index + 1 >= args.length || args[index + 1].startsWith('--')) throw new Error(`${arg} 缺少参数值。`);
    index += 1;
  }
  const value = name => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : null;
  };
  const loop = args.includes('--loop');
  const interval = Number(value('--interval-seconds') || 300);
  const rawRounds = value('--max-rounds');
  const maxRounds = rawRounds == null ? (loop ? Infinity : 1) : Number(rawRounds);
  if (args.includes('--once') && loop) throw new Error('--once 与 --loop 不能同时使用。');
  if (!Number.isFinite(interval) || interval < 60 || interval > 86400) throw new Error('循环间隔应为 60～86400 秒。');
  if (!(maxRounds === Infinity || (Number.isInteger(maxRounds) && maxRounds > 0))) throw new Error('--max-rounds 应为正整数。');
  const accountId = value('--account-id');
  if (accountId != null && (!accountId.trim() || accountId.length > 128 || /[\x00-\x1f]/.test(accountId))) throw new Error('--account-id 无效。');
  return { loop, intervalSeconds: interval, maxRounds, accountId, json: args.includes('--json') };
}

function readConnection(root = ROOT) {
  const env = require('./setup.cjs').serviceEnvironment(root);
  if (!fs.existsSync(path.join(env.QC_RUNTIME_CONFIG_ROOT, 'config.json'))) throw Object.assign(new Error('缺少本机账户配置。'), {code:'setup_required'});
  const config = require('../server-app/scripts/start-workbench').settings(path.join(root, 'server-app'), env);
  if (!['127.0.0.1', 'localhost', '::1'].includes(config.host)) throw new Error('只连接本机回环地址。');
  return { env, port: config.port, baseUrl: config.url };
}

async function fetchJson(url, options = {}) {
  const fetchImpl = options.fetch || global.fetch;
  const timeoutMs = options.timeoutMs || 30000;
  let response;
  try { response = await fetchImpl(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) }); }
  catch (error) { throw Object.assign(new Error(error.name === 'TimeoutError' ? '请求超时' : error.message), { code: error.name === 'TimeoutError' ? 'timeout' : 'request_failed' }); }
  let value;
  try { value = await response.json(); } catch { throw Object.assign(new Error('本机服务返回了非 JSON 响应。'), { code: 'invalid_json' }); }
  if (!response.ok || value?.ok !== true) throw Object.assign(new Error(value?.error || `HTTP ${response.status}`), { code: value?.code || `http_${response.status}` });
  return value;
}

async function verifyService(connection, options = {}) {
  const health = await fetchJson(connection.baseUrl + '/health/live', { ...options, timeoutMs: options.healthTimeoutMs || 4000 });
  const launcher = options.launcher || require('../server-app/scripts/start-workbench');
  if (!launcher.verifyHealth(health, path.join(options.root || ROOT, 'server-app', 'server.js'))) {
    throw Object.assign(new Error('该端口不是本项目当前服务；未继续读取。'), { code: 'service_identity_mismatch' });
  }
  return health;
}

function selectAccount(status, requested) {
  const accounts = Array.isArray(status?.accounts) ? status.accounts : [];
  if (requested) {
    const found = accounts.find(item => String(item.id) === String(requested) || String(item.aavid) === String(requested));
    return found ? String(found.id) : null;
  }
  return accounts.length === 1 ? String(accounts[0].id) : null;
}

function errorItem(code, message, component = 'monitor') { return { code, message, component }; }
function sourceAt(dashboard) {
  return dashboard?.component_times?.core?.source_at || dashboard?.fetchedAt || dashboard?.today?.source_at || dashboard?.source_at || null;
}
function normalizedErrors(errors) {
  return (Array.isArray(errors) ? errors : []).map(item => {
    if (!item || typeof item !== 'object') return errorItem('upstream_error', String(item || '未知错误'), 'live_dashboard');
    return errorItem(item.code || 'upstream_error', item.message || item.error || '上游返回异常', item.component || 'live_dashboard');
  });
}
function freshness(source, dashboard, options = {}) {
  const now = typeof options.now === 'function' ? options.now() : options.now ?? Date.now();
  const at = Date.parse(source);
  if (!source || !Number.isFinite(at)) return { ok: false, code: 'source_time_missing', message: '大屏缺少可靠来源时间。' };
  const age = now - at;
  const maxAge = options.maxSourceAgeMs || 5 * 60 * 1000;
  const futureTolerance = options.futureToleranceMs || 60 * 1000;
  if (dashboard.stale === true || dashboard.data_stale === true || dashboard.status_stale === true) return { ok: false, code: 'dashboard_stale', message: '大屏已标记为陈旧。' };
  if (age > maxAge) return { ok: false, code: 'source_too_old', message: '大屏来源时间超过 5 分钟。' };
  if (age < -futureTolerance) return { ok: false, code: 'source_in_future', message: '大屏来源时间明显晚于本机时间。' };
  return { ok: true, age_ms: age };
}

function snapshotOf(report, dashboard) {
  const today = dashboard?.today || {};
  return {
    state: report.state, data_valid: report.data_valid, source_at: report.source_at,
    rooms: (dashboard?.live?.rooms || []).map(room => String(room.roomId || room.room_id || '')).filter(Boolean).sort(),
    cost: today.cost ?? null, gmv: today.gmv ?? null, roi: today.roi ?? null,
    net_gmv: today.netGmv ?? null, net_roi: today.netRoi ?? null,
    order_count: today.orderCount ?? null,
    errors: report.errors.map(item => `${item?.component || ''}:${item?.code || ''}`).sort(),
  };
}

function meaningfulChanges(previous, current) {
  if (!previous) return [{ kind: 'baseline', current }];
  const changes = [];
  for (const key of ['state', 'data_valid', 'rooms', 'cost', 'gmv', 'roi', 'net_gmv', 'net_roi', 'order_count', 'errors']) {
    if (JSON.stringify(previous[key]) !== JSON.stringify(current[key])) changes.push({ field: key, from: previous[key] ?? null, to: current[key] ?? null });
  }
  return changes;
}

function readPrevious(file, io = fs) {
  try { return JSON.parse(io.readFileSync(file, 'utf8')).snapshot || null; } catch { return null; }
}

function writeLatest(file, report, snapshot, io = fs) {
  io.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.writing-${process.pid}-${Date.now()}`;
  io.writeFileSync(temporary, JSON.stringify({ report, snapshot }, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  io.renameSync(temporary, file);
}

function lockPort(root = ROOT) {
  const hash = crypto.createHash('sha256').update(path.resolve(root).toLowerCase()).digest().readUInt32BE(0);
  return 40000 + (hash % 20000);
}

function acquireLock(root = ROOT, options = {}) {
  if (options.acquireLock) return options.acquireLock(root);
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', error => reject(Object.assign(new Error('监控互斥端口已被占用；可能有监控进程或其他本机程序正在使用。'), { code: 'monitor_busy', cause: error })));
    server.listen({ host: '127.0.0.1', port: lockPort(root), exclusive: true }, () => resolve({ release: () => new Promise(done => server.close(done)) }));
  });
}

function baseReport(accountId = null) {
  return { ok: false, state: 'error', account_id: accountId, checked_at: new Date().toISOString(), source_at: null, data_valid: false, changes: [], errors: [], should_notify: false, next_step: null };
}

async function monitorOnce(context, options = {}) {
  const now = typeof options.now === 'function' ? options.now() : options.now ?? Date.now();
  const checkedAt = new Date(now).toISOString();
  let accountId = context.accountId || null;
  if (!accountId) {
    const status = await fetchJson(context.connection.baseUrl + '/api/onboarding', { ...options, timeoutMs: options.statusTimeoutMs || 10000 });
    accountId = selectAccount(status, context.requestedAccountId);
    if (!accountId) {
      const count = Array.isArray(status.accounts) ? status.accounts.length : 0;
      return { ...baseReport(null), state: 'needs_input', checked_at: checkedAt,
        errors: [errorItem('account_selection_required', count === 0 ? '尚未保存账户。' : context.requestedAccountId ? '指定账户不在已保存账户中。' : `已保存 ${count} 个账户，需要明确选择。`, 'account')],
        next_step: count === 0 ? '本人在 onboarding 页面登录并选择账户。' : '使用 --account-id 明确选择已保存账户。' };
    }
    context.accountId = accountId;
  }
  let live;
  try {
    live = await fetchJson(`${context.connection.baseUrl}/api/live-status?account=${encodeURIComponent(accountId)}`, { ...options, timeoutMs: options.liveTimeoutMs || 30000 });
  } catch (error) {
    return { ...baseReport(accountId), state: 'unhealthy', checked_at: checkedAt, errors: [errorItem(error.code || 'live_status_failed', error.message, 'live_status')], next_step: '稍后重试直读状态；不要按本轮数据调整投放。' };
  }
  const liveErrors = [...(Array.isArray(live.errors) ? live.errors : [])];
  if (live.partial === true || live.dataValid === false || live.data_valid === false || live.stale === true || live.status_stale === true || live.error || liveErrors.length || typeof live.isLive !== 'boolean') {
    return { ...baseReport(accountId), state: 'unhealthy', checked_at: checkedAt,
      errors: [errorItem(live.code || 'live_status_unreliable', live.error || '直播状态不完整。', 'live_status'), ...liveErrors],
      next_step: '稍后重试直读状态；不要按本轮数据调整投放。' };
  }
  if (live.isLive === false) return { ...baseReport(accountId), ok: true, state: 'not_live', checked_at: checkedAt, data_valid: true, next_step: '等待下一次外部定时检查。' };
  let dashboard;
  try {
    dashboard = await fetchJson(`${context.connection.baseUrl}/api/live-dashboard?account=${encodeURIComponent(accountId)}&slim=1`, { ...options, timeoutMs: options.dashboardTimeoutMs || 60000 });
  } catch (error) {
    return { ...baseReport(accountId), state: 'partial', checked_at: checkedAt, errors: [errorItem(error.code || 'dashboard_failed', error.message, 'live_dashboard')], next_step: '直播中，但大屏读取失败；保留缺失值并在下一轮重试。' };
  }
  const source = sourceAt(dashboard);
  const fresh = freshness(source, dashboard, { ...options, now });
  const errors = normalizedErrors(dashboard.errors);
  if (!fresh.ok) errors.push(errorItem(fresh.code, fresh.message, 'freshness'));
  const valid = dashboard.dataValid === true && dashboard.partial !== true && errors.length === 0;
  return { ...baseReport(accountId), ok: valid, state: valid ? 'live' : 'partial', checked_at: checkedAt,
    source_at: source, data_valid: valid, errors,
    next_step: valid ? '由外部 Agent 根据已授权规则判断；本工具不执行投放。' : '数据不完整；缺失指标保持未知并在下一轮重试。', _dashboard: dashboard };
}

async function run(options = {}) {
  const root = options.root || ROOT;
  let cli, connection;
  try {
    cli = options.cli || parseArgs(options.args);
    connection = options.connection || readConnection(root, options.io || fs);
  } catch (error) {
    const setup = error.code === 'setup_required';
    const report = { ...baseReport(null), state: setup ? 'needs_setup' : 'error',
      errors: [errorItem(setup ? 'setup_required' : 'invalid_arguments', error.message)],
      should_notify: true, paused: true,
      next_step: setup ? '先运行 node tools/setup.cjs --json。' : '修正参数后重试。' };
    if (options.onReport) options.onReport(report);
    return { reports: [report], result: report, exitCode: 1 };
  }
  let lock = null;
  let exitCode = 0;
  const reports = [];
  try {
    lock = await acquireLock(root, options);
    await verifyService(connection, { ...options, root });
    const runtime = path.resolve(connection.env.QC_RUNTIME_DATA_ROOT || connection.env.QC_RUNTIME_CONFIG_ROOT || path.join(root, 'private-runtime'));
    const context = { connection, requestedAccountId: cli.accountId, accountId: null };
    let failures = 0;
    for (let round = 1; round <= cli.maxRounds; round += 1) {
      let report;
      try { report = await monitorOnce(context, options); }
      catch (error) { report = { ...baseReport(context.accountId), state: 'unhealthy', errors: [errorItem(error.code || 'round_failed', error.message)], next_step: '修复本机读取问题后重试。' }; }
      const accountKey = report.account_id || 'unselected';
      const file = path.join(runtime, 'monitor', accountKey.replace(/[^A-Za-z0-9._-]/g, '_'), 'latest.json');
      const snapshot = snapshotOf(report, report._dashboard);
      const previous = readPrevious(file, options.io || fs);
      report.changes = meaningfulChanges(previous, snapshot);
      delete report._dashboard;
      const nextFailures = report.ok ? 0 : Number(previous?.consecutive_failures ?? failures) + 1;
      report.consecutive_failures = nextFailures;
      report.paused = nextFailures >= 3;
      snapshot.consecutive_failures = nextFailures;
      if (nextFailures >= 3) report.next_step = cli.loop ? '连续失败 3 次，本机循环已停止；请检查服务或账户后重新启动。' : '连续失败 3 次，请 Agent 暂停外部定时安排；修复服务或账户后再恢复。';
      report.should_notify = (!previous && !report.ok) || report.changes.some(change => change.kind !== 'baseline') || nextFailures === 3;
      writeLatest(file, report, snapshot, options.io || fs);
      reports.push(report);
      if (reports.length > 20) reports.shift();
      if (options.onReport) options.onReport(report);
      failures = nextFailures;
      if (!cli.loop || round === cli.maxRounds || failures >= 3) {
        if (!report.ok || failures >= 3) exitCode = 1;
        break;
      }
      await (options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms))))(cli.intervalSeconds * 1000);
    }
  } catch (error) {
    reports.push({ ...baseReport(cli.accountId), state: error.code === 'monitor_busy' ? 'busy' : 'unhealthy', errors: [errorItem(error.code || 'service_unavailable', error.message)], should_notify: error.code !== 'monitor_busy', paused: error.code !== 'monitor_busy', next_step: error.code === 'monitor_busy' ? '已有任务或本机程序占用监控端口，本轮跳过。' : '本机服务或监控程序不可用；请暂停外部定时安排，修复后再恢复。' });
    if (options.onReport) options.onReport(reports[reports.length - 1]);
    exitCode = 1;
  } finally { if (lock) await lock.release(); }
  return { reports, result: reports[reports.length - 1], exitCode };
}

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const { result, exitCode } = await run({ args, onReport: json ? report => console.log(JSON.stringify(report)) : null });
  if (!json) console.log(`${result.state}: ${result.account_id || '-'} ${result.next_step || ''}`);
  process.exitCode = exitCode;
}

if (require.main === module) main();
module.exports = { parseArgs, readConnection, fetchJson, verifyService, selectAccount, snapshotOf, meaningfulChanges, acquireLock, monitorOnce, run };
