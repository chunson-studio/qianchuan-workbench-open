# 首次部署与接续

部署用途须符合[免费自用许可证](LICENSE)：允许自有店铺免费使用，禁止转卖、收费部署、代运营和收费平台；具体场景见[使用说明](docs/使用说明.md#许可与使用范围)。

1. 读取 AGENTS.md 和使用者当前任务。检查已有配置与工作区，先续接可用环境。
2. 在仓库根运行 `node tools/setup.cjs --check --json`。缺依赖时由 Agent 安装；可手动执行 `npm ci` 与 `npm --prefix server-app ci`。
3. 运行 `node tools/setup.cjs --json`，以返回的 URL、账户接入地址、Skill 入口和下一步为准。启动为空账户，业务后台默认关闭。
4. 运行 `node tools/connect-client.cjs --project-root "客户项目绝对路径" --client codex --json` 安装项目 Skill；运行 `node tools/init-workspace.cjs --project-root "客户项目绝对路径" --json` 建立独立客户记录目录。
5. 没有登录时由使用者本人在千川网页登录。Agent 核对实际身份与主计划，按本机接入页返回 revision 预演、展示并保存。已有账户不重复保存。
6. 读取完整任务池并核总数、唯一 ID、筛选、日期、场次和数据口径。缺数记未知，不补零。
7. 使用者提供自己的经营规则与动作范围。先验证明确授权的一次动作和原对象回读，再按授权启用持续调度。
8. 记录实际完成项和未决事项；不能把服务进程启动或测试通过写成真实业务成功。

入口：[使用说明](docs/使用说明.md)、[公开 Skill](skills/qianchuan-ops/SKILL.md)、[脚本索引](skills/qianchuan-ops/references/脚本索引.md)。
