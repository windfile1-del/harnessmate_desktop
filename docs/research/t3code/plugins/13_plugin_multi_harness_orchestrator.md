# 插件开发任务说明书 13 · Multi-Harness Parallel Orchestrator

| 属性 | 说明 |
| --- | --- |
| **插件名称 & Plugin ID** | Multi-Harness Parallel Orchestrator · `hm.plugin.multi-harness-orchestrator` |
| **功能定位** | 承接**场景 D（多 Harness 并行协作）**，与串行上下文交接（场景 A/B/C）在架构上严格分离：支持由用户或主控 Harness 通过 MCP 委托并行子任务（如“Codex 写后端 + Claude 写测试 + Antigravity 审查架构”），为每个可写子任务强制分配隔离 Git Worktree、实施权限不提权天花板、队列化自动唤醒父会话与无副作用冲突预检合并 |
| **参考来源 (T3 Code)** | `t3code/apps/server/src/mcp/toolkits/orchestrator/tools.ts`（`delegate_task` / `list_subagents` / `get_subagent_result` / `send_to_subagent` / `stop_subagent`、`isolation: "worktree"`）、`mcp/toolkits/worktree/tools.ts`、`apps/server/src/workflows/WorkflowEngine.ts`（父会话完成批次唤醒 Cohort Wakeup 与权限封顶）、`apps/web/src/components/chat/ChildThreadApprovals.tsx`（`[T3 Code 已验证实现]`） |
| **HarnessMate 当前状态** | **完全缺失**：现有 v0.6.0 仅支持单会话串行切换与手工 `createGitWorktree`，无父子会话拓扑、无 MCP 并行子任务委托、无子任务批次完成自动唤醒、无并行执行看板与冲突预检回并工作流 |
| **插件类型** | Optional Plugin（官方高阶可选插件，面向复杂工程多引擎协同，需用户显式启用） |
| **开发难度与风险** | **极高**（风险点：无限递归派生子 Agent 引发 Token 爆炸与进程风暴；多子任务并发改写同一目录互相踩踏文件；子任务越权获取高于父会话的权限模式；子任务完成后无节制打断正在发言的父会话；Worktree 长期泄漏占用磁盘） |
| **开发优先级** | **P2**（Phase 3，严格置于 Core Kernel + Git Checkpoints + Handoff 稳定之后落地） |

---

## 1. 职责范围

### 明确负责
- **与串行交接清晰划界**：本插件只处理“**1 个主控父会话 → N 个独立子会话并行执行 → 结果汇总与分支合回**”（场景 D），绝不篡改单会话串行切引擎的 `context-handoff` 状态机；
- **MCP 多引擎编排工具集**（面向任意支持 MCP 的主控 Harness 开放）：
  - `hm_delegate_task`：按指定 `targetInstanceId`、任务目标、`mode: 'read_only' | 'worktree_write'` 与预算上限派生子会话；**所有可写子任务强制分配独立 Git Worktree**（共享原目录仅允许 `read_only` 审查/调研任务）；
  - `hm_list_subagents` / `hm_get_subagent_result` / `hm_send_to_subagent` / `hm_stop_subagent`：查询并行状态、拉取子任务最终结论与 diffstat、追加澄清或中止失控子任务；
- **硬性安全护栏（借鉴并强化 T3 Code `WorkflowEngine.ts`）**：
  1. **防递归爆炸**：默认最大嵌套深度 `maxDepth = 1`（子任务不可再派生孙任务，除非用户全局策略显式放开至 2）与单父会话最大并发子任务数 `maxConcurrent = 4`；
  2. **权限不提权天花板（No Privilege Escalation）**：子任务的 `approvalPolicy` 永远受限于 `min(parentPolicy, requestedPolicy)`，父会话是受控审批模式时，绝不允许派生全自动无审批子任务；
  3. **审批透传至全局审批中心**：子任务触发的高危命令/文件审批自动标记 `parentSessionId`，由 `hm.plugin.approval-center` 统一呈现并交由人类裁决；
- **批次完成唤醒（Completion Cohort Wakeup）**：
  - 同批次派生的多个子任务全部终结（或任一失败且策略为 fail-fast）时，自动汇总每个子任务的状态、摘要、变更文件列表、测试结果与分支名；若父会话正忙则排队等待当前轮次结束，再作为单条结构化回执安全唤醒父会话继续决策，避免 N 次零碎打断；
- **可视化并行看板与安全合回（Dry-Run Merge-Back）**：
  - 在并排看板展示主控与全部子任务实时进度、各自引擎徽标、Token 消耗与 Worktree 分支；
  - 合回前强制调用 `git.dryRunMerge(baseBranch, childBranch)` 展示冲突文件清单，仅在用户显式确认后执行合并并清理对应 Worktree。

### 明确不负责
- 不替代 `hm.plugin.git-checkpoints` 直接拼装底层 Git 命令（全部 Worktree 与冲突预检调用 `ctx.get('git')`）；
- 不擅自自动 `git merge` 或覆盖主分支未提交更改（最终合回必须人工确认）；
- 不直接维护底层进程池或绕过 Core `SessionKernel` 伪造会话状态。

---

## 2. 依赖关系、SDK 接口与对外能力

- **依赖关系**（DAG Layer 4，严格无环）：
  - 强依赖：Core Runtime、`hm.plugin.git-checkpoints`（`inject: ['git']`）；
  - 可选依赖：`hm.plugin.task-ledger`（`optional: ['ledger']`，用于将主控任务拆解的子步骤与负责人实例自动同步进任务账本）。
