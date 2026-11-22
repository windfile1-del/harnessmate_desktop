# HarnessMate Desktop

**Modular Multi-Harness Atelier & Mobile Remote Hub** — 统一管理本机 `Codex CLI`、`Antigravity CLI (agy)`、`Claude Code CLI` 及任意 ACP 兼容 CLI 的桌面控制台，支持单一共享会话内的跨引擎无损上下文接力，并为移动端 HarnessMate 提供 `HM-Remote v1` 远程会话管理与跨端审批底座。

## 核心特性

- **统一共享会话 & 跨引擎无损接力**：不按 Harness 割裂会话；基于 `session_harness_bindings` 增量水位线与四层上下文编译器，优先调用 `codex thread/inject_items`、`agy embeddedContext`、`claude stream-json` 原生通道实现往返零失忆接力。
- **结构化任务状态账本**：自动沉淀任务目标、步骤清单、修改文件、验证结果与钉选铁律，并同步落盘 `.harnessmate/task-ledger.md`。
- **模块化插件微内核**：内置引擎插件、图片/文件上下文、跨 CLI MCP 统一管理中心、多账号配额看板、Git Diff/Worktree 检视、限额一键 Failover 等模块，支持目录安装与自定义扩展。
- **Star Loom Atelier 界面 & `HM-Remote v1`**：夜织深空 / 暖宣浅色双主题、扫码配对移动端、局域网/Tailscale 远程控制与原子跨端审批。

## 架构概览

- `packages/protocol`: 统一规范事件模型（`CanonicalEvent`）、任务账本/上下文预览契约与 `HM-Remote v1` REST/WebSocket 协议定义。
- `packages/daemon`: 独立 Node.js 24 守护服务（`node:sqlite` WAL 事件日志 + 三大 CLI 结构化双向适配器 + ContextCompiler + TaskLedgerService + `HM-Remote v1` 网关）。
- `packages/web`: React 19 + Tailwind v4 **Star Loom Atelier** 统一对话前端。
- `packages/electron`: 轻量桌面壳（自动托管本地 Daemon、关闭隐藏到系统托盘保活、系统审批通知与原生目录选择器）。

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
# 输出位于 packages/electron/release/HarnessMate-Desktop-0.3.0-portable.exe
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
