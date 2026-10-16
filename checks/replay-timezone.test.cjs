'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function timezoneFixture() {
  // Must run before importing any production module; no real account or network.
  require('./setup-runtime.cjs');
  const { mock } = require('node:test');
  const now = Date.parse('2026-09-30T00:05:00+08:00');
  mock.timers.enable({ apis: ['Date'], now });
  try {
    const config = require('../server-app/server/lib/config');
    config.QIANCHUAN_ACCOUNTS.push({ id: 'timezone_test', aavid: '123', name: 'Fixture' });
    const tabs = require('../server-app/server/lib/qianchuanTabs');
    const board = require('../server-app/server/lib/liveBoard');
    const details = require('../server-app/server/lib/liveBoardDetail');
    const collector = require('../server-app/server/lib/liveCollector');
    const listDates = [], reportWindows = [], boardBindings = [];
    tabs.fetchLiveSessions = async date => { listDates.push(date); return { sessions: [] }; };
    tabs.fetchBoostTaskReport = async (start, end) => { reportWindows.push([start, end]); return { ok: true, tasks: [] }; };
    board.fetchLiveBoard = async (room, anchor, start, account, end) => {
      boardBindings.push({ room, start, account, end });
      return { fetched_at: new Date().toISOString(), anchorId: 'fixture-anchor', init: { rows: [{ Dimensions: { room_status: { Value: '4' } } }] } };
    };
    details.fetchBoardDetail = async () => ({ partial: false, errors: [] });
    collector.assembleRecord = () => ({ dataValid: false, partial: true, live_metrics: {}, trend: [], source: [], materials: {}, errors: [] });
    collector.getLatestWatch = () => [];
    const route = require('../server-app/server/routes/liveReplay');
    const { normalizeSessionTime, replayStoragePath, loadReplayStorage, sessionsSettled, replaySettled,
      sessionsArchiveStable, sessionDates, sessionCatalog, SETTLE_WINDOW_MS } = route._internal;
    assert.equal(SETTLE_WINDOW_MS, 90 * 60 * 1000);
    const start = '2026-09-29 21:00:00';
    const equivalentStarts = [start, '2026-09-29T21:00:00+08:00', '2026-09-29T13:00:00Z', '2026-09-29T08:00:00-05:00'];
    const keys = equivalentStarts.map(value => replayStoragePath('timezone_test', 'room', value));
    assert.equal(new Set(keys).size, 1, 'same instant must share one account/room/session cache key');
    for (const value of equivalentStarts) assert.equal(normalizeSessionTime(value), '2026-09-29T13:00:00.000Z');
    assert.equal(normalizeSessionTime('2026-09-29 21:00:00.125'), '2026-09-29T13:00:00.125Z');
    assert.equal(normalizeSessionTime('not-a-time'), 'not-a-time', 'unknown binding must not acquire invented time');
    const endMs = Date.parse('2026-09-29T22:30:00+08:00');
    const offsets = [SETTLE_WINDOW_MS - 1, SETTLE_WINDOW_MS, SETTLE_WINDOW_MS + 1];
    const expectedBoundary = [false, false, true];
    for (const end of ['2026-09-29 22:30:00', '2026-09-29T14:30:00Z', '2026-09-29T22:30:00+08:00']) {
      const sessions = [{ status: '4', startTime: start, endTime: end }];
      assert.deepEqual(offsets.map(offset => sessionsSettled(sessions, endMs + offset)), expectedBoundary);
      assert.deepEqual(offsets.map(offset => replaySettled({ room: { end_time: end }, fetchedAt: new Date(endMs + offset).toISOString() }, endMs + offset)), expectedBoundary);
      for (const [index, offset] of offsets.entries()) {
        assert.equal(sessionsArchiveStable({ sessions, fetchedAt: new Date(endMs + offset).toISOString() }, '2026-09-29', now), expectedBoundary[index]);
      }
    }
    for (const end of [null, '-', 'invalid']) assert.equal(replaySettled({ room: { end_time: end } }, now), false);
    const sessions = [{ account: 'timezone_test', roomId: 'room', status: '4', startTime: start, endTime: '2026-09-29 22:30:00' }];
    const archive = { ok: true, account: 'timezone_test', date: '2026-09-29', sessions, fetchedAt: '2026-09-30 00:00:00.001' };
    assert.equal(sessionsArchiveStable(archive, archive.date, now), true);
    assert.equal(sessionsArchiveStable({ ...archive, fetchedAt: '2026-09-29 22:40:00' }, archive.date, now), false, 'early sample does not mature through wall-clock age');
    assert.equal(sessionsArchiveStable({ ...archive, fetchedAt: undefined }, archive.date, now), false);
    assert.equal(sessionsArchiveStable({ ...archive, fetchedAt: '2026-09-30T00:06:00.001+08:00' }, archive.date, now), false, 'future source beyond tolerance remains unknown');
    const storage = path.join(config.STORAGE_DIR, 'replay');
    fs.mkdirSync(storage, { recursive: true });
    fs.writeFileSync(path.join(storage, 'sessions_timezone_test_2026-09-29.json'), JSON.stringify(archive));
    const day = sessionCatalog('timezone_test', ['2026-09-29'], now).days[0];
    assert.equal(day.cache_stable, true); assert.equal(day.status, 'ready');
    assert.equal(day.source_at, archive.fetchedAt); assert.deepEqual(day.sessions, sessions);
    const stored = { ok: true, room: { room_id: 'room', start_time: start, end_time: sessions[0].endTime }, fetchedAt: archive.fetchedAt };
    const storedBytes = JSON.stringify(stored);
    fs.writeFileSync(keys[0], storedBytes);
    assert.deepEqual(loadReplayStorage('timezone_test', 'room', equivalentStarts[2]), stored);
    assert.equal(loadReplayStorage('timezone_test', 'room', '2026-09-29T14:00:00Z'), null);
    assert.equal(fs.readFileSync(keys[0], 'utf8'), storedBytes, 'normalization must not rewrite original bound timestamps');
    assert.deepEqual(sessionDates('2026-09-29', '2026-09-30'), ['2026-09-30', '2026-09-29']);
    assert.equal(sessionDates('2026-10-01', '2026-10-01'), null);
    assert.equal(sessionDates('2026-02-30', '2026-02-30'), null);
    const read = async (suffix, params) => {
      let status, payload;
      const url = new URL('http://localhost/api/live-replay' + suffix);
      url.search = new URLSearchParams({ account: 'timezone_test', ...params });
      await route({ method: 'GET' }, { writeHead(value) { status = value; }, end(value) { payload = JSON.parse(value); } }, url);
      return { status, payload };
    };
    const defaultDay = await read('/sessions', { refresh: '1' });
    assert.equal(defaultDay.status, 200); assert.equal(defaultDay.payload.date, '2026-09-30');
    assert.deepEqual(listDates, ['2026-09-30']);
    for (const date of ['2026-10-01', '2026-02-30']) assert.equal((await read('/sessions', { date })).status, 400);
    assert.equal(listDates.length, 1, 'future/invalid dates must not trigger collection');
    // UTC date is the day before the platform report date; upstream bound fields remain exact.
    const originalStart = '2026-09-28T16:10:00Z', originalEnd = '2026-09-28T18:00:00Z';
    const detail = await read('', { roomId: 'history-room', startTime: originalStart, endTime: originalEnd, include_boost_history: '1', refresh: '1' });
    assert.equal(detail.status, 200);
    assert.deepEqual(reportWindows, [['2026-09-29', '2026-09-29']]);
    assert.deepEqual(boardBindings, [{ room: 'history-room', start: originalStart, account: 'timezone_test', end: originalEnd }]);
    assert.equal(detail.payload.room.start_time, originalStart); assert.equal(detail.payload.room.end_time, originalEnd);
    assert.deepEqual(detail.payload.related_boost_history.window, { start_date: '2026-09-29', end_date: '2026-09-29' });
    assert.equal(detail.payload.settlement_state.final_settlement_available, false);
    return { host_offset_min: new Date(now).getTimezoneOffset(), normalized_start: normalizeSessionTime(start),
      cache_file: path.basename(keys[0]), boundary: expectedBoundary, archive_status: day.status, source_at: day.source_at,
      default_date: defaultDay.payload.date, report_windows: reportWindows, original_binding_retained: true };
  } finally { mock.timers.reset(); }
}

