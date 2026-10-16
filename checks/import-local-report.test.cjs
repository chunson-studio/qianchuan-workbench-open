'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { test, after } = require('node:test');
const project = path.resolve(process.env.IMPORT_TEST_PROJECT_ROOT || path.join(__dirname, '..'));
const cli = path.join(project, 'tools/import-local-report.cjs');
const { MAX_FILE_BYTES, readBoundedFile, run } = require(cli);
const requireApp = createRequire(path.join(project, 'server-app/package.json'));
const XLSX = requireApp('xlsx');
const parent = path.resolve(process.env.IMPORT_TEST_OUTPUT_ROOT || require('./test-output.cjs').testOutputRoot());
fs.mkdirSync(parent, { recursive: true });
const output = fs.mkdtempSync(path.join(parent, 'import-local-report-'));
const marker = 'ROW_AND_COOKIE_SENTINEL_MUST_NOT_APPEAR';
const longId = '60000003789';
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const calls = [];
const guard = path.join(output, 'guard.cjs');
fs.writeFileSync(guard, `
'use strict';
const fs = require('node:fs'), path = require('node:path');
const root = path.resolve(process.env.QC_IMPORT_TEST_RUNTIME || '');
if (!process.env.QC_IMPORT_TEST_RUNTIME || process.env.QC_DISABLE_BACKGROUND !== '1') throw Error('test_isolation_required');
for (const key of ['QC_RUNTIME_CONFIG_ROOT', 'QC_RUNTIME_DATA_ROOT']) if (!path.resolve(process.env[key] || '').startsWith(root + path.sep)) throw Error('runtime_outside_test');
const config = JSON.parse(fs.readFileSync(path.join(process.env.QC_RUNTIME_CONFIG_ROOT, 'config.json'), 'utf8'));
if (config.cleanup_enabled !== false || config.scheduler.enabled !== false || config.qianchuan_accounts.some(a => !['fixture_a','fixture_b'].includes(a.id))) throw Error('test_config_required');
if (fs.existsSync(path.join(process.env.QC_RUNTIME_CONFIG_ROOT, '.account-transaction.json')) || fs.existsSync(path.join(process.env.QC_RUNTIME_CONFIG_ROOT, '.account-transaction.lock'))) throw Error('test_transaction_state_present');
function blocked(kind) { fs.appendFileSync(path.join(root, 'blocked.jsonl'), JSON.stringify({ kind }) + '\\n'); throw Error('test_blocked_' + kind); }
require('node:net').Socket.prototype.connect = () => blocked('network');
require('node:dgram').Socket.prototype.send = () => blocked('network');
global.fetch = async () => blocked('network');
for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) require('node:child_process')[key] = () => blocked('subprocess');
for (const key of ['rm', 'rmdir', 'unlink', 'rmSync', 'rmdirSync', 'unlinkSync']) fs[key] = () => blocked('deletion');
for (const key of ['rm', 'rmdir', 'unlink']) fs.promises[key] = async () => blocked('deletion');
process.on('exit', code => fs.appendFileSync(path.join(root, 'exits.jsonl'), JSON.stringify({ pid: process.pid, code }) + '\\n'));
`, { flag: 'wx' });

