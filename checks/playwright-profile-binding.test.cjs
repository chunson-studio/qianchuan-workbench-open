'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validatePlaywrightBinding,
  normalizeLocalEndpoint,
} = require('../tools/lib/playwright-profile-binding.cjs');

function registry(overrides = {}) {
  return {
    schema_version: 1,
    bindings: [{
      account_id: 'account-1',
      browser_type: 'playwright-cdp',
      profile_name: 'Profile-1',
      cdp_endpoint: 'http://127.0.0.1:9222',
      status: 'active',
      advertisers: [{ advertiser_id: 'adv-1', primary_ad_ids: ['plan-1'] }],
      ...overrides,
    }],
  };
}

test('validates a local Playwright/CDP binding and returns runtime-only evidence', () => {
  const result = validatePlaywrightBinding(
    registry(),
    { account_id: 'account-1', advertiser_id: 'adv-1', primary_ad_id: 'plan-1' },
    { browserType: 'playwright-cdp', profileName: 'Profile-1', cdpEndpoint: 'http://127.0.0.1:9222', browserId: 'runtime-1' },
  );
  assert.equal(result.ok, true);
  assert.equal(result.identity.browser_type, 'playwright-cdp');
  assert.equal(result.evidence.browser_id_scope, 'runtime_only');
  assert.equal(result.evidence.cdp_endpoint_scope, 'local_only');
});

test('rejects remote endpoints, endpoint reuse, and wrong runtime identity', () => {
  assert.throws(() => normalizeLocalEndpoint('https://example.com:9222'), { code: 'playwright_binding_non_local_endpoint' });
  assert.throws(() => validatePlaywrightBinding(
    registry(),
    { account_id: 'account-1', advertiser_id: 'adv-1', primary_ad_id: 'plan-1' },
    { browserType: 'extension', profileName: 'Profile-1' },
  ), { code: 'playwright_binding_type_mismatch' });
  assert.throws(() => validatePlaywrightBinding(
    registry(),
    { account_id: 'account-1', advertiser_id: 'adv-1', primary_ad_id: 'plan-1' },
    { browserType: 'playwright-cdp', profileName: 'Other', cdpEndpoint: 'http://127.0.0.1:9222' },
  ), { code: 'playwright_binding_profile_mismatch' });
});

test('rejects mismatched account, advertiser, and plan before runtime access', () => {
  for (const binding of [
    { account_id: 'other', advertiser_id: 'adv-1', primary_ad_id: 'plan-1' },
    { account_id: 'account-1', advertiser_id: 'other', primary_ad_id: 'plan-1' },
    { account_id: 'account-1', advertiser_id: 'adv-1', primary_ad_id: 'other' },
  ]) {
    assert.throws(() => validatePlaywrightBinding(registry(), binding, {
      browserType: 'playwright-cdp', profileName: 'Profile-1', cdpEndpoint: 'http://127.0.0.1:9222',
    }));
  }
});
