# 插件开发任务说明书 09 · Session Explorer, Search & Importer

| 属性 | 说明 |
| --- | --- |
| **插件名称 & Plugin ID** | Session Explorer, Search & Importer · `hm.plugin.session-explorer` |
| **功能定位** | 提供跨工作区与跨 Harness 的历史会话发现、SQLite FTS5 全文检索、GiB 级流式外部 CLI 原生会话导入（Codex/Claude/Antigravity/Pi 等）、原生+便携会话分叉（Fork）、分支结论回流（`merge_back`）、轻量侧边问答（Side Chat）与多格式完整导出 |
| **参考来源 (T3 Code)** | `t3code/apps/server/src/project/AgentSessionScanner.ts`（支持 Claude/Codex 含 `.jsonl.zst` zstd 压缩卷/Pi 扫描与 200MB 防 OOM 截断）、`t3code/apps/server/src/orchestration-v2/ContextHandoffService.ts`（`fork_delta_summary`）、`t3code/apps/server/src/persistence/Migrations/055_OrchestrationV2.ts`（分支与归档字段）、`t3code/apps/web/src/components/chat/SideChat`（`[T3 Code 已验证实现]`） |
| **HarnessMate 当前状态** | **部分实现**：`packages/daemon/src/harnesses/history-scanner.ts`（310 行）已支持扫描 Claude（`~/.claude`）、Codex（`~/.codex/sessions` + `archived_sessions`）及 Antigravity（`~/.gemini/antigravity/conversation_summaries.db` `conversations_fts` 与 `antigravity-cli`），且具备基础 Markdown 导出；**缺口**：无 SQLite FTS5 全文跨会话检索、无 Codex `.jsonl.zst` 解压与超大 transcript 内存硬限保护、不支持插件注册自定义 CLI 扫描器、无会话 Fork / `merge_back` / Side Chat、缺含脱敏选项的结构化 JSON/Audit 导出 |
| **插件类型** | Built-in Plugin（默认启用第一方业务插件，提供公共服务 `session-search`） |
| **开发难度与风险** | **中**（风险点：外部 CLI 目录包含数万文件或数百 MB 巨型 JSONL 导致扫描卡顿/OOM；导入正在被外部终端写入的活跃会话引发半截 JSON 报错或双写冲突；FTS5 索引写入拖慢流式对话热路径） |
| **开发优先级** | **P1**（Phase 2，补齐外部 CLI 平滑迁入与历史资产复用能力） |

---

## 1. 职责范围

### 明确负责
- **全局 FTS5 会话检索（`session-search` 服务）**：
  - 订阅 Core `turn.completed` 事件，异步将终态落盘的归一化 `TurnBlock` 文本、文件名与会话标题增量同步到 Core 托管的 `session_search_fts`（FTS5 虚拟表），支持中英文分词、按工作区/Harness/时间范围过滤与上下文高亮片段返回；
- **GiB 级安全原生 CLI 会话发现与导入**：
  - 演进 `history-scanner.ts`：保留现有 Claude、Codex、Antigravity（含 `conversation_summaries.db`）扫描能力，新增 Codex 归档 `.jsonl.zst` 流式 zstd 解压、Pi/OpenCode 扫描支持，并允许第三方 Adapter 插件注册自定义只读 `NativeSessionScanner`；
  - 强制内存与文件安全上限：单 transcript 解析上限（如 200MB 或 10,000 行流式滑窗，遇损坏尾行容错跳过），扫描并发限流（≤ 4）与增量 `mtime` 缓存，杜绝 UI 冻结；
  - 导入模式支持二选一：（1）**只读镜像导入**（安全复刻历史到 HarnessMate 并保留原原生 ID 作为参考）；（2）**直接接管续跑**（建立 `session_harness_bindings`，并在目标原生文件被外部进程锁定时发出明确警告而非静默分叉）；
