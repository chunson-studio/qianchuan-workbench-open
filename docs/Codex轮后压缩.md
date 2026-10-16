# Codex 轮后压缩

默认沿用宿主压缩行为。以下为可选配置参考，不代表已启用；只有使用者明确要求时才修改设置，不强制重启正在运行的宿主。

撤回命令：`node tools/codex-post-turn-compact-config.mjs --restore-defaults --apply`。仅移除根配置中的该项，保留其他配置，不能用历史整份备份覆盖当前文件。结果与证据保存在本机deployment.json和rollback.json。

适用：Codex 定时任务长期使用同一会话，希望将压缩尽量放在本轮业务结束之后。无需新增定时任务，也不在每轮提示词中要求模型自行猜测剩余上下文。

## 已验证的原生设置

本机 `codex-cli 0.162.0-alpha.2` 支持根配置项：

```toml
model_post_turn_compact_threshold_percent = 75
```

这是当前可用上下文窗口的百分比，不是聊天轮数、累计计费Token或硬盘日志大小。达到阈值后，宿主在本轮最终回答之后进行压缩，再发出 `turn/completed`。75是本机选择值，不是官方默认值或其他客户的强制策略。保留原有 `model_auto_compact_token_limit` 和 `model_context_window`，单轮异常增长仍可能触发原来的中途压缩保护。

公开配置参考尚未列出此项，因此按实际安装版本验证后启用；不能只凭字段名判断语义。原生程序拒绝0–100范围以外的值；安装脚本进一步只接受1–100，不依赖未核验的0值含义。

## 安装与回读

先执行原生隔离测试。`QC_COMPACT_PROBE_CODEX` 指向实际 `codex.exe`，`QC_COMPACT_PROBE_EVIDENCE` 为本机验收JSON路径：

```powershell
node --test tools/codex-post-turn-compact.test.mjs
node tools/codex-post-turn-compact-config.mjs --codex "实际codex.exe路径" --percent 75
node tools/codex-post-turn-compact-config.mjs --codex "实际codex.exe路径" --percent 75 --apply
```

配置脚本默认预览；`--apply`仅变更用户Codex根配置中的此项，保留notify、模型、插件、权限等其余内容。原文件备份到同目录 `backups/post-turn-compaction/`，保存前检查并发变更，写后逐字回读。可通过 `--config` 显式指定目标配置，不能修改无关宿主的Profile。

**生效边界：已加载会话不会仅因配置文件变化就自动采用新值。** 隔离测试已验证：会话以100加载，磁盘改75后直接启动下一轮仍按旧值运行。新加载/重新初始化会话需要重新解析配置；桌面运行中的既有会话是否重载须核实。不得将写入成功、配置读取成功或新建测试通过表述为所有实盘会话已经采用。不要启动第二个app-server接管实盘线程；不得为启用此项强制中断正在执行的投控。

## 验证与证据

- `tools/codex-post-turn-compact-probe.mjs`：独立临时CODEX_HOME与工作目录、回环地址假模型、ephemeral测试线程；不读取实盘线程或凭据，不操作广告。测试用量为模拟值，不代表真实模型速度或摘要质量。
- `tools/codex-post-turn-compact.test.mjs`：配置保留/幂等，以及本机原生app-server三场景测试。40000窗口实际报告可用38000；75%阈值下28000输入不压缩、29000输入压缩；验证最终回答→contextCompaction→turn/completed的顺序；验证已加载会话配置不会自动更新。
- 2026-10-08验收：2组测试通过，原生测试3场景通过。证据：`private-runtime/audits/codex-post-turn-compaction/validation.json`。本机部署与待重载状态：同目录 `deployment.json`。

## Agent 轮次收尾

最终回复前保存本轮身份/场次、有效策略版本、已核操作回执、未决提交和下轮入口。压缩后重新核对当前任务与新鲜盘面，未决提交按原ID核验，不重放旧动作；异常回执不改写为成功。原生机制不检查业务台账，因此不能假定压缩会自动解决未决业务。

压缩耗时不固定；本机制将触发点移至轮末，不承诺在下次定时点前完成。继续沿用同会话，不自动新开或重置聊天。不新增睡眠循环、工单或高频压缩提醒。若未来版本拒绝此项，保留原始错误，撤回该单项并重新验证，不关闭全部压缩或伪造上下文容量。

接口背景：[官方App Server事件与压缩接口](https://learn.chatgpt.com/docs/app-server)、[公开配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)。当前参数行为以本机测试为证。
