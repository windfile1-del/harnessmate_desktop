# 插件开发任务说明书 08 · Git Checkpoints, Diff & Worktree

| 属性 | 说明 |
| --- | --- |
| **插件名称 & Plugin ID** | Git Checkpoints, Diff & Worktree · `hm.plugin.git-checkpoints` |
| **功能定位** | 为单会话与多引擎协作提供安全的文件状态底座：每轮自动捕获**隐藏 Git Ref 检查点**（零污染用户提交历史）、强制“对话先回滚、文件后还原”的原子撤回机制、彩色 Unified Diff 检视、一键 Commit/Push/PR 与隔离 Git Worktree 全生命周期管理 |
| **参考来源 (T3 Code)** | `t3code/apps/server/src/checkpointing/CheckpointStore.ts`、`CheckpointReactor.ts`、`git/GitCore.ts`、`git/GitManager.ts`、`orchestration-v2/Adapters/CodexAdapterV2.ts`（回滚先撤对话守卫）、`apps/web/src/components/DiffPanel.tsx`（`[T3 Code 已验证实现]`） |
| **HarnessMate 当前状态** | **部分实现**：已有 `core.git-inspector` 清单与 `packages/daemon/src/core/git-service.ts`（131 行，仅含 `inspectGitRepo`、`getGitStatusSummary`、`createGitWorktree`）；**缺口**：无每轮自动快照与回滚机制、无隐藏 Git Ref 捕获、无对话/文件联动回滚原子守卫、无 Worktree 列表/回收/`.harnessmate/setup` 初始化脚本、无 `git merge-tree` 冲突预检、无一键 Commit/PR |
| **插件类型** | Built-in Plugin（默认启用第一方核心基础设施插件，提供公共服务 `git` 与 `checkpoints`） |
| **开发难度与风险** | **高**（风险点：检查点捕获阻塞大仓库或吸入未忽略的 `node_modules`/大二进制；不当 `git reset`/`checkout` 破坏用户未提交工作；回滚失败造成对话历史与磁盘状态分裂；Windows 文件锁导致 Worktree 清理失败） |
| **开发优先级** | **P1**（Phase 2，保障多引擎修改代码的可逆性与安全性） |

---

## 1. 职责范围

### 明确负责
- **隐藏 Git Ref 检查点（借鉴 T3 Code `CheckpointStore`）**：
  - 使用独立临时 `GIT_INDEX_FILE` 在每轮开始前（`turn_pre`）与结束后（`turn_post`）调用 `git write-tree` + `git commit-tree` + `git update-ref refs/harnessmate/checkpoints/<sessionId>/turn-<seq>` 捕获工作区快照，**绝不触碰用户 `HEAD`、暂存区（`.git/index`）或 `git log`**；
  - 捕获前自动过滤超大未追踪文件（默认单文件 > 10MB 或新增未追踪总大小 > 100MB 跳过并记警告，遵循 `.gitignore`）；
  - 支持任意两个检查点之间以及检查点与当前工作区之间的精准 `git diff` 计算。
- **原子级“对话先回滚、文件后还原”守卫**：
  - 回滚到历史某轮时，按严格顺序执行：
    1. 校验目标 Harness 能力：若支持原生回滚（`supportsNativeRollback: true`），先通知 `SessionKernel` 撤销原生对话轮次；若不支持原生回滚，明确告知用户将创建“回滚后全新原生分支/会话”或仅恢复文件（**绝不静默伪造对话回滚**）；
    2. 还原文件前先为当前脏工作区捕获一条 `pre_revert` 保护性检查点（支持反悔撤销回滚！）；
    3. 按目标检查点树精准还原受变更文件并清理该轮次之后新建的未追踪文件；
    4. 发布 `checkpoint.reverted` 事件通知 `task-ledger` 与前端刷新状态。