- **会话分叉（Fork）、回流（`merge_back`）与侧边探索（Side Chat）**：
  - 支持从任意历史轮次分叉新逻辑会话：若目标驱动声明 `supportsNativeFork: true` 优先走原生分叉，否则走便携分叉（调用 `SessionKernel.fork` 并标记需要便携交接上下文），可选联动创建新 Worktree；
  - 支持从分叉子会话执行 **`merge_back`**：提炼分叉后增量变更与结论（`fork_delta_summary`），作为审阅后摘要注入回父会话时间线；
  - 提供独立轻量 **Side Chat**（寄生在当前会话侧栏的临时只读问答线程，读取当前工作区/账本上下文但不污染主会话历史，支持一键清空或升级为正式分叉）；
- **多格式导出与脱敏**：
  - 演进现有 Markdown 导出，补充 **Portable JSON Bundle v2**（含脱敏开关，剔除密钥与绝对隐私路径，支持跨机器导入复现或提交 Bug 报告）。

### 明确不负责
- 不直接修改外部 CLI（`~/.codex`、`~/.claude`、`~/.gemini`）的原生历史文件（严格只读访问）；
- 不自行实现跨引擎交接编译逻辑（分叉后跨引擎续跑交由 Core 与 `hm.plugin.context-handoff` 完成）；
- 不在高频 `*.delta` 流式热路径中同步更新 FTS5 索引（仅在轮次终态批量异步刷写）。

---

## 2. 依赖关系、SDK 接口与对外能力

- **依赖关系**（DAG Layer 2）：仅依赖 Core Runtime（`SessionKernel`、`session_search_fts`、文件系统只读通道），**零跨插件强依赖**。
- **调用的 SDK 接口**：
  - V4 既有：`ctx.events.on`、`ctx.storage.plugin`、`ctx.logger`；
  - V5 增量：`ctx.sessions.listItems()`、`ctx.sessions.getItem()`、`ctx.sessions.getBindings()`、`ctx.sessions.fork()`、`ctx.sessions.postNotice()`、Core `session_search_fts` 查询/索引写入接口。
- **对外暴露能力（`provides: ['session-search']`）**：
  - `session-search.query(opts)`：全局 FTS5 全文检索（支持 `q`、`workspaceId`、`driverId`、`fromTs`、`toTs`、`limit`）；
  - `session-search.discoverExternal(opts)`：列举本机外部 CLI 会话（支持 `mtime` 缓存与手动强制刷新）；
  - `session-search.importExternal(discoveredId, mode)`：将外部 CLI 会话导入为逻辑会话；
  - `session-search.registerScanner(scanner)`：允许第三方 Adapter 插件注册自有外部历史扫描器；
  - `session-search.exportSession(sessionId, format, opts)`：导出 `markdown` / `json_bundle`（可选脱敏）。

---

## 3. 事件协议与数据模型

- **订阅事件**：`turn.completed`、`session.created`、`session.archived`、`session.deleted`。
- **发布事件**：`session.imported`、`session.forked`、`session.merged_back`、`search_index.rebuilt`。
- **核心数据模型**：
```ts
export interface SessionSearchHit {
  sessionId: string;
  sessionTitle: string;
  workspaceId: string;
  turnSeq: number;
  itemId: string;
  blockType: string;
  snippetHtmlSafe: string;   // 纯文本偏移数组或转义高亮片段，防 XSS
  driverId: string;
  createdAt: number;
}

export interface DiscoveredExternalSessionV2 {
  scannerId: string;         // 'codex' | 'claude' | 'agy_desktop' | 'agy_cli' | 'pi' | custom
  nativeSessionId: string;
  title: string;
  cwd: string;
  updatedAt: number;
  fileSizeBytes: number;
  compressed: boolean;       // 如 Codex .jsonl.zst
  approxTurnCount: number;
  alreadyImportedSessionId?: string;
}
```
- **持久化方式**：复用 Core SQLite `session_search_fts` 虚拟表与 `sessions.parent_session_id` / `forked_from_turn_seq` 字段；外部扫描索引缓存存 `ctx.storage.plugin`（带 TTL 与 `mtime` 校验）。

