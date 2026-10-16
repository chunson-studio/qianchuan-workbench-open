'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { chromium } = require('../server-app/node_modules/playwright-core');
const root = path.resolve(__dirname, '..');
const publicRoot = path.join(root, 'server-app/server/public');
const workerSource = fs.readFileSync(path.join(publicRoot, 'sw.js'), 'utf8');
const prefix = workerSource.match(/const CACHE_PREFIX = '([^']+)';/)[1];
const version = workerSource.match(/const CACHE_NAME = CACHE_PREFIX \+ '([^']+)';/)[1];
const currentCache = prefix + version, oldCache = prefix + 'fixture-old', extraOldCache = prefix + 'fixture-extra';
const unrelatedCache = 'unrelated-service-worker-fixture';
const sha = data => crypto.createHash('sha256').update(data).digest('hex');

// Playwright 1.63 waitForFunction treats a Promise as truthy before it resolves.
// Await asynchronous Cache API predicates here, so a false result keeps polling.
async function waitForBrowserValue(page, predicate, arg, description) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await page.evaluate(predicate, arg)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

test('real Chrome service worker activates, upgrades selectively and falls back only for static assets', { timeout: 60000 }, async () => {
  const parent = require('./test-output.cjs').testOutputRoot();
  fs.mkdirSync(parent, { recursive: true });
  const output = fs.mkdtempSync(path.join(parent, 'run-'));
  const profile = path.join(output, 'chrome-profile');
  fs.mkdirSync(profile);
  const requests = [], blockedProxyRequests = [];
  let revision = 1, context, failure;
  let servedWorker = workerSource.replace(`const CACHE_NAME = CACHE_PREFIX + '${version}';`, "const CACHE_NAME = CACHE_PREFIX + 'fixture-old';");
  const server = http.createServer((req, res) => {
    if (/^https?:\/\//i.test(req.url)) { blockedProxyRequests.push('http_proxy'); res.writeHead(403); res.end(); return; }
    const url = new URL(req.url, 'http://fixture');
    requests.push({ path: url.pathname, query: url.search, method: req.method });
    res.setHeader('Cache-Control', 'no-store');
    if (url.pathname === '/sw.js') {
      res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      res.setHeader('Service-Worker-Allowed', '/'); res.end(servedWorker); return;
    }
    if (url.pathname === '/sw-check.html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<!doctype html><title>Local Service Worker verification</title><main>Isolated browser fixture</main>'); return;
    }
    if (url.pathname === '/api/sw-fixture' || url.pathname === '/compass_api/sw-fixture') {
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, synthetic: true })); return;
    }
    if (url.pathname === '/v4/offline-probe.js') {
      res.setHeader('Content-Type', 'text/javascript'); res.end(`globalThis.__swFixtureRevision = ${revision};`); return;
    }
    const requested = url.pathname === '/v4' || url.pathname === '/v4/' ? '/v4/index.html' : decodeURIComponent(url.pathname);
    const file = path.resolve(publicRoot, '.' + requested);
    if (!file.startsWith(publicRoot + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end('fixture_not_found'); return; }
    res.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml' })[path.extname(file)] || 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  });
  // The browser's proxy is this same fixture: unexpected external traffic cannot leave through it.
  server.on('connect', (_req, socket) => { blockedProxyRequests.push('https_proxy'); socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const report = { recorded_at: new Date().toISOString(), output, profile, origin,
    sw_source_sha256: sha(workerSource), production_worker_modified: false, checks: {}, page_errors: [],
    worker_events: [], all_fixture_http_loopback: true, credentials_used: false };
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chrome', headless: true, serviceWorkers: 'allow', viewport: { width: 1000, height: 700 },
      args: ['--disable-background-networking', `--proxy-server=${origin}`, '--proxy-bypass-list=127.0.0.1;localhost;[::1]'],
    });
    const page = context.pages()[0] || await context.newPage();
    page.on('pageerror', error => report.page_errors.push(error.message));
    await page.exposeFunction('__recordWorkerEvent', event => report.worker_events.push(event));
    await page.goto(origin + '/sw-check.html');
    await page.evaluate(async () => {
      let registration;
      const watched = new Set();
      const state = worker => worker ? { scriptURL: worker.scriptURL, state: worker.state } : null;
      const record = async reason => {
        const event = { reason, time: performance.now(), active: state(registration?.active), controller: state(navigator.serviceWorker.controller) };
        event.cache_keys = await caches.keys();
        await window.__recordWorkerEvent(event);
      };
      const watch = worker => {
        if (!worker || watched.has(worker)) return;
        watched.add(worker);
        worker.addEventListener('statechange', () => record(`statechange:${worker.state}`));
      };
      navigator.serviceWorker.addEventListener('controllerchange', () => { watch(navigator.serviceWorker.controller); record('controllerchange'); });
      registration = await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
      registration.addEventListener('updatefound', () => { watch(registration.installing); record('updatefound'); });
      watch(registration.installing); watch(registration.waiting); watch(registration.active);
      await record('registered');
      await navigator.serviceWorker.ready;
    });
    await page.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated');
    await page.evaluate(async ({ unrelated, extra }) => {
      await (await caches.open(unrelated)).put('/unrelated-fixture-record', new Response('preserve unrelated fixture'));
      await (await caches.open(extra)).put('/v4/legacy-fixture.js', new Response('old product fixture'));
      window.__previousController = navigator.serviceWorker.controller;
    }, { unrelated: unrelatedCache, extra: extraOldCache });
    const initialCaches = await page.evaluate(() => caches.keys());
    assert.ok(initialCaches.includes(oldCache));
    assert.ok(initialCaches.includes(extraOldCache));
    assert.ok(initialCaches.includes(unrelatedCache));
    report.checks.initial_install_activated = true;

    servedWorker = workerSource;
    await page.evaluate(async () => { const registration = await navigator.serviceWorker.getRegistration(); await registration.update(); });
    await waitForBrowserValue(page, async ({ current, old, extra }) => {
      const keys = await caches.keys();
      return navigator.serviceWorker.controller?.state === 'activated'
        && navigator.serviceWorker.controller !== window.__previousController
        && keys.includes(current) && !keys.includes(old) && !keys.includes(extra);
    }, { current: currentCache, old: oldCache, extra: extraOldCache }, 'new controller activation and old product cache removal');
    const upgraded = await page.evaluate(async name => ({
      keys: await caches.keys(), preserved: await (await caches.open(name)).match('/unrelated-fixture-record').then(value => value?.text()),
      active: (await navigator.serviceWorker.getRegistration()).active?.scriptURL,
      controller: navigator.serviceWorker.controller?.scriptURL,
    }), unrelatedCache);
    assert.deepEqual(upgraded.keys.sort(), [currentCache, unrelatedCache].sort());
    assert.equal(upgraded.preserved, 'preserve unrelated fixture');
    assert.equal(upgraded.active, origin + '/sw.js');
    assert.equal(upgraded.controller, origin + '/sw.js');
    report.checks.upgrade = { current_cache: currentCache, old_product_caches_removed: 2, unrelated_cache_preserved: true, ...upgraded };
    await page.reload();
    assert.equal(await page.evaluate(() => navigator.serviceWorker.controller?.state), 'activated');
    report.checks.reload_still_controlled = true;

    const read = address => page.evaluate(async address => {
      try { const response = await fetch(address, { cache: 'no-store' }); return { status: response.status, text: await response.text() }; }
      catch { return { network_failed: true }; }
    }, address);
    assert.match((await read('/v4/offline-probe.js')).text, /Revision = 1/);
    revision = 2;
    assert.match((await read('/v4/offline-probe.js')).text, /Revision = 2/);
    await waitForBrowserValue(page, async cacheName => (await (await caches.open(cacheName)).match('/v4/offline-probe.js').then(value => value?.text()))?.includes('Revision = 2'), currentCache, 'new static response in cache');
    report.checks.network_refresh_updates_static_cache = true;
    for (const address of ['/api/sw-fixture', '/compass_api/sw-fixture', '/v4/offline-probe.js?token=fixture-only', '/v4?token=']) {
      assert.equal((await read(address)).status, 200);
    }
    const cacheUrls = await page.evaluate(async () => {
      const all = [];
      for (const name of await caches.keys()) for (const request of await (await caches.open(name)).keys()) all.push(request.url);
      return all;
    });
    assert.ok(cacheUrls.every(address => !new URL(address).pathname.startsWith('/api/')
      && !new URL(address).pathname.startsWith('/compass_api/') && !new URL(address).searchParams.has('token')));
    report.checks.api_and_token_urls_absent_from_cache = true;

    const beforeOffline = requests.length;
    await context.setOffline(true);
    const cachedScript = await read('/v4/offline-probe.js');
    assert.equal(cachedScript.status, 200); assert.match(cachedScript.text, /Revision = 2/);
    const cachedDocument = await read('/v4');
    assert.equal(cachedDocument.status, 200); assert.ok(cachedDocument.text.includes('<main'));
    assert.equal((await read('/v4/uncached-fixture.css')).status, 503);
    assert.equal((await read('/api/sw-fixture')).network_failed, true);
    assert.equal((await read('/v4/offline-probe.js?token=fixture-only')).network_failed, true);
    assert.equal(requests.length, beforeOffline, 'offline reads must not reach even the fixture HTTP server');
    report.checks.offline = { cached_script: 200, cached_document: 200, uncached_static: 503, api_network_failed: true, token_network_failed: true, http_requests: 0 };
    await context.setOffline(false);
    assert.equal((await read('/api/sw-fixture')).status, 200);
    report.checks.online_recovery = true;
    assert.deepEqual(report.page_errors, []);
    report.ok = true;
  } catch (error) {
    failure = error; report.ok = false; report.error = error.message;
  } finally {
    if (context) { await context.close(); report.own_browser_context_closed = true; }
    await new Promise(resolve => server.close(resolve));
    report.own_http_server_closed = true;
    report.request_count = requests.length;
    report.blocked_external_proxy_attempts = blockedProxyRequests.length;
    fs.writeFileSync(path.join(output, 'http-requests.json'), JSON.stringify(requests, null, 2) + '\n', { flag: 'wx' });
    fs.writeFileSync(path.join(output, 'acceptance.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ service_worker_acceptance: path.join(output, 'acceptance.json'), ok: report.ok, checks: report.checks }));
  }
  if (failure) throw failure;
});
