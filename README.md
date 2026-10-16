# 千川通用执行工作台

面向 Agent 的千川浏览器与本机 API 工具集。包含网页工作台、原始数据读取、素材查询、指定参数操作、批量执行、CLI、后台连接和断线接续。

**不含作者账户、凭据、经营记录和私有投放策略。** 所有业务参数由使用者提供。安装不会自动投放或创建调度。策略评分、自动选材、止损和扩量建议未开放；相关接口明确返回不支持或 `strategy_status: not_included`，不代表经营正常。

## 给 Agent 使用

下载或克隆本仓库，在 Codex 等支持本地文件和命令的客户端中打开项目，然后发送：

> 请读取 AGENTS.md 和 AGENT_START.md，开始部署。使用我自己的账户和经营规则；先验证读取，操作后按原对象回读。不要删除主计划，不要改任务默认名称。

Agent 负责检查环境和安装依赖；需要本人登录或浏览器许可时再由使用者操作。账户资料仅保存在本机，不能发进聊天或提交到 Git。

## 手动启动

需要 Node.js 22.5 或更新的受支持版本。Windows 可双击「开始使用.cmd」。终端可运行：

```sh
npm ci
npm --prefix server-app ci
npm run check
npm start
```

以命令实际返回的本机 URL 为准；打开账户接入页，登录并核对自己的账户和主计划。首次启动为空账户，后台业务采集默认不启用。已有登录或本机配置应续接，不覆盖。

## 包含什么

| 能力 | 入口 |
| --- | --- |
| 安装、工作区与 Skill | `tools/setup.cjs`、`tools/connect-client.cjs`、`tools/init-workspace.cjs` |
| 官方 Playwright CLI 接入 | `tools/run-qc-playwright-cli.cjs` |
| 原生后台、客户端与恢复 | `tools/start-qc-native-session.cjs`、`tools/qc-native-session-client.cjs` |
| 扩展后台与多账户绑定 | `tools/start-qc-extension-session.cjs` |
| 完整任务池读取、分页与并发 | `tools/read-qc-control-*.playwright.cjs` |
| 浏览器批量、参数编辑和素材表单 | `tools/qc-native-operations.cjs`、`tools/browser-actions/` |
| API、历史查询、原始报表 | `server-app/server/routes/`、`server-app/server/lib/qianchuan.js` |
| 网页工作台 | `server-app/server/public/v4/` |
| 通用 Skill、模板和脚本索引 | `skills/qianchuan-ops/` |

通道按所用客户端的能力与权限选择。CLI、MCP和浏览器扩展不是同一个接口；换通道后重新核验身份和未决原请求，不能重放未知提交。每次操作显式绑定账户、主计划、场次和任务，不能跟随当前活动标签。

## 验证与维护

运行 `npm test` 执行公开版离线回归。覆盖范围和限制见 [验证记录](VERIFICATION.md)。合成测试通过不表示任何使用者的真实账户已通过验收；首次使用要逐项验证读取、授权操作及回读。

[使用说明](docs/使用说明.md) · [脚本索引](skills/qianchuan-ops/references/脚本索引.md) · [公开范围](审核说明.md) · [第三方许可](THIRD-PARTY-NOTICES.md)

本项目为非官方工具；平台页面和接口变化时可能需要维护。代码使用 MIT 许可，第三方资源保留各自许可。
