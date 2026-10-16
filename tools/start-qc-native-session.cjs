'use strict';

const fs = require('node:fs');
const path = require('node:path');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, names) => plain(value) && Object.keys(value).every(key => names.includes(key));
const id = value => typeof value === 'string' && /^\d+$/.test(value);
const nonempty = value => typeof value === 'string' && !!value.trim() && value === value.trim();

function normalizeConfig(config) {
  if (!keys(config, ['markerPath', 'expectedPort', 'runtimeFile', 'bindings', 'timeoutMs', 'observedUrls', 'parameterStateDirectory', 'runtimeRoot']) ||
      typeof config.markerPath !== 'string' || !path.isAbsolute(config.markerPath) || path.basename(config.markerPath) !== 'DevToolsActivePort' ||
      typeof config.runtimeFile !== 'string' || !path.isAbsolute(config.runtimeFile) ||
      (config.parameterStateDirectory !== undefined && (typeof config.parameterStateDirectory !== 'string' || !path.isAbsolute(config.parameterStateDirectory))) ||
      (config.runtimeRoot !== undefined && (typeof config.runtimeRoot !== 'string' || !path.isAbsolute(config.runtimeRoot))) ||
      !Number.isInteger(config.expectedPort) || config.expectedPort < 1 || config.expectedPort > 65535 ||
      !Number.isSafeInteger(config.timeoutMs ?? 60000) || (config.timeoutMs ?? 60000) < 1 || (config.timeoutMs ?? 60000) > 60000 ||
      !Array.isArray(config.bindings) || !config.bindings.length || config.bindings.length > 100) fail('native_start_config_invalid');
  const rooms = new Set(), targets = new Set();
  const bindings = config.bindings.map(binding => {
    if (!keys(binding, ['room', 'account_id', 'advertiser_id', 'primary_ad_id', 'browser_context_id', 'target_id', 'observed_url']) ||
        !nonempty(binding.room) || !id(binding.advertiser_id) || !id(binding.primary_ad_id) ||
        (binding.observed_url !== undefined ? !nonempty(binding.observed_url) || binding.browser_context_id !== undefined || binding.target_id !== undefined
          : !nonempty(binding.browser_context_id) || !nonempty(binding.target_id)) ||
        (binding.account_id !== undefined && (typeof binding.account_id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(binding.account_id)))) fail('native_start_binding_invalid');
    if(binding.observed_url)verifyBoundUrl(binding.observed_url,binding);
    const targetKey=binding.target_id??'observed:'+binding.observed_url;
    if (rooms.has(binding.room) || targets.has(targetKey)) fail('native_start_binding_duplicate');
    rooms.add(binding.room); targets.add(targetKey);
    return { ...binding, account_id: binding.account_id ?? binding.advertiser_id };
  });
  const observedUrls = config.observedUrls ?? [];
  if (!Array.isArray(observedUrls) || observedUrls.some(item => !keys(item, ['browser_context_id', 'url']) ||
      !nonempty(item.browser_context_id) || typeof item.url !== 'string' || !item.url.length)) fail('native_start_observed_urls_invalid');
  return { ...config, bindings, observedUrls, timeoutMs: config.timeoutMs ?? 60000,
    parameterStateDirectory: config.parameterStateDirectory ?? path.join(path.dirname(config.runtimeFile), 'parameter-state') };
}

