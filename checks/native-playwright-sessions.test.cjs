'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createQianchuanPlaywrightSessions } = require('../tools/connect-qc-playwright.cjs');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const contexts = [];
  const state = { launches: 0, navigation: [], initializations: 0 };
  function makePage(context, url = 'about:blank') {
    const page = {
      closed: false, currentUrl: url,
      isClosed() { return this.closed; },
      url() { return this.currentUrl; },
      async goto(next) { state.navigation.push(next); this.currentUrl = context.redirect || next; },
      async close() { this.closed = true; },
    };
    context.items.push(page);
    return page;
  }
  const chromium = {
    async launchPersistentContext(directory, options) {
      state.launches++;
      const context = {
        directory, options, items: [], listeners: {}, closed: false,
        pages() { return this.items.filter(page => !page.closed); },
        async newPage() { return makePage(this); },
        setDefaultTimeout(value) { this.timeout = value; },
        setDefaultNavigationTimeout(value) { this.navigationTimeout = value; },
        on(event, listener) { this.listeners[event] = listener; },
        async close() { this.closed = true; for (const page of this.items) page.closed = true; this.listeners.close?.(); },
      };
      contexts.push(context);
      return context;
    },
  };
  const sessions = createQianchuanPlaywrightSessions({ chromium, headless: true, timeoutMs: 2000, onContextCreated: async () => { state.initializations++; } });
  return { sessions, contexts, state, chromium, makePage };
}

function spec(account = 'a', overrides = {}) {
  return {
    profile_dir: path.resolve(__dirname, 'native-profiles', account), account_id: account,
    advertiser_id: 'adv-' + account, primary_ad_id: 'plan-' + account,
    url: 'https://qianchuan.jinritemai.com/uni-prom/detail?aavid=adv-' + account + '&adId=plan-' + account,
    ...overrides,
  };
}

test('different profiles run concurrently while one profile queues and reuses its context/page', async () => {
  const f = fixture(), entered = deferred(), release = deferred(), order = [];
  let firstSession;
  const first = f.sessions.run(spec(), async session => { firstSession = session; order.push('a-start'); entered.resolve(); await release.promise; order.push('a-end'); });
  await entered.promise;
  const second = f.sessions.run(spec(), async session => { assert.equal(session.page, firstSession.page); assert.equal(session.context, firstSession.context); order.push('a-next'); });
  await f.sessions.run(spec('b'), async session => { assert.notEqual(session.context, firstSession.context); order.push('b'); });
  assert.deepEqual(order, ['a-start', 'b']);
  release.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['a-start', 'b', 'a-end', 'a-next']);
  assert.equal(f.state.launches, 2);
  assert.equal(f.state.navigation.length, 2);
  await f.sessions.close();
});

test('binding and configuration errors reject before browser launch', async () => {
  const f = fixture();
  const invalid = [
    spec('a', { account_id: '' }), spec('a', { advertiser_id: 60000041 }),
    spec('a', { profile_dir: 'relative/profile' }),
    spec('a', { url: 'http://qianchuan.jinritemai.com/uni-prom/detail?aavid=adv-a&adId=plan-a' }),
    spec('a', { url: 'https://qianchuan.jinritemai.com.evil.invalid/?aavid=adv-a&adId=plan-a' }),
    spec('a', { url: 'https://qianchuan.jinritemai.com/?aavid=adv-b&adId=plan-a' }),
    spec('a', { url: 'https://qianchuan.jinritemai.com/?aavid=adv-a&adId=plan-a&primary_ad_id=plan-b' }),
    spec('a', { url: 'https://qianchuan.jinritemai.com/?aavid=adv-a&adId=plan-a#?aavid=adv-b' }),
    spec('a', { url: 'https://qianchuan.jinritemai.com/?aavid=adv-a&adId=plan-a#/detail?adId=plan-b' }),
    spec('a', { url: 'https://qianchuan.jinritemai.com/?aavid=adv-a' }),
    spec('a', { url: 'https://user:password@qianchuan.jinritemai.com/?aavid=adv-a&adId=plan-a' }),
  ];
  for (const value of invalid) await assert.rejects(f.sessions.open(value));
  await assert.rejects(f.sessions.run(spec(), null), { code: 'session_callback_invalid' });
  assert.equal(f.state.launches, 0);
  assert.throws(() => createQianchuanPlaywrightSessions({ timeoutMs: 0 }), { code: 'session_options_invalid' });
  assert.throws(() => createQianchuanPlaywrightSessions({ executablePath: 'relative/chrome' }), { code: 'session_options_invalid' });
});

