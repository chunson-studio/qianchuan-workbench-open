'use strict';
// Local historical evidence only. No platform request, account save or advertising action.
const fs = require('node:fs');
const path = require('node:path');
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const VALUE_FLAGS = new Set(['file', 'account-id', 'start', 'end', 'sheet', 'exported-at', 'net-roi-basis', 'expected-report-id']);
const CODES = new Set(['invalid_arguments', 'required_arguments', 'expected_report_id_required', 'invalid_expected_report_id',
  'expected_report_id_mismatch', 'file_not_regular', 'invalid_file_size', 'file_changed_during_read', 'file_unavailable',
  'account_required', 'account_invalid', 'account_not_found', 'report_window_required', 'invalid_roi_basis',
  'invalid_export_time', 'csv_unclosed_quote', 'unsupported_encoding', 'report_too_large', 'unsupported_file_type',
  'sheet_required', 'sheet_not_found', 'invalid_headers', 'unsupported_report', 'profile_population_unknown',
  'row_width_mismatch', 'report_account_mismatch', 'invalid_row_date', 'row_outside_window', 'unsafe_numeric_id',
  'conflicting_rows', 'empty_report', 'dependency_unavailable', 'report_import_failed', 'readback_failed']);
const NEXT = {
  sheet_required: 'Specify --sheet and preview again.',
  sheet_not_found: 'Check --sheet against the workbook, then preview again.',
  expected_report_id_mismatch: 'Preview the current file and binding again; do not reuse the old report ID.',
  account_not_found: 'Use an account ID already configured in the selected runtime.',
  readback_failed: 'Read this account/report_id using get_local_reports before deciding any next action; no automatic retry was performed.',
};
const fail = code => Object.assign(new Error(code), { code });

function parseArgs(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const values = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--commit') {
      if (values.commit) throw fail('invalid_arguments');
      values.commit = true;
      continue;
    }
    const key = flag.startsWith('--') ? flag.slice(2) : '';
    if (!VALUE_FLAGS.has(key) || Object.hasOwn(values, key) || !args[i + 1] || args[i + 1].startsWith('--')) throw fail('invalid_arguments');
    values[key] = args[++i];
  }
  if (['file', 'account-id', 'start', 'end'].some(key => !values[key]?.trim())) throw fail('required_arguments');
  if (values.commit && !values['expected-report-id']) throw fail('expected_report_id_required');
  if (values['expected-report-id'] && (!values.commit || !/^[a-f0-9]{64}$/.test(values['expected-report-id']))) throw fail('invalid_expected_report_id');
  return values;
}

function readBoundedFile(filename, fileSystem = fs) {
  const file = path.resolve(filename), named = fileSystem.lstatSync(file);
  if (!named.isFile()) throw fail('file_not_regular');
  const fd = fileSystem.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const before = fileSystem.fstatSync(fd);
    if (!before.isFile() || before.dev !== named.dev || before.ino !== named.ino) throw fail('file_not_regular');
    if (!Number.isSafeInteger(before.size) || before.size <= 0 || before.size > MAX_FILE_BYTES) throw fail('invalid_file_size');
    const buffer = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = fileSystem.readSync(fd, buffer, offset, buffer.length - offset, null);
      if (!count) throw fail('file_changed_during_read');
      offset += count;
    }
    // At most one extra byte is read to detect growth; never readFile an unbounded input.
    const extra = fileSystem.readSync(fd, Buffer.allocUnsafe(1), 0, 1, null);
    const after = fileSystem.fstatSync(fd);
    if (extra || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw fail('file_changed_during_read');
    return buffer;
  } finally { fileSystem.closeSync(fd); }
}

function safeCode(error) {
  if (CODES.has(error?.code)) return error.code;
  if (['ENOENT', 'EACCES', 'EPERM', 'ELOOP'].includes(error?.code)) return 'file_unavailable';
  if (error?.code === 'MODULE_NOT_FOUND') return 'dependency_unavailable';
  // Existing account validation has a fixed prefix but no error.code; never echo its supplied value.
  const account = error?.statusCode === 400 && /^account_(required|invalid|not_found)(?::|$)/.exec(error.message || '');
  return account ? 'account_' + account[1] : 'report_import_failed';
}

function compact(meta) {
  return {
    account_id: meta.account_id, report_id: meta.report_id, input_file_hash: meta.file_hash,
    kind: meta.kind, start: meta.start, end: meta.end,
    row_count: meta.row_count, scope_counts: meta.scope_counts, duplicate_rows: meta.duplicate_rows,
    net_roi_basis: meta.net_roi_basis, source_at: meta.exported_at, input_sheet: meta.sheet,
    binding_source: meta.binding_source, parser_version: meta.parser_version, warnings: meta.warnings,
    historical_only: true, live_decision_eligible: false,
  };
}