- **Git Diff 检视与交付工作流**：
  - 演进 `git-service.ts` 提供按文件延迟加载 Diff（避免 120KB 一刀切截断导致丢失文件）、Staged/Unstaged 切换、单文件放弃变更；
  - 提供交互式 Commit（可选自动生成提交信息）、Push、Pull 与调用 `gh` CLI 创建 PR（均需用户显式点击确认）。
- **Git Worktree 全生命周期管理**：
  - 演进 `createGitWorktree`：支持从指定基础分支创建、列举托管 Worktree、安全删除并 `git worktree prune`、检测并经用户确认后执行 `.harnessmate/setup` 初始化脚本（如软链 `.env` 或安装依赖）；
  - 提供无副作用合并预检 `dryRunMerge(baseBranch, headBranch)`（调用 `git merge-tree --write-tree`，供 `multi-harness-orchestrator` 与用户提前识别冲突文件）。

### 明确不负责
- 不替 AI 自动执行 `git push --force` 或自动合并分支；
- 不修改核心会话事件流表（检查点索引通过 Core `SessionKernel` 的 `session_checkpoints` 表托管）；
- 不干涉用户日常终端里的常规 `git` 操作，绝不锁定主 `.git/index` 文件。

---

## 2. 依赖关系、SDK 接口与对外能力

- **依赖关系**（DAG Layer 1）：仅依赖 Core Runtime，**零跨插件依赖**。
- **调用的 SDK 接口**：
  - V4 既有：`ctx.logger`、`ctx.storage.workspace`、`ctx.events`；
  - V5 增量：`ctx.runtime.spawnCli`（受控调用 `git` 与可选 `gh`）、Core `session_checkpoints` 持久化接口、`ctx.sessions.postNotice()`。
- **对外暴露能力（`provides: ['git', 'checkpoints']`）**：
  - `git.status(cwd)` / `git.diff(cwd, opts)` / `git.fileDiff(cwd, filePath, staged)`；
  - `git.listWorktrees(repoRoot)` / `git.createWorktree(opts)` / `git.removeWorktree(worktreePath, opts)` / `git.dryRunMerge(repoRoot, base, head)`；
  - `checkpoints.capture(sessionId, turnSeq, phase)` / `checkpoints.list(sessionId)` / `checkpoints.diff(sessionId, fromSeq, toSeq)` / `checkpoints.revert(sessionId, targetTurnSeq, mode)`；
  - `git.workspaceTruthDigest(cwd)`：为 `context-handoff` 提供轻量只读真值摘要（分支、HEAD SHA、脏文件列表、diffstat，耗时 < 80ms）。

---

## 3. 事件协议与数据模型

- **订阅事件**：`turn.started`（自动捕获 `turn_pre` 检查点）、`turn.completed` / `turn.failed`（若工作区存在变更则捕获 `turn_post` 检查点）、`session.archived`（按保留策略清理过旧隐藏 Ref）。
- **发布事件**：`checkpoint.captured`、`checkpoint.reverted`、`worktree.changed`、`git.status_changed`。
- **核心数据模型（索引存 Core SQLite `session_checkpoints`，树对象存本地 `.git/refs/harnessmate/checkpoints/*`）**：
```ts
export interface SessionCheckpointRecord {
  id: string;
  sessionId: string;
  turnSeq: number;
  phase: 'turn_pre' | 'turn_post' | 'pre_revert' | 'manual';
  gitRef: string;               // refs/harnessmate/checkpoints/<sessionId>/<id>
  treeSha: string;
  baseHeadSha: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  skippedLargeFiles: string[];
  createdAt: number;
}
```

---

## 4. UI 扩展、权限需求与生命周期