---

## 4. UI 扩展、权限需求与生命周期

- **UI 扩展点与交互形式**：
  - `sidebar_tool` + `modal`：**Session Explorer & Importer 面板**——提供全局即时全文搜索（高亮命中轮次并点击直达滚动定位）、按工作区/引擎筛选、以及“从本机 CLI 导入”向导（显示外部 Codex/Claude/AGY 会话列表、体积与是否已导入徽标）；
  - 会话树/轮次操作菜单：提供 **“从此轮分叉（Fork）”**、**“将分叉结论合并回父会话”**、**“导出 Markdown / 脱敏 JSON”**；
  - `inspector_tab`（key: `side-chat`）：轻量 **Side Chat** 抽屉，随时就当前代码或报错向任意引擎提问而不弄脏主时间线。
- **权限需求**：内置受信任插件；声明 `session:read`、`session:fork` 及受限外部 CLI 历史目录只读权限（`fs:cli_histories:read`，仅限用户确认的 `~/.codex`、`~/.claude`、`~/.gemini` 等已知只读路径）。
- **生命周期**：
  - **安装/启用**：检查 `session_search_fts` 索引水位，若落后于已有会话则在后台低优先级队列分批补建（每批 20 轮、空闲让出事件循环，零阻塞启动）；
  - **更新**：保留已导入会话与索引，仅在 FTS Tokenizer 变更时触发后台重建；
  - **禁用**：停止后台索引增量更新与外部目录扫描，不删除已导入会话。

---

## 5. 异常处理、恢复与降级机制

1. **巨型或损坏的外部 JSONL/ZST**：流式逐行解析并硬限单文件读取字节与最大保留轮次数，遇到外部程序正在写入导致的半截尾行直接静默跳过并标记 `partial: true` 提醒用户；
2. **外部 SQLite 被占锁（如 Antigravity 正在写 `conversation_summaries.db`）**：采用只读打开 + 短 busy timeout，遇 `SQLITE_BUSY` 自动跳过本次刷新并在 3s 后退避重试，绝不阻塞外部应用；
3. **FTS5 索引损坏或查询语法报错**：对用户输入查询串自动转义特殊 FTS 操作符（`-`、`"`、`*`、`NEAR`），异常时降级为安全 `LIKE` 子串查询并触发后台重建索引；
4. **Fork 目标驱动不支持原生分叉**：无缝降级为便携分叉并在新会话顶部注入清晰提示，确保交互路径一致。

---

## 6. 测试方案与可验证验收标准

- **单元测试**：
  - FTS5 特殊字符转义、中英文命中片段提取与分页；
  - 模拟 250MB 超大 JSONL、截断损坏尾行与 `.jsonl.zst` 压缩卷流式解析器内存峰值验证；
  - 导出脱敏过滤器（屏蔽绝对用户名路径与常见密钥模式）。
- **集成测试**：
  - 复用 `history-scanner.ts` 覆盖 Claude/Codex/AGY 真实样例目录导入 → 生成逻辑会话 → 触发 FTS5 索引 → 搜索命中直达对应 `itemId`；
  - 从第 3 轮分叉子会话 → 完成修复 → 执行 `merge_back` 验证父会话准确收到 `fork_delta_summary`。
- **可验证验收标准**：
  1. 1,000 轮本地历史库中，全文 FTS5 检索 P95 响应时间 < 50ms；
  2. 扫描包含 500 个历史文件及单个 > 200MB 超大 transcript 的目录时，Daemon 内存增量 < 80MB 且零 OOM 崩溃；
  3. 外部 CLI 导入过程严格零写入外部目录（通过只读权限夹具验证）；
  4. 导出的 JSON Bundle 在空实例重新导入后，标题、轮次顺序与结构化块 100% 完整还原。
