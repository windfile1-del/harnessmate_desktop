# 插件开发任务说明书 15 · Integrated PTY Terminal & Context Chips

| 属性 | 说明 |
| --- | --- |
| **插件名称 & Plugin ID** | Integrated PTY Terminal & Context Chips · `hm.plugin.terminal-workspace` |
| **功能定位** | 将现有一次性命令执行器演进为按工作区/Worktree 隔离的**持久化交互式 PTY 终端抽屉 + 后台开发服务监控器**，并引入 T3 Code 风格的 **`TerminalContextInlineChip`**，让用户一键将终端中任意报错片段、堆栈或选区作为结构化上下文胶囊直接附加到聊天输入框喂给任意 Harness |
| **参考来源 (T3 Code)** | `t3code/apps/web/src/components/chat/TerminalContextInlineChip.tsx`、`ComposerPendingTerminalContexts.tsx`、`apps/web/src/lib/terminalContext.ts`、`apps/server/src/terminal/`（PTY 生命周期与每线程/Worktree 终端管理）（`[T3 Code 已验证实现]`） |
| **HarnessMate 当前状态** | **基础片段实现**：现有 `core.terminal-runner` 清单与 `packages/daemon/src/core/terminal-service.ts`（103 行）仅提供单次非交互 `runWorkspaceCommand(cwd, command, timeoutMs = 30_000)`（`stdio: ['ignore', 'pipe', 'pipe']`，64KB 截断）；**缺口**：无交互式 PTY（`xterm.js` + `node-pty`/ConPTY）、无多 Tab 持久终端会话、无后台 dev server 存活与端口状态监控、无一键将终端选中输出转为 `TerminalContextInlineChip` 附入对话的能力 |
| **插件类型** | Optional Plugin（官方可选工作台增强插件，演进并替代旧 `core.terminal-runner` 的高级终端视图） |
| **开发难度与风险** | **中**（风险点：Windows ConPTY 与 macOS/Linux PTY 跨平台适配差异及原生模块打包复杂度；海量高频终端 stdout（如 `yes` 或构建刷屏）阻塞 WebSocket；关闭工作区/退出应用时泄漏孤儿 Shell 子进程） |
| **开发优先级** | **P3**（Phase 4，提升一体化 IDE 级人机协同开发闭环体验） |

---

## 1. 职责范围

### 明确负责
- **按工作区/Worktree 隔离的多 Tab 持久化 PTY 终端**：
  - 为当前会话绑定的工作区（或独立 Worktree 目录）提供可折叠底部/右侧多标签终端抽屉，支持完整交互式输入（`Ctrl+C`、Vim、REPL、彩色 ANSI、窗口 resize 同步）；
  - 实时跟随当前激活会话的工作区/Worktree 切换对应终端组，避免把命令敲进错误的 Worktree 分支；
  - 复用 `CommandOutputHub` 架构思想：高频 PTY 字节流走独立背压控制 WebSocket 通道 + 内存环形缓冲区（默认单终端 512KB），**绝不写入 Core SQLite 事件表**；
- **终端上下文胶囊（`TerminalContextInlineChip`）**：
  - 借鉴 T3 Code `TerminalContextInlineChip.tsx` 与 `terminalContext.ts`：用户在终端中框选报错堆栈或点击“发送最近 50 行报错到对话”，一键生成紧凑胶囊附着于输入框（展示 `Terminal #1 · lines 118-164 · exit 1`），支持悬停预览与单点移除；
  - 发送消息时将所附终端选区以结构化可移植上下文块（含 CWD、行号范围与剥离 ANSI 控制符后的干净文本）送入当前任意 Harness，实现无缝排错；
- **后台开发进程与运行状态监控**：
  - 识别托管终端中的常驻开发服务（如 `vite` / `next dev` / `pytest --watch`），在顶栏显示运行状态指示灯与一键重启/终止按钮，并在应用退出或 Worktree 删除前精准回收整棵进程树。

### 明确不负责
- 不负责替 AI Harness 执行工具调用命令（AI 触发的命令由各自 Harness 或审批中心管理，不混入用户交互终端）；
- 不持久化海量终端原始字节流到 SQLite（应用重启后仅恢复 Tab 布局与工作目录元数据，不回放旧终端内存输出）；
- 不绕过工作区路径校验允许插件访问未授权系统目录。

---

## 2. 依赖关系、SDK 接口与对外能力

- **依赖关系**（DAG Layer 1）：仅依赖 Core Runtime（`ProcessSupervisor`、`CommandOutputHub`、工作区路径校验），**零跨插件依赖**。
- **调用的 SDK 接口**：
  - V4 既有：`ctx.events.on('session.switched' | 'worktree.changed')`、`ctx.storage.workspace`、`ctx.logger`；
  - V5 增量：受控 PTY/CLI 托管句柄（经宿主 `ProcessSupervisor` 进程组登记，支持跨平台优雅终止）、向 Composer 附加结构化上下文胶囊的 UI 桥接 API。
