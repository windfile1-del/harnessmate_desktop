# 插件开发任务说明书 14 · AI Context Compression & Symbol Index

| 属性 | 说明 |
| --- | --- |
| **插件名称 & Plugin ID** | AI Context Compression & Symbol Index · `hm.plugin.context-compression` |
| **功能定位** | 为 100+ 轮超长开发会话与大型代码仓库提供**可选的高压缩比智能上下文引擎**：通过增量滚动 LLM 摘要（Rolling Summary）+ 轻量文件/符号级 AST 轮廓索引，挂载到 `context-handoff` 压缩扩展点，在极严苛的 Token 预算下显著提升场景 C 跨引擎交接与超长会话续跑质量 |
| **参考来源 (T3 Code)** | `t3code/apps/server/src/orchestration-v2/ContextHandoffService.ts`（模型生成交接摘要与 `handoffBudget.ts` 分段裁剪、`[T3 Code 已验证实现]`）+ `[HarnessMate 原创设计]`（可插拔低成本滚动压缩器 + 轻量文件/符号轮廓索引 + 失败零阻塞回退确定性骨架） |
| **HarnessMate 当前状态** | **完全缺失**：现有 `context-compiler.ts` 与 `handoff-snapshot.ts` 仅做基于规则与字数截断的确定性编译，超长 100+ 轮会话跨引擎切换或遇 32k 小窗口模型时，早期技术推理脉络容易因硬截断而信息密度下降 |
| **插件类型** | Optional Plugin（官方高阶可选插件；不安装时 `context-handoff` 仍通过本地确定性引擎 100% 正常工作） |
| **开发难度与风险** | **中高**（风险点：摘要模型自身产生幻觉篡改真实文件路径或函数名；压缩调用额外消耗 API 费用或阻塞发消息延迟；代码仓库文件变动导致符号索引过期误导模型） |
| **开发优先级** | **P2**（Phase 3，面向超长项目与小上下文模型用户的质量倍增器） |

---

## 1. 职责范围

### 明确负责
- **可插拔滚动语义摘要器（Rolling Semantic Compressor）**：
  - 向 Core / `context-handoff` 注册 `context.registerCompressor` 扩展点；
  - 对长会话中已落盘且超过近期原文窗口的旧轮次按分块（如每 10 轮一个 Chunk，以 `fromSeq..toSeq` + 内容哈希为缓存键）生成高密度结构化语义摘要，显著压缩探索过程废话，保留关键架构结论、踩坑根因与接口契约；
  - 支持用户自由配置“摘要执行引擎”（例如指定用低价快速模型或本地便宜实例执行后台摘要，避免消耗主力高价 Opus/Codex 额度），并强制执行单次摘要费用/Token 硬顶与 8 秒超时；
  - **事实保真护栏**：摘要输出中引用的全部文件路径均在注入前与当前工作区文件系统做一次 `fs.stat` 存在性校验，自动标注 `[已删除/已重命名]` 防止幻觉路径误导目标 Harness；
- **轻量工作区文件/符号轮廓索引（Symbol Outline Indexer）**：
  - 仅针对当前会话 `touchedFiles` 及相邻直接依赖文件（**绝不做全仓百万行重量级向量库索引**），提取轻量只读符号轮廓（导出类、接口、函数签名及行号范围，支持 TypeScript/JavaScript/Python/Go/Rust 等主流语言正则/Tree-sitter 轻量解析）；
  - 在超预算场景 C 下将触达文件的“符号签名骨架 + 行号”替代动辄数千行的原始文件内容写入交接包，让目标 Harness 精准用 `read_file` 或 `hm_session_read` 按需精读；
- **后台预热压缩（Idle Background Roll-up）**：
  - 当检测到会话轮次数超过阈值（默认 25 轮）且当前上下文占用 > 60% 时，利用轮次间隙异步预编译旧分段摘要并缓存，使真正切换引擎时达到毫秒级命中。

### 明确不负责
- 不负责改写或删除 Core SQLite 里的原始会话消息历史（**用户可见完整历史永远无损保存**，压缩产物仅作为独立衍生视图存在）；
- 不替代 `hm.plugin.context-handoff` 裁决交接模式、水位线或敏感脱敏（脱敏永远在交接包最终出站前由 `context-handoff` 统一执行）；
- 不在未经用户配置允许的情况下向任意云端发送代码片段（默认优先使用本机已授权的轻量实例，并在设置中明确展示“摘要使用哪个实例与估算成本”）。

---

## 2. 依赖关系、SDK 接口与对外能力

- **依赖关系**（DAG Layer 2，严格无环）：仅依赖 Core Runtime（向 Core 注册 `compressor` 服务供 Layer 3 的 `hm.plugin.context-handoff` 通过 `optional: ['compressor']` 消费，**绝不反向依赖 `context-handoff`**）。
- **调用的 SDK 接口**：
  - V4 既有：`ctx.fs.read/stat`（只读工作区文件提取符号轮廓）、`ctx.storage.workspace`（缓存按内容哈希索引的分段摘要）、`ctx.events.on`、`ctx.logger`；
  - V5 增量：`ctx.sessions.listItems()`、`ctx.context.registerCompressor(compressor)`、`ctx.harnesses.listInstances()`。
