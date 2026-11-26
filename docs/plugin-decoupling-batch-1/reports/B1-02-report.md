# B1-02 交付报告 · 本机历史来源插件（`history.source.v1` v`1.0.0`）

- **任务编号**：B1-02
- **开发基线**：`b1/baseline`（`4eed4537f15d48e4e99d2cd033fe2e15d578083f`）
- **交付分支**：`b1/b1-02-history-sources`
- **契约版本**：`history.source.v1`（`1.0.0`），完全对齐 `docs/plugin-decoupling-batch-1/B1-01-contract-draft.md` 与 `docs/plugin-decoupling-batch-1/fixtures/B1-01-peer-contracts.json`

## 1. 交付物清单

1. **来源共享解析/桥接模块**（`packages/daemon/src/harnesses/history-sources/*`，保持 `history-scanner.ts` 既有导出 100% 兼容）：
   - `types.ts`：`history.source.v1` 类型、`resolveHistorySourceIdentity`、`buildHistorySourceId`、`legacySourcesForSourceId`、`defaultRootsForNamespace`
   - `cursor.ts`：不透明 Base64URL 分页游标编解码（防篡改校验返回 `invalid_request`）
   - `jsonl-reader.ts`：支持 `AbortSignal` 取消的 `.jsonl` / `.jsonl.zst`（Node 24 `createZstdDecompress`）流式读取，保留 `DEFAULT_MAX_TRANSCRIPT_BYTES`（200 MiB）、`DEFAULT_MAX_TRANSCRIPT_LINES`（10,000）、半截尾行容错与 `fileLockedWarning`
   - `agy-reader.ts`：只读 `?immutable=1` 打开 `conversation_summaries.db`（零 `-wal`/`-shm` 副作用），并区分「仅有摘要或 `.pb` 但 `conversations_fts` 缺失正文」
   - `sources.ts`：`HistorySourceInstance`、`createCodexHistorySource`、`createClaudeHistorySource`、`createAgyCliHistorySource`、`createAgyDesktopHistorySource`、`createCustomHistorySource`、`registerHistorySourceScannerBridge`
2. **四款预装历史来源插件**（纯 Node ESM，自包含且零外部 npm 依赖，可直接随 `stage-bundle.mjs` 拷贝打包）：
   - `plugins/bundled/hm.plugin.history-source-codex/`（`hm.plugin.history-source-codex`，覆盖 Codex CLI 与 Codex Desktop）
   - `plugins/bundled/hm.plugin.history-source-claude/`（`hm.plugin.history-source-claude`）
   - `plugins/bundled/hm.plugin.history-source-agy-cli/`（`hm.plugin.history-source-agy-cli`）
   - `plugins/bundled/hm.plugin.history-source-agy-desktop/`（`hm.plugin.history-source-agy-desktop`）
3. **第三方可独立安装样例**：
   - `plugins/examples/hm.plugin.history-source-custom/`（`user.history-source-custom`，含包内 `samples/*.jsonl` 与安装说明 `README.md`）
