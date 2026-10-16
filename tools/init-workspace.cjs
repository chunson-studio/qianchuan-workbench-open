'use strict';
// 只建立客户文档工作区，不启动服务、不读取凭据、不改变账户或调度。
const fs = require('node:fs');
const path = require('node:path');
const PACKAGE_ROOT = path.resolve(__dirname, '..');
const asLink = value => value.replace(/\\/g, '/');
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function initWorkspace({ projectRoot = process.cwd(), packageRoot = PACKAGE_ROOT } = {}) {
  projectRoot = fs.realpathSync(path.resolve(projectRoot));
  packageRoot = fs.realpathSync(path.resolve(packageRoot));
  if (!fs.statSync(projectRoot).isDirectory()) fail('project_not_directory', '当前项目不是目录');
  if (!fs.existsSync(path.join(packageRoot, 'AGENT_START.md'))) fail('package_missing', '未找到项目内的 AGENT_START.md');
  const workspaceRoot = path.join(projectRoot, 'workspace');
  const entries = {
    start: path.join(packageRoot, 'AGENT_START.md'),
    initialize: path.join(packageRoot, 'docs', '客户端接入.md'),
    resume: path.join(packageRoot, 'workspace', '运行入口', '日常接续.md'),
    loop: path.join(packageRoot, 'workspace', '运行入口', 'loop指令.md'),
    monitor: path.join(packageRoot, 'workspace', '运行入口', '盯盘提示词.md'),
    replay: path.join(packageRoot, 'workspace', '运行入口', '复盘指令.md'),
    skill: path.join(packageRoot, 'skills', 'qianchuan-ops', 'SKILL.md'),
    client: path.join(packageRoot, 'docs', '客户端接入.md'),
    cookies: path.join(packageRoot, 'docs', '用户引导.md'),
    scheduling: path.join(packageRoot, 'docs', '定时与循环任务.md'),
    collaboration: path.join(packageRoot, 'docs', '定时与循环任务.md'),
    task_template: path.join(packageRoot, 'workspace', '运行入口', '盯盘任务模板.md'),
  };
  for (const [key, file] of Object.entries(entries)) if (!fs.existsSync(file)) fail('entry_missing', `项目缺少 ${key} 入口`);
  const manifestFile = path.join(workspaceRoot, '.qianchuan-workspace.json');
  const files = ['.qianchuan-workspace.json', '工作区索引.md', '接续状态.md', 'AGENTS.md', '部署检查.md'];
  const directories = ['账户策略', '任务', '任务卡', '素材分析', '复盘报告'];
  // 不跟随工作区目录或将写入文件的链接；先检查全部目标，再建立文件。
  for (const file of [path.join(projectRoot, 'AGENTS.md'), workspaceRoot, ...directories.concat(files).map(name => path.join(workspaceRoot, name))]) {
    try { if (fs.lstatSync(file).isSymbolicLink()) fail('workspace_link_conflict', '目标包含链接，请先核对实际工作区位置'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const name of directories) {
    const target = path.join(workspaceRoot, name);
    if (fs.existsSync(target) && !fs.statSync(target).isDirectory()) fail('workspace_directory_conflict', `业务目录被同名文件占用：${name}，未覆盖`);
  }
  for (const file of [path.join(projectRoot, 'AGENTS.md'), ...files.map(name => path.join(workspaceRoot, name))]) {
    if (fs.existsSync(file) && !fs.statSync(file).isFile()) fail('workspace_file_conflict', '入口文件位置被目录占用，未覆盖');
  }
  let current;
  if (fs.existsSync(manifestFile)) {
    try { current = JSON.parse(fs.readFileSync(manifestFile, 'utf8').replace(/^\uFEFF/, '')); }
    catch { fail('workspace_mapping_invalid', '已有工作区映射无法读取，未覆盖'); }
    for (const [key, expected] of Object.entries({ project_root: projectRoot, package_root: packageRoot, workspace_root: workspaceRoot })) {
      if (typeof current[key] !== 'string' || path.resolve(current[key]) !== expected) fail('workspace_mapping_conflict', '已有工作区指向其他目录，未覆盖；请核对搬迁路径');
    }
    // 已有客户选择直接以当前策略盯盘，不重新创建已清理的任务目录。
    if (current.customer_layout?.type === 'account_strategy_entry') directories.splice(directories.indexOf('任务'), 1);
  }
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const createdDirectories = [], preservedDirectories = [];
  for (const name of directories) {
    const target = path.join(workspaceRoot, name);
    if (fs.existsSync(target)) preservedDirectories.push(target);
    else { fs.mkdirSync(target); createdDirectories.push(target); }
  }
  const manifest = current || { schema_version: 1, project_root: projectRoot, package_root: packageRoot,
    workspace_root: workspaceRoot, created_at: new Date().toISOString(), entries };
  const collaborationLink = `[多账号多会话](<${asLink(entries.collaboration)}>)`;
  const maintenance = '说明与任务入口只保留当前有效版本，规则正文只维护一份；更新时同步索引和引用。用户授权清理后将已替代入口移入系统回收站，不另留“已停用”或跳转文件。账户登录、原始资料、操作回执和复盘另行保留。';
  const index = `# 我的千川工作区\n\n本目录保存本人的账户策略、任务和复盘。通用知识与流程使用项目内置文件。\n\n- [公共部署状态](接续状态.md)\n- [部署检查](部署检查.md)\n- [首次使用](<${asLink(entries.start)}>)\n- [日常接续](<${asLink(entries.resume)}>)\n- [循环盯盘指令](<${asLink(entries.loop)}>)\n- [下播复盘指令](<${asLink(entries.replay)}>)\n\n基础目录已建立：${directories.map(name => name + '/').join('、')}。按${collaborationLink}核验账户后直接建立该账号的独立任务；真实场次尚未确定时放在该账号的准备目录。空白任务模板只读取程序内的 [任务模板](<${asLink(entries.task_template)}>)，不在客户根任务目录另建共享副本。\n\n## 账号任务导航\n\n核验后登记账号策略及具体任务绝对路径；这里不保存可驱动所有会话的“当前账号”。每轮只更新本任务的接续状态。\n`;
  const state = `# 公共部署接续状态\n\n只记录共享环境、安装进度和公共待办。账号核验后按${collaborationLink}建立独立任务和业务接续状态。\n\n- 文档工作区：已建立\n- 服务 / 浏览器 / Skill：待核验\n- 已连接账户及路径：核验后登记工作区索引\n- 本次初始化未创建任务、调度或投放授权\n- 宿主调度状态：待核验，清空文件不等于停用\n- 下一步：读取程序 AGENT_START.md，复用已有接入并确认本会话负责的账号\n\n公共内容仅在部署或交接时合并更新；每轮业务进度只写本任务接续状态。凭据不进入文档。\n`;
  const rules = `# 客户工作区入口\n\n先遵守当前项目上层 AGENTS.md，再读[公共部署状态](接续状态.md)和[账号任务索引](工作区索引.md)。目录映射见 .qianchuan-workspace.json；搬迁后先核对路径。\n\n通用技能入口：[qianchuan-ops](<${asLink(entries.skill)}>)。首次接入：[AGENT_START](<${asLink(entries.start)}>)。已有账户与策略先续接，不重复开户、授权或建立调度。\n\n按${collaborationLink}定位本会话任务。每个会话固定账号与主计划，每次请求显式传账号；前端账号选择不是操作范围。根接续状态仅供部署导航，业务进度写在本账号本任务的独立接续状态中。启动前检查同主计划执行归属，文档登记不等于程序互斥锁。\n\n本地文档不授予投放权限。执行必须具备用户授权、有效账户策略和接口能力，并在操作后回读。不把凭据或客户记录打进通用包。\n\n${maintenance}\n`;
  const deployment = `# 部署检查\n\n每项写实际结果、核验时间和证据；不得写 Cookie 内容。\n\n- 程序目录：${asLink(packageRoot)}\n- 客户项目：${asLink(projectRoot)}\n- 工作区：${asLink(workspaceRoot)}\n- 环境与依赖：待验证\n- 服务身份与地址：待验证\n- Skill 安装位置 / 已读取 / 客户端发现：待验证\n- 浏览器配置 / 账户绑定 / 实际读取：待验证\n- 运行配置与数据根目录：待 setup 返回后填写\n- 千川 Cookie 实际文件绝对路径 / 有效性：待导入后核验\n- 罗盘 Cookie 实际文件绝对路径 / 有效性：待导入后核验\n- 账户与主计划：待核验\n- 宿主名称 / 循环工具 / 停止方式：待检查\n- 调度：未创建\n- 账号任务：核验后按${collaborationLink}建立，在工作区索引登记实际路径\n- 阻断与下一步：按首次使用说明继续\n\n会话、场次、执行归属和调度回执写入本账号的独立任务目录。\n`;
  const contents = { '.qianchuan-workspace.json': JSON.stringify(manifest, null, 2) + '\n',
    '工作区索引.md': index, '接续状态.md': state, 'AGENTS.md': rules, '部署检查.md': deployment };
  const created = [], preserved = [];
  for (const [name, content] of Object.entries(contents)) {
    const file = path.join(workspaceRoot, name);
    try { fs.writeFileSync(file, content, { encoding: 'utf8', flag: 'wx' }); created.push(file); }
    catch (error) { if (error.code !== 'EEXIST') throw error; preserved.push(file); }
  }
  const projectEntry = path.join(projectRoot, 'AGENTS.md');
  try {
    fs.writeFileSync(projectEntry, `# 千川客户工作区\n\n用户说“请开始部署”时读取 [程序首次使用](<${asLink(entries.start)}>)，按说明安装环境、Skill并连接浏览器，并引导本人配置 Cookie。日常先读 [公共部署状态](workspace/接续状态.md)、[工作区入口](workspace/AGENTS.md)和 [账号任务索引](workspace/工作区索引.md)，再读本会话绑定任务的独立接续状态。\n\n遵守${collaborationLink}：固定本会话账号与主计划，显式传入请求，不跟随前端选择；每个任务独立循环和接续文件，同一主计划先核验执行归属，不重复接管。任务核验账号后直接建立在独立目录，空白模板只读程序内原件。循环工具由当前宿主检查，不把不同客户端命令混用。\n`, { encoding: 'utf8', flag: 'wx' });
    created.push(projectEntry);
  } catch (error) { if (error.code !== 'EEXIST') throw error; preserved.push(projectEntry); }
  return { ok: true, project_root: projectRoot, package_root: packageRoot, workspace_root: workspaceRoot,
    created, preserved, created_directories: createdDirectories, preserved_directories: preservedDirectories,
    entries, next_step: 'read AGENT_START.md; verify existing service and account; complete handoff checklist in docs/客户端接入.md',
    service_started: false, account_connected: false, scheduler_created: false, advertising_writes: 0 };
}
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    let projectRoot = process.cwd();
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--json') continue;
      if (args[i] === '--project-root' && args[i + 1] && !args[i + 1].startsWith('--')) projectRoot = args[++i];
      else fail('invalid_arguments', '用法：node tools/init-workspace.cjs --project-root "当前选中的项目绝对路径" --json');
    }
    const result = initWorkspace({ projectRoot });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, code: error.code || 'workspace_init_failed', message: error.message, retryable: false }));
    process.exitCode = 1;
  }
}
module.exports = { initWorkspace };
