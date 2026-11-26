# B1-02 可复用历史来源测试夹具

本目录提供零隐私、确定性、可重复生成的五类本机历史来源测试夹具：

- `build-fixtures.mjs`：导出 `buildB102Fixtures(baseDir)`，生成以下结构：
  - `codex-home/`：`session_index.jsonl`、Codex CLI `.jsonl`（含 `<environment_context>` 过滤）、Codex Desktop `.jsonl`、Codex Desktop 归档 `.jsonl.zst`、以及含半截损坏尾行的 `codex_exec` `.jsonl`。
  - `codex-account-b/`：独立第二个 Codex 账户目录，故意复用同一 `nativeSessionId` 验证跨账户身份隔离。
  - `claude-home/`：`history.jsonl` 与 `projects/demo-proj/<uuid>.jsonl`（含 `isMeta` 过滤）。
  - `agy-cli-root/`：`conversation_summaries.db`（含已建立 `conversations_fts` 索引的会话 + 仅有摘要/标题但缺失 FTS 正文的会话）与 `conversations/*.pb`。
  - `agy-desktop-root/`：同构独立桌面端根目录（含已索引会话 + 仅有 `.pb`/摘要缺失正文会话）。
  - `agy-corrupt-root/`：损坏 SQLite 数据库，用于单来源失败隔离测试。

## 复现命令

```powershell
node -e "import('./packages/daemon/tests/fixtures/b1-02/build-fixtures.mjs').then(m => console.log(m.buildB102Fixtures('D:/HarnessMate/b1-fixtures/b1-02/generated')))"
```
