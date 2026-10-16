'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { main: importBrowserSnapshot } = require('./import-browser-snapshot.cjs');

const RESULT_FILES = ['result-summary.json', 'result.md'];

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function parseArgs(args) {
  if (args.length !== 2 || args[0] !== '--run-dir' || !args[1] || args[1].startsWith('--')) {
    fail('invalid_arguments', '用法: node tools/finalize-browser-read.cjs --run-dir <dir>');
  }
  return { runDir: args[1] };
}

function displayMetric(metric) {
  if (!metric || typeof metric !== 'object') return '缺失';
  if (metric.status === 'missing') return '缺失';
  if (metric.status === 'unknown') return '未知';
  if (metric.status === 'not_applicable') return '不适用';
  if (metric.status !== 'available' || metric.value == null || !Number.isFinite(metric.value)) return '未知';
  return String(metric.value);
}

function displayStatus(boost) {
  if (!Object.hasOwn(boost, 'status')) return '缺失';
  if (boost.status == null || boost.status === '') return '未知';
  const value = String(boost.status).replace(/[|\r\n]/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120);
  return value || '未知';
}

function tablePresentation(snapshot) {
  if (snapshot.plan?.plan_type === 'quan_yu') {
    return {
      costMetric: 'cost',
      roiMetric: 'payment_roi',
      columns: [
        { key: 'id', label: 'ID' },
        { key: 'status', label: '状态' },
        { key: 'cost', label: '消耗（元）' },
        { key: 'orders', label: '成交订单' },
        { key: 'roi', label: '支付ROI' },
        { key: 'budget', label: '预算（元）' },
        { key: 'duration', label: '投放时长（秒）' },
      ],
    };
  }
  if (snapshot.plan?.plan_type === 'cheng_fang') {
    return {
      costMetric: 'comprehensive_cost',
      roiMetric: 'comprehensive_roi',
      columns: [
        { key: 'id', label: 'ID' },
        { key: 'status', label: '状态' },
        { key: 'cost', label: '综合成本（元）' },
        { key: 'orders', label: '成交订单' },
        { key: 'roi', label: '综合营销ROI' },
        { key: 'budget', label: '预算（元）' },
        { key: 'duration', label: '投放时长（秒）' },
      ],
    };
  }
  fail('unsupported_plan_type', '归一化快照包含不支持的计划类型');
}

function buildTable(snapshot, presentation) {
  return snapshot.boosts.map(boost => ({
    id: String(boost.id),
    status: displayStatus(boost),
    cost: displayMetric(boost.metrics?.[presentation.costMetric]),
    orders: displayMetric(boost.metrics?.payment_orders),
    roi: displayMetric(boost.metrics?.[presentation.roiMetric]),
    budget: displayMetric(boost.metrics?.budget),
    duration: displayMetric(boost.metrics?.duration_seconds),
  }));
}

function escapeMarkdownCell(value) {
  return String(value).replace(/[|\r\n]/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120);
}

function markdownFor(result) {
  const headers = result.columns.map(column => escapeMarkdownCell(column.label));
  const lines = [
    '# 浏览器读取结果',
    '',
    '以下内容仅反映本次捕获的当前页面行。',
    '',
    `页面日期范围：${result.source_date.start ?? '未知'} 至 ${result.source_date.end ?? '未知'}`,
    `本机捕获时间：${result.captured_at ?? '未知'}`,
    `快照 ID：${result.snapshot_id}`,
    '',
    `| ${headers.join(' | ')} |`,
    `| ${headers.map((_, index) => index < 2 ? '---' : '---:').join(' | ')} |`,
  ];
  for (const row of result.table) {
    lines.push(`| ${result.columns.map(column => escapeMarkdownCell(row[column.key])).join(' | ')} |`);
  }
  if (!result.table.length) lines.push(`| ${result.columns.map(() => '—').join(' | ')} |`);
  lines.push('', '指标单元格使用“缺失”“未知”或“不适用”表示对应状态；数字 0 表示页面明确提供了零值。', '');
  return lines.join('\n');
}

