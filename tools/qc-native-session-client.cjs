'use strict';

const fs = require('node:fs');
const path = require('node:path');
const FIELDS = ['room', 'account_id', 'advertiser_id', 'primary_ad_id', 'request_id'];
const fail = (code, details = {}) => { throw Object.assign(new Error(code), { code, retry_write: false, ...details }); };

function readRuntime(runtimeFile) {
  if (typeof runtimeFile !== 'string' || !path.isAbsolute(runtimeFile)) fail('native_runtime_file_invalid');
  let stat, value;
  try {
    stat = fs.lstatSync(runtimeFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) fail('native_runtime_file_invalid');
    value = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
  } catch { fail('native_runtime_file_invalid'); }
  if (value.schema !== 'qianchuan-native-session/v1' || value.status !== 'running' ||
      typeof value.host_id !== 'string' || !/^[a-f0-9-]{36}$/.test(value.host_id) ||
      !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(value.endpoint || '') ||
      Number(new URL(value.endpoint).port) > 65535 || !/^[a-f0-9]{64}$/.test(value.token || '')) fail('native_runtime_file_invalid');
  return value;
}

/**
 * Read a private runtime descriptor once and retain its host identity. No CDP
 * connection or automatic retry. Keep host_id with pending requests; supplying
 * expectedHostId rejects a replacement host instead of replaying an old write.
 * A client timeout means unknown, not cancellation. getRequest reads prior state.
 * Completed read receipts can expire. Old write payloads can return
 * result_expired:true; their request IDs remain non-replayable on that host and
 * callers must read the real page again. ui calls do not reserve a multi-step
 * form: one active round per room/main plan is a caller requirement.
 */
function createQianchuanNativeClient({ runtimeFile, expectedHostId, timeoutMs = 20000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300000) fail('native_timeout_invalid');
  const runtime = readRuntime(runtimeFile);
  if (expectedHostId !== undefined && expectedHostId !== runtime.host_id) fail('native_host_changed');
  const request = async (route, data, waitMs = timeoutMs) => {
    if (!Number.isSafeInteger(waitMs) || waitMs <= 0 || waitMs > 300000) fail('native_timeout_invalid');
    const current = readRuntime(runtimeFile);
    if (current.host_id !== runtime.host_id || current.endpoint !== runtime.endpoint || current.token !== runtime.token) fail('native_host_changed');
    const body = { host_id: runtime.host_id };
    for (const key of FIELDS) body[key] = data?.[key];
    if (route === '/call') Object.assign(body, { operation: data?.operation, input: data?.input ?? {}, deadline_at_ms: Date.now() + waitMs });
    if (route === '/rebind') Object.assign(body, { target_id: data?.target_id, observed_url: data?.observed_url, deadline_at_ms: Date.now() + waitMs });
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), waitMs);
    try {
      const response = await fetch(runtime.endpoint + route, { method: route === '/status' ? 'GET' : 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + runtime.token },
        ...(route === '/status' ? {} : { body: JSON.stringify(body) }) });
      const result = await response.json();
      if (result.host_id !== runtime.host_id) fail('native_host_changed');
      return result;
    } catch (error) {
      if (error?.code === 'native_host_changed') throw error;
      fail('native_result_unknown', { host_id: runtime.host_id, request_id: data?.request_id ?? null, effect_status: 'unconfirmed' });
    } finally { clearTimeout(timer); }
  };
  return Object.freeze({ host_id: runtime.host_id, endpoint: runtime.endpoint,
    call: (data, options = {}) => request('/call', data, options.timeoutMs ?? timeoutMs),
    getRequest: (data, options = {}) => request('/request', data, options.timeoutMs ?? timeoutMs),
    status: (options = {}) => request('/status', null, options.timeoutMs ?? timeoutMs),
    rebindPage: (data, options = {}) => request('/rebind', data, options.timeoutMs ?? timeoutMs) });
}

module.exports = { createQianchuanNativeClient };