- **对外暴露能力**：
  - UI 插槽：`inspector_tab`（底部/侧栏 PTY 终端抽屉）、`composer_action`（待发送的 `TerminalContextInlineChip` 栏）；
  - 可选内部工具动作：`terminal.attachSelectionToComposer(terminalId, lineRange)`。

---

## 3. 事件协议与数据模型

- **订阅事件**：`worktree.changed`（当某 Worktree 即将删除时提前检测并释放驻留该 CWD 的终端）、`app.before_quit`（强制清理全部托管 PTY 进程树）。
- **发布事件**：`terminal.opened`、`terminal.exited`、`terminal.context_attached`。
- **核心数据模型**：
```ts
export interface ManagedTerminalTab {
  terminalId: string;
  workspaceId: string;
  cwd: string;
  title: string;
  shell: string;
  pid: number;
  status: 'running' | 'exited';
  exitCode?: number;
  ringBufferBytes: number;
  createdAt: number;
}

export interface TerminalContextChip {
  id: string;
  terminalId: string;
  terminalTitle: string;
  cwd: string;
  lineStart: number;
  lineEnd: number;
  cleanText: string;            // 已剥离 ANSI 转义序列且限制 ≤ 16KB
  truncated: boolean;
}
```
- **持久化方式**：仅将 Tab 名称/历史快捷命令/抽屉高度存入 `ctx.storage.workspace`；实时输出只留内存环形缓冲区，零写入 SQLite。

---

## 4. UI 扩展、权限需求与生命周期

- **UI 扩展点与交互形式**：
  - `inspector_tab`（支持停靠底部面板或右侧抽屉）：多 Tab `xterm.js` 终端视图，选中文本时浮现紧凑浮动条 **`[附加到对话 (Ctrl+Shift+L)]`** 与 **`[复制]`**；
  - `composer_action`：展示已附加的 `TerminalContextInlineChip` 胶囊列表（点击弹出完整纯文本预览，支持多个选区并行附加）；
  - 顶栏/底栏状态徽标：显示运行中托管终端数（如 `2 Terminals`）。
- **权限需求**：可选工作区高权限 `process:pty:workspace`（仅允许在已授权工作区 CWD 下启动用户默认 Shell，且显式提示用户授权）。
- **生命周期**：
  - **安装/启用**：检测原生 PTY 后端可用性（若环境缺失 `node-pty` 原生二进制则自动降级为基于 `terminal-service.ts` 的受限管道命令行执行器并给出友好提示）；
  - **更新**：支持热更新前端终端样式与快捷键，不杀掉正在运行的本地开发服务器 PTY；
  - **禁用/卸载**：先向用户确认终止当前活跃托管 PTY，经 `killProcessTree` 彻底回收全部子进程（含 Windows 进程树），再卸载面板。

---

## 5. 异常处理、恢复与降级机制

1. **原生 `node-pty` 编译/加载失败降级**：自动无感回落至现有 `packages/daemon/src/core/terminal-service.ts` 的一次性命令执行器（`powershell.exe` / `/bin/sh`），保障基础排错与上下文附加依然可用；
2. **输出风暴背压保护**：当终端每秒输出超过阈值（如 > 2MB/s）时自动合并渲染帧（16ms 批刷）并在达到环形缓冲区上限时丢弃最老行，杜绝 WebSocket 阻塞主对话流与审批响应；
3. **ANSI 噪声与超大选区清洗**：生成 `TerminalContextChip` 时自动剥离全部 ANSI 颜色/光标转义码并做 16KB 截断保护，避免几十万行刷屏日志直接撑爆目标 Harness 上下文窗口；
4. **Windows Worktree 句柄占用释放**：收到 `git-checkpoints` 准备删除 Worktree 的通知前主动提示一键关闭占用该目录的终端，消除 Windows `EBUSY` 报错。

---

## 6. 测试方案与可验证验收标准

- **单元测试**：
  - `stripAnsiAndClip()` 对复杂彩色终端堆栈（Vitest/TypeScript/Cargo 报错）的清洗、行号计算与 16KB 截断边界测试；
  - 环形缓冲区溢出驱逐与背压合帧逻辑测试。
- **集成测试（跨平台 Windows PowerShell + POSIX Shell）**：
  - 启动交互 PTY → 执行 `echo` 与长驻子进程 → 触发退出/卸载 → 验证 OS 进程表中零残留子进程；
  - 模拟高频输出风暴（10MB 连续输出）同时在主聊天区发送消息并响应审批，验证主对话延迟无退化。
- **端到端测试**：
  - 在终端运行失败的单测 → 框选报错栈点“附加到对话” → 生成 `TerminalContextInlineChip` → 发送给 Claude / Codex 修复，验证模型准确收到干净报错堆栈。
- **可验证验收标准**：
  1. 跨平台（Windows ConPTY 与 macOS/Linux）终端进程树回收测试残留进程数为 **0**；
  2. 10MB 刷屏压力下，主程序 SQLite 数据库体积增量严格为 **0 字节**，聊天区审批响应 < 100ms；
  3. 从终端框选报错到生成 `TerminalContextInlineChip` 并送入任意 Harness，端到端操作 ≤ 2 次点击或 1 个快捷键。
