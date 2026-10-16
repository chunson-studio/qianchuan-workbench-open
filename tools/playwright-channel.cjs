'use strict';
// 独立本地 CDP 入口；不加载 CUA 脚本，不读取其他宿主的登录态。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createPlaywrightBrowserAdapter } = require('./lib/playwright-browser-adapter.cjs');
const { loadPlaywrightBindings, validatePlaywrightBinding } = require('./lib/playwright-profile-binding.cjs');
const { readBoostTable, validateBoostReadRequest } = require('./lib/playwright-boost-read.cjs');
const ROOT = path.resolve(__dirname, '..');
const ACTIONS = new Set(['snapshot', 'read', 'read_boost_table', 'click', 'fill', 'press', 'check', 'uncheck', 'selectOption']);
const READS = new Set(['snapshot', 'read', 'read_boost_table']);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function save(file, value) {
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  fs.renameSync(temp, file);
}
function requestBinding(request) {
  const binding = {};
  for (const key of ['account_id', 'advertiser_id', 'primary_ad_id']) {
    if (typeof request[key] !== 'string' || !request[key].trim()) fail('binding_required', '必须显式提供 ' + key);
    binding[key] = request[key];
  }
  return binding;
}
function selectBinding(file, request) {
  const registry = loadPlaywrightBindings(file);
  const binding = requestBinding(request);
  const entry = registry.bindings.find(item => item.account_id === binding.account_id);
  if (!entry) fail('playwright_binding_account_mismatch', '本地 CDP 登记中没有此账户');
  const verified = validatePlaywrightBinding(registry, binding, {
    browserType: 'playwright-cdp', profileName: entry.profile_name, cdpEndpoint: entry.cdp_endpoint,
  });
  return { entry, binding, verified };
}
function locator(page, spec) {
  if (!spec || typeof spec !== 'object') fail('locator_required', '需要来自页面证据的定位参数');
  if (typeof spec.role === 'string' && typeof spec.name === 'string') return page.getByRole(spec.role, { name: spec.name, exact: true });
  if (typeof spec.text === 'string') return page.getByText(spec.text, { exact: true });
  if (typeof spec.css === 'string' && spec.css.trim()) return page.locator(spec.css);
  fail('locator_invalid', '定位参数必须是 role/name、text 或 css');
}
async function unique(page, spec) {
  const target = locator(page, spec);
  if (await target.count() !== 1) fail('target_not_unique', '页面目标不是唯一匹配');
  return target;
}

