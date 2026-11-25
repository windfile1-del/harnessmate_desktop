# 13 · Git Worktree 和多会话协作

## 审计和分支起点

下列命令是 G0 初始化记录，在现有专项 Worktree 上不需要重复运行。当前 `main` 与其他既存 Worktree 保持原状。用户批准启动开发后，先冻结新的远端 SHA 若与 [基线](01_Baseline.md) 不同，复核 diff 和影响。集成分支 `codex/agy-np-integration` 已建立，Worktree 根为 `D:\HarnessMate\agy-np-worktrees`。具体分支状态见 [MASTER_PROGRESS](MASTER_PROGRESS.md)。每个 package 的独立 branch 见 [任务索引](11_Parallel_Development_Plan.md)。任一 branch 可由 Codex 的 Worktree 创建入口或有权限的 shell 按计划执行，开始前确认没有已存在的同名 branch/路径。

下列 PowerShell 示例说明首次启动步骤。必须先让 NP-00 文档进入集成分支的 plan commit，后续 Worktree 才能直接读取全部提示词和共享文档。只复制新增专项文件，检查 staging 内容后提交。

~~~powershell
$repo = 'D:\HarnessMate\harnessmate_desktop'
$npRoot = 'D:\HarnessMate\agy-np-worktrees'
$npTemp = 'D:\HarnessMate\np00-research'
$env:TEMP = $npTemp
$env:TMP = $npTemp
$env:TMPDIR = $npTemp
$expected = '0409bc8a4ea85d05ef6b0ee85fc2d0b980f06039'

git -C $repo fetch origin refs/heads/main:refs/remotes/origin/main
if ($LASTEXITCODE -ne 0) { throw 'fetch failed' }
$remote = git -C $repo rev-parse origin/main
if ($remote -ne $expected) { throw 'origin/main changed. Recheck the NP-00 audit base.' }
git -C $repo status --short --branch
git -C $repo worktree list

New-Item -ItemType Directory -Path $npRoot -Force | Out-Null
$intDir = Join-Path $npRoot 'integration'
git -C $repo worktree add -b codex/agy-np-integration $intDir $expected
if ($LASTEXITCODE -ne 0) { throw 'integration worktree creation failed' }

$npDocs = Join-Path $repo 'docs\phase-agy-native-parity'
Copy-Item -LiteralPath $npDocs -Destination (Join-Path $intDir 'docs') -Recurse
git -C $intDir add -- docs/phase-agy-native-parity
git -C $intDir diff --cached --check
if ($LASTEXITCODE -ne 0) { throw 'review staged documentation' }
git -C $intDir diff --cached --stat
git -C $intDir commit -m "docs(agy-np): establish Native Parity research baseline"
if ($LASTEXITCODE -ne 0) { throw 'plan commit failed' }
$plan = git -C $intDir rev-parse HEAD

git -C $repo worktree add -b codex/agy-np-01-observatory (Join-Path $npRoot 'np-01') $plan
git -C $repo worktree add -b codex/agy-np-02-contracts (Join-Path $npRoot 'np-02') $plan
git -C $repo worktree add -b codex/agy-np-03-frontend (Join-Path $npRoot 'np-03') $plan
git -C $repo worktree list
~~~

首批以外，从 [DAG](10_Task_Dependency_Graph.md) 对应合并检查点的 **已审 commit** 切工作树，命令形如 `git worktree add -b <task-branch> <D-drive-task-path> <reviewed-checkpoint-sha>`。任务不在同一 checked-out branch 并写。若使用 Codex Worktree 入口，实际位置由工具在 D 盘创建，记录该路径后用相同 task branch 和 base。

依赖通过各 Worktree 的 D 盘缓存或安装，避免对运行中的包和旧 release 写入。使用 `pnpm install --frozen-lockfile --store-dir D:\HarnessMate\agy-np-pnpm-store`（仅缺依赖时）。快照、SQLite fixture、缓存和所有临时文件使用 D 盘。不要复用正在运行的 HM 用户数据目录、ACP 若干账号或本机生产配置。

## 所有权与评审

- NP-02 单一写入 `packages/protocol/src`、共享 `SessionManager`/`AcpSessionHandle`、传输接线、`sqlite.ts`、路由注册、共享迁移及插件 API。其他任务使用 port 和目录，提出跨文件变更请求并附用例，由 02 做独立 commit 后重放。
- NP-03 单一写入 `App.tsx`、`ChatStage.tsx`、通用 Store、投影、通用 AGY shell 与 slot registry。领域任务只写自己目录和专属组件，通过已冻结 registry 接入。
- 各领域档案与资料负责人可追加 `reviews/NP-XX-*.md`、`handoffs/NP-XX-*.md`、对应 fixture/report。总进度、Capability 等级、迁移文件和公共契约只由总指挥/指定 owner 整理。所有跨队列依赖写清 contract revision。
- 迁移用独立 component 序列 `agy-native-runtime`。NP-02 授予下一个编号，每笔 migrations 复核 new DB、旧 DB、gate off、已写数据回读。其他任务通过 port 获得分区，不能各自改数据库初始化。
- 提交格式 `feat(agy-np-04): ...`、`test(agy-np-07): ...` 或 `docs(agy-np): ...`。尽量把工作包放在独立清楚的提交。PR 对集成分支，写基线和 HEAD、测试与真实证据、矩阵变更、范围外缺口和回滚。不自动 push、创建 PR 或部署。

检查参考命令：

~~~powershell
git status --short --branch
git diff --check <reviewed-base>...HEAD
git diff --name-status <reviewed-base>...HEAD
pnpm typecheck
pnpm test
pnpm build
~~~

集成顺序为 G0 → NP-02 基础与 NP-01 → G1 → NP-04/05/06/07 与 NP-03b → G2，各模式和恢复合并 → G3 → NP-16/17。主合同变化先合入契约分支，并通知依赖 Agent rebase 或合入 reviewed checkpoint。冲突由原 owner + 集成负责人处理。单个任务在审查后的局部冲突可以交作者改，不能直接用 ours/theirs 丢跨模块内容。若无现有 CI 配置，先按本地门禁执行并附结果，后续 PR CI 从相同脚本触发。

优先 feature gate 回滚。已合入的单独提交用 `git revert <commit>`，明确 merge commit 才用 `git revert -m 1 <mergeCommit>`。回滚由集成 owner 做，对照迁移的旧版可读性。发布后的数据留只读，回退前确认备份。已交付的分支和 Worktree 用 Codex 归档动作或后续明确要求安全移除，保留有用户未提交改动的路径。
