'use strict';
// 安装本项目的客户端入口；不读取 Cookie，不创建调度，不修改广告权限。
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function checkPath(root, file) {
  const relative = path.relative(root, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) fail('path_outside_project', '目标不在客户项目内');
  let cursor = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    try { if (fs.lstatSync(cursor).isSymbolicLink()) fail('client_link_conflict', '客户端配置路径包含链接；请先核对，未覆盖'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
function connectClient({ projectRoot, packageRoot = ROOT, client } = {}) {
  if (!projectRoot || !['codex', 'manual'].includes(client)) fail('invalid_arguments', '请指定 --project-root 和 --client codex|manual');
  projectRoot = fs.realpathSync(path.resolve(projectRoot));
  packageRoot = fs.realpathSync(path.resolve(packageRoot));
  const skillSource = path.join(packageRoot, 'skills', 'qianchuan-ops');
  if (!fs.existsSync(path.join(skillSource, 'SKILL.md'))) fail('skill_missing', '随包 Skill 不完整');
  const skillTarget = path.join(projectRoot, '.agents', 'skills', 'qianchuan-ops');
  let skillInstalled = false;
  if (client === 'codex') {
    checkPath(projectRoot, path.dirname(skillTarget));
    try {
      if (fs.realpathSync(skillTarget) !== fs.realpathSync(skillSource)) fail('skill_conflict', '已有同名 Skill 指向其他位置；未覆盖');
      skillInstalled = true;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    // 悬空链接也属于已有客户配置，不能覆盖。
    if (!skillInstalled) {
      try { fs.lstatSync(skillTarget); fail('skill_conflict', '已有同名 Skill 无法解析；未覆盖'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  if (client === 'codex' && !skillInstalled) {
    fs.mkdirSync(path.dirname(skillTarget), { recursive: true });
    fs.symlinkSync(skillSource, skillTarget, process.platform === 'win32' ? 'junction' : 'dir');
  }
  return { ok: true, client, project_root: projectRoot, package_root: packageRoot,
    skill: { entry: path.join(client === 'codex' ? skillTarget : skillSource, 'SKILL.md'), status: client === 'codex' ? 'project_installed_not_verified' : 'read_by_path' },
    next_step: '读取 Skill；使用宿主浏览器插件核对当前账户和场次。',
    scheduler_created: false, advertising_writes: 0 };
}
if (require.main === module) {
  try {
    const args = process.argv.slice(2), options = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--json') continue;
      if (['--project-root', '--client'].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith('--')) options[args[i] === '--client' ? 'client' : 'projectRoot'] = args[++i];
      else fail('invalid_arguments', '用法：node tools/connect-client.cjs --project-root "客户项目绝对路径" --client codex|manual --json');
    }
    console.log(JSON.stringify(connectClient(options)));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, code: error.code || 'client_setup_failed', message: error.message }));
    process.exitCode = 1;
  }
}
module.exports = { connectClient };