- **对外暴露能力（`provides: ['compressor']`）**：
  - `compressor.compressRange(sessionId, fromSeq, toSeq, budgetChars)`：返回缓存命中或按预算生成的结构化滚动摘要与引用文件校验报告；
  - `compressor.buildSymbolOutline(workspaceId, filePaths, maxChars)`：为指定热点文件生成紧凑符号与行号轮廓；
  - `compressor.getCacheStats(sessionId)`：返回缓存命中率、已压缩轮次区间与累计摘要开销。

---

## 3. 事件协议与数据模型

- **订阅事件**：`turn.completed`（触发异步后台分段预热检查）、`session.deleted`（清理对应缓存）。
- **发布事件**：`compression.chunk_ready`、`compression.fallback_triggered`。
- **核心数据模型**：
```ts
export interface CompressedTurnChunk {
  sessionId: string;
  fromSeq: number;
  toSeq: number;
  sourceItemsHash: string;      // 源 TurnBlock 集合 SHA-256，确保历史不可变复用
  summaryMarkdown: string;
  referencedPaths: Array<{ path: string; existsAtCheck: boolean }>;
  summarizerInstanceId: string;
  inputChars: number;
  outputChars: number;
  compressionRatio: number;
  createdAt: number;
}

export interface FileSymbolOutline {
  path: string;
  mtimeMs: number;
  symbols: Array<{ kind: 'class' | 'interface' | 'function' | 'type' | 'const'; name: string; line: number }>;
}
```
- **持久化方式**：分段摘要与按 `mtimeMs` 缓存的文件符号轮廓存入 `ctx.storage.workspace`（支持 TTL 与 LRU 上限控制，默认单工作区 ≤ 20MB），不新建 SQLite 核心表。

---

## 4. UI 扩展、权限需求与生命周期

- **UI 扩展点与交互形式**：
  - `inspector_tab`（扩展信息或独立子面板 `context-compression`）：展示当前会话已滚动压缩的分段列表（如 `Turns 1–10: 18k → 1.4k chars (12.8x)`）、热点文件符号轮廓预览、以及“手动重新压缩 / 清空摘要缓存”按钮；
  - `modal`（插件设置）：选择摘要所用实例（默认“关闭自动后台摘要，仅切换时按需触发”或“低价实例后台预热”）、单次摘要最大 Token 与超时阈值。
- **权限需求**：可选插件权限 `session:read`、`fs:workspace:read`、`context:compressor`。
- **生命周期**：
  - **安装/启用**：向 Core 注册 `compressor` 服务；首次启用弹出向导引导用户选择用于摘要的实例与成本上限（未选定前默认仅启用“纯本地零费用符号轮廓索引”，不私自调用任何付费模型）；
  - **更新**：支持热更新提示词模板与语言符号提取规则，版本号变更时按哈希自然失效旧缓存；
  - **禁用/卸载**：反注册 `compressor` 服务并清理缓存，`context-handoff` 立即无感退回内置确定性骨架编译。

---

## 5. 异常处理、恢复与降级机制

1. **摘要模型超时（> 8s）、限流或报错**：立即中止等待并向 `context-handoff` 返回 `fallback: true`，由 `context-handoff` 在 < 50ms 内无缝回退至确定性骨架摘要，**绝不卡死跨引擎切换或发消息**；
2. **摘要模型幻觉防线**：后处理阶段用正则提取摘要内所有文件路径并逐一做工作区校验，对不存在的文件打标记，且永远不覆盖 `L0 Workspace Truth` 与 `L1 Task Ledger` 中的硬事实；
3. **超大单文件或二进制文件防护**：符号提取器跳过 > 512KB 文件与二进制文件，防止正则回溯或 CPU 飙升；
4. **成本防失控**：设置每日最大摘要调用次数与单会话摘要 Token 预算上限，触顶后自动切换至“仅符号索引 + 确定性裁剪”并提示用户。

---

## 6. 测试方案与可验证验收标准

- **单元测试**：
  - TypeScript / Python / Go / Rust 样本文件的轻量符号与行号轮廓提取准确度测试；
  - 幻觉路径后置校验器测试（验证摘要中伪造路径被标注剔除）；
  - 分段哈希缓存命中与超时 8s 降级测试。
- **基准对比测试**：
  - 构造 100 轮大型重构会话向 32k 窗口模型切换，对比“纯确定性裁剪”与“开启本插件滚动摘要 + 符号轮廓”的信息保留率（架构决策、关键符号签名、失败尝试完整度）与编译延迟。
- **可验证验收标准**：
  1. 禁用或卸载本插件后，`context-handoff` 全部测试 100% 通过，验证完全解耦；
  2. 100 轮会话在缓存预热命中时，跨引擎交接编译延迟 < 120ms，压缩比 ≥ 6x；
  3. 模拟摘要模型 500 报错或 10s 无响应，主流程在 8s 内无感降级且交接 100% 成功；
  4. 未显式选定摘要模型实例时，外发 LLM 请求次数严格为 **0**（纯本地符号轮廓模式）。
