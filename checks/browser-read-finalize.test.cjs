'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { finalizeBrowserRead } = require('../tools/finalize-browser-read.cjs');
const ledger = require('../server-app/server/lib/decisionLedger');

const ACCOUNT_ID = 'account_finalize_60000005';
const CAPTURED_AT = '2026-09-23T01:29:04.000Z';

function capture({ invalidCost = false } = {}) {
  const from = '2026-09-22';
  const to = '2026-09-23';
  return {
    schema_version: '1.0',
    source: 'browser_dom',
    private_note: 'PRIVATE_CAPTURE_MARKER',
    binding: { account_id: ACCOUNT_ID, advertiser_id: '60000005', primary_ad_id: 'ad_123' },
    page: {
      advertiser_id: '60000005', primary_ad_id: 'ad_123', date_range: [from, to],
      url: `https://qianchuan.jinritemai.com/uni-prom/detail?aavid=60000005&adId=ad_123&dr=${from}%2C${to}`,
      updated_at_label: '09:30更新', status_filter: '全部',
      headers: ['任务名称', '调控状态', '调控预算(元)', '调控消耗', '调控支付ROI', '调控时长(小时)'],
      rows: [
        ['可用零值 任务ID: task_zero', '投放中', '0', invalidCost ? 'PRIVATE_CAPTURE_MARKER' : '0', '1.5', '0'],
        ['未知指标 任务ID: task_unknown', '', '-', '--', '-', '1小时30分钟'],
      ],
      total_count: 8,
    },
    timing: {
      refresh_started_at: '2026-09-23T01:29:00.000Z',
      refresh_completed_at: '2026-09-23T01:29:03.000Z',
      captured_at: CAPTURED_AT,
    },
  };
}

function chengfangCapture() {
  const value = capture();
  const from = '2026-09-22';
  const to = '2026-09-23';
  value.page.url = `https://qianchuan.jinritemai.com/overall-prom/detail?aavid=60000005&adId=ad_123&dateRange=%5B%22${from}%22%2C%22${to}%22%5D`;
  value.page.headers = ['任务名称', '调控状态', '调控预算(元)', '调控消耗', '调控综合成本', '调控成交订单数', '调控综合营销ROI', '调控时长(小时)'];
  value.page.rows = [
    ['乘方行 任务ID: task_cf', '投放中', '100', '40', '12', '2', '3.5', '1'],
  ];
  value.page.total_count = 1;
  return value;
}

function createRunDir(root, data) {
  const runDir = fs.mkdtempSync(path.join(root, 'run-'));
  fs.writeFileSync(path.join(runDir, 'capture.json'), `${JSON.stringify(data)}\n`, { flag: 'wx' });
  return runDir;
}