function verifyReport(reports, report, preview) {
  let receipt;
  for (const [scope, count] of Object.entries(preview.scope_counts)) {
    const back = reports.queryReports({ account_id: report.account_id, mode: 'rows', report_id: report.report_id, scope, limit: 1 });
    const stored = back?.report;
    const same = back?.ok === true && back.account_id === report.account_id && back.mode === 'rows'
      && stored?.report_id === report.report_id && stored.account_id === report.account_id
      && ['kind', 'start', 'end', 'net_roi_basis', 'exported_at', 'parser_version'].every(key => stored[key] === report[key])
      && stored.row_count === preview.row_count && back.total === count
      && Object.keys(stored.scope_counts || {}).length === Object.keys(preview.scope_counts).length
      && Object.entries(preview.scope_counts).every(([key, value]) => stored.scope_counts[key] === value)
      && Array.isArray(back.rows) && back.rows.length === 1 && back.rows[0].scope === scope
      && back.historical_only === true && back.live_decision_eligible === false
      && /^[a-f0-9]{64}$/.test(stored.file_hash || '') && Number.isFinite(Date.parse(stored.imported_at));
    if (!same) throw fail('readback_failed');
    const current = { imported_at: stored.imported_at, stored_file_hash: stored.file_hash, stored_sheet: stored.sheet };
    if (receipt && JSON.stringify(current) !== JSON.stringify(receipt)) throw fail('readback_failed');
    receipt = current;
  }
  if (!receipt) throw fail('readback_failed');
  return receipt;
}

function execute(args, dependencies) {
  let stage = 'arguments';
  try {
    const options = parseArgs(args);
    if (options.help) return { ok: true, command: 'import-local-report', default: 'preview',
      usage: 'node tools/import-local-report.cjs --file <path.csv|path.xlsx> --account-id <configured-id> --start <YYYY-MM-DD> --end <YYYY-MM-DD>',
      optional: ['--sheet <name>', '--exported-at <ISO-with-timezone>', '--net-roi-basis <unknown|platform_net_1h|final_settlement>'],
      commit: 'Repeat the same file and binding options with --commit --expected-report-id <preview.report_id>',
      runtime: ['QC_RUNTIME_CONFIG_ROOT', 'QC_RUNTIME_DATA_ROOT'], max_file_bytes: MAX_FILE_BYTES };
    stage = 'input';
    const buffer = readBoundedFile(options.file, dependencies.fs || fs);
    stage = 'prepare';
    const reports = dependencies.reports || require('../server-app/server/lib/offlineReports');
    const report = reports.prepareReport(buffer, { account_id: options['account-id'], filename: path.basename(options.file),
      start: options.start, end: options.end, sheet: options.sheet, exported_at: options['exported-at'], net_roi_basis: options['net-roi-basis'] });
    const preview = reports.previewReport(report), metadata = compact(preview);
    if (!options.commit) return { ok: true, status: 'preview', ...metadata,
      expected_report_id: report.report_id, database_write_attempted: false };
    if (options['expected-report-id'] !== report.report_id) throw fail('expected_report_id_mismatch');
    stage = 'import';
    let result;
    try { result = reports.importReport(report); }
    catch { return { ok: false, status: 'import_failed', code: 'report_import_failed', ...metadata,
      verified: false, database_write_attempted: true, import_status: 'unknown' }; }
    stage = 'readback';
    try {
      if (!result?.ok || !['imported', 'duplicate'].includes(result.status) || result.report_id !== report.report_id) throw fail('readback_failed');
      const receipt = verifyReport(reports, report, preview);
      return { ok: true, status: result.status, ...metadata, imported_rows: result.imported_rows,
        ...receipt, verified: true, database_write_attempted: true };
    } catch {
      return { ok: false, status: 'verification_failed', code: 'readback_failed', ...metadata,
        import_status: ['imported', 'duplicate'].includes(result?.status) ? result.status : 'unknown',
        verified: false, database_write_attempted: true, next_step: NEXT.readback_failed };
    }
  } catch (error) {
    const code = safeCode(error);
    return { ok: false, status: 'rejected', code, stage, verified: false, database_write_attempted: false,
      ...(NEXT[code] ? { next_step: NEXT[code] } : {}) };
  }
}

function run(args, dependencies = {}) {
  // The reused synchronous libraries may log account lists or parser diagnostics.
  // Keep the CLI channel to the explicit JSON projection, including on failure.
  const original = { log: console.log, warn: console.warn, error: console.error };
  try {
    console.log = console.warn = console.error = () => {};
    return execute(args, dependencies);
  } finally { Object.assign(console, original); }
}

if (require.main === module) {
  const result = run(process.argv.slice(2));
  process.stdout.write(JSON.stringify(result) + '\n');
  if (!result.ok) process.exitCode = 1;
}
module.exports = { MAX_FILE_BYTES, parseArgs, readBoundedFile, run };
