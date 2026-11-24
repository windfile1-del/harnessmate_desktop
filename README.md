# HarnessMate Desktop

开放式、插件驱动的多 AI Coding Harness 桌面工作台。统一管理多实例 `Codex CLI`、`Antigravity CLI (agy)`、`Claude Code CLI`、ACP 兼容 CLI 与隔离第三方引擎插件（如 `plugins/hm-adapter-deepseek`、`plugins/hm-adapter-opencode`），支持无损跨引擎上下文接力、多引擎并行编排、`HM-Remote v1` 移动远程控制，以及内置 AI Plugin Builder v2。

## 核心特性

- **统一多实例 Harness 架构**：通过 `HarnessDriverV2` 三层能力声明、动态 `OptionDescriptor`、被动零副作用探活与环境变量/目录隔离（`CODEX_HOME` / `CLAUDE_CONFIG_DIR`），允许通过 Plugin SDK V5 接入任意第三方非 ACP 引擎而无需修改主程序前后端源码。
- **Context Handoff Protocol v2 & 结构化任务账本**：自动沉淀任务目标、步骤清单、修改文件、验证结果、钉选铁律与 `failedAttempts`（同步落盘 `.harnessmate/task-ledger.md`）；支持敏感信息出站脱敏、`delivery_status = 'pending'` 崩溃防重入守卫、小窗口预算溢出自动开新线程，以及内置 MCP `hm_session_read` 按需分页回查。
- **Plugin SDK V5 & AI Plugin Builder v2**：在兼容 V1–V4 的基础上提供 `registerDriver`、`spawnCli`、`net.openStream`、`secrets.resolve`、DAG 环检测与 V5 5 个前端 UI 插槽（`chat.block`、`composer.traits`、`harness.settings`、`inspector.diff`、`session.sidebar.badge`），并配套 `@harnessmate/plugin-sdk/testing` 离线回放测试库、`harness-adapter` 黄金模板、静态安全审计器，以及 Tier 1 快速清单 / Tier 2 隔离工程 4 步沙箱验证与 3 轮自修复闭环。
- **核心内置与高阶可选插件体系**：
  - **Git Checkpoints & Diff/Worktree**（`hm.plugin.git-checkpoints`）：隐藏 Git Ref 每轮零污染快照、原子级“先撤对话、后还文件”回滚守卫、`pre_revert` 撤销备份、Unified/Split 按需 Diff、Worktree 全生命周期与 `.harnessmate/setup` SHA-256 信任门禁。
  - **Session Explorer & Approval Center**（`hm.plugin.session-explorer`、`hm.plugin.approval-center`）：SQLite FTS5 全局检索、zstd 流式外部 CLI 历史导入、原生/便携 Fork 与 `merge_back`、Side Chat、脱敏 Bundle 导入导出，以及带高危命令分级标注、跨端 409 原子锁和 `secret_request` 零落盘通道的全局审批中心。
  - **Message Studio & Multi-Instance Usage/Failover**（`hm.plugin.message-studio`、`hm.plugin.usage-failover`）：交错时间线 `TurnBlock` + 可折叠 `WorkGroup`、侧信道按需流式输出、双隔离 `html_render` 沙箱卡、动态 `TraitsPicker`、上下文窗口与 Prompt Cache 仪表，以及限额触发一键 Failover。
  - **多 Harness 并行编排、智能上下文压缩、持久终端与 Triage收件箱（按需启用）**：场景 D 并行委托 + 强制 Worktree 隔离与 `dryRunMerge` 合回（`hm.plugin.multi-harness-orchestrator`）、多语言符号轮廓索引与 8 秒无感回退滚动摘要（`hm.plugin.context-compression`）、零 SQLite 污染 512KB 环形持久终端 + `TerminalContextInlineChip`（`hm.plugin.terminal-workspace`）、4 级 Triage 待办与中文 IME 免疫的 `Ctrl/Cmd+K` 全局命令面板（`hm.plugin.triage-inbox`）。
- **Star Loom Atelier 界面 & `HM-Remote v1`**：夜织深空 / 暖宣浅色双主题、扫码配对移动端、局域网/Tailscale 远程控制与原子跨端审批。

## 对话命令与历史导入

在会话输入框输入 `/`，菜单会跟随当前 Harness。原生命令由内置的「原生 Harness 命令」插件提供，可在插件中心启停。

| 指令 | 用法 |
| --- | --- |
| `/model` | 查看模型，或用 `/model <ID>` 选择模型。用 `/model default` 恢复 CLI 默认。 |
| `/plan` | 进入计划模式，可附任务直接启动一轮。用 `/plan off` 回到手动权限模式。 |
| `/usage` | 查看 Codex 订阅额度、AGY 模型额度或 Claude 原生用量输出。 |
| `/compact` | 压缩当前原生会话的模型上下文。Claude 支持附加摘要重点。 |
| `/goal` | 使用底层引擎的目标模式。Codex 支持 `status`、`pause`、`resume`、`clear`。AGY CLI 需要提供目标。 |
| `/plugin` | 查看原生插件，或用 `/plugin install <插件[@市场]>` 安装。Claude 支持 `/plugin reload`。 |
| `/skills` 和 `/skill <名称> [参数]` | 查看或调用当前环境提供的技能。 |

