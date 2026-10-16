'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire, Module } = require('node:module');

// APP_ROOT selects an installed candidate's dependencies, without changing source node_modules.
require('./setup-runtime.cjs');
const appRoot = path.resolve(process.env.APP_ROOT || path.join(__dirname, '../server-app'));
const candidate = createRequire(path.join(appRoot, 'package.json'));
const XLSX = candidate('xlsx');
const parserFile = path.resolve(__dirname, '../server-app/server/lib/offlineReports.js');
const sourceRequire = createRequire(parserFile);
const config = sourceRequire('./config');
assert.equal(config.QIANCHUAN_ACCOUNTS.length, 0, 'test configuration must start empty');
// Synthetic identity only in memory; no credential, platform request, or database import.
config.QIANCHUAN_ACCOUNTS.push({ id: 'xlsx_fixture', aavid: '1234567890' });
const parserModule = new Module(parserFile, module);
parserModule.filename = parserFile;
parserModule.require = name => name === 'xlsx' ? XLSX : sourceRequire(name);
parserModule._compile(fs.readFileSync(parserFile, 'utf8'), parserFile);
const { readRows, prepareReport, date } = parserModule.exports;
const materialId = '60000003789';

function fixture(value, format, { date1904 = false, header = '日期', formula = false } = {}) {
  const ws = XLSX.utils.aoa_to_sheet([[header, '素材ID', '整体消耗', '备注'], [value, materialId, 12.5, '=SUM(1,2)']]);
  if (format) ws.A2.z = format;
  if (formula) ws.C2 = { t: 'n', v: 12.5, f: '1000+999' };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '报表');
  wb.Workbook = { WBProps: { date1904 } };
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
function rows(buffer) { return readRows(buffer, 'fixture.xlsx').rows; }
function report(buffer, start = '2026-09-29', end = start) {
  return prepareReport(buffer, { account_id: 'xlsx_fixture', filename: 'fixture.xlsx', start, end });
}
function timezoneFixture() {
  return {
    host_offset_min: new Date('2026-09-29T00:00:00Z').getTimezoneOffset(),
    xlsx_version: XLSX.version,
    dates: [rows(fixture(46294.999, 'yyyy-mm-dd'))[1][0],
      rows(fixture(44832.125, 'yyyy-mm-dd', { date1904: true }))[1][0],
      rows(fixture(0, 'yyyy-mm-dd', { date1904: true }))[1][0]],
    invalid_leap_day: rows(fixture(60, 'yyyy-mm-dd'))[1][0],
    material_id: rows(fixture(46294, 'yyyy-mm-dd'))[1][1],
  };
}

if (process.argv.includes('--timezone-fixture')) {
  console.log(JSON.stringify(timezoneFixture()));
} else {
  const test = require('node:test');
  const { spawnSync } = require('node:child_process');

  test('calendar-formatted Excel 日期 values become calendar strings without changing raw IDs, numbers or formulas', () => {
    for (const format of ['yyyy-mm-dd', 'm/d/yy', 'yyyy"年"m"月"d"日"', 'yyyy-mm-dd hh:mm:ss']) {
      const buffer = fixture(46294.75, format, { formula: true });
      const values = rows(buffer)[1];
      assert.deepEqual(values, ['2026-09-29', materialId, 12.5, '=SUM(1,2)']);
      const prepared = report(buffer);
      assert.equal(prepared.rows[0].stat_date, '2026-09-29');
      assert.equal(prepared.rows[0].entity_id, materialId);
      assert.equal(prepared.rows[0].metrics.cost, 12.5, 'cached formula value is read, not evaluated');
    }
    const numericId = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(numericId, XLSX.utils.aoa_to_sheet([['日期', '素材ID', '整体消耗'], ['2026-09-29', 1e18, 7.25]]), '报表');
    assert.throws(() => report(XLSX.write(numericId, { type: 'buffer', bookType: 'xlsx' })), { code: 'unsafe_numeric_id' });
  });

  test('1904 workbook epoch and Gregorian validation preserve valid dates and reject Excel fictional dates', () => {
    assert.equal(rows(fixture(44832, 'yyyy-mm-dd', { date1904: true }))[1][0], '2026-09-29');
    assert.equal(rows(fixture(0, 'yyyy-mm-dd', { date1904: true }))[1][0], '1904-01-01');
    assert.equal(rows(fixture(59, 'yyyy-mm-dd'))[1][0], '1900-02-28');
    assert.equal(rows(fixture(61, 'yyyy-mm-dd'))[1][0], '1900-03-01');
    for (const value of [0, 60, 60.75, -1]) {
      const buffer = fixture(value, 'yyyy-mm-dd');
      assert.equal(rows(buffer)[1][0], value);
      assert.throws(() => report(buffer, '1900-01-01', '1900-12-31'), { code: 'invalid_row_date' });
    }
  });

  test('text dates and summary rows retain their raw values', () => {
    for (const value of ['2026/9/29', '2026-09-29', '全部']) {
      const buffer = fixture(value, 'yyyy-mm-dd');
      assert.equal(rows(buffer)[1][0], value);
      assert.equal(report(buffer).rows[0].scope, value === '全部' ? 'period_total' : 'day');
    }
  });

  test('ordinary, quoted, time-only and conditional numeric formats do not acquire guessed dates', () => {
    for (const format of ['General', '0.00', 'hh:mm', 'mm:ss', '[h]:mm:ss', '0"days"', '0\\y', '[>=0]0;yyyy-mm-dd']) {
      const buffer = fixture(46294.5, format);
      assert.equal(rows(buffer)[1][0], 46294.5, format);
      assert.equal(date(rows(buffer)[1][0]), null);
      assert.throws(() => report(buffer), { code: 'invalid_row_date' }, format);
    }
    assert.equal(rows(fixture(46294, 'yyyy-mm-dd', { header: '其他日期' }))[1][0], 46294, 'only the exact 日期 heading is converted');
  });

  test('blank rows preserve worksheet addresses for later calendar values', () => {
    const ws = XLSX.utils.aoa_to_sheet([['日期', '整体消耗'], [46294, 1.25], [], [46295, 2.5]]);
    ws.A2.z = ws.A4.z = 'yyyy-mm-dd';
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '报表');
    const actual = rows(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
    assert.deepEqual(actual, [['日期', '整体消耗'], ['2026-09-29', 1.25], [null, null], ['2026-09-30', 2.5]]);
  });

  test('calendar results and exact text IDs are identical in UTC and Asia/Shanghai', t => {
    const results = ['UTC', 'Asia/Shanghai'].map(TZ => {
      const child = spawnSync(process.execPath, [__filename, '--timezone-fixture'], {
        cwd: path.resolve(__dirname, '..'), env: { ...process.env, TZ, APP_ROOT: appRoot },
        encoding: 'utf8', windowsHide: true, timeout: 15000,
      });
      assert.equal(child.status, 0, `${TZ}: ${child.error?.message || child.stderr || child.stdout}`);
      return JSON.parse(child.stdout);
    });
    assert.notEqual(results[0].host_offset_min, results[1].host_offset_min);
    const { host_offset_min: utcOffset, ...utc } = results[0];
    const { host_offset_min: chinaOffset, ...china } = results[1];
    assert.deepEqual(utc, china);
    assert.deepEqual(utc.dates, ['2026-09-29', '2026-09-29', '1904-01-01']);
    assert.equal(utc.invalid_leap_day, 60);
    t.diagnostic(`XLSX ${XLSX.version}; offsets ${utcOffset}/${chinaOffset}; no platform or database writes`);
  });
}