4. **可复用零隐私夹具与自动化测试**：
   - `packages/daemon/tests/fixtures/b1-02/build-fixtures.mjs` & `README.md`
   - D 盘实体夹具与只读验证脚本：`D:\HarnessMate\b1-fixtures\b1-02\generated\`、`D:\HarnessMate\b1-fixtures\b1-02\verify-real-sources.mjs`
   - `packages/daemon/tests/b1-02-history-sources.test.ts`

## 2. 稳定 `sourceId` 命名规范、旧来源映射与可用示例

- **默认账户命名**：
  - Codex（同一 `~/.codex` 下 CLI 与 Desktop 共享记录去重身份）：`codex:default` -> `compatLegacySources: ['codex_cli', 'codex_desktop']`
  - Claude CLI：`claude:default` -> `compatLegacySources: ['claude_cli']`
  - AGY CLI：`agy_cli:default` -> `compatLegacySources: ['agy_cli']`
  - AGY Desktop：`agy_desktop:default` -> `compatLegacySources: ['agy_desktop']`
  - Custom 样例：`custom:default` -> `compatLegacySources: ['custom']`
- **独立账户 / 自定义根目录**：未显式传入 `config.sourceId` 时按 `<namespace>:acct:<sha256_12(canonicalRoot)>` 生成，`compatLegacySources: []`，不同账户下同名 `nativeSessionId` 保持完全独立身份。
- **插件配置示例**（`composition` 实例配置）：

```json
[
  { "id": "hm.plugin.history-source-codex", "name": "hm.plugin.history-source-codex", "config": { "rootDir": "D:\\Fixtures\\codex-home" } },
  { "id": "codex.account-b", "name": "hm.plugin.history-source-codex", "config": { "rootDir": "D:\\Fixtures\\codex-account-b", "sourceId": "codex:work" } },
  { "id": "hm.plugin.history-source-agy-cli", "name": "hm.plugin.history-source-agy-cli", "config": {} },
  { "id": "hm.plugin.history-source-agy-desktop", "name": "hm.plugin.history-source-agy-desktop", "config": {} }
]
```

- **可用 `discover` / `read` 请求与响应示例**（同步支持 `ctx.services.call('history.source.v1', ...)` 与 `/api/v1/plugin-instances/:instanceId/routes/{discover,read,cancel,status}`）：

```json
// POST /api/v1/plugin-instances/hm.plugin.history-source-codex/routes/discover
{ "query": "中文检索", "limit": 20 }
// ->
{
  "ok": true,
  "value": {
    "sessions": [{
      "ref": {
        "sourceInstanceId": "hm.plugin.history-source-codex",
        "sourceId": "codex:default",
        "nativeSessionId": "11111111-1111-4111-8111-111111111111"
      },
      "title": "Codex CLI 示例会话（中文检索）",
      "harnessKind": "codex",
      "updatedAt": 1795651200000,
      "workspaceHint": { "cwd": "D:\\Fixtures\\repo-codex-cli", "label": "repo-codex-cli" },
      "legacySource": "codex_cli",
      "compatLegacySources": ["codex_cli", "codex_desktop"]
    }],
    "nextCursor": null
  }
}