- **调用的 SDK 接口**：
  - V4 既有：`ctx.tools.register`、`ctx.get('git')`、`ctx.get('ledger')`、`ctx.storage.workspace`、`ctx.events.on`、`ctx.logger`；
  - V5 增量：`ctx.sessions.fork()` / 子会话创建接口（需显式权限 `session:orchestrate`）、`ctx.sessions.listItems()`、`ctx.sessions.postNotice()`、`ctx.harnesses.listInstances()`。
- **对外暴露能力**：
  - MCP 工具套件：`hm_delegate_task`、`hm_list_subagents`、`hm_get_subagent_result`、`hm_send_to_subagent`、`hm_stop_subagent`；
  - UI 插槽：`inspector_tab`（并行执行看板）与 `chat.block`（子任务批次状态卡片）。

---

## 3. 事件协议与数据模型

- **订阅事件**：`turn.completed`、`turn.failed`、`turn.interrupted`、`approval.requested`（聚合子任务阻塞计数）、`session.closing`（父会话关闭时按策略级联停止孤儿子任务）。
- **发布事件**：`subagent.spawned`、`subagent.updated`、`subagent.cohort_completed`、`subagent.merged`。
- **核心数据模型**：
```ts
export interface SubagentRunRecord {
  subagentId: string;
  cohortId: string;
  parentSessionId: string;
  childSessionId: string;
  targetInstanceId: string;
  roleTitle: string;              // 如 "Backend API (Codex)" / "Unit Tests (Claude)"
  isolation: 'read_only' | 'worktree_write';
  worktreePath?: string;
  branchName?: string;
  effectiveApprovalPolicy: string; // 受父会话上限封顶后的真实权限策略
  status: 'queued' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'stopped';
  diffStat?: { filesChanged: number; insertions: number; deletions: number };
  summary?: string;
  createdAt: number;
  finishedAt?: number;
}
```
- **持久化方式**：子会话本身为 Core `SessionKernel` 一等公民（借助 `sessions.parent_session_id` 外键关联）；编排批次元数据与合并状态存入 `ctx.storage.workspace`。

---

## 4. UI 扩展、权限需求与生命周期

- **UI 扩展点与交互形式**：
  - `inspector_tab`（key: `orchestrator-board`）：**Parallel Execution Board**——顶部展示父会话与并发池配额（`3 / 4 运行中`），下方以卡片网格展示每个子任务的引擎徽标、实时步骤状态、Worktree 分支名、阻塞审批直达按钮与一键终止按钮；
  - `chat.block`（key: `ext:orchestrator.cohort`）：父会话时间线中的批次协作摘要卡（显示全部子任务状态表格、diffstat 与 **[预检冲突并合回]** 按钮）；
  - `modal`：**Merge-Back 冲突审查弹窗**，展示 `git.dryRunMerge` 结果、按文件 Diff 预览及合并后自动清理 Worktree 复选框。
- **权限需求**：高风险编排权限 `session:orchestrate`（全局显式确认）、`workspace:git:write`（经 `git` 服务创建/清理隔离 Worktree）、`tools:model`。
- **生命周期**：
  - **安装/启用**：注册 MCP 工具套件与编排看板；恢复未终结的孤儿记录（检查关联子会话是否已因重启退出并收敛为 `stopped`）；
  - **更新**：保留历史协作记录与 Worktree 映射；
  - **禁用/卸载**：先向全部运行中子任务发送 `interrupt`，反注册 MCP 工具，保留未合回的 Worktree 分支并提示用户手动决定保留或清理（**绝不静默丢弃子任务已写代码**）。

---

## 5. 异常处理、恢复与降级机制

1. **防子任务风暴与超预算熔断**：同时拒绝超过 `maxConcurrent` 或深度 > `maxDepth` 的委托调用并返回清晰 MCP 错误引导模型等待；支持按单个子任务设置最大执行时间（默认 15 min），超时自动中断并保留 Worktree 现场供人工接管；
2. **父会话异常退出或用户手动取消**：立即级联中止该父会话名下全部 `running` 状态子任务，同时完整保留 Worktree 分支防止成果丢失；
3. **非 Git 工作区降级**：若当前工作区不是 Git 仓库，自动拒绝 `isolation: 'worktree_write'` 请求（返回明确提示 `"Write delegation requires a Git repository"`），仅允许 `read_only` 并行调研/代码审查任务，杜绝多引擎互相踩踏同一份源码；
4. **合并冲突处理**：`dryRunMerge` 检出冲突时绝不强行污染主工作区，列出冲突文件并支持将冲突详情交回主控 Harness 或在独立临时合并分支中由用户手工解决。

---

## 6. 测试方案与可验证验收标准

- **单元测试**：
  - 权限天花板裁决（验证父会话为 `ask` 时无论子任务如何请求均无法提权为 `full_auto`）；
  - 递归深度（`maxDepth = 1`）与最大并发（`maxConcurrent = 4`）硬拦截；
  - Cohort Wakeup 合并队列（验证 3 个子任务乱序完成且父会话忙碌时，最终仅在父会话空闲后触发 1 次聚合唤醒）。
- **集成测试（真实临时 Git 仓库 + Mock 驱动）**：
  - 父会话（Codex）并发委托两个可写子任务（Claude 写功能 A、DeepSeek 写测试 B）→ 验证各自落盘于独立 Worktree 且互不干扰 → 验证 `dryRunMerge` 精准识别无冲突与有冲突两种情况 → 验证人工确认合回后正确清理 Worktree。
- **可验证验收标准**：
  1. 非 Git 目录下发起 `worktree_write` 委托 100% 被拒绝且零修改源目录；
  2. 权限提权与超过最大深度委托测试拦截率为 **100%**；
  3. 模拟父会话崩溃重启后，所有遗留运行中子任务全部收敛至终态，已生成的 Worktree 分支 0 丢失；
  4. 并行开启 3 个不同引擎子任务并顺利合并回主分支，单会话串行 `context-handoff` 功能零受影响。