function context() {
  const root = fs.mkdtempSync(path.join(output, 'runtime-'));
  const config = path.join(root, 'config'), data = path.join(root, 'data');
  fs.mkdirSync(config); fs.mkdirSync(data);
  fs.writeFileSync(path.join(config, 'config.json'), JSON.stringify({ cleanup_enabled: false, scheduler: { enabled: false },
    qianchuan_accounts: [{ id: 'fixture_a', aavid: '0000000001', cookieFile: 'missing-fixture-cookie.txt' },
      { id: 'fixture_b', aavid: '0000000002', cookieFile: 'missing-fixture-cookie.txt' }], accounts: [], yuntu_accounts: [], test_marker: marker }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^QC_|^NODE_OPTIONS$/i.test(key)));
  Object.assign(env, { QC_IMPORT_TEST_RUNTIME: root, QC_RUNTIME_CONFIG_ROOT: config, QC_RUNTIME_DATA_ROOT: data, QC_DISABLE_BACKGROUND: '1' });
  return { root, config, data, env, db: path.join(data, 'storage/offline_reports.db') };
}
function csv(ctx, name = 'fixture.csv', cost = 12.5) {
  const file = path.join(ctx.root, name);
  fs.writeFileSync(file, `日期,素材ID,整体消耗,净成交ROI,素材视频名称\n2026-09-29,${longId},${cost},8.25,${marker}\n全部,,${cost},8.25,${marker}\n`);
  return file;
}
function args(file, account = 'fixture_a', extra = []) {
  return ['--file', file, '--account-id', account, '--start', '2026-09-29', '--end', '2026-09-29', ...extra];
}
function call(ctx, values, expected = 0) {
  const child = spawnSync(process.execPath, ['--require', guard, cli, ...values], { env: ctx.env, cwd: project, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  calls.push({ pid: child.pid, code: child.status, signal: child.signal, stdout_bytes: Buffer.byteLength(child.stdout || ''), runtime: ctx.root });
  assert.equal(child.error, undefined);
  assert.equal(child.status, expected, child.stderr || child.stdout);
  assert.equal(child.stdout.trim().split('\n').length, 1, 'one compact JSON record');
  assert(!child.stdout.includes(marker) && !child.stderr.includes(marker), 'no raw row or config marker');
  const result = JSON.parse(child.stdout);
  for (const key of ['sample', 'raw', 'rows', 'headers']) assert(!Object.hasOwn(result, key), key);
  return result;
}
function query(ctx, account, reportId, scope = 'day') {
  const source = `const lib = require(process.argv[1]); try { console.log(JSON.stringify(lib.queryReports({ account_id: process.argv[2], mode: 'rows', report_id: process.argv[3], scope: process.argv[4], limit: 100, include_raw: true }))); } catch(e) { console.log(JSON.stringify({ ok:false,code:e.code || 'query_failed' })); process.exitCode=1; }`;
  const child = spawnSync(process.execPath, ['--require', guard, '-e', source, path.join(project, 'server-app/server/lib/offlineReports.js'), account, reportId, scope],
    { env: ctx.env, cwd: project, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  calls.push({ pid: child.pid, code: child.status, signal: child.signal, query_only: true, runtime: ctx.root });
  assert.equal(child.error, undefined);
  return JSON.parse(child.stdout);
}
function commit(ctx, file, preview, extra = [], account = 'fixture_a') {
  return call(ctx, args(file, account, [...extra, '--commit', '--expected-report-id', preview.report_id]));
}

test('preview emits compact metadata without creating a report database or modifying config/source', () => {
  const ctx = context(), file = csv(ctx), before = hash(file), configBefore = hash(path.join(ctx.config, 'config.json'));
  const preview = call(ctx, args(file, 'fixture_a', ['--net-roi-basis', 'platform_net_1h', '--exported-at', '2026-09-30T00:00:00+08:00']));
  assert.equal(preview.status, 'preview'); assert.equal(preview.database_write_attempted, false);
  assert.equal(preview.expected_report_id, preview.report_id); assert.equal(preview.row_count, 2);
  assert.deepEqual(preview.scope_counts, { day: 1, period_total: 1 });
  assert.equal(preview.source_at, '2026-09-29T16:00:00.000Z');
  assert.equal(preview.net_roi_basis, 'platform_net_1h');
  assert(Buffer.byteLength(JSON.stringify(preview)) < 1400);
  assert(!fs.existsSync(ctx.db)); assert.equal(hash(file), before); assert.equal(hash(path.join(ctx.config, 'config.json')), configBefore);
});

test('commit verifies rows, keeps text IDs and period totals; renamed content is duplicate', () => {
  const ctx = context(), file = csv(ctx), before = hash(file), preview = call(ctx, args(file));
  const first = commit(ctx, file, preview);
  assert.equal(first.status, 'imported'); assert.equal(first.verified, true); assert.equal(first.imported_rows, 2);
  const daily = query(ctx, 'fixture_a', first.report_id);
  assert.equal(daily.rows[0].entity_id, longId); assert.equal(daily.rows[0].stat_date, '2026-09-29');
  assert.equal(daily.rows[0].metrics.net_roi, 8.25);
  const total = query(ctx, 'fixture_a', first.report_id, 'period_total');
  assert.equal(total.total, 1); assert.equal(total.rows[0].stat_date, null);
  const renamed = path.join(ctx.root, 'renamed.csv'); fs.copyFileSync(file, renamed);
  const second = commit(ctx, renamed, preview);
  assert.equal(second.status, 'duplicate'); assert.equal(second.verified, true); assert.equal(second.imported_rows, 0);
  assert.equal(second.imported_at, first.imported_at); assert.equal(hash(file), before);
});

test('semantic duplicates distinguish input bytes from the first stored file hash', () => {
  const ctx = context(), file = csv(ctx), preview = call(ctx, args(file));
  const first = commit(ctx, file, preview);
  assert.equal(first.input_file_hash, first.stored_file_hash);
  const other = path.join(ctx.root, 'same-content-crlf.csv');
  fs.writeFileSync(other, fs.readFileSync(file, 'utf8').replaceAll('\n', '\r\n'));
  const again = call(ctx, args(other));
  assert.equal(again.report_id, preview.report_id); assert.notEqual(again.input_file_hash, preview.input_file_hash);
  const duplicate = commit(ctx, other, again);
  assert.equal(duplicate.status, 'duplicate'); assert.equal(duplicate.verified, true);
  assert.equal(duplicate.input_file_hash, again.input_file_hash); assert.equal(duplicate.stored_file_hash, first.stored_file_hash);
  assert.equal(query(ctx, 'fixture_a', duplicate.report_id).report.file_hash, first.stored_file_hash);
});

test('changed file, account, ROI basis or data time rejects the expected report ID before writing', () => {
  const ctx = context(), file = csv(ctx), preview = call(ctx, args(file));
  csv(ctx, 'fixture.csv', 99);
  let result = call(ctx, args(file, 'fixture_a', ['--commit', '--expected-report-id', preview.report_id]), 1);
  assert.equal(result.code, 'expected_report_id_mismatch');
  csv(ctx);
  for (const [account, extra] of [['fixture_b', []], ['fixture_a', ['--net-roi-basis', 'final_settlement']],
    ['fixture_a', ['--exported-at', '2026-09-30T00:00:00Z']]]) {
    result = call(ctx, args(file, account, [...extra, '--commit', '--expected-report-id', preview.report_id]), 1);
    assert.equal(result.code, 'expected_report_id_mismatch'); assert.equal(result.database_write_attempted, false);
  }
  assert(!fs.existsSync(ctx.db));
});

test('each configured account gets a separate report binding and cannot query the other account report', () => {
  const ctx = context(), file = csv(ctx), a = call(ctx, args(file)), first = commit(ctx, file, a);
  assert.equal(query(ctx, 'fixture_b', first.report_id).code, 'report_not_found');
  const b = call(ctx, args(file, 'fixture_b')); assert.notEqual(a.report_id, b.report_id);
  const second = commit(ctx, file, b, [], 'fixture_b');
  assert.equal(second.account_id, 'fixture_b'); assert.equal(second.verified, true);
  assert.equal(query(ctx, 'fixture_a', second.report_id).code, 'report_not_found');
  assert.equal(query(ctx, 'fixture_a', first.report_id).total, 1);
});

test('native XLSX dates are preserved through CLI import; multiple sheets require a selection', () => {
  const ctx = context(), file = path.join(ctx.root, 'fixture.xlsx');
  const sheet = XLSX.utils.aoa_to_sheet([['日期', '素材ID', '整体消耗'], [46294.75, longId, 1.25], ['全部', null, 1.25]]);
  sheet.A2.z = 'yyyy-mm-dd';
  const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, sheet, 'first'); XLSX.utils.book_append_sheet(book, sheet, 'second');
  fs.writeFileSync(file, XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
  assert.equal(call(ctx, args(file), 1).code, 'sheet_required');
  assert.equal(call(ctx, args(file, 'fixture_a', ['--sheet', 'missing']), 1).code, 'sheet_not_found');
  assert(!fs.existsSync(ctx.db));
  const preview = call(ctx, args(file, 'fixture_a', ['--sheet', 'second']));
  const result = commit(ctx, file, preview, ['--sheet', 'second']);
  assert.equal(result.input_sheet, 'second'); assert.equal(result.stored_sheet, 'second'); assert.equal(result.verified, true);
  const back = query(ctx, 'fixture_a', result.report_id);
  assert.equal(back.rows[0].stat_date, '2026-09-29'); assert.equal(back.rows[0].entity_id, longId);
  const otherSheet = call(ctx, args(file, 'fixture_a', ['--sheet', 'first']));
  const duplicate = commit(ctx, file, otherSheet, ['--sheet', 'first']);
  assert.equal(duplicate.status, 'duplicate'); assert.equal(duplicate.input_sheet, 'first'); assert.equal(duplicate.stored_sheet, 'second');
});

test('invalid arguments, dates, account, file type and expected ID do not create a report database', () => {
  const ctx = context(), file = csv(ctx);
  const cases = [
    [[...args(file), '--database-path', 'ignored'], 'invalid_arguments'],
    [[...args(file), '--start', '2026-09-29'], 'invalid_arguments'],
    [args(file).map(value => value === '2026-09-29' ? '2026-02-30' : value), 'report_window_required'],
    [args(file, 'not_configured'), 'account_not_found'],
    [[...args(file), '--commit'], 'expected_report_id_required'],
    [[...args(file), '--commit', '--expected-report-id', 'bad'], 'invalid_expected_report_id'],
    [[...args(file), '--net-roi-basis', 'guessed'], 'invalid_roi_basis'],
    [[...args(file), '--exported-at', '2026-09-29T10:00:00'], 'invalid_export_time'],
  ];
  for (const [values, code] of cases) assert.equal(call(ctx, values, 1).code, code);
  const wrong = path.join(ctx.root, 'fixture.xlsm'); fs.copyFileSync(file, wrong);
  assert.equal(call(ctx, args(wrong), 1).code, 'unsupported_file_type');
  assert.equal(call(ctx, args(ctx.root), 1).code, 'file_not_regular');
  assert(!fs.existsSync(ctx.db));
});

test('account columns, malformed rows and unsafe numeric XLSX IDs are rejected without raw output', () => {
  const ctx = context(), mismatch = path.join(ctx.root, 'mismatch.csv');
  fs.writeFileSync(mismatch, `日期,素材ID,整体消耗,账户ID\n2026-09-29,${longId},1,0000000002\n`);
  assert.equal(call(ctx, args(mismatch), 1).code, 'report_account_mismatch');
  const broken = path.join(ctx.root, 'broken.csv'); fs.writeFileSync(broken, `日期,整体消耗\n2026-09-29,"${marker}`);
  assert.equal(call(ctx, args(broken), 1).code, 'csv_unclosed_quote');
  const file = path.join(ctx.root, 'numeric.xlsx'), book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['日期', '素材ID', '整体消耗'], ['2026-09-29', 1e18, 1]]), 'fixture');
  fs.writeFileSync(file, XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
  assert.equal(call(ctx, args(file), 1).code, 'unsafe_numeric_id'); assert(!fs.existsSync(ctx.db));
});

test('bounded input rejects oversize before reading and detects growth during the read', () => {
  const ctx = context(), empty = path.join(ctx.root, 'empty.csv'); fs.writeFileSync(empty, '');
  assert.equal(call(ctx, args(empty), 1).code, 'invalid_file_size');
  let reads = 0, closes = 0;
  const stat = { isFile: () => true, dev: 1, ino: 2, size: MAX_FILE_BYTES + 1, mtimeMs: 1, ctimeMs: 1 };
  const stub = { lstatSync: () => stat, openSync: () => 7, fstatSync: () => stat,
    readSync: () => { reads++; throw Error('must_not_read'); }, closeSync: () => { closes++; } };
  assert.throws(() => readBoundedFile('fixture.csv', stub), { code: 'invalid_file_size' });
  assert.equal(reads, 0); assert.equal(closes, 1);
  stat.size = 3;
  stub.readSync = (fd, buffer, offset, length) => { reads++; assert(length <= 3); return length; };
  assert.throws(() => readBoundedFile('fixture.csv', stub), { code: 'file_changed_during_read' });
  assert.equal(reads, 2); assert.equal(closes, 2); assert(!fs.existsSync(ctx.db));
});

test('unknown import and readback failures stay explicit and do not retry or leak diagnostics', () => {
  const ctx = context(), file = csv(ctx);
  const report = { account_id: 'fixture_a', report_id: 'a'.repeat(64), rows: [], warnings: [] };
  const preview = { ...report, row_count: 1, scope_counts: { day: 1 } };
  let imports = 0, reads = 0;
  const reports = { prepareReport: () => report, previewReport: () => preview,
    importReport: () => { imports++; return { ok: true, status: 'imported', report_id: report.report_id, imported_rows: 1 }; },
    queryReports: () => { reads++; console.error(marker); throw Error(marker); } };
  const values = [...args(file), '--commit', '--expected-report-id', report.report_id];
  let result = run(values, { reports });
  assert.equal(result.ok, false); assert.equal(result.status, 'verification_failed'); assert.equal(result.import_status, 'imported');
  assert.equal(result.verified, false); assert.equal(imports, 1); assert.equal(reads, 1); assert(!JSON.stringify(result).includes(marker));
  reports.importReport = () => { imports++; throw Error(marker); };
  result = run(values, { reports });
  assert.equal(result.status, 'import_failed'); assert.equal(result.import_status, 'unknown'); assert.equal(imports, 2); assert.equal(reads, 1);
  reports.prepareReport = () => { throw Error(marker); };
  result = run(args(file), { reports }); assert.equal(result.code, 'report_import_failed'); assert(!JSON.stringify(result).includes(marker));
});

after(() => {
  const blocked = fs.readdirSync(output, { withFileTypes: true }).filter(item => item.isDirectory())
    .flatMap(item => { const file = path.join(output, item.name, 'blocked.jsonl'); return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : []; });
  const processChecks = calls.map(item => {
    let running = true;
    try { process.kill(item.pid, 0); } catch (error) { if (error.code === 'ESRCH') running = false; else throw error; }
    return { ...item, running };
  });
  fs.writeFileSync(path.join(output, 'evidence.json'), JSON.stringify({ project, xlsx_version: XLSX.version,
    dependency_mode: process.env.NODE_PATH ? 'explicit_NODE_PATH_reuse' : 'project_local', output,
    process_checks: processChecks, blocked_attempts: blocked, real_accounts: false, platform_requests: 0,
    test_db_only: true, original_files_deleted: 0 }, null, 2) + '\n');
  assert.equal(blocked.length, 0); assert(processChecks.every(item => !item.running));
  console.log(JSON.stringify({ evidence: path.join(output, 'evidence.json'), child_count: calls.length,
    child_processes_exited: true, blocked_attempts: blocked.length }));
});