/** Configuration is local runtime data; no accounts, browser paths or tokens live in this script. */
function readQianchuanNativeConfig(configFile) {
  if (typeof configFile !== 'string' || !path.isAbsolute(configFile)) fail('native_start_config_path_invalid');
  let config;
  try {
    const stat = fs.lstatSync(configFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024) fail('native_start_config_file_invalid');
    config = JSON.parse(fs.readFileSync(configFile, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    if (/^native_start_/.test(error?.code || '')) throw error;
    fail('native_start_config_unreadable');
  }
  return normalizeConfig(config);
}

function verifyBoundUrl(value, binding) {
  let url;
  try { url = new URL(value); } catch { fail('native_start_page_identity_mismatch'); }
  if (url.origin !== 'https://qianchuan.jinritemai.com' || url.username || url.password) fail('native_start_page_identity_mismatch');
  const params = new URLSearchParams(url.search), query = url.hash.indexOf('?');
  if (query >= 0) for (const [key, item] of new URLSearchParams(url.hash.slice(query + 1))) params.append(key, item);
  for (const [names, expected] of [
    [['aavid', 'advertiser_id', 'advertiserId'], binding.advertiser_id],
    [['adId', 'primary_ad_id', 'primaryAdId'], binding.primary_ad_id],
  ]) {
    const values = names.flatMap(name => params.getAll(name));
    if (!values.length || values.some(item => item !== expected)) fail('native_start_page_identity_mismatch');
  }
}

function safePageIdentity(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.origin !== 'https://qianchuan.jinritemai.com' || url.username || url.password) return null;
  const params = new URLSearchParams(url.search), query = url.hash.indexOf('?');
  if (query >= 0) for (const [key, item] of new URLSearchParams(url.hash.slice(query + 1))) params.append(key, item);
  const accountNames = ['aavid', 'advertiser_id', 'advertiserId'], planNames = ['adId', 'primary_ad_id', 'primaryAdId'];
  const allValues = [...accountNames, ...planNames].flatMap(name => params.getAll(name));
  const values = names => [...new Set(names.flatMap(name => params.getAll(name)).filter(id))];
  return { origin: url.origin, path: url.pathname,
    ...(allValues.some(value => !id(value)) ? { invalid_identity_parameters: true } : {}),
    advertiser_ids: values(['aavid', 'advertiser_id', 'advertiserId']),
    primary_ad_ids: values(['adId', 'primary_ad_id', 'primaryAdId']) };
}

function safeTitle(value) {
  return String(value ?? '').replace(/https?:\/\/\S+/gi, '[URL]')
    .replace(/\b(access_token|refresh_token|token|authorization|cookie|secret|password)\s*[:=]\s*\S+/gi, '$1=[redacted]').slice(0, 300);
}

function safeNonQianchuanSurface(value) {
  let url;
  try { url = new URL(value); } catch { return { surface: 'other_page' }; }
  if (url.protocol === 'chrome:' && ['newtab', 'version', 'inspect'].includes(url.hostname)) {
    return { surface: 'chrome_internal', origin: 'chrome://' + url.hostname, path: url.pathname };
  }
  if (url.href === 'about:blank') return { surface: 'blank_page', origin: 'about:blank' };
  if (url.protocol === 'https:' && /(?:^|\.)(?:bytedance\.com|oceanengine\.com|jinritemai\.com|douyin\.com)$/.test(url.hostname) &&
      /(?:^|\/)(?:login|signin|sign-in|passport|auth)(?:\/|$)/i.test(url.pathname)) {
    return { surface: 'task_login_page', origin: url.origin, path: url.pathname };
  }
  return { surface: 'other_page' }; // Other personal tabs expose only their CDP profile/target.
}

function safeTargetMetadata(target) {
  const identity = safePageIdentity(target.url);
  return { target_id: target.targetId, browser_context_id: target.browserContextId ?? null,
    ...(identity ? { surface: 'qianchuan_page', title: safeTitle(target.title), ...identity } : safeNonQianchuanSurface(target.url)) };
}

async function inventoryChromeTargets(browser) {
  let session;
  try {
    session = await browser.newBrowserCDPSession();
    const result = await session.send('Target.getTargets');
    if (!Array.isArray(result?.targetInfos)) throw new Error('Target inventory unavailable');
    return { ok: true, targets: result.targetInfos.filter(target => target.type === 'page').map(safeTargetMetadata) };
  } catch {
    return { ok: false, code: 'native_inventory_cdp_targets_unavailable', targets: [] };
  } finally {
    if (session) await session.detach().catch(() => {});
  }
}

function stageFailure(error, stage, connected) {
  if (error?.diagnostic) return error;
  const failure = error instanceof Error ? error : new Error('Native session failed');
  const diagnostic = Object.freeze({ stage, failure_type: connected ? 'initialization_failed' : 'startup_failed', transport_connected: connected });
  try { failure.diagnostic = diagnostic; return failure; }
  catch { return Object.assign(new Error('Native session failed', { cause: failure }), { code: failure.code, diagnostic }); }
}

/** Read target/profile metadata and title only; URL output contains no arbitrary query or hash. */
async function inventoryQianchuanNativeSession(config, dependencies = {}) {
  config = normalizeConfig(config);
  const module = require('./attach-qc-chrome.playwright.cjs');
  const attach = dependencies.attachQianchuanChrome ?? module.attachQianchuanChrome;
  const getTarget = dependencies.getChromePageTarget ?? module.getChromePageTarget;
  const attachment = await attach({ markerPath: config.markerPath, expectedPort: config.expectedPort, timeoutMs: config.timeoutMs });
  let timer;
  let primaryFailure = false;
  try {
    const pages = [...new Set(attachment.browser.contexts().flatMap(context => context.pages()))].filter(page => !page.isClosed());
    const [results, cdpInventory] = await Promise.race([
      Promise.all([Promise.all(pages.map(async page => {
        try {
          const target = await getTarget(page);
          const identity = safePageIdentity(target.url), current = safePageIdentity(page.url());
          if (!identity && !current) return { ok: true, category: 'non_qianchuan', target_id: target.targetId,
            browser_context_id: target.browserContextId ?? null, ...safeNonQianchuanSurface(target.url) };
          if (!identity || !current || JSON.stringify(identity) !== JSON.stringify(current)) return { ok: false, code: 'native_inventory_page_changed' };
          return { ok: true, target_id: target.targetId, browser_context_id: target.browserContextId ?? null,
            title: safeTitle(await page.title()), ...identity };
        } catch { return { ok: false, code: 'native_inventory_page_unavailable' }; }
      })), inventoryChromeTargets(attachment.browser)]),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('native_start_inventory_timeout'),
        { code: 'native_start_inventory_timeout' })), Math.min(config.timeoutMs, 15000)); }),
    ]);
    const mappedIds = new Set(results.filter(item => item.ok).map(item => item.target_id));
    const cdpIds = new Set(cdpInventory.targets.map(item => item.target_id));
    return { status: 'inventory', pid: process.pid, pages: results.filter(item => item.category !== 'non_qianchuan'),
      non_qianchuan_pages: results.filter(item => item.category === 'non_qianchuan').map(({ category, ...item }) => item),
      cdp_target_inventory: cdpInventory,
      target_comparison: { available: cdpInventory.ok,
        cdp_only_target_ids: cdpInventory.ok ? [...cdpIds].filter(target => !mappedIds.has(target)) : [],
        mapped_only_target_ids: cdpInventory.ok ? [...mappedIds].filter(target => !cdpIds.has(target)) : [] },
      configured_candidates: config.bindings.map(binding => ({ room: binding.room,
      targets: results.filter(item => item.ok && item.category !== 'non_qianchuan' && !item.invalid_identity_parameters && item.advertiser_ids.length === 1 && item.advertiser_ids[0] === binding.advertiser_id &&
        item.primary_ad_ids.length === 1 && item.primary_ad_ids[0] === binding.primary_ad_id)
        .map(item => ({ target_id: item.target_id, browser_context_id: item.browser_context_id })) })),
    configuration_changed: false, advertising_writes: 0 };
  } catch (error) {
    primaryFailure = true;
    throw stageFailure(error, 'page_inventory', true);
  } finally {
    clearTimeout(timer);
    try { await attachment.detach(); }
    catch (error) { if (!primaryFailure) throw stageFailure(error, 'detach', true); }
  }
}