- **UI 扩展点与交互形式**：
  - `inspector.diff`（SDK V5 新增插槽）：右侧/分屏 **Unified & Split Diff 检视面板**，支持文件树过滤、按单轮检查点对比（`Turn #5 vs Turn #4`）、单文件还原与顶部 Commit/Push/PR 操作栏；
  - `chat.block` 轮次尾栏：每个修改过文件的 AI 轮次底部展示紧凑徽章（`+142 -28 · 4 files`）与 **“查看 Diff” / “回滚到此轮前”** 按钮（点击回滚弹出二次确认，明确说明对话是否可原生回滚及已自动保存 `pre_revert` 备份）；
  - `sidebar_tool` / `modal`：**Worktree 管理器**，展示所有并行隔离工作树、关联会话、脏状态与一键清理按钮。
- **权限需求**：内置受信任核心插件；按工作区粒度细分为 `workspace:git:read`（状态、Diff、真值摘要）与 `workspace:git:write`（检查点写 Ref、文件还原、Worktree 增删、Commit/Push）。
- **生命周期**：
  - **安装/启用**：接管原 `core.git-inspector`；检测本机 `git --version`（需 ≥ 2.38 以支持 `git merge-tree --write-tree`，低版本自动降级冲突预检）；
  - **更新**：热更新 UI 与脚本模板，保留既有隐藏 Refs 与数据库记录；
  - **禁用/卸载**：停止自动捕获新检查点，**绝不自动删除**用户已有 Worktree 或已有隐藏 Ref（提供手动清理命令 `gcCheckpoints` 供用户回收空间）。

---

## 5. 异常处理、恢复与降级机制

1. **非 Git 仓库工作区**：自动探测 `isGitRepo === false`，禁用检查点与 Worktree 按钮并在面板给出“一键 `git init`”可选提示，不报错刷屏；
2. **大仓捕获超时 / 超大未追踪文件**：单次检查点捕获设 4s 超时与大文件过滤阈值；若超时则跳过本次快照并写入 `diagnostic`，绝不阻塞 AI 轮次启动或结束；
3. **检查点对象被外部 `git gc` 清理**：回滚前先执行 `git cat-file -t <treeSha>` 校验对象存活；若已丢失则立即中止并返回 `E_CHECKPOINT_MISSING`，避免半截破坏工作区；
4. **Windows Worktree 目录占用**：删除 Worktree 遇 `EBUSY`/`EPERM` 时，检查是否仍有终端或 Harness 进程驻留该 CWD 并明确提示需先关闭对应会话，绝不强行 `rm -rf` 损坏 `.git/worktrees` 元数据；
5. **`.harnessmate/setup` 信任边界**：首次在某仓库发现 `.harnessmate/setup` 脚本时强制展示脚本全文并要求用户显式信任（按仓库路径+内容哈希记忆），防止恶意开源仓库通过 clone 触发 RCE。

---

## 6. 测试方案与可验证验收标准

- **单元测试**：
  - 隐藏 Ref 捕获不改变主 `.git/index` 与 `HEAD`（构造已暂存 + 未暂存 + 未追踪混合场景验证）；
  - 超大未追踪文件跳过策略与 `dryRunMerge` 冲突列表解析；
  - 回滚前自动创建 `pre_revert` 备份点与二次反悔恢复验证。
- **集成测试（真实临时 Git 仓库）**：
  - 模拟 3 轮文件修改 → 回滚到第 1 轮前：验证支持原生回滚的驱动先撤对话再还文件；不支持原生回滚的驱动绝不静默丢弃状态而是明确提示并切换新原生分支；
  - 创建并行 Worktree → 修改文件 → `dryRunMerge` 检出冲突与无冲突两种场景 → 安全删除与 `git worktree prune`。
- **可验证验收标准**：
  1. 连续 20 轮捕获隐藏检查点后，执行 `git log --all --oneline` 与 `git status` 显示**零污染**用户正常提交历史与暂存区；
  2. 回滚任意轮次后，点击“撤销回滚”可 100% 恢复至回滚前逐字节一致的工作区；
  3. 5,000 文件中型仓库中单次增量检查点捕获 P95 耗时 < 400ms，`workspaceTruthDigest` < 80ms；
  4. 未经用户签名信任的 `.harnessmate/setup` 脚本执行率为 **0**。
