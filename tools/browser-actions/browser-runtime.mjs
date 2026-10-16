
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { assertAccountUrl, readWithRecovery, readinessSource, safeUrl } from './browser-readiness.mjs';

const file = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(file), '../..');
const lockRoot = path.join(root, 'work/browser-actions/runs/.leases');
const hash = value => createHash('sha256').update(value).digest('hex');
const runtimeSource = Object.freeze({ file, sha256: hash(await fs.readFile(file)) });
const shared = { active: new Set(), context: new AsyncLocalStorage() };

export function immutable(value) {
  const copy = structuredClone(value);
  const freeze = v => {
    if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); }
    return v;
  };
  return freeze(copy);
}

export function accountBinding(value) {
  if (typeof value?.advertiser_id !== 'string' || !/^\d+$/.test(value.advertiser_id))
    throw Error('Explicit advertiser ID string required');
  for (const name of ['advertiser_name', 'profile_name', 'extension_instance_id'])
    if (typeof value[name] !== 'string' || !value[name].trim()) throw Error('Missing explicit binding: ' + name);
  return immutable(value);
}


export async function captureSource(url, dependencies = []) {
  const ownFile = fileURLToPath(url);
  const own = { file: ownFile, sha256: hash(await fs.readFile(ownFile)) };
  const all = [own, runtimeSource, readinessSource, ...dependencies.flatMap(d => d.sources || [d])];
  const map = new Map();
  for (const item of all) {
    if (map.has(item.file) && map.get(item.file).sha256 !== item.sha256) throw Error('Mixed dependency versions');
    map.set(item.file, item);
  }
  return immutable({ ...own, sources: [...map.values()] });
}

export async function verifySources(proof) {
  for (const item of proof.sources)
    if (hash(await fs.readFile(item.file)) !== item.sha256)
      throw Error('Script changed since import; use a fresh CUA session: ' + path.basename(item.file));
}

