# 01 · 审计基线

核验日期 2026-11-25，Asia/Shanghai。工作区 `D:\HarnessMate\harnessmate_desktop`，分支 `main`，读出的 `HEAD`、本地 `origin/main` 与 `git ls-remote origin refs/heads/main` 均为 `0409bc8a4ea85d05ef6b0ee85fc2d0b980f06039`。启动时 `git status --porcelain=v1 -b` 显示干净且无领先或落后。当前专项写入为本目录的新文件。三个既有 Phase 1 Worktree `hm-wt-1a-adapters`、`hm-wt-1b-handoff`、`hm-wt-1c-sdk-v5` 保持原有分支和用途。参考远端可复核快照。[HarnessMate 固定提交](https://github.com/windfile1-del/harnessmate_desktop/tree/0409bc8a4ea85d05ef6b0ee85fc2d0b980f06039)

| 版本 | 内容 |
| --- | --- |
| `088f27e` → `dffcf37` | AGY-0 审计和设计 → AGY-1 Driver/LaunchContext/Profile 隔离 |
| `d3b3f87` → `3da6545` | AGY-2 OAuth/Usage/手动账户 → AGY-3 作用域、动态配置和命令 |
| `b000222` → `52251be` | AGY-4 事件、Steering、子任务读取和静默失败 → AGY-5 Composer、Artifact、生态组件 |
| `0409bc8` | AGY-6 1.5.14 回放、Windows 隔离探针与验收报告 |
| `5ebb275c2bb054ca44ae1731942a0eed24a73c96` | 另行读取的 T3 Code 主线快照。与 HarnessMate 的基线独立 |

历史资料从 [AGY-0 至 AGY-6 文档入口](../phase-agy/00_INDEX.md)、[前置源审与实测](../phase-agy/01_Source_Audit_and_Protocol_Verification.md)、[阶段验收](../phase-agy/06_Acceptance_Report.md)、[公共插件 API](../plugin-api/plugin-api.api.md)、[插件插槽](../plugin-api/slots.md) 和 [旧 T3 体系研究](../research/t3code/08_Plugin_Catalog.md) 往源码复核。前置文档的功能承诺和历史脚本输出均按当时版本理解。

## 本机依赖

| 项 | 实际值 |
| --- | --- |
| 系统 | Windows 10 Home x64，10.0.19045，PowerShell 7.6.9 |
| 官方 AGY | `agy.exe 1.5.16`，Windows Authenticode `Valid`，签名者 Google LLC |
| App / IDE 安装 | Windows 卸载注册表报告 Antigravity App `2.35.1`、Antigravity IDE `2.5.5`。未打开 GUI 或执行对照 |
| Node / pnpm / Git | `24.18.0` / `11.21.0` / `2.54.0.windows.1`。根包要求 Node ≥22.13.0 |
| 应用 / Electron | HarnessMate Desktop `0.6.0`，Electron `35.7.5`，electron-builder `26.18.0` |
| 服务和存储 | Fastify `5.12.8`，ws `8.23.0`，Node 内置 `node:sqlite`，Zod `3.25.76` |
| Web / 工具链 | React `19.3.1`，Zustand `5.1.0`，Vite `6.4.6`，TS `5.9.3`，Vitest `3.2.7` |
| Plugin | V5 扩展插槽及能力已存在。`PLUGIN_API_VERSION` 常量为 `4.0.0`，沿用当前公开契约与实际宿主协商 |

依赖值来自 [lockfile](../../pnpm-lock.yaml) 与 [仓库脚本](../../package.json)。Windows 暂存、构建工具的 TEMP/TMP/TMPDIR 和调研快照放在 `D:\HarnessMate\np00-research`。生产仓库的依赖分析以锁文件为准，本轮使用已安装的工作区依赖。

## 本轮重新执行

| 命令 | 结果 |
| --- | --- |
| `pnpm test` | 退出 0。包含 `contracts:check`，Protocol 1 文件 1 测试，Web 11 文件 50 测试，Daemon 30 文件 134 测试，合计 185。Electron 入口允许空测试集 |
| `pnpm typecheck` | 退出 0，6 个 workspace 包完成 |
| `pnpm build` | 退出 0，6 个 workspace 包完成。Vite 构建 2127 模块 |
| 调研脚本 `node --check` | `probe-acp.mjs` 和 `probe-current-routing.mjs` 退出 0 |
| `probe-acp.mjs --catalog` 与 `--protocol 2` | Windows AGY 1.5.16 真实 stdio，初始化成功，v1 会话要求登录，v2 请求返回 v1，详见 [证据](06_Protocol_Evidence.md) |
| `node .../evidence/probe-current-routing.mjs` | 退出 0。当前基线的适配器连接合成对端，重现晚消息占位轮次、审批取消及并行任务保活覆写 |
| 旧回放 | `agy-replay-protocol.test.ts` 2 个测试随 pnpm test 通过。原 fixture 未修改 |

AGY-6 的双空白 Profile 结果是历史离线凭据隔离证据。本轮使用新空白隔离目录做无模型探活，未复用官方默认账户。真实 OAuth、模型调用、Windows 官方面板逐项对照、Electron 打包和部署均不计入上述结果。
