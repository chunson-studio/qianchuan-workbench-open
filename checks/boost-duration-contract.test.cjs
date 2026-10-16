'use strict';
require('./setup-runtime.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { readBoostDuration, positiveInteger } = require('../server-app/server/lib/boostDuration');
// These are pure data-contract checks. Avoid querying even the isolated operation log.
const actionLimits = require('../server-app/server/lib/actionLimits');
actionLimits.safeActionLimits = () => ({});
actionLimits.resumeProtection = () => ({ allowed: true, reason: null });
const { normalizedTarget } = require('../server-app/server/lib/writeReceipt');
const { parseTask } = require('../server-app/server/lib/boostTaskContract');
const { slimBoostTask } = require('../server-app/server/lib/mcpClean');

const keys = ['duration_seconds', 'duration_unit', 'duration_source', 'duration_reason'];
const durationFields = value => Object.fromEntries(keys.map(key => [key, value[key]]));
const unknown = reason => ({ duration_seconds: null, duration_unit: 'unknown', duration_source: null,
  duration_reason: reason || 'duration_unavailable' });
const known = (seconds, source) => ({ duration_seconds: seconds, duration_unit: 'seconds', duration_source: source,
  duration_reason: null });
const parse = raw => parseTask({ id: '11', smartBidType: 7, adDeliveryName: '投放中', ...raw },
  { id: '22' }, { data: { adStatsMap: {} } }, { accountId: 'duration_contract_test' });

test('official startTime/endTime numeric and decimal-string seconds produce total duration with provenance', () => {
  const start = 1790731800;
  for (const raw of [
    { startTime: start, endTime: start + 21600 },
    { startTime: String(start), endTime: String(start + 21600) },
    { startTime: start, endTime: String(start + 21600) },
    { startTime: String(start), endTime: start + 21600 },
  ]) assert.deepEqual(readBoostDuration(raw), known(21600, 'upstream.endTime-startTime'));
});

test('explicit unit-bearing seconds remain available without schedule and agree with a matching schedule', () => {
  for (const value of [21600, '21600']) {
    assert.deepEqual(readBoostDuration({ duration_seconds: value }), known(21600, 'upstream.duration_seconds'));
    assert.deepEqual(readBoostDuration({ startTime: 100, endTime: 21700, duration_seconds: value }),
      known(21600, 'upstream.endTime-startTime'));
  }
});

test('zero, null, negative, fractional and malformed times are not interpreted as seconds', () => {
  const invalid = [0, '0', null, undefined, -1, '-1', 1.5, '1.5', true, false, '', ' ', ' 100', '100 ',
    '1e3', '0x10', {}, [], Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1];
  for (const value of invalid) {
    assert.equal(positiveInteger(value), null, String(value));
    assert.deepEqual(readBoostDuration({ duration_seconds: value }), unknown());
    assert.deepEqual(readBoostDuration({ startTime: value, endTime: 100000 }), unknown('duration_schedule_invalid'));
    assert.deepEqual(readBoostDuration({ startTime: 100, endTime: value }), unknown('duration_schedule_invalid'));
  }
  assert.deepEqual(readBoostDuration(), unknown());
  for (const raw of [null, 0, '21600', false, []]) assert.deepEqual(readBoostDuration(raw), unknown());
  assert.deepEqual(readBoostDuration({ startTime: 100 }), unknown('duration_schedule_invalid'));
  assert.deepEqual(readBoostDuration({ endTime: 21700 }), unknown('duration_schedule_invalid'));
});

test('equal and reverse schedules remain unknown and ambiguous elapsed fields never provide total duration', () => {
  for (const raw of [
    { startTime: 100, endTime: 100 },
    { startTime: 200, endTime: 100 },
    { startTime: '200', endTime: '100' },
    { Duration: 21600, deliverySeconds: 21600, startTime: 200, endTime: 100 },
  ]) assert.deepEqual(readBoostDuration(raw), unknown('duration_schedule_invalid'));
  for (const raw of [{ Duration: 21600 }, { deliverySeconds: 21600 }]) {
    assert.deepEqual(readBoostDuration(raw), unknown());
  }
  assert.deepEqual(readBoostDuration({ startTime: 100, endTime: 21700, Duration: 5, deliverySeconds: 30 }),
    known(21600, 'upstream.endTime-startTime'));
});

test('invalid or partial schedule never falls back to otherwise valid explicit seconds', () => {
  for (const raw of [
    { startTime: 200, endTime: 100 },
    { startTime: 100, endTime: 100 },
    { startTime: 100 },
    { endTime: 21700 },
    { startTime: 0, endTime: 21600 },
    { startTime: null, endTime: 21700 },
    { startTime: 100, endTime: 21700.5 },
  ]) {
    const input = { ...raw, duration_seconds: 21600 };
    const expected = unknown('duration_schedule_invalid');
    assert.deepEqual(readBoostDuration(input), expected);
    assert.deepEqual(durationFields(normalizedTarget(input)), expected);
    assert.deepEqual(durationFields(slimBoostTask(parse(input))), expected);
  }
});

test('conflicting explicit and scheduled totals stay null with an explanatory reason', () => {
  for (const value of [18000, '18000']) {
    const raw = { startTime: 100, endTime: 21700, duration_seconds: value };
    const expected = unknown('duration_fields_conflict');
    assert.deepEqual(readBoostDuration(raw), expected);
    assert.deepEqual(durationFields(normalizedTarget(raw)), expected);
    assert.deepEqual(durationFields(parse(raw)), expected);
  }
});

test('list parser, receipt normalization and MCP slim output share value, unit, source and reason', () => {
  const cases = [
    [{ startTime: '100', endTime: '21700' }, known(21600, 'upstream.endTime-startTime')],
    [{ duration_seconds: 21600 }, known(21600, 'upstream.duration_seconds')],
    [{ Duration: 21600, deliverySeconds: 500 }, unknown()],
    [{ startTime: 100, endTime: 21700, duration_seconds: 18000 }, unknown('duration_fields_conflict')],
  ];
  for (const [raw, expected] of cases) {
    const normalized = normalizedTarget(raw);
    const parsed = parse(raw);
    assert.deepEqual(durationFields(normalized), expected);
    assert.deepEqual(durationFields(parsed), expected);
    assert.deepEqual(durationFields(slimBoostTask(parsed)), expected);
    assert.deepEqual(durationFields(slimBoostTask(normalized)), expected);
  }
});