AGY 的额度、压缩和目标等命令通过其 CLI 入口执行。导入的 AGY 桌面会话使用桌面数据目录，经 ACP 续接，对话菜单提供该会话可用的模型、计划和额度命令。原生命令随 CLI 版本和账号能力变化。

打开「新建会话 → 导入本机会话」，选择 Codex 桌面端或 CLI、AGY 桌面端或 CLI、Claude Code 的本地记录。原工作目录失效时可以选择备用工作区。导入保存用户和助手的文本历史及原生会话绑定，同一个来源和原生 ID 的重复导入会打开已有会话。AGY 优先读取 ACP 历史，必要时使用本地全文索引中的文本。原生附件、工具执行详情和仅存云端的记录保留在原客户端。

## 插件中心

在「插件中心 → 安装 / 创建插件」选择工作区、Harness 和模型，描述想要的扩展。AI 在单独的计划模式会话中生成草稿。你可以修改清单，校验后选择「安装并热加载」。已安装的声明式插件可通过「AI 改版」生成升级草稿。

- 生成器支持斜杠命令及右侧检视器的插件面板。面板可显示轮次统计、已记录的改动文件、验证结果和近期轮次。面板按钮会把本插件的命令填入输入框，发送仍由你操作。
- 插件也可通过内置目录、JSON 清单或包含 `harnessmate-plugin.json` 的本地目录安装。清单支持 `apiVersion: 1`、`contributes.slashCommands`、`contributes.panels`、ACP Harness 和 MCP 预设。面板的 `sections` 可选 `turns`、`changed_files`、`verifications`、`recent_activity`，`actions` 中的 `{ label, command, args? }` 引用本插件的命令。
- V2 插件可订阅轮次事件、按会话或工作区取数、配置面板列和筛选器，并注册侧栏、输入区和斜杠命令入口。可从插件目录安装「项目验收台」，或在插件中心让 AI 生成自定义清单。参见 [插件 SDK V2](docs/plugin-sdk-v2.md)。
- V3 插件增加可组合的文本处理程序、聊天动作和会话级模型工具。安装「会话工具箱」后，可在已安装列表中按工作区授权。参见 [插件 SDK V3](docs/plugin-sdk-v3.md)。
- V4 声明式插件可用 `engines.pluginApi` 声明 API 范围，并用 `inject` 声明依赖。插件中心的「查看完整组合」显示组合包、用户覆盖和启用状态。参见 [V4 开发计划与进度](docs/plugin-sdk-v4-progress.md)。
- 本地 V1 JavaScript 插件在信任预览后以本机用户权限运行。`beforeTurn(context)` 返回的文本会显示为可选建议，发送前由用户确认。`onEvent(event)` 兼容轮次完成、失败和取消。JavaScript、ACP 引擎和 MCP 预设均按本次预览的包摘要确认。
- 安装先校验候选版本，再切换有效版本。初始化失败时保留当前版本。已安装列表提供启停、热重载和回退，版本记录在应用重启后保留。

## 架构概览

- `packages/protocol`: 统一规范事件模型（`CanonicalEvent`、`TurnBlock`）、多 Harness / 插件 / 并行编排契约与 `HM-Remote v1` REST/WebSocket 协议定义。
- `packages/plugin-api` & `packages/plugin-sdk`: Plugin SDK V4/V5 公共契约、`@harnessmate/plugin-sdk/testing` 离线测试夹具库与 5 套黄金脚手架模板（含 `harness-adapter`）。
- `packages/daemon`: 独立 Node.js 24 守护服务（`node:sqlite` WAL + FTS5 混合投影、`CommandOutputHub`、结构化适配器、ContextCompiler、CheckpointService、SessionExplorer、ApprovalCenter、OrchestratorService、AI Plugin Builder v2 与 `HM-Remote v1` 网关）。
- `packages/web`: React 19 + Tailwind v4 **Star Loom Atelier** 零硬编码统一前端与 V5 沙箱插槽宿主。
- `packages/electron`: 轻量桌面壳（自动托管本地 Daemon、关闭隐藏到系统托盘保活、系统审批通知与便携 `.exe` 打包）。
- `plugins/`: 官方外部隔离非 ACP 适配器标杆（`hm-adapter-deepseek`、`hm-adapter-opencode`）。

## 快速启动

```bash
pnpm install
pnpm build
```

### 方式一：Electron 桌面应用启动（推荐）
```bash
pnpm dev:electron
```

### 方式二：打包独立 Windows `.exe` 启动程序
```bash
pnpm pack:exe
# 输出位于 packages/electron/release/HarnessMate-Desktop-0.6.0-portable.exe
```

### 方式三：独立 Daemon + 浏览器开发模式
```bash
# 终端 1：启动本地守护服务 (默认 127.0.0.1:4789)
pnpm dev:daemon

# 终端 2：启动前端 Vite 开发服务器 (http://localhost:5173)
pnpm dev:web
```

## 运行测试

```bash
pnpm test
pnpm typecheck
```
