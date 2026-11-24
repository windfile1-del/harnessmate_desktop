# 插件开发任务说明书 07 · Structured Task State Ledger

| 属性 | 说明 |
| --- | --- |
| **插件名称 & Plugin ID** | Structured Task State Ledger · `hm.plugin.task-ledger` |
| **功能定位** | 维护独立于任何单一 Harness 对话流的结构化任务事实账本（目标、约束/钉选铁律、架构决策、步骤进度、修改文件、验证结果、**已尝试但失败的方案**），同步镜像至工作区 `.harnessmate/task-ledger.md`，为跨引擎交接与超长项目防漂移提供“单一真相源” |
| **参考来源 (T3 Code)** | T3 Code **无此内置结构化账本**（`[T3 Code 源码受限/未完善]`：仅依赖事件流 + `plan` Item + LLM 摘要）；本模块属于 **`[HarnessMate 原创设计]`** 对现有优势能力的工程化强化 |
| **HarnessMate 当前状态** | **已实现基础版**：现有 `core.task-ledger` 清单、`packages/daemon/src/core/task-ledger-service.ts`、`packages/daemon/src/plugin-host/builtin/services.ts`（`ledger` 公共服务）已实现目标/步骤/修改文件/钉选规则/验证结果及 `.harnessmate/task-ledger.md` 同步；**缺口**：缺 `failedAttempts`（失败方案与根因，防切换引擎后反复踩坑）、缺架构决策表（`decisions`）与人工编辑冲突合并策略、缺手动钉选/勾选交互面板、缺与 Git 检查点/测试结果的自动关联 |
| **插件类型** | Built-in Plugin（默认启用第一方核心业务插件，提供公共服务 `ledger`） |
| **开发难度与风险** | **中**（风险点：低质量自动抽取污染账本信噪比；用户手动编辑 `.harnessmate/task-ledger.md` 与自动更新并发写冲突；账本无限增长挤占交接预算） |
| **开发优先级** | **P0**（Phase 1B，与 `context-handoff` 配套交付） |

---

## 1. 职责范围

### 明确负责
- 为每个逻辑会话维护结构化 `TaskLedgerV2` 文档，包含 7 个强类型区块：
  1. `goal`（任务终极目标与边界）；
  2. `pinnedConstraints`（用户明确钉选的不可违背约束，最高保留优先级）；
  3. `decisions`（已敲定的关键架构/技术决策与取舍理由）；
  4. `steps`（结构化执行清单：`pending | in_progress | done | blocked`）；
  5. `failedAttempts`（**新增**：已尝试但失败的方案、对应错误特征与为何放弃，防止切引擎后新模型重蹈覆辙）；
  6. `touchedFiles`（涉及的关键文件与简要修改说明）；
  7. `verifications`（最近构建/测试/检查命令与退出码/摘要）；
- 在每轮终态（`turn.completed` / `turn.failed`）运行**确定性零成本摄取器**（从归一化 `TurnBlock` 中的 `plan`、`file_change`、`command_execution` 退出码提取变更），并暴露 MCP 工具 `hm_ledger_update` 允许 AI 显式记录架构决策与失败尝试；
- 双向安全镜像至 `<workspace>/.harnessmate/task-ledger.md`（采用乐观版本/mtime 与区块保留策略，绝不粗暴覆盖用户在外部编辑器手动修改的约束段落）；
- 执行账本容量治理（对超限的已完成步骤与过旧验证记录自动折叠归档，保证 `pinnedConstraints` 与 `failedAttempts` 优先保留）。

### 明确不负责
- 不负责组装完整跨引擎交接包或与特定 Harness 通信（由 `hm.plugin.context-handoff` 读取本服务）；
- 不直接修改业务代码或执行 Git 提交；
- 不以额外 LLM 调用阻塞每轮对话结束（自动摄取必须 100% 确定性本地计算；可选智能提炼仅由外部主动触发）。

---

## 2. 依赖关系、SDK 接口与对外能力

- **依赖关系**（DAG Layer 2）：
  - 强依赖：Core Runtime；
  - 可选依赖：`hm.plugin.git-checkpoints`（`optional: ['git']`，用于校验 `touchedFiles` 与真实 `git status` 一致性，清理已被回滚的幽灵文件记录）。
- **调用的 SDK 接口**：
  - V4 既有：`ctx.fs.read/write/stat`（仅限工作区 `.harnessmate/` 路径）、`ctx.tools.register`、`ctx.storage.workspace`、`ctx.logger`；
  - V5 增量：`ctx.sessions.listItems()`、`ctx.events.on('turn.completed' | 'turn.failed' | 'checkpoint.reverted')`。
- **对外暴露能力（`provides: ['ledger']`）**：
  - `ledger.get(sessionId)`：返回结构化 `TaskLedgerV2` 及渲染后的紧凑 Markdown；
  - `ledger.patch(sessionId, patch)`：支持用户 UI 或插件按字段合并更新（带乐观版本号 `revision`）；
  - `ledger.pinConstraint(sessionId, text)` / `ledger.unpinConstraint(sessionId, id)`；
  - `ledger.recordFailedAttempt(sessionId, attempt)`（SDK V5 规范新增）；
  - `ledger.appendVerification(sessionId, record)`；
  - MCP 模型工具：`hm_ledger_read`（`readOnly: true`）、`hm_ledger_record`（记录决策、失败方案或更新步骤状态）。