test('finalizes a current-page capture into an isolated SQLite receipt and preserves metric states', t => {
  const root = require('./test-output.cjs').testOutputRoot();
  fs.mkdirSync(root, { recursive: true });
  t.after(() => {
    ledger.closeAll();
  });
  const runRoot = fs.mkdtempSync(path.join(root, 'browser-read-finalize-'));
  const runDir = createRunDir(runRoot, capture());

  const result = finalizeBrowserRead({ runDir });

  assert.equal(result.ok, true);
  assert.equal(result.persisted, true);
  assert.equal(typeof result.snapshot_id, 'string');
  assert.equal(result.plan_type, 'quan_yu');
  assert.deepEqual(result.source_date, { start: '2026-09-22', end: '2026-09-23' });
  assert.equal(result.captured_at, CAPTURED_AT);
  assert.deepEqual(result.columns.map(column => column.label), ['ID', '状态', '消耗（元）', '成交订单', '支付ROI', '预算（元）', '投放时长（秒）']);
  assert.equal(result.row_count, 2);
  assert.ok(result.finalize_ms >= 0);
  assert.equal(result.paths.capture, path.join(runDir, 'capture.json'));
  assert.equal(result.paths.receipt, path.join(runDir, 'receipt.json'));
  assert.equal(result.paths.ledger, path.join(runDir, 'ledger'));
  assert.deepEqual(result.table, [
    { id: 'task_zero', status: '投放中', cost: '0', orders: '缺失', roi: '1.5', budget: '0', duration: '0' },
    { id: 'task_unknown', status: '未知', cost: '未知', orders: '缺失', roi: '未知', budget: '未知', duration: '未知' },
  ]);

  const receipt = JSON.parse(fs.readFileSync(result.paths.receipt, 'utf8'));
  assert.equal(receipt.persisted, true);
  assert.equal(receipt.isolated, true);
  assert.equal(receipt.registry_used, false);
  assert.deepEqual(ledger.getSnapshot(ACCOUNT_ID, result.snapshot_id, { baseDir: result.paths.ledger }), receipt.snapshot);

  const summaryText = fs.readFileSync(result.paths.summary, 'utf8');
  const summary = JSON.parse(summaryText);
  assert.equal(summary.snapshot_id, result.snapshot_id);
  assert.equal(summary.row_count, 2);
  assert.doesNotMatch(summaryText, /PRIVATE_CAPTURE_MARKER/);
  const markdown = fs.readFileSync(result.paths.markdown, 'utf8');
  assert.match(markdown, /仅反映本次捕获的当前页面行/);
  assert.match(markdown, /页面日期范围：2026-09-22 至 2026-09-23/);
  assert.match(markdown, new RegExp(CAPTURED_AT.replaceAll('.', '\\.')));
  assert.match(markdown, /\| task_zero \| 投放中 \| 0 \| 缺失 \| 1\.5 \| 0 \| 0 \|/);
  assert.match(markdown, /\| task_unknown \| 未知 \| 未知 \| 缺失 \| 未知 \| 未知 \| 未知 \|/);
  assert.doesNotMatch(markdown, /PRIVATE_CAPTURE_MARKER|建议/);

  assert.throws(() => finalizeBrowserRead({ runDir }), { code: 'output_exists' });
  assert.equal(fs.readFileSync(result.paths.summary, 'utf8'), summaryText, 'a repeated finalization must not overwrite the summary');
  assert.equal(fs.readFileSync(result.paths.markdown, 'utf8'), markdown, 'a repeated finalization must not overwrite the Markdown report');

  const chengfangDir = createRunDir(runRoot, chengfangCapture());
  const chengfang = finalizeBrowserRead({ runDir: chengfangDir });
  assert.equal(chengfang.plan_type, 'cheng_fang');
  assert.deepEqual(chengfang.columns.map(column => column.label), ['ID', '状态', '综合成本（元）', '成交订单', '综合营销ROI', '预算（元）', '投放时长（秒）']);
  assert.deepEqual(chengfang.table, [{ id: 'task_cf', status: '投放中', cost: '12', orders: '2', roi: '3.5', budget: '100', duration: '3600' }]);
  const chengfangMarkdown = fs.readFileSync(chengfang.paths.markdown, 'utf8');
  assert.match(chengfangMarkdown, /综合成本（元）/);
  assert.match(chengfangMarkdown, /综合营销ROI/);
  assert.doesNotMatch(chengfangMarkdown, /支付ROI/);
});

test('CLI emits compact JSON on success and a sanitized short error on bad private cell data', t => {
  const root = require('./test-output.cjs').testOutputRoot();
  fs.mkdirSync(root, { recursive: true });
  t.after(() => {
    ledger.closeAll();
  });
  const runRoot = fs.mkdtempSync(path.join(root, 'browser-read-finalize-cli-'));
  const runDir = createRunDir(runRoot, capture());
  const cliPath = path.resolve(__dirname, '../tools/finalize-browser-read.cjs');
  const setupPath = path.resolve(__dirname, 'setup-runtime.cjs');
  const child = spawnSync(process.execPath, ['--require', setupPath, cliPath, '--run-dir', runDir], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, '');
  const result = JSON.parse(child.stdout);
  assert.equal(result.persisted, true);
  assert.equal(result.row_count, 2);
  assert.doesNotMatch(child.stdout, /PRIVATE_CAPTURE_MARKER/);

  const badRunDir = createRunDir(runRoot, capture({ invalidCost: true }));
  const failed = spawnSync(process.execPath, ['--require', setupPath, cliPath, '--run-dir', badRunDir], { encoding: 'utf8' });
  assert.equal(failed.status, 1);
  assert.equal(failed.stdout, '');
  assert.match(failed.stderr, /浏览器读取收尾失败/);
  assert.doesNotMatch(failed.stderr, /PRIVATE_CAPTURE_MARKER/);
});
