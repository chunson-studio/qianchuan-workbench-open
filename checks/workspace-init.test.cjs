'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { initWorkspace } = require('../tools/init-workspace.cjs');
const packageRoot = path.resolve(__dirname, '..');
const parent = require('./test-output.cjs').testOutputRoot();
fs.mkdirSync(parent, {recursive:true});
const makeProject = () => fs.mkdtempSync(path.join(parent, '客户项目-'));
test('在另一个客户项目初始化；入口指向程序，记录留在客户目录，重复运行保留客户内容', () => {
  const projectRoot = makeProject();
  fs.writeFileSync(path.join(projectRoot, 'AGENTS.md'), '用户项目的规则');
  const first = initWorkspace({projectRoot});
  assert.equal(first.created.length, 5);
  assert.equal(first.created_directories.length, 5);
  for (const dir of first.created_directories) assert.equal(fs.statSync(dir).isDirectory(), true);
  assert.equal(first.workspace_root, path.join(projectRoot, 'workspace'));
  assert.equal(first.account_connected, false);
  assert.equal(first.scheduler_created, false);
  assert.equal(first.advertising_writes, 0);
  assert.deepEqual(fs.readdirSync(path.join(first.workspace_root, '任务')), []);
  const manifest = JSON.parse(fs.readFileSync(path.join(first.workspace_root, '.qianchuan-workspace.json')));
  assert.equal(manifest.project_root, projectRoot);
  assert.equal(manifest.package_root, packageRoot);
  for (const file of Object.values(manifest.entries)) assert.equal(fs.statSync(file).isFile(), true);
  const state = path.join(first.workspace_root, '接续状态.md');
  fs.writeFileSync(state, '用户已确认的进度；不能重置');
  const second = initWorkspace({projectRoot});
  assert.equal(second.created.length, 0);
  assert.equal(second.preserved.length, 6);
  assert.equal(second.created_directories.length, 0);
  assert.equal(second.preserved_directories.length, 5);
  assert.deepEqual(fs.readdirSync(path.join(first.workspace_root, '任务')), []);
  assert.equal(fs.readFileSync(state, 'utf8'), '用户已确认的进度；不能重置');
  assert.equal(fs.readFileSync(path.join(projectRoot, 'AGENTS.md'), 'utf8'), '用户项目的规则');
  assert.deepEqual(fs.readdirSync(projectRoot).sort(), ['AGENTS.md', 'workspace']);
});
test('已有工作区规则和索引保留，仅补不存在的初始化记录', () => {
  const projectRoot = makeProject(), workspace = path.join(projectRoot,'workspace');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace,'AGENTS.md'),'用户工作区规则');
  fs.writeFileSync(path.join(workspace,'工作区索引.md'),'用户索引');
  const result = initWorkspace({projectRoot});
  assert.equal(result.created.length,4);
  assert.equal(fs.readFileSync(path.join(workspace,'AGENTS.md'),'utf8'),'用户工作区规则');
  assert.equal(fs.readFileSync(path.join(workspace,'工作区索引.md'),'utf8'),'用户索引');
});
test('目录映射冲突拒绝覆盖或另写文件', () => {
  const projectRoot = makeProject(), workspace = path.join(projectRoot,'workspace');
  fs.mkdirSync(workspace);
  const file = path.join(workspace,'.qianchuan-workspace.json');
  const text = JSON.stringify({project_root:projectRoot,package_root:path.dirname(packageRoot),workspace_root:workspace});
  fs.writeFileSync(file,text);
  assert.throws(() => initWorkspace({projectRoot}), {code:'workspace_mapping_conflict'});
  assert.equal(fs.readFileSync(file,'utf8'),text);
  assert.equal(fs.readdirSync(workspace).length,1);
});
test('客户采用当前策略作为入口时，重新初始化不重建任务目录或覆盖策略', () => {
  const projectRoot = makeProject(), workspace = path.join(projectRoot, 'workspace');
  const account = path.join(workspace, '账户策略', '本账号');
  fs.mkdirSync(account, {recursive:true});
  const strategy = path.join(account, '当前策略.md');
  fs.writeFileSync(strategy, '用户当前规则，不能被模板覆盖');
  fs.writeFileSync(path.join(workspace, '.qianchuan-workspace.json'), JSON.stringify({
    project_root:projectRoot, package_root:packageRoot, workspace_root:workspace,
    customer_layout:{type:'account_strategy_entry', separate_task_files:false}
  }));
  initWorkspace({projectRoot});
  initWorkspace({projectRoot});
  assert.equal(fs.existsSync(path.join(workspace, '任务')), false);
  assert.equal(fs.readFileSync(strategy, 'utf8'), '用户当前规则，不能被模板覆盖');
});
test('业务目录被文件占用时停止，不覆盖也不留下部分初始化文件', () => {
  const projectRoot = makeProject(), workspace = path.join(projectRoot, 'workspace');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, '任务'), '客户原文件');
  assert.throws(() => initWorkspace({projectRoot}), {code:'workspace_directory_conflict'});
  assert.deepEqual(fs.readdirSync(workspace), ['任务']);
  assert.equal(fs.readFileSync(path.join(workspace, '任务'), 'utf8'), '客户原文件');
});
test('工作区连接到其他目录时不写入链接目标', t => {
  const projectRoot = makeProject(), external = makeProject();
  try { fs.symlinkSync(external,path.join(projectRoot,'workspace'),process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') return t.skip('系统不允许创建测试链接'); throw error; }
  assert.throws(() => initWorkspace({projectRoot}), {code:'workspace_link_conflict'});
  assert.equal(fs.readdirSync(external).length,0);
});