if (process.argv.includes('--timezone-fixture')) {
  timezoneFixture().then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error); process.exitCode = 1; });
} else {
  const test = require('node:test');
  const { spawnSync } = require('node:child_process');
  test('replay identity, archive window and platform dates are identical under UTC and Asia/Shanghai', t => {
    const results = ['UTC', 'Asia/Shanghai'].map(TZ => {
      const child = spawnSync(process.execPath, [__filename, '--timezone-fixture'], {
        cwd: path.resolve(__dirname, '..'), env: { ...process.env, TZ }, encoding: 'utf8', windowsHide: true, timeout: 20000,
      });
      assert.equal(child.status, 0, `${TZ}: ${child.error?.message || child.stderr || child.stdout}`);
      return JSON.parse(child.stdout.trim());
    });
    assert.equal(results[0].host_offset_min, 0);
    assert.equal(results[1].host_offset_min, -480, 'two fixtures must actually use different host timezones');
    const comparable = ({ host_offset_min, ...result }) => result;
    assert.deepEqual(comparable(results[0]), comparable(results[1]));
    t.diagnostic(JSON.stringify({ timezones: ['UTC', 'Asia/Shanghai'], boundary_ms: [-1, 0, 1],
      stable_after_90min: results[0].boundary, default_beijing_date: results[0].default_date,
      real_network_requests: 0, source: 'isolated synthetic route fixtures' }));
  });
}