async function acquire(resource, waitMs = 0) {
  await fs.mkdir(lockRoot, { recursive: true });
  const lock = path.join(lockRoot, hash(resource) + '.lock');
  const token = randomUUID();
  const payload = JSON.stringify({ token, resource, created_at: new Date().toISOString() });
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const handle = await fs.open(lock, 'wx');
      try { await handle.writeFile(payload); } finally { await handle.close(); }
      return async () => {
        if (await fs.readFile(lock, 'utf8') !== payload) throw Error('Lease ownership changed; preserved for inspection');
        await fs.unlink(lock); 
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (Date.now() >= deadline) throw Error('Resource busy; no action performed: ' + resource);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
}

export async function withTabLease(tabs, fn) {
  const ids = [...new Set(tabs.map(tab => {
    if (tab?.id === undefined || !String(tab.id)) throw Error('CUA tab ID required for coordination');
    return 'codex-cua-tab:' + String(tab.id);
  }))].sort();
  const held = shared.context.getStore() || new Set();
  const missing = ids.filter(id => !held.has(id));
  if (missing.some(id => shared.active.has(id))) throw Error('Tab busy; no action performed');
  const releases = [];
  for (const id of missing) shared.active.add(id);
  try {
    for (const id of missing) releases.push(await acquire(id));
    return await shared.context.run(new Set([...held, ...missing]), fn);
  } finally {
    try {
      const outcomes = await Promise.allSettled(releases.reverse().map(release => release()));
      const failures = outcomes.filter(r => r.status === 'rejected').map(r => r.reason);
      if (failures.length) throw new AggregateError(failures, 'Lease release failed; inspect preserved lease');
    }
    finally { for (const id of missing) shared.active.delete(id); }
  }
}


export function guardRunner(tabs, runner, source) {
  return Object.fromEntries(Object.entries(runner).map(([name, value]) => [
    name, typeof value !== 'function' ? value : (...args) => {
      const frozen = immutable(args);
      return withTabLease(tabs, async () => { await verifySources(source); return value(...frozen); });
    }
  ]));
}

export async function updateActionCatalog(filePath, event) {
  const release = await acquire('catalog:' + path.resolve(filePath).toLowerCase(), 5000);
  try {
    const before = await fs.readFile(filePath, 'utf8');
    const catalog = JSON.parse(before.replace(/^\uFEFF/, ''));
    if (!Array.isArray(catalog.actions)) throw Error('Catalog schema changed');
    const index = catalog.actions.findIndex(a => a.id === event.id && a.channel === event.channel);
    const old = index < 0 ? {} : catalog.actions[index];
    const current = { ...old, ...event, last_validation: event,
      sources: [...new Set([...(old.sources || []), ...(event.sources || [])])] };
    if (index < 0) catalog.actions.push(current); else catalog.actions[index] = current;
    const content = JSON.stringify(catalog, null, 2) + '\n';
    const temp = filePath + '.pending-' + randomUUID();
    await fs.writeFile(temp, content, { flag: 'wx' });
    if (await fs.readFile(filePath, 'utf8') !== before) {
      await fs.unlink(temp);
      throw Error('Concurrent catalog edit; original preserved');
    }
    await fs.rename(temp, filePath);
    if (await fs.readFile(filePath, 'utf8') !== content) throw Error('Catalog readback failed');
  } finally { await release(); }
}

export async function accountIdentity(tab, binding) {
  assertAccountUrl(await readWithRecovery(() => tab.url()), binding);
  const name = tab.playwright.getByText(binding.advertiser_name, { exact: true }).filter({ visible: true });
  const id = tab.playwright.getByText('ID：' + binding.advertiser_id, { exact: true }).filter({ visible: true });
  const banner = tab.playwright.getByRole('banner').filter({ visible: true });
  const scopedName = await readWithRecovery(() => banner.count()) === 1
    ? banner.getByText(binding.advertiser_name, { exact: true }).filter({ visible: true }) : name;
  await readWithRecovery(() => scopedName.waitFor({ state: 'visible', timeoutMs: 15000 }));
  await readWithRecovery(() => id.waitFor({ state: 'visible', timeoutMs: 15000 }));
  if (await readWithRecovery(() => scopedName.count()) !== 1 || await readWithRecovery(() => id.count()) !== 1)
    throw Error('Visible advertiser identity missing or ambiguous');
  const dom = await readWithRecovery(() => tab.playwright.domSnapshot());
  const url = assertAccountUrl(await readWithRecovery(() => tab.url()), binding).href;
  return { url, dom };
}

export async function ensureNoOpenForm(tab) {
  const visible = locator => locator.filter({ visible: true });
  const url = new URL(await readWithRecovery(() => tab.url()));
  if (/\/(?:create|edit|form)(?:\/|$)/.test(url.pathname) ||
      await readWithRecovery(() => visible(tab.playwright.getByRole('dialog')).count()) ||
      await readWithRecovery(() => visible(tab.playwright.getByRole('button', { name: '取消', exact: true })).count()))
    throw Error('Existing form must be resolved before replay; page preserved');
}

export async function formFingerprint(tab) {
  
  const controls = await readWithRecovery(() => tab.playwright.evaluate(() =>
    Array.from(document.querySelectorAll('input,textarea,select,[role="checkbox"],[role="radio"],[role="switch"]'))
      .filter(el => el.type !== 'hidden' && el.type !== 'password' &&
        el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden')
      .map(el => ({ tag: el.tagName, type: el.type || el.getAttribute('role'),
        name: el.getAttribute('name'), label: el.getAttribute('aria-label'),
        value: el.value, checked: el.checked, ariaChecked: el.getAttribute('aria-checked'),
        selected: el.tagName === 'SELECT' ? [...el.selectedOptions].map(o => o.value) : null }))));
  return hash(JSON.stringify(controls));
}

export async function unchangedForm(tab, fingerprint) {
  if (await formFingerprint(tab) !== fingerprint) throw Error('Form changed; cancellation stopped and page preserved');
}

export async function observedUrl(tab) {
  try { return safeUrl(await readWithRecovery(() => tab.url())); } catch { return null; }
}
