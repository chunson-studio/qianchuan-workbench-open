'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadBrowserBindings, validateBrowserBinding } = require('../tools/lib/browser-profile-binding.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-profile-binding-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const entry = (overrides = {}) => ({
  account_id: 'account-a',
  advertiser_id: 'advertiser-a',
  primary_ad_id: 'plan-a',
  browser_type: 'extension',
  extension_instance_id: 'extension-a',
  profile_name: 'Profile A',
  status: 'active',
  ...overrides,
});
const registry = (bindings = [entry()]) => ({ schema_version: 1, bindings });
const profileEntry = (overrides = {}) => ({
  account_id: 'account-a',
  browser_type: 'extension',
  extension_instance_id: 'extension-a',
  profile_name: 'Profile A',
  status: 'active',
  advertisers: [
    { advertiser_id: 'advertiser-a', primary_ad_ids: ['plan-a', 'plan-b'] },
    { advertiser_id: 'advertiser-b', primary_ad_ids: ['plan-c'] },
  ],
  ...overrides,
});
const profileRegistry = (bindings = [profileEntry()]) => ({ schema_version: 2, bindings });
const request = (overrides = {}) => ({
  account_id: 'account-a', advertiser_id: 'advertiser-a', primary_ad_id: 'plan-a', ...overrides,
});
const browser = (overrides = {}) => ({
  browserId: 'runtime-browser-1',
  metadata: { extensionInstanceId: 'extension-a' },
  profileName: 'Profile A',
  ...overrides,
});

function writeJson(name, value) {
  const file = path.join(root, name);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

test('loads a strict local registry and returns runtime browser id only as evidence', () => {
  const loaded = loadBrowserBindings(writeJson('valid.json', registry()));
  const first = validateBrowserBinding(loaded, request(), browser({ browserId: 'runtime-one' }));
  const second = validateBrowserBinding(loaded, request(), browser({ browserId: 'runtime-two' }));
  assert.equal(first.ok, true);
  assert.equal(first.verified, true);
  assert.equal(first.identity.account_id, 'account-a');
  assert.equal(first.identity.extension_instance_id, 'extension-a');
  assert.equal(first.evidence.browser_id, 'runtime-one');
  assert.equal(second.evidence.browser_id, 'runtime-two');
  assert.equal(loaded.bindings[0].browser_id, undefined);
});

test('allows one Profile/account to select multiple advertiser scopes explicitly', () => {
  const loaded = profileRegistry();
  const first = validateBrowserBinding(loaded, request(), browser());
  const second = validateBrowserBinding(loaded, request({ advertiser_id: 'advertiser-b', primary_ad_id: 'plan-c' }), browser());
  assert.equal(first.ok, true);
  assert.equal(first.identity.advertiser_id, 'advertiser-a');
  assert.equal(second.ok, true);
  assert.equal(second.identity.advertiser_id, 'advertiser-b');
  assert.throws(() => validateBrowserBinding(loaded, request({ advertiser_id: 'advertiser-b', primary_ad_id: 'plan-b' }), browser()), { code: 'browser_binding_plan_mismatch' });
  assert.throws(() => validateBrowserBinding(loaded, request({ advertiser_id: 'advertiser-c' }), browser()), { code: 'browser_binding_advertiser_mismatch' });
});

test('fails closed for wrong runtime instance, profile, account, plan, and type', () => {
  const loaded = registry();
  assert.throws(() => validateBrowserBinding(loaded, request(), browser({ metadata: { extensionInstanceId: 'extension-other' } })), { code: 'browser_binding_instance_mismatch' });
  assert.throws(() => validateBrowserBinding(loaded, request(), browser({ profileName: 'Profile Other' })), { code: 'browser_binding_profile_mismatch' });
  assert.throws(() => validateBrowserBinding(loaded, request({ account_id: 'account-other' }), browser()), { code: 'browser_binding_account_mismatch' });
  assert.throws(() => validateBrowserBinding(loaded, request({ primary_ad_id: 'plan-other' }), browser()), { code: 'browser_binding_plan_mismatch' });
  assert.throws(() => validateBrowserBinding(loaded, request({ browser_type: 'native' }), browser()), { code: 'browser_binding_type_mismatch' });
  assert.throws(() => validateBrowserBinding(loaded, request(), browser({ browserType: 'native' })), { code: 'browser_binding_type_mismatch' });
  assert.throws(() => validateBrowserBinding(loaded, request(), browser({ metadata: { extensionInstanceId: 'extension-a', account_id: 'account-other' } })), { code: 'browser_binding_account_mismatch' });
  assert.throws(() => validateBrowserBinding(loaded, request(), browser({ metadata: { extensionInstanceId: 'extension-a', primaryAdId: 'plan-other' } })), { code: 'browser_binding_plan_mismatch' });
});

test('requires a matching registry entry and complete runtime metadata', () => {
  assert.throws(() => validateBrowserBinding(registry([]), request(), browser()), { code: 'browser_binding_account_mismatch' });
  assert.throws(() => validateBrowserBinding(registry(), request({ advertiser_id: 'advertiser-other' }), browser()), { code: 'browser_binding_advertiser_mismatch' });
  assert.throws(() => validateBrowserBinding(registry(), request(), { metadata: { extensionInstanceId: 'extension-a' }, profileName: 'Profile A' }), { code: 'browser_identity_missing' });
  assert.throws(() => validateBrowserBinding(registry(), request(), { browserId: 'runtime', metadata: { extensionInstanceId: 'extension-a' } }), { code: 'browser_identity_missing' });
});

test('rejects duplicate account and extension instance assignments', () => {
  assert.throws(() => loadBrowserBindings(writeJson('duplicate-account.json', registry([entry(), entry({ primary_ad_id: 'plan-b' })]))), { code: 'browser_bindings_ambiguous' });
  assert.throws(() => loadBrowserBindings(writeJson('duplicate-extension.json', registry([
    entry(), entry({ account_id: 'account-b', advertiser_id: 'advertiser-b', primary_ad_id: 'plan-b' }),
  ]))), { code: 'browser_bindings_extension_reused' });
});

test('invalid JSON is read-only and does not rewrite the source file', () => {
  const file = path.join(root, 'invalid.json');
  const source = '{ malformed';
  fs.writeFileSync(file, source);
  assert.throws(() => loadBrowserBindings(file), { code: 'browser_bindings_invalid_json' });
  assert.equal(fs.readFileSync(file, 'utf8'), source);
});

test('rejects malformed registry fields and never accepts a browser id as a stable key', () => {
  assert.throws(() => loadBrowserBindings(writeJson('browser-key.json', { ...registry(), bindings: [entry({ browser_id: 'persistent-browser' })] })), { code: 'browser_bindings_invalid_registry' });
  assert.throws(() => loadBrowserBindings(writeJson('wrong-status.json', registry([entry({ status: 'inactive' })]))), { code: 'browser_bindings_invalid_registry' });
  assert.throws(() => loadBrowserBindings(writeJson('wrong-type.json', registry([entry({ browser_type: 'native' })]))), { code: 'browser_bindings_invalid_registry' });
});

test('rejects duplicate advertiser scopes inside one Profile binding', () => {
  assert.throws(() => loadBrowserBindings(writeJson('duplicate-profile-advertiser.json', profileRegistry([
    profileEntry({ advertisers: [
      { advertiser_id: 'advertiser-a', primary_ad_ids: ['plan-a'] },
      { advertiser_id: 'advertiser-a', primary_ad_ids: ['plan-b'] },
    ] }),
  ]))), { code: 'browser_bindings_ambiguous' });
});
