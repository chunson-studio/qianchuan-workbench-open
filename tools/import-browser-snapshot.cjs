'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { normalizeBrowserBoostCapture } = require('../server-app/server/lib/browserBoostSnapshot');

const MAX_INPUT_BYTES = 256 * 1024;

function parseArgs(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!['--input', '--output', '--ledger-dir'].includes(key) || !args[i + 1] || args[i + 1].startsWith('--')) {
      throw new Error('用法: node tools/import-browser-snapshot.cjs --input <raw.json> --output <receipt.json> [--ledger-dir <isolateddir>]');
    }
    out[key.slice(2)] = args[++i];
  }
  if (!out.input || !out.output) throw new Error('必须提供 --input 和 --output');
  return out;
}

function writeReceiptSafely(file, receipt, inputFile) {
  const target = path.resolve(file);
  if (target === path.resolve(inputFile)) throw new Error('receipt 输出路径不能覆盖 raw input');
  const content = `${JSON.stringify(receipt, null, 2)}\n`;
  if (fs.existsSync(target)) {
    if (fs.readFileSync(target, 'utf8') === content) return;
    throw new Error('输出文件已存在且内容不同，拒绝覆盖');
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, { flag: 'wx' });
}

function withIsolatedRuntimeConfig(callback, runtimeParent) {
  if (!runtimeParent) throw new Error('隔离运行目录必须随本次读取账本明确提供');
  runtimeParent = path.resolve(runtimeParent);
  fs.mkdirSync(runtimeParent, { recursive: true });
  const runtimeRoot = fs.mkdtempSync(path.join(runtimeParent, 'runtime-'));
  const oldConfigRoot = process.env.QC_RUNTIME_CONFIG_ROOT;
  const oldDataRoot = process.env.QC_RUNTIME_DATA_ROOT;
  process.env.QC_RUNTIME_CONFIG_ROOT = runtimeRoot;
  process.env.QC_RUNTIME_DATA_ROOT = runtimeRoot;
  try { return callback(); }
  finally {
    try { require('../server-app/server/lib/decisionLedger').closeAll(); } catch { /* ledger may not have loaded */ }
    if (oldConfigRoot == null) delete process.env.QC_RUNTIME_CONFIG_ROOT;
    else process.env.QC_RUNTIME_CONFIG_ROOT = oldConfigRoot;
    if (oldDataRoot == null) delete process.env.QC_RUNTIME_DATA_ROOT;
    else process.env.QC_RUNTIME_DATA_ROOT = oldDataRoot;
    // 保留隔离运行材料；清理遵守项目约定，不在导入时永久删除目录。
  }
}

function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  const inputFile = path.resolve(options.input);
  const stat = fs.statSync(inputFile);
  if (!stat.isFile() || stat.size > MAX_INPUT_BYTES) throw new Error('输入必须是小于等于256KB的JSON文件');
  const capture = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  const summary = normalizeBrowserBoostCapture(capture);
  let receipt;
  if (!options['ledger-dir']) {
    receipt = { ok: true, preview: true, persisted: false, isolated: true, registry_used: false, snapshot_id: summary.snapshot_id, summary };
  } else {
    receipt = withIsolatedRuntimeConfig(() => {
      const ledger = require('../server-app/server/lib/decisionLedger');
      const { ingestBrowserSnapshot } = require('../server-app/server/lib/browserSnapshotStore');
      const baseDir = path.resolve(options['ledger-dir']);
      const existing = ledger.getSnapshot(summary.meta.account_id, summary.snapshot_id, { baseDir });
      if (fs.existsSync(path.resolve(options.output))) {
        if (!existing) throw new Error('输出文件已存在但目标账本中无对应快照，拒绝写入');
        let priorReceipt;
        try { priorReceipt = JSON.parse(fs.readFileSync(path.resolve(options.output), 'utf8')); }
        catch { throw new Error('输出文件已存在且不是有效receipt，拒绝覆盖'); }
        if (priorReceipt.snapshot_id !== summary.snapshot_id || priorReceipt.persisted !== true
          || JSON.stringify(priorReceipt.snapshot) !== JSON.stringify(existing)) {
          throw new Error('输出文件已存在且内容不同，拒绝覆盖');
        }
        return priorReceipt;
      }
      const ingested = ingestBrowserSnapshot(capture, { baseDir });
      const readback = ledger.getSnapshot(summary.meta.account_id, summary.snapshot_id, { baseDir });
      if (!readback || readback.snapshot_id !== summary.snapshot_id || JSON.stringify(readback) !== JSON.stringify(ingested.summary)) {
        throw new Error('账本回读验证失败');
      }
      return { ok: true, preview: false, persisted: true, isolated: true, registry_used: false,
        duplicate: ingested.duplicate, snapshot_id: summary.snapshot_id, snapshot: readback };
    }, path.join(path.resolve(options['ledger-dir']), '.runtime'));
  }
  writeReceiptSafely(options.output, receipt, inputFile);
  return receipt;
}

if (require.main === module) {
  try { main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { main, parseArgs, writeReceiptSafely, withIsolatedRuntimeConfig, MAX_INPUT_BYTES };