/** Find already-open exact targets. Never navigate, create tabs or infer identity from context count. */
async function bindQianchuanNativePages(browser, bindings, getChromePageTarget, timeoutMs = 15000) {
  if (!browser?.isConnected()) fail('native_start_browser_unavailable');
  const pages = [...new Set(browser.contexts().flatMap(context => context.pages()))];
  let timer;
  let found;
  try {
    found = await Promise.race([
      Promise.all(pages.map(async page => {
        try { return { page, target: await getChromePageTarget(page) }; }
        catch { return null; }
      })),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('native_start_inventory_timeout'),
        { code: 'native_start_inventory_timeout' })), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
  return bindings.map(binding => {
    const matches = binding.observed_url
      ? found.filter(item => item?.target?.url === binding.observed_url && item.page.url() === binding.observed_url)
      : found.filter(item => item?.target?.targetId === binding.target_id);
    if (matches.length !== 1) fail('native_start_target_missing');
    const { page, target } = matches[0];
    if (page.isClosed() || !nonempty(target.browserContextId) || !nonempty(target.targetId)
        || !binding.observed_url && target.browserContextId !== binding.browser_context_id) fail('native_start_profile_mismatch');
    verifyBoundUrl(target.url, binding);
    verifyBoundUrl(page.url(), binding);
    return { ...binding, browser_context_id:target.browserContextId, target_id:target.targetId, page };
  });
}

function mergeOperations(...registries) {
  const result = {};
  for (const registry of registries) {
    if (!plain(registry)) fail('native_start_operations_invalid');
    for (const [name, operation] of Object.entries(registry)) {
      if (Object.hasOwn(result, name)) fail('native_start_operation_duplicate');
      Object.defineProperty(result, name, { value: operation, enumerable: true });
    }
  }
  return result;
}

/** Own one authorized CDP attachment in an independent process; no scheduler or automatic reconnection. */
async function startQianchuanNativeSession(config, dependencies = {}) {
  config = normalizeConfig(config);
  const attachmentModule = require('./attach-qc-chrome.playwright.cjs');
  const attach = dependencies.attachQianchuanChrome ?? attachmentModule.attachQianchuanChrome;
  const getTarget = dependencies.getChromePageTarget ?? attachmentModule.getChromePageTarget;
  const startHost = dependencies.startQianchuanNativeHost ?? require('./qc-native-session-host.cjs').startQianchuanNativeHost;
  const createOperations = dependencies.createQianchuanNativeOperations ?? require('./qc-native-operations.cjs').createQianchuanNativeOperations;
  let createAuxiliary = dependencies.createQianchuanNativeAuxiliaryOperations;
  if (!createAuxiliary) {
    try { createAuxiliary = require('./qc-native-auxiliary.cjs').createQianchuanNativeAuxiliaryOperations; }
    catch { fail('native_start_auxiliary_unavailable'); }
  }
  if (typeof createAuxiliary !== 'function') fail('native_start_auxiliary_unavailable');
  let createParameters = dependencies.createQianchuanNativeParameterOperations;
  if (!createParameters) {
    try { createParameters = require('./qc-native-parameter-operations.cjs').createQianchuanNativeParameterOperations; }
    catch { fail('native_start_parameters_unavailable'); }
  }
  if (typeof createParameters !== 'function') fail('native_start_parameters_unavailable');
  const attachment = await attach({ markerPath: config.markerPath, expectedPort: config.expectedPort, timeoutMs: config.timeoutMs });
  let host;
  let phase = 'page_binding';
  try {
    const bindings = await bindQianchuanNativePages(attachment.browser, config.bindings, getTarget, Math.min(config.timeoutMs, 15000));
    phase = 'operation_registration';
    const operations = mergeOperations(createOperations(), createAuxiliary({ browser: attachment.browser, observedUrls: config.observedUrls }),
      createParameters({ stateDirectory: config.parameterStateDirectory, runtimeRoot: config.runtimeRoot }));
    phase = 'host_initialization';
    host = await startHost({ browser: attachment.browser, bindings, operations, runtimeFile: config.runtimeFile, port: 0 });
  } catch (error) {
    await attachment.detach().catch(() => {});
    throw stageFailure(error, phase, true);
  }
  let closePromise;
  const close = () => closePromise ||= (async () => {
    try { return await host.close(); }
    finally { await attachment.detach(); }
  })();
  return Object.freeze({ host, browser: attachment.browser, close });
}

function publicNativeSessionFailure(error) {
  const code = /^(?:chrome_|native_|playwright_)[a-z0-9_]{1,72}$/.test(error?.code || '') ? error.code : 'native_start_failed';
  let diagnostic = error?.diagnostic;
  if (!diagnostic) {
    const stage = /^chrome_marker|^chrome_port/.test(code) ? 'marker_read' :
      /config|usage/.test(code) ? 'configuration' : /unavailable/.test(code) ? 'dependencies' : 'startup';
    diagnostic = { stage, failure_type: 'startup_failed', transport_connected: null };
  }
  const stages = ['attachment', 'transport_connect', 'websocket_handshake', 'cdp_initialization', 'page_inventory', 'page_binding',
    'operation_registration', 'host_initialization', 'detach', 'marker_read', 'configuration', 'dependencies', 'startup'];
  const types = ['connection_failed', 'initialization_timeout', 'initialization_failed', 'endpoint_unreachable', 'handshake_rejected',
    'handshake_timeout', 'handshake_failed', 'timeout_phase_unknown', 'startup_failed'];
  const result = { stage: stages.includes(diagnostic.stage) ? diagnostic.stage : 'startup',
    failure_type: types.includes(diagnostic.failure_type) ? diagnostic.failure_type : 'startup_failed',
    transport_connected: typeof diagnostic.transport_connected === 'boolean' ? diagnostic.transport_connected : null };
  for (const key of ['timeout_ms', 'elapsed_ms']) if (Number.isSafeInteger(diagnostic[key]) && diagnostic[key] >= 0) result[key] = diagnostic[key];
  if (Number.isInteger(diagnostic.http_status) && diagnostic.http_status >= 100 && diagnostic.http_status <= 599) result.http_status = diagnostic.http_status;
  if (['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET'].includes(diagnostic.transport_code)) result.transport_code = diagnostic.transport_code;
  return { code, diagnostic: result };
}

async function main(argv = process.argv.slice(2)) {
  if(argv.length===3&&argv[0]==='--supervise'&&argv[1]==='--config'){
    const config=readQianchuanNativeConfig(argv[2]);
    const supervisor=require('./qc-native-session-supervisor.cjs').superviseQianchuanNativeSession({configFile:argv[2],runtimeFile:config.runtimeFile});
    const stop=()=>{void supervisor.stop();};
    process.once('SIGINT',stop);process.once('SIGTERM',stop);
    void supervisor.done.then(state=>{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);if(state.status==='failed')process.exitCode=1;});
    return supervisor;
  }
  if (argv.length === 3 && argv[0] === '--inventory' && argv[1] === '--config') {
    const result = await inventoryQianchuanNativeSession(readQianchuanNativeConfig(argv[2]));
    process.stdout.write(JSON.stringify(result) + '\n');
    return result;
  }
  if (argv.length !== 2 || argv[0] !== '--config') fail('native_start_usage_config_required');
  const owner = await startQianchuanNativeSession(readQianchuanNativeConfig(argv[1]));
  let stopping = false;
  const stop = async reason => {
    if (stopping) return;
    stopping = true;
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
    owner.browser.removeListener('disconnected', disconnected);
    try {
      await owner.close();
      process.stdout.write(JSON.stringify({ status: 'stopped', reason, pid: process.pid }) + '\n');
    } catch (error) {
      process.exitCode = 1;
      process.stderr.write(JSON.stringify({ status: 'stop_failed', ...publicNativeSessionFailure(stageFailure(error, 'detach', true)), pid: process.pid }) + '\n');
    }
  };
  const interrupt = () => { void stop('SIGINT'); };
  const terminate = () => { void stop('SIGTERM'); };
  const disconnected = () => { process.exitCode = 1; void stop('browser_disconnected'); };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  owner.browser.once('disconnected', disconnected);
  process.stdout.write(JSON.stringify({ status: 'running', pid: process.pid, host_id: owner.host.host_id,
    runtime_file: owner.host.runtime_file, binding_count: owner.host.bindings.length, operation_count: owner.host.operations.length }) + '\n');
  if (!owner.browser.isConnected()) await stop('browser_disconnected');
  return owner;
}

if (require.main === module) main().catch(error => {
  process.exitCode = 1;
  process.stderr.write(JSON.stringify({ status: 'start_failed', ...publicNativeSessionFailure(error), pid: process.pid }) + '\n');
});

module.exports = { readQianchuanNativeConfig, bindQianchuanNativePages, inventoryQianchuanNativeSession, startQianchuanNativeSession, publicNativeSessionFailure, main };
