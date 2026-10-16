'use strict';

// 配置、Profile、凭据是一组提交。崩溃后在加载配置前恢复；日志不含文件内容。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const contentVersion = text => text === null ? null : crypto.createHash('sha256').update(text).digest('hex');

function atomicText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}

function recoverAccountTransaction(root) {
  const journal = path.join(root, '.account-transaction.json');
  if (!fs.existsSync(journal)) return false;
  const entries = JSON.parse(fs.readFileSync(journal, 'utf8')).entries;
  if (!Array.isArray(entries)) throw new Error('account_transaction_invalid');
  for (const item of entries) {
    const file = path.resolve(root, item.relative);
    if (!file.startsWith(path.resolve(root) + path.sep)) throw new Error('account_transaction_invalid');
    if (item.previous === null) { if (fs.existsSync(file)) fs.unlinkSync(file); }
    else atomicText(file, item.previous);
  }
  fs.unlinkSync(journal);
  return true;
}

function commitAccountFiles(root, files, afterWrite = () => {}) {
  root = path.resolve(root);
  fs.mkdirSync(root, { recursive: true });
  const lock = path.join(root, '.account-transaction.lock');
  let fd;
  try { fd = fs.openSync(lock, 'wx', 0o600); }
  catch { throw Object.assign(new Error('配置正在保存，请稍后重试'), { code: 'configuration_busy', statusCode: 409 }); }
  try {
    fs.writeFileSync(fd, String(process.pid));
    recoverAccountTransaction(root);
    const entries = files.map(({ file, text, expectedVersion }) => {
      file = path.resolve(file);
      if (!file.startsWith(root + path.sep)) throw new Error('account_transaction_path_invalid');
      const previous = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
      if (expectedVersion !== undefined && contentVersion(previous) !== expectedVersion) {
        throw Object.assign(new Error('配置已被其他入口更新，请重新读取后继续'), { code: 'configuration_conflict', statusCode: 409 });
      }
      return { relative: path.relative(root, file), previous, text };
    });
    const journal = path.join(root, '.account-transaction.json');
    atomicText(journal, JSON.stringify({ entries: entries.map(({ text, ...item }) => item) }));
    try {
      for (const entry of entries) atomicText(path.join(root, entry.relative), entry.text);
      afterWrite();
      fs.unlinkSync(journal);
    } catch (error) {
      recoverAccountTransaction(root);
      throw error;
    }
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}

function recoverAtStartup(root) {
  const lock = path.join(root, '.account-transaction.lock');
  if (fs.existsSync(lock)) {
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); return; } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    fs.unlinkSync(lock);
  }
  recoverAccountTransaction(root);
}

module.exports = { atomicText, commitAccountFiles, recoverAtStartup, contentVersion };