test('one profile cannot change accounts, including normalized path aliases and after close', async () => {
  const f = fixture(), initial = spec();
  const first = await f.sessions.open(initial);
  const alias = path.join(initial.profile_dir, 'unused', '..') + path.sep;
  assert.equal((await f.sessions.open({ ...initial, profile_dir: alias })).context, first.context);
  const other = spec('b', { profile_dir: alias });
  await assert.rejects(f.sessions.open(other), { code: 'profile_account_conflict' });
  await f.sessions.close(initial.profile_dir);
  await assert.rejects(f.sessions.open(other), { code: 'profile_account_conflict' });
  if (process.platform === 'win32') {
    await assert.rejects(f.sessions.open({ ...other, profile_dir: alias.toUpperCase() }), { code: 'profile_account_conflict' });
  }
  assert.equal(f.state.launches, 1);
});

test('same account different plans use separate explicitly bound pages in one context', async () => {
  const f = fixture();
  const one = await f.sessions.open(spec());
  const two = await f.sessions.open(spec('a', { primary_ad_id: 'plan-2', url: 'https://qianchuan.jinritemai.com/uni-prom/detail?aavid=adv-a&adId=plan-2' }));
  assert.equal(one.context, two.context);
  assert.notEqual(one.page, two.page);
  assert.equal(f.state.launches, 1);
  await f.sessions.close();
});

test('callback failure releases the queue without replaying the failed action', async () => {
  const f = fixture();
  let submissions = 0;
  const timeout = new Error('submission response disconnected');
  timeout.name = 'TimeoutError';
  timeout.code = 'readback_timeout';
  timeout.details = { object_id: 'original-object' };
  const failed = f.sessions.run(spec(), async () => { submissions++; throw timeout; });
  const next = f.sessions.run(spec(), async () => 'readback-only');
  await assert.rejects(failed, error => {
    assert.equal(error, timeout);
    assert.equal(error.name, 'TimeoutError');
    assert.equal(error.code, 'readback_timeout');
    assert.deepEqual(error.details, { object_id: 'original-object', effect_status: 'unconfirmed', retry_write: false });
    return true;
  });
  assert.equal(await next, 'readback-only');
  assert.equal(submissions, 1);
  assert.equal(f.state.launches, 1);
  await f.sessions.close();
});

test('initialization precedes navigation and failed initialization cannot be silently bypassed', async () => {
  const f = fixture();
  let attempts = 0;
  const sessions = createQianchuanPlaywrightSessions({ chromium: f.chromium, onContextCreated: async () => {
    assert.equal(f.state.navigation.length, 0);
    if (++attempts === 1) throw Error('route setup failed');
  } });
  await assert.rejects(sessions.open(spec()), /route setup failed/);
  assert.equal(f.contexts[0].closed, false);
  await sessions.open(spec());
  assert.equal(attempts, 2);
  assert.equal(f.state.launches, 1);
  await sessions.close();
});

test('absent URL only reuses an observed matching page; ambiguous pages are rejected', async () => {
  const f = fixture();
  await assert.rejects(f.sessions.open(spec('a', { url: undefined })), { code: 'page_unavailable' });
  assert.equal(f.state.launches, 1);
  assert.equal(f.state.navigation.length, 0);
  const existing = f.makePage(f.contexts[0], spec().url);
  assert.equal((await f.sessions.open(spec('a', { url: undefined }))).page, existing);
  const duplicate = f.makePage(f.contexts[0], spec().url);
  await assert.rejects(f.sessions.run(spec(), async () => assert.fail('must not execute')), { code: 'browser_page_ambiguous' });
  assert.equal(existing.closed, false);
  assert.equal(duplicate.closed, false);
  await f.sessions.close();
});