function assertSafeLedgerDir(ledgerDir, runDir) {
  if (!fs.existsSync(ledgerDir)) return;
  const stat = fs.lstatSync(ledgerDir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail('invalid_ledger_dir', '隔离账本目录必须是 runDir 下的普通目录');
  }
  const realRunDir = fs.realpathSync(runDir);
  const realLedgerDir = fs.realpathSync(ledgerDir);
  const relative = path.relative(realRunDir, realLedgerDir);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail('invalid_ledger_dir', '隔离账本目录必须位于 runDir 内');
  }
}

function finalizeBrowserRead({ runDir } = {}) {
  const startedAt = performance.now();
  if (typeof runDir !== 'string' || !runDir.trim()) fail('invalid_run_dir', '必须提供 runDir');
  const absoluteRunDir = path.resolve(runDir);
  let runStat;
  try { runStat = fs.statSync(absoluteRunDir); }
  catch { fail('invalid_run_dir', 'runDir 不存在或无法读取'); }
  if (!runStat.isDirectory()) fail('invalid_run_dir', 'runDir 必须是目录');

  const capturePath = path.join(absoluteRunDir, 'capture.json');
  const receiptPath = path.join(absoluteRunDir, 'receipt.json');
  const ledgerDir = path.join(absoluteRunDir, 'ledger');
  const summaryPath = path.join(absoluteRunDir, RESULT_FILES[0]);
  const markdownPath = path.join(absoluteRunDir, RESULT_FILES[1]);
  for (const target of [summaryPath, markdownPath]) {
    if (fs.existsSync(target)) fail('output_exists', '结果文件已存在，拒绝覆盖');
  }
  assertSafeLedgerDir(ledgerDir, absoluteRunDir);

  // The importer performs canonical normalization, isolated SQLite persistence, and readback.
  importBrowserSnapshot(['--input', capturePath, '--output', receiptPath, '--ledger-dir', ledgerDir]);
  let receipt;
  try { receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')); }
  catch { fail('invalid_receipt', '导入器回执不可读取'); }
  if (receipt?.ok !== true || receipt.persisted !== true || receipt.isolated !== true
    || receipt.registry_used !== false || !receipt.snapshot || !Array.isArray(receipt.snapshot.boosts)
    || typeof receipt.snapshot_id !== 'string' || receipt.snapshot.snapshot_id !== receipt.snapshot_id) {
    fail('snapshot_not_persisted', '隔离账本回执未通过检查');
  }

  const snapshot = receipt.snapshot;
  const presentation = tablePresentation(snapshot);
  const result = {
    ok: true,
    persisted: true,
    isolated: true,
    registry_used: false,
    coverage: 'current_page_only',
    snapshot_id: receipt.snapshot_id,
    plan_type: snapshot.plan.plan_type,
    source_date: {
      start: snapshot.metrics_scope?.start || null,
      end: snapshot.metrics_scope?.end || null,
    },
    date_range: [snapshot.metrics_scope?.start || null, snapshot.metrics_scope?.end || null],
    captured_at: snapshot.components?.browser_capture?.captured_at || null,
    row_count: snapshot.boosts.length,
    columns: presentation.columns,
    paths: {
      capture: capturePath,
      receipt: receiptPath,
      ledger: ledgerDir,
      summary: summaryPath,
      markdown: markdownPath,
    },
    finalize_ms: 0,
    table: buildTable(snapshot, presentation),
  };
  const markdown = markdownFor(result);

  // Use exclusive creation so a second finalization cannot replace either result artifact.
  fs.writeFileSync(markdownPath, markdown, { encoding: 'utf8', flag: 'wx' });
  result.finalize_ms = Math.round((performance.now() - startedAt) * 100) / 100;
  fs.writeFileSync(summaryPath, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  return result;
}

function safeCliError(error) {
  const code = typeof error?.code === 'string' && /^[a-z0-9_]{1,48}$/.test(error.code) ? error.code : null;
  return code ? `浏览器读取收尾失败（${code}）` : '浏览器读取收尾失败';
}

function main(args = process.argv.slice(2)) {
  const { runDir } = parseArgs(args);
  return finalizeBrowserRead({ runDir });
}

if (require.main === module) {
  try { process.stdout.write(`${JSON.stringify(main())}\n`); }
  catch (error) {
    process.stderr.write(`${safeCliError(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = { finalizeBrowserRead, main, parseArgs, displayMetric, buildTable };