async function run(request, options = {}) {
  if (!request || !ACTIONS.has(request.action)) fail('action_invalid', '不支持的浏览器动作');
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(request.request_id || '')) fail('request_id_required', 'request_id 需要 8–100 位字母、数字、下划线或短横线');
  if (['fill','press','selectOption'].includes(request.action) && typeof request.value !== 'string') fail('value_required', '动作需要字符串 value');
  if (request.action === 'read_boost_table') validateBoostReadRequest(request);
  const selected = selectBinding(options.bindings_file, request);
  const endpoint = selected.verified.evidence.cdp_endpoint;
  const root = path.resolve(options.evidence_root || path.join(ROOT, 'private-runtime/playwright-channel'));
  fs.mkdirSync(root, { recursive: true });
  // 同一端点跨进程串行；锁异常遗留时只报告，不抢锁。
  const lockFile = path.join(root, 'endpoint-' + hash(endpoint) + '.lock');
  let lock;
  try { lock = fs.openSync(lockFile, 'wx'); } catch (error) {
    if (error.code === 'EEXIST') fail('browser_channel_busy', '该 CDP 端点正在操作或有未处理的锁');
    throw error;
  }
  let adapter, dispatched = false, journal;
  const recordFile = path.join(root, 'request-' + hash(selected.binding.account_id + '|' + request.request_id) + '.json');
  const fingerprint = hash(JSON.stringify({ request, endpoint, profile: selected.entry.profile_name }));
  try {
    if (fs.existsSync(recordFile)) {
      const prior = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
      if (prior.fingerprint !== fingerprint) fail('request_conflict', '同一 request_id 的参数或绑定已变化');
      return { ...(prior.result || { ok: false, effect_status: 'unconfirmed', code: 'prior_request_unresolved', retry_write: false, advertising_writes: null }), replayed: true, evidence_file: recordFile };
    }
    journal = { schema_version: 1, channel: 'playwright-cdp', request_id: request.request_id, fingerprint,
      evidence_origin: options.adapter_factory ? 'injected_adapter' : 'live_cdp',
      action: request.action, binding: selected.binding, profile_name: selected.entry.profile_name,
      identity_source: 'local_registry_and_cdp_endpoint', status: 'prepared', observed_at: new Date().toISOString() };
    save(recordFile, journal);
    adapter = (options.adapter_factory || createPlaywrightBrowserAdapter)({ cdp_url: endpoint, profile_name: selected.entry.profile_name });
    await adapter.connect({ ...selected.binding, ...(request.date ? { date: request.date } : {}), ...(request.date_range ? { date_range: request.date_range } : {}) });
    const before = await adapter.assertIdentity(selected.binding);
    let value, readback = null, refresh = null, attempts = null;
    if (request.action === 'read_boost_table') {
      journal.actions = []; journal.read_attempt_failures = [];
      const result = await readBoostTable(adapter, request, {
        onVerified: async (id, evidence, attempt) => {
          const names = { 'common.identity.verify': '核对账户、计划和日期', 'common.page.reload': '刷新追投页面', 'common.table.read_headers_and_row': '读取当前页追投表' };
          const event = { channel: 'playwright-cdp', evidence_origin: journal.evidence_origin, id, name: names[id],
            page: evidence.identity?.url || evidence.capture?.page.url, entry: 'read_boost_table',
            locator: { implementation: 'tools/lib/playwright-boost-read.cjs', action_id: id },
            status: 'read_verified', observed_at: new Date().toISOString(), attempt, binding: selected.binding,
            success_evidence: evidence, exit: '保持当前页面', advertising_writes: 0,
            constraints: ['仅当前页', '不证明直播场次', '不改变筛选或投放'], sources: [recordFile] };
          const eventFile = recordFile.replace(/\.json$/, '') + '-action-' + journal.actions.length + '.json';
          save(eventFile, event);
          journal.actions.push({ id, attempt, evidence_file: eventFile });
          save(recordFile, journal);
          // 每个请求单独登记，避免跨账户、端点或宿主覆写成功记录。
          save(recordFile.replace(/\.json$/, '') + '-actions.json', { schema_version: 1, channel: 'playwright-cdp',
            request_id: request.request_id, binding: selected.binding, actions: journal.actions });
        },
        onAttemptFailed: async failure => { journal.read_attempt_failures.push(failure); save(recordFile, journal); },
      });
      value = result.capture; attempts = result.attempts;
      refresh = { started_at: value.timing.refresh_started_at, completed_at: value.timing.refresh_completed_at };
    } else if (READS.has(request.action)) {
      const started_at = new Date().toISOString();
      await adapter.reload({ waitUntil: 'domcontentloaded' });
      refresh = { started_at, completed_at: new Date().toISOString() };
      value = request.action === 'snapshot' ? await adapter.domSnapshot() : await (await unique(adapter.page(), request.locator)).innerText();
      if (!String(value).trim() || /^(加载中[.…]*|-|未知)$/.test(String(value).trim())) fail('page_data_unavailable', '页面尚未取得数据；重新读取，不能当作零');
    } else {
      const target = await unique(adapter.page(), request.locator);
      journal.status = 'dispatched';
      save(recordFile, journal);
      dispatched = true;
      if (['fill','press','selectOption'].includes(request.action)) await target[request.action](request.value);
      else await target[request.action]();
      if (request.readback) {
        const text = await (await unique(adapter.page(), request.readback.locator)).innerText();
        readback = { text, expected_text: request.readback.expected_text ?? null,
          matched: typeof request.readback.expected_text === 'string' ? text === request.readback.expected_text : null };
      }
    }
    if (readback?.matched === false) fail('readback_mismatch', '回读未匹配预期文字；动作结果待核验，不重发');
    const after = await adapter.assertIdentity(selected.binding);
    if (before.url !== after.url) fail('page_changed', '操作期间页面地址发生变化，需要重新核验');
    const result = { ok: true, channel: 'playwright-cdp', request_id: request.request_id, action: request.action,
      binding: selected.binding, captured_at: value?.timing?.captured_at || new Date().toISOString(), refresh,
      evidence_origin: journal.evidence_origin, value: request.action === 'read_boost_table' ? undefined : value, readback,
      ...(request.action === 'read_boost_table' ? { capture: value, attempts, coverage: 'current_page_only',
        action_evidence: journal.actions } : {}),
      // 通用控件调用只证明动作返回；业务效果须核对目标 ID 和状态。
      status: READS.has(request.action) ? 'read_verified' : 'opened',
      effect_status: READS.has(request.action) ? 'read_only' : 'unconfirmed',
      advertising_writes: READS.has(request.action) ? 0 : null, retry_write: false, evidence_file: recordFile };
    journal.status = result.status; journal.result = result;
    save(recordFile, journal);
    return result;
  } catch (error) {
    if (!journal) throw error;
    const result = { ok: false, code: error.code || 'browser_channel_failed', message: error.message, channel: 'playwright-cdp',
      evidence_origin: journal.evidence_origin,
      request_id: request.request_id, binding: selected.binding, status: 'attempt_failed',
      effect_status: dispatched ? 'unconfirmed' : 'not_submitted', advertising_writes: dispatched ? null : 0,
      retry_write: false, evidence_file: recordFile };
    journal.status = result.status; journal.result = result;
    save(recordFile, journal);
    return result;
  } finally {
    try { if (adapter) await adapter.close(); } finally { fs.closeSync(lock); fs.unlinkSync(lockFile); }
  }
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help')) {
    process.stdout.write('node tools/playwright-channel.cjs --bindings 本地CDP登记.json --request 请求.json [--check]\n--check 仅检查依赖和请求绑定，不连接浏览器；不加载 CUA 或 dsh 登录态。\n读取追投列表使用 action=read_boost_table，并提供 date 或 date_range。\n');
    return;
  }
  const get = flag => { const i = argv.indexOf(flag); if (i < 0 || !argv[i+1] || argv[i+1].startsWith('--')) fail('argument_required', '缺少 ' + flag); return argv[i+1]; };
  const request = JSON.parse(fs.readFileSync(get('--request'), 'utf8'));
  const bindings_file = path.resolve(get('--bindings'));
  if (argv.includes('--check')) {
    if (!ACTIONS.has(request.action)) fail('action_invalid', '不支持的浏览器动作');
    if (request.action === 'read_boost_table') validateBoostReadRequest(request);
    const { entry } = selectBinding(bindings_file, request);
    const runtime = require('node:module').createRequire(path.join(ROOT, 'server-app/package.json'))('playwright-core');
    process.stdout.write(JSON.stringify({ ok: typeof runtime.chromium.connectOverCDP === 'function', channel: 'playwright-cdp',
      profile_name: entry.profile_name, dependency_ready: true, binding_valid: true, browser_verified: false }) + '\n');
    return;
  }
  const result = await run(request, { bindings_file });
  process.stdout.write(JSON.stringify(result) + '\n');
  if (!result.ok) process.exitCode = 1;
}
if (require.main === module) main().catch(error => {
  process.stderr.write(JSON.stringify({ ok: false, code: error.code || 'browser_channel_failed', message: error.message }) + '\n');
  process.exitCode = 1;
});
module.exports = { run, selectBinding, main };