// POST /api/v1/plugin-instances/hm.plugin.history-source-codex/routes/read
{
  "ref": {
    "sourceInstanceId": "hm.plugin.history-source-codex",
    "sourceId": "codex:default",
    "nativeSessionId": "11111111-1111-4111-8111-111111111111"
  },
  "limit": 100
}
// ->
{
  "ok": true,
  "value": {
    "ref": {
      "sourceInstanceId": "hm.plugin.history-source-codex",
      "sourceId": "codex:default",
      "nativeSessionId": "11111111-1111-4111-8111-111111111111"
    },
    "items": [
      { "itemId": "message-1", "role": "user", "text": "请检查 Codex CLI 历史导入兼容性", "timestamp": 1795651201000 },
      { "itemId": "message-2", "role": "assistant", "text": "已完成 Codex CLI 历史兼容性检查。", "timestamp": 1795651203000 }
    ],
    "nextCursor": null,
    "readStatus": "complete",
    "warnings": []
  }
}
```

## 3. 五类本机历史来源实测矩阵

> 实机目录均以**严格只读**方式探测（未改动任何生产目录，AGY SQLite 采用 `?immutable=1` 无 `-wal`/`-shm` 副作用）。

| 来源类型 | 样本来源（真实只读 / 合成夹具） | 产品或格式版本 | 发现结果（`discover`） | 正文读取结果（`read`） | 失败 / 标题无正文情况说明 |
| --- | --- | --- | --- | --- | --- |
| **Codex CLI** | 真实只读 `CODEX_HOME` (`D:\Codex\OpenAI-Codex-data\sessions\|archived_sessions`) + 合成夹具 `codex-home` | `session_meta` JSONL / `.jsonl.zst`，`originator: codex_exec \| codex_cli_rs`，`source: cli \| exec`，`cli_version: 0.147.0` | 实机扫描命中 3 条（`sourceId: codex:default`）；合成夹具命中 CLI 与 `codex_exec` 样本 | 实机探测 3 条中 2 条完整读出（样例 5 条消息）；合成夹具完整读出并验证 `<environment_context>` 过滤及半截尾行 `partial` 提示 | 实机 1 条仅含工具/元数据无 user/assistant 文本，返回 `source_unreadable`（`会话记录存在但未包含可解析的用户/助手文本消息`） |
| **Codex 桌面** | 真实只读 `CODEX_HOME` (`D:\Codex\OpenAI-Codex-data\sessions\|archived_sessions`) + 合成夹具 `codex-home` | `session_meta` JSONL / `.jsonl.zst`，`originator: Codex Desktop \| codex_work_desktop \| harnessmate-desktop`，`source: vscode \| {subagent}`，`cli_version: 0.147.0 ~ 0.171.0-alpha.13` | 实机首页返回 20 条（`nextCursor != null`），与 CLI 共享 `sourceId: codex:default`；合成夹具覆盖明文与 `.jsonl.zst` | 实机探测 8 条中 7 条完整读出（样例 31 条消息）；合成 `.jsonl.zst` 支持分页续读（`limit=1` -> `nextCursor` -> 第 2 页） | 实机 1 条子代理/系统记录无文本消息，返回 `source_unreadable`；与 CLI 共享同一物理记录时通过 `(sourceId, nativeSessionId)` 一致去重 |
| **Claude CLI** | 真实只读 `C:\Users\windfile\.claude`（11 份 `projects/*/*.jsonl` + `history.jsonl`） + 合成夹具 `claude-home` | Claude Code `v2.1.197` JSONL（`user`/`assistant`/`queue-operation`/`ai-title`） | 实机扫描命中 11 条（`sourceId: claude:default`）；合成夹具命中并正确取自 `history.jsonl` 标题 | 实机探测 8/8 全部完整读出（`readOkCount: 8`）；合成夹具正确过滤 `isMeta` 行 | 无失败样本；未开启 `sessions/` 子目录时（本机 `sessionsDirCount: 0`）正常仅扫描 `projects/` |
| **AGY CLI** | 真实只读 `C:\Users\windfile\.gemini\antigravity-cli`（113 摘要、77 `conversations_fts`、81 `.pb`） + 合成夹具 `agy-cli-root` | `conversation_summaries.db`（`conversation_summaries` + `conversations_fts` 字节偏移）与 `conversations/*.pb` | 实机首页返回 20 条（`nextCursor != null`，`sourceId: agy_cli:default`）；独立于 AGY 桌面 | 实机探测 8 条中 4 条有 FTS 索引记录完整读出（样例 4 条消息）；合成夹具 0 `-wal`/`-shm` 副作用 | 实机 4 条（及合成 `agyCliNoFtsId`）**仅扫描到标题/摘要或 `.pb` 但缺少 `conversations_fts` 正文**：已分开判定返回 `source_unreadable`（明确提示只读源无法解析未建索引的 `.pb`） |
| **AGY 桌面** | 真实只读 `C:\Users\windfile\.gemini\antigravity`（324 摘要、83 `conversations_fts`、650 `.pb`） + 合成夹具 `agy-desktop-root` | `conversation_summaries.db` + `conversations/*.pb` | 实机首页返回 20 条（`nextCursor != null`，`sourceId: agy_desktop:default`）；与 AGY CLI 保持独立发现 | 实机探测 8 条中 1 条有 FTS 索引记录完整读出（样例 3 条消息）；合成夹具完整读出并校验 symlink/junction 拦截 | 实机 7 条（及合成 `agyDesktopNoFtsId`）**仅扫描到标题/摘要或 `.pb` 但缺少 `conversations_fts` 正文**：返回 `source_unreadable` 并保留其余可索引会话正常读取 |

## 4. 覆盖范围对比（真实只读 vs 合成夹具）与已知协作边界

- **真实只读数据覆盖**：验证了真实 1,040 份 Codex `.jsonl`/`.jsonl.zst`、真实 Claude Code `v2.1.197` JSONL、真实 AGY CLI 与 AGY Desktop 的 WAL/FTS SQLite 数据库、以及真实存在的「扫到标题但正文缺失」与「无文本消息」场景。
- **合成夹具覆盖**：补齐了确定性 CI 可重放的边界条件：半截损坏尾行（`corrupted_trailing_line`）、Codex CLI + Desktop 同源去重 vs 第二独立账户同名 ID 隔离、1.5 MiB/条数分页续读、运行中取消（`operationId` 与实例停用取消）、损坏 SQLite 单来源失败隔离、以及反转载入顺序一致性。
- **交付给 B1-01 / B1-06 的宿主与发行配置需求**：
  1. **发行列表与本地只读授权**：请在 `packages/daemon/src/plugin-host/builtin/manifests.ts` 中将 `hm.plugin.history-source-codex`、`hm.plugin.history-source-claude`、`hm.plugin.history-source-agy-cli`、`hm.plugin.history-source-agy-desktop` 加入 `BUNDLED_PLUGIN_IDS` 与 `BUNDLED_TRUSTED_LOCAL_IDS`（或为声明 `fs:cli_histories:read` 且已授权的隔离插件授予目标历史目录 `--allow-fs-read`）。
  2. **环境变量透传**：`packages/daemon/src/plugin-host/isolation/isolated-process.ts` 的 `buildIsolatedChildEnv()` 当前会过滤 `CODEX_HOME` 与 `CLAUDE_CONFIG_DIR`。若宿主希望不显式配置 `config.rootDir` 时自动继承环境变量指定的目录，建议在 `buildIsolatedChildEnv()`（或由组合配置 `config.rootDir`）透传 `CODEX_HOME` 与 `CLAUDE_CONFIG_DIR`。
  3. **第三方样例安装步骤**：见 [第三方自定义来源 README](../../../plugins/examples/hm.plugin.history-source-custom/README.md)，支持 `local_dir` 普通沙箱安装与多实例并存。

## 5. 实跑命令与结果

| 命令 | 退出码 | 结果摘要 |
| --- | --- | --- |
| `node D:\HarnessMate\b1-fixtures\b1-02\verify-real-sources.mjs .` | `0` | 严格只读探测真实 Codex CLI/Desktop、Claude CLI、AGY CLI、AGY Desktop 五类来源全部成功（无任何写操作） |
| `pnpm --filter @harnessmate/daemon test tests/b1-02-history-sources.test.ts --maxWorkers=1 --testTimeout=35000` | `0` | `1 passed (1)`，`5 passed (5)`（含 5 插件包同构校验、稳定 `sourceId` 与旧映射、5 类格式只读/去重/隔离/分页/缺失正文诊断、取消与停用隔离、第三方自定义样例与预装插件隔离进程并行及反转加载顺序） |
| `pnpm --filter @harnessmate/daemon test tests/b1-02-history-sources.test.ts tests/session-explorer-approval.test.ts tests/agy-np15-recovery.test.ts tests/agy-np-hardening-isolation.test.ts --maxWorkers=1 --testTimeout=60000` | `1` | `3 passed (4)`，`22 passed (23)`：`b1-02` (5/5)、`agy-np15-recovery` (8/8)、`agy-np-hardening-isolation` (3/3) 通过；`session-explorer-approval` 中 `Fork/Side Chat/Bundle v2` 的 `afterEach` 清理超过默认 `10000ms` hook 超时 |
| `pnpm --filter @harnessmate/daemon test tests/session-explorer-approval.test.ts --maxWorkers=1 --testTimeout=120000 --hookTimeout=120000` | `0` | `1 passed (1)`，`7 passed (7)`，确认既有导入/分叉/审批回归全通 |
| `pnpm typecheck` | `0` | 全部 6 个有 `typecheck` 脚本的工作区包（`plugin-api`、`plugin-sdk`、`protocol`、`daemon`、`web`、`electron`）全部通过 |
| `git diff --check` | `0` | 无空白字符或冲突标记问题 |

- **可复用脱敏/合成夹具路径**：
  - 仓库内可复用生成器：`packages/daemon/tests/fixtures/b1-02/build-fixtures.mjs`（附 `README.md`）
  - D 盘已物化复现目录：`D:\HarnessMate\b1-fixtures\b1-02\generated\`（及只读实机探测脚本 `D:\HarnessMate\b1-fixtures\b1-02\verify-real-sources.mjs`）