test('a closed page is rediscovered; unrelated pages are preserved', async () => {
  const f = fixture();
  const first = await f.sessions.open(spec());
  const unrelated = f.makePage(first.context, 'https://example.invalid/');
  await first.page.close();
  const replacement = f.makePage(first.context, spec().url);
  const found = await f.sessions.open(spec());
  assert.equal(found.page, replacement);
  assert.equal(unrelated.closed, false);
  await replacement.close();
  const fresh = await f.sessions.open(spec());
  assert.notEqual(fresh.page, replacement);
  assert.equal(f.state.launches, 1);
  assert.equal(f.state.navigation.length, 2);
  await f.sessions.close();
});

test('login redirect and changed page identity block callbacks; returned write outcomes remain unconfirmed', async () => {
  const f = fixture();
  const first = await f.sessions.open(spec());
  first.page.currentUrl = 'https://qianchuan.jinritemai.com/login';
  await assert.rejects(f.sessions.run(spec(), async () => assert.fail('must not execute')), { code: 'browser_identity_unavailable' });
  first.page.currentUrl = spec('b').url;
  await assert.rejects(f.sessions.open(spec()), { code: 'browser_identity_mismatch' });
  first.page.currentUrl = spec().url;
  await assert.rejects(f.sessions.run(spec(), async ({ page }) => { page.currentUrl = spec('b').url; }), error => {
    assert.equal(error.code, 'browser_identity_mismatch');
    assert.equal(error.details.effect_status, 'unconfirmed');
    assert.equal(error.details.retry_write, false);
    return true;
  });
  assert.equal(f.state.navigation.length, 1);
  await f.sessions.close();
});