---

## 3. 事件协议与数据模型

- **订阅事件**：`turn.completed`、`turn.failed`、`checkpoint.reverted`（检查点回滚时自动标注受影响的 `touchedFiles` 与失效的 `verifications`）、`session.created`。
- **发布事件**：`ledger.updated`（携带 `{ sessionId, revision, changedSections }`）。
- **核心数据模型（向后兼容现有 `TaskLedger` 字段并增量扩展）**：
```ts
export interface FailedAttemptRecord {
  id: string;
  summary: string;          // 尝试了什么方案（≤ 200 chars）
  failureReason: string;    // 报错特征或为什么不可行（≤ 300 chars）
  relatedFiles?: string[];
  harnessInstanceId: string;
  recordedAt: number;
}

export interface ArchitectureDecisionRecord {
  id: string;
  title: string;
  rationale: string;
  pinned: boolean;
  recordedAt: number;
}

export interface TaskLedgerV2 {
  sessionId: string;
  revision: number;
  goal: string;
  pinnedConstraints: Array<{ id: string; text: string; source: 'user' | 'agent' }>;
  decisions: ArchitectureDecisionRecord[];
  steps: Array<{ id: string; title: string; status: 'pending' | 'in_progress' | 'done' | 'blocked'; ownerHarness?: string }>;
  failedAttempts: FailedAttemptRecord[];
  touchedFiles: Array<{ path: string; note?: string; lastTurnSeq: number }>;
  verifications: Array<{ command: string; exitCode: number; summary: string; at: number }>;
  updatedAt: number;
}
```
- **持久化方式**：结构化主数据持久化于 Core SQLite 既有任务账本表（增量迁移追加 `decisions_json`、`failed_attempts_json`、`revision` 字段），并异步防抖（500ms）单向/冲突感知镜像到 `<workspace>/.harnessmate/task-ledger.md`。

---

## 4. UI 扩展、权限需求与生命周期

- **UI 扩展点与交互形式**：
  - `inspector_tab`（key: `task-ledger`）：可视化任务账本编辑器——支持增删钉选约束、勾选/重排步骤、查看“已踩坑/失败方案”红色警告卡片、查看最近测试结果、一键复制或导出 Markdown；
  - `chat.block` 快捷动作：在任意助手消息或工具报错卡片右键菜单提供 **“钉选为约束”** 与 **“记为失败尝试”** 一键操作。
- **权限需求**：内置受信任插件；声明 `session:read`、`fs:workspace:write`（作用域限定 `.harnessmate/task-ledger.md`）、`tools:model`。
- **生命周期**：
  - **安装/启用**：沿用并升级现有 `core.task-ledger` 数据，自动对旧版账本 JSON 做无损字段补齐（空数组初始化 `decisions` / `failedAttempts`）；
  - **更新**：支持热更新提取规则与 UI 模板，零丢失历史账本；
  - **禁用**：停止自动摄取与 Markdown 写入，保留历史数据与磁盘文件不删除；`context-handoff` 检测到 `ledger` 不可用时降级为纯对话摘要交接。

---

## 5. 异常处理、恢复与降级机制

1. **外部编辑冲突防护**：写 `.harnessmate/task-ledger.md` 前校验上次写入 SHA-256；若检测到用户手工修改了文件，则先解析文件中的 `## Pinned Constraints` 与 `## Goal` 合并回 SQLite，再回写合并结果并弹出温和通知，绝不静默覆盖人工内容；
2. **只读工作区或无写权限**：写 `.harnessmate/task-ledger.md` 失败（`EACCES` / `EROFS`）时仅保留 SQLite 主存储并降级为内存/数据库模式，绝不阻断轮次运行；
3. **自动摄取噪声过滤**：跳过退出码 0 的只读探查命令（如 `ls` / `git status`），仅将测试/构建类命令写入 `verifications`，且按相同命令去重保留最近 5 条；
4. **并发乐观锁**：`ledger.patch` 携带 `expectedRevision`，冲突时返回 `E_CONFLICT` 并提供最新快照供 UI 自动重算。

---

## 6. 测试方案与可验证验收标准

- **单元测试**：
  - 旧版 v0.6.0 `TaskLedger` 向 `TaskLedgerV2` 无损升级测试；
  - `command_execution` 失败自动提炼验证记录、`checkpoint.reverted` 自动清理失效验证状态；
  - Markdown 双向镜像与人工修改 `Pinned Constraints` 冲突合并测试；
  - 超长账本容量裁剪（验证 `pinnedConstraints` 与最近 `failedAttempts` 永不被裁掉）。
- **集成测试**：
  - Codex 执行方案 A 报错 → 记录 `failedAttempt` → 切换 Claude Code → 验证 `context-handoff` 编译包内完整包含该失败方案，且 Claude 可调用 `hm_ledger_read` 核验。
- **可验证验收标准**：
  1. 兼容既有 `core.task-ledger` 全部 28 个守护进程回归测试中的账本用例，零数据迁移丢失；
  2. 人工编辑 `.harnessmate/task-ledger.md` 约束段落后触发新轮次，人工新增条款 100% 保留；
  3. 确定性每轮摄取耗时 < 20ms，账本渲染长度始终受控于预算上限内。
