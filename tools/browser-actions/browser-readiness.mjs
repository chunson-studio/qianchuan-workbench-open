
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const ownFile = fileURLToPath(import.meta.url);
export const readinessSource = Object.freeze({ file: ownFile,
  sha256: createHash('sha256').update(await fs.readFile(ownFile)).digest('hex') });
const sensitiveKey = /token|cookie|password|secret|credential|authorization|auth_code|redirect|callback/i;

export function assertAccountUrl(raw, binding, expectedPath = null) {
  const u = new URL(raw);
  const accountKeys = [...u.searchParams.keys()].filter(k => k.toLowerCase() === 'aavid');
  if (typeof binding?.advertiser_id !== 'string' || !/^\d+$/.test(binding.advertiser_id) ||
      u.origin !== 'https://qianchuan.jinritemai.com' || u.username || u.password ||
      accountKeys.length !== 1 || accountKeys[0] !== 'aavid' || u.searchParams.get('aavid') !== binding.advertiser_id ||
      (expectedPath && u.pathname !== expectedPath)) throw Error('Account or route binding mismatch');
  return u;
}

export function idTextPattern(id) {
  if (typeof id !== 'string' || !/^\d+$/.test(id)) throw Error('Explicit object ID string required');
  return new RegExp('ID：' + id + '(?!\\d)');
}

export function safeUrl(value) {
  if (!value) return null;
  try {
    const u = new URL(value);
    if (u.username) u.username = 'REDACTED';
    if (u.password) u.password = 'REDACTED';
    for (const key of [...u.searchParams.keys()]) {
      if (sensitiveKey.test(key)) u.searchParams.set(key, 'REDACTED');
    }
    if (sensitiveKey.test(u.hash)) u.hash = '#REDACTED';
    return u.href;
  } catch { return 'unknown_url'; }
}

export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, sensitiveKey.test(key) ? 'REDACTED' : redact(item)]));
  if (typeof value === 'string') return value.replace(/https?:\/\/[^\s"'<>]+/g, url => safeUrl(url));
  return value;
}

export function classifyPage(dom, url, expected = {}) {
  const body = typeof dom === 'string' ? dom : '';
  const network = body.match(/ERR_[A-Z_]+/);
  if (network) return { ready: false, code: 'network_error', browser_error: network[0] };
  let u;
  try { u = new URL(url); } catch { return { ready: false, code: 'url_unavailable' }; }
  if (['accounts.feishu.cn', 'business.oceanengine.com'].includes(u.hostname) && /login/.test(u.pathname))
    return { ready: false, code: 'authentication_required' };
  if (u.protocol !== 'https:' || u.username || u.password ||
      (expected.hostname && u.origin !== 'https://' + expected.hostname))
    return { ready: false, code: 'site_mismatch' };
  if (expected.hostname && u.hostname !== expected.hostname) return { ready: false, code: 'site_mismatch' };
  const accountKeys = [...u.searchParams.keys()].filter(k => k.toLowerCase() === 'aavid');
  if (expected.advertiser_id && (accountKeys.length !== 1 || accountKeys[0] !== 'aavid' || u.searchParams.get('aavid') !== expected.advertiser_id))
    return { ready: false, code: 'advertiser_url_mismatch' };
  if (!body.trim()) return { ready: false, code: 'blank_unloaded' };
  if (/status[^\n]*数据加载中|status[^\n]*加载中|aria-busy=["']?true/i.test(body))
    return { ready: false, code: 'loading' };
  const absent = (expected.identity_markers || []).filter(marker => !body.includes(marker));
  if (absent.length) return { ready: false, code: 'identity_unverified', missing: absent };
  const missing = (expected.loaded_markers || []).filter(marker => !body.includes(marker));
  if (missing.length) return { ready: false, code: 'content_unverified', missing };
  return { ready: true, code: 'observed_ready', source_at: null, formal_fresh_sample: false };
}


export async function readWithRecovery(fn, { attempts = 3 } = {}) {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 3) throw Error('Read attempts must be an integer from 1 to 3');
  const limit = attempts;
  for (let attempt = 1; ; attempt++) {
    try { return await fn(); }
    catch (e) {
      const message = String(e);
      const transient = message.includes('Detached while handling command') ||
        /CDP operation exceeded its deadline before command dispatch/i.test(message) ||
        /Playwright selector deadline exceeded/i.test(message) ||
        /Timed out.*(?:CDP command )?Runtime\.evaluate/.test(message);
      if (!transient || attempt >= limit) throw e;
    }
  }
}