test('close waits for current work, closes only selected owned contexts, and permits reopening', async () => {
  const f = fixture(), entered = deferred(), release = deferred();
  const a = await f.sessions.open(spec());
  const b = await f.sessions.open(spec('b'));
  const active = f.sessions.run(spec(), async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const closing = f.sessions.close(spec().profile_dir);
  assert.equal(a.context.closed, false);
  await assert.rejects(f.sessions.open(spec()), { code: 'session_closing' });
  release.resolve();
  await Promise.all([active, closing]);
  assert.equal(a.context.closed, true);
  assert.equal(b.context.closed, false);
  const reopened = await f.sessions.open(spec());
  assert.notEqual(reopened.context, a.context);
  assert.equal(f.state.launches, 3);
  assert.equal(f.state.initializations, 3);
  await f.sessions.close();
});

test('externally closed owned context can be reopened without stale page handles', async () => {
  const f = fixture();
  const first = await f.sessions.open(spec());
  await first.context.close();
  const next = await f.sessions.open(spec());
  assert.notEqual(next.context, first.context);
  assert.notEqual(next.page, first.page);
  assert.equal(f.state.launches, 2);
  await f.sessions.close();
});

test('launch failure releases only its own queue and an explicit later attempt can succeed', async () => {
  const f = fixture();
  let attempts = 0;
  const sessions = createQianchuanPlaywrightSessions({ chromium: {
    async launchPersistentContext(...args) {
      if (++attempts === 1) throw Error('native profile already in use');
      return f.chromium.launchPersistentContext(...args);
    },
  } });
  await assert.rejects(sessions.open(spec()), { code: 'browser_launch_failed' });
  assert.equal(attempts, 1);
  await sessions.open(spec());
  assert.equal(attempts, 2);
  await sessions.close();
});

test('a fresh page redirected to login preserves its context without retrying navigation', async () => {
  const f = fixture();
  const sessions = createQianchuanPlaywrightSessions({ chromium: f.chromium, onContextCreated: async context => {
    context.redirect = 'https://qianchuan.jinritemai.com/login';
  } });
  await assert.rejects(sessions.open(spec()), { code: 'browser_identity_unavailable' });
  await assert.rejects(sessions.open(spec()), { code: 'browser_identity_unavailable' });
  assert.equal(f.contexts[0].closed, false);
  assert.equal(f.state.navigation.length, 1);
  await sessions.close();
});

test('default Windows Chrome and Edge profiles are rejected before launch', { skip: process.platform !== 'win32' || !process.env.LOCALAPPDATA }, async () => {
  const f = fixture();
  for (const product of ['Google/Chrome', 'Microsoft/Edge']) {
    const root = path.join(process.env.LOCALAPPDATA, product, 'User Data');
    for (const profile_dir of [root, path.join(root, 'Default'), path.join(root, 'Profile 101')]) {
      await assert.rejects(f.sessions.open(spec('a', { profile_dir })), { code: 'default_profile_forbidden' });
    }
  }
  assert.equal(f.state.launches, 0);
});

test('an expired queued run never submits later and other profiles remain available', async () => {
  const f = fixture(), entered = deferred(), release = deferred();
  let submissions = 0;
  const first = f.sessions.run(spec(), async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const expired = f.sessions.run(spec(), async () => { submissions++; }, { queueTimeoutMs: 15 });
  await assert.rejects(expired, error => {
    assert.equal(error.code, 'session_queue_timeout');
    assert.deepEqual(error.details, { effect_status: 'not_submitted', retry_write: false });
    return true;
  });
  assert.equal(await f.sessions.run(spec('b'), async () => 'other-account-read'), 'other-account-read');
  release.resolve();
  await first;
  assert.equal(await f.sessions.run(spec(), async () => 'original-id-readback'), 'original-id-readback');
  assert.equal(submissions, 0);
  await f.sessions.close();
});

test('a pre-aborted signal launches no browser and invokes no callback', async () => {
  const f = fixture(), abort = new AbortController();
  abort.abort();
  await assert.rejects(f.sessions.run(spec(), async () => assert.fail('must not execute'), { signal: abort.signal }), error => {
    assert.equal(error.code, 'session_cancelled');
    assert.deepEqual(error.details, { effect_status: 'not_submitted', retry_write: false });
    return true;
  });
  assert.equal(f.state.launches, 0);
});

test('a delayed timer cannot allow an already expired callback to start', async () => {
  const f = fixture(), entered = deferred(), release = deferred();
  let submissions = 0;
  const first = f.sessions.run(spec(), async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const expired = f.sessions.run(spec(), async () => { submissions++; }, { queueTimeoutMs: 10 });
  // Block only this test's event loop so promise jobs can run before the timer.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  release.resolve();
  await first;
  await assert.rejects(expired, { code: 'session_queue_timeout' });
  assert.equal(submissions, 0);
  await f.sessions.close();
});

test('aborting during page preparation prevents callback and keeps preparation in the queue', async () => {
  const f = fixture(), preparing = deferred(), release = deferred(), abort = new AbortController();
  let submissions = 0, subsequent = 0;
  const sessions = createQianchuanPlaywrightSessions({ chromium: f.chromium, onContextCreated: async () => {
    preparing.resolve();
    await release.promise;
  } });
  const active = sessions.run(spec(), async () => { submissions++; }, { signal: abort.signal });
  await preparing.promise;
  abort.abort();
  await assert.rejects(active, { code: 'session_cancelled' });
  const next = sessions.run(spec(), async () => { subsequent++; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(subsequent, 0);
  release.resolve();
  await next;
  assert.equal(submissions, 0);
  assert.equal(subsequent, 1);
  await sessions.close();
});

test('an abort after callback start does not abandon it or release its profile queue early', async () => {
  const f = fixture(), entered = deferred(), release = deferred(), abort = new AbortController();
  let submissions = 0, nextStarted = false;
  const active = f.sessions.run(spec(), async () => {
    submissions++;
    entered.resolve();
    await release.promise;
    return 'original-operation-readback';
  }, { signal: abort.signal, queueTimeoutMs: 20 });
  await entered.promise;
  abort.abort();
  const next = f.sessions.run(spec(), async () => { nextStarted = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(nextStarted, false);
  release.resolve();
  assert.equal(await active, 'original-operation-readback');
  await next;
  assert.equal(submissions, 1);
  assert.equal(nextStarted, true);
  await f.sessions.close();
});

test('invalid run cancellation options reject before launch', async () => {
  const f = fixture();
  for (const options of [null, { queueTimeoutMs: 0 }, { queueTimeoutMs: 2147483648 }, { signal: {} }]) {
    await assert.rejects(f.sessions.run(spec(), async () => {}, options), { code: 'session_run_options_invalid' });
  }
  assert.equal(f.state.launches, 0);
});
