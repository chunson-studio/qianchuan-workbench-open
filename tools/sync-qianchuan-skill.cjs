'use strict';
// 只同步已核对的副本，不删除目录或额外文件；每次覆盖先保存原文。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
function inventory(directory) {
  const files = {};
  function visit(current, prefix = '') {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
      const name = prefix + entry.name, file = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw Error(`nested_link_requires_review:${name}`);
      if (entry.isDirectory()) visit(file, name + '/');
      else if (entry.isFile()) files[name] = digest(fs.readFileSync(file));
      else throw Error(`unsupported_entry:${name}`);
    }
  }
  visit(directory); return files;
}
function planSync(sourcePath, targetPath) {
  const source = fs.realpathSync(sourcePath), target = fs.realpathSync(targetPath);
  const sourceFiles = inventory(source), targetFiles = inventory(target);
  if (!sourceFiles['SKILL.md']) throw Error('source_skill_missing');
  const changes = Object.keys(sourceFiles).filter(file => sourceFiles[file] !== targetFiles[file]).map(file => ({ file,
    before: targetFiles[file] || null, after: sourceFiles[file] }));
  const extras = Object.keys(targetFiles).filter(file => !Object.hasOwn(sourceFiles, file));
  return { source, target, files: Object.keys(sourceFiles).length, changes, extras,
    digest: digest(JSON.stringify({ source, target, sourceFiles, targetFiles })) };
}
function applySync(source, target, expectedDigest, backupRoot) {
  const plan = planSync(source, target);
  if (plan.digest !== expectedDigest) throw Error('sync_plan_changed');
  if (plan.extras.length) throw Error('target_extra_files_require_merge');
  if (!plan.changes.length) return { ok: true, changed: 0, verified: true };
  const backup = path.join(backupRoot, new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(5).toString('hex'));
  fs.mkdirSync(backup, { recursive: true });
  fs.writeFileSync(path.join(backup, 'plan.json'), JSON.stringify(plan, null, 2), { flag: 'wx' });
  // 先保存所有将被替换的正文。不得把备份/同步操作视为删除授权。
  for (const change of plan.changes) if (change.before != null) {
    const file = path.join(backup, 'before', change.file);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.copyFileSync(path.join(plan.target, change.file), file, fs.constants.COPYFILE_EXCL);
  }
  if (planSync(source, target).digest !== expectedDigest) throw Error('sync_plan_changed_after_backup');
  for (const change of plan.changes) {
    // 每项再做 CAS，避免覆盖同步过程中出现的用户编辑。
    const from = path.join(plan.source, change.file), to = path.join(plan.target, change.file);
    if (digest(fs.readFileSync(from)) !== change.after || (fs.existsSync(to) ? digest(fs.readFileSync(to)) : null) !== change.before)
      throw Error(`sync_file_changed:${change.file}`);
    fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to);
  }
  const verified = planSync(source, target);
  if (verified.changes.length || verified.extras.length) throw Error('sync_verification_failed');
  const result = { ok: true, changed: plan.changes.length, verified: true, source: plan.source, target: plan.target, backup };
  fs.writeFileSync(path.join(backup, 'receipt.json'), JSON.stringify(result, null, 2), { flag: 'wx' });
  return result;
}
if (require.main === module) {
  try {
    const args = process.argv.slice(2), options = {};
    for (let i = 0; i < args.length; i++) {
      if (['--check','--apply'].includes(args[i])) options[args[i].slice(2)] = true;
      else if (['--target','--expect'].includes(args[i]) && args[i + 1]) options[args[i].slice(2)] = args[++i];
      else throw Error('invalid_arguments');
    }
    if (!options.target || Boolean(options.check) === Boolean(options.apply)) throw Error('use_check_or_apply_with_target');
    const source = path.join(root, 'skills/qianchuan-ops'), plan = planSync(source, options.target);
    console.log(JSON.stringify(options.apply ? applySync(source, options.target, options.expect, path.join(root, 'work/skill-sync')) : plan));
  } catch (error) { console.error(JSON.stringify({ ok: false, code: error.code || error.message })); process.exitCode = 1; }
}
module.exports = { inventory, planSync, applySync };
