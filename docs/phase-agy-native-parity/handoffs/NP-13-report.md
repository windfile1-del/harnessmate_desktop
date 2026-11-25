# NP-13 交付报告 · 原生生态、Custom Agents 与配置

## 1. 基线、分支与提交信息

| 项目 | 值 |
| --- | --- |
| Task ID | `NP-13`（原生生态、Custom Agents 与配置） |
| 源码审计基线 | `0409bc8a4ea85d05ef6b0ee85fc2d0b980f06039`（`main`） |
| G3 Wave-1 复验源码祖先 | `5711a8266bdca72fd34a5dd07f59aedfb108a237` |
| Reviewed Base（`agy-np-g3-wave1` 开工标签） | `9826359a46d0518c88d12ca45318bb5cb891a73a`（`docs(agy-np): freeze reviewed G3 wave-one and wave-two launch`） |
| 当前工作分支 / Worktree | `np13_native_ecosystem_config` · `D:\AppDataCache\.gemini\antigravity\worktrees\harnessmate_desktop\np13_native_ecosystem_config`（经 junction 挂载于 `C:\Users\windfile\.gemini\antigravity\worktrees\harnessmate_desktop\np13_native_ecosystem_config`；总指挥集成时可按需 cherry-pick / merge 至 `codex/agy-np-13-ecosystem`） |
| **代码与测试交付提交 SHA** | **`12777f0a8d54b7de736eca1ac4a2ee0f49c74798`**（`feat(agy-np-13): add native ecosystem discovery, config scope provenance, descriptors, and settings UI`） |
| 公共契约版本 | `AGY_NATIVE_CONTRACT_VERSION = 1` · `AGY_NATIVE_CONTRACT_REVISION = 'agy-native-v1.0.0'`（零修改） |
| SQLite 组件迁移版本 | `component = 'agy-native-runtime'` · `version = 1`（零修改） |
| `MASTER_PROGRESS.md` | 未修改（按约定由总指挥统一更新） |

---

## 2. 实际变更路径与所有权核对

全部改动严格限定在 NP-13 允许写入范围内（`packages/protocol/**`、`packages/plugin-api/**`、`packages/daemon/src/harnesses/agy/native/wiring/**`、`packages/daemon/src/harnesses/agy/native/commands/**`、`packages/daemon/src/server/app.ts`、`packages/daemon/src/core/**`、`packages/daemon/src/db/sqlite.ts`、`agy-driver.ts`、`agy-auth-service.ts`、`agy-launch-context.ts`、`packages/web/src/components/agy/native/shared/**`、`packages/web/src/slots/**`、`packages/web/src/stores/app-store.ts`、`packages/web/src/api/client.ts`、`packages/web/src/App.tsx` 及其他 Harness Adapter 均零改动）：

| 路径 | 类别 | 说明 |
| --- | --- | --- |
| `packages/daemon/src/harnesses/agy/native/ecosystem/types.ts` | 新增 | `AgyEcosystemFeatureGates`（全门控默认 `false`）、`AgyEcosystemCatalogSnapshot`、三层配置与 6 域只读元数据及边界卡片类型 |
| `packages/daemon/src/harnesses/agy/native/ecosystem/path-guard.ts` | 新增 | 敏感文件名拒绝（`antigravity-oauth-token` / `.env` / `*credentials*` / `*token*` / `*secret*` / 密钥文件）、目录遍历/符号链接越界拦截、有界读取（64 KiB）与 DTO 路径脱敏 |
| `packages/daemon/src/harnesses/agy/native/ecosystem/discovery.ts` | 新增 | 只读发现与脱敏投影：Custom Agents（`new_session_or_fork_required`）、Skills 1.5.16 优先级（工作区 > `~/.gemini` > `~/.agents/skills`）、Rules（路径哈希去重 + `#1540` 标注）、Hooks（仅事件名与数量，不执行）、AGY Plugins（独立于 HM V5）、MCP（脱敏 `env`/`headers`）、工作区与附加目录校验、9 项无原生 Feed 边界状态 |
| `packages/daemon/src/harnesses/agy/native/ecosystem/descriptors.ts` | 新增 | NP-13 `CapabilityDescriptor` 工厂与 `registerEcosystemCapabilityDescriptors`（贡献至 NP-06 catalog 且不覆盖既有 `/skills`、`/mcp`、`/credits` 动作），显式列出 `NP13_NO_NATIVE_FEED_CAPABILITY_IDS` |
| `packages/daemon/src/harnesses/agy/native/ecosystem/service.ts` | 新增 | `AgyNativeEcosystemService`：按 `instanceId + canonicalGeminiDir + source + workspaceRoot` 隔离缓存（支持同名 Profile）、管理员政策融合、以及经 `assertAgyConsumerProvenance` + `userOptInConfirmed` + `officialOptInQueryEnabled` 三重校验的官方 CLI 只读查询入口 |
| `packages/daemon/src/harnesses/agy/native/ecosystem/fixtures.ts` · `index.ts` | 新增 | `synthetic` 确定性夹具（`NP13_SYNTHETIC_FIXTURE_SOURCE = 'synthetic'`）与模块统一导出 |
| `packages/daemon/src/harnesses/agy/agy-ecosystem.ts` | 增强 | 保留既有 `AgyEcosystemSnapshot` 与 `collectAgyEcosystemSnapshot` 100% 向后兼容；新增 `collectNativeEcosystemCatalogSnapshot` 便捷入口 |
| `packages/daemon/src/harnesses/agy/agy-config-scope.ts` | 增强 | 保留既有 `resolveAgyTurnConfig`、`buildAgySessionRestorePatch`、`AgyModelEffortCache` 不变；新增 `resolveAgyConfigWithProvenance`、`AGY_CONFIG_READ_WRITE_BOUNDARIES`、实测漂移检测与组织策略上限/模型列表校验 |
| `packages/daemon/src/harnesses/agy/agy-profile-manager.ts` | 限定只读增强 | 保留既有 `prepareAgyProfile` 等导出不变；新增非侵入只读边界检查 `inspectAgyProfileScopeBoundary`（Windows junction / symlink 安全校验、1.5.16 skills 根优先级状态与 `#1610` 标记） |
| `packages/web/src/components/agy/native/settings/types.ts` · `selectors.ts` · `fixtures.ts` · `index.ts` | 新增 | Settings 分区视图模型、命名空间/作用域/策略中文词典、`synthetic` 前端夹具与模块导出 |
| `packages/web/src/components/agy/native/settings/AgyNativeSettingsWorkspace.tsx` | 新增 | 账户 / 模型与配置 / 原生 Agents / 生态与边界 / 项目与目录 五分区工作台（支持 480px 响应式、键盘 Tab 切换、门控关闭降级、命名空间与搜索筛选） |
| `packages/web/src/components/agy/AgySettingsSlot.tsx` | 增强 | 保持默认特性关闭下与原输出完全一致；新增可选 `ecosystemSnapshot` / `showNativeEcosystem` / `onRequestOptInQuery` 挂载点及 `agyNativeWorkbenchEnabled` 展开开关 |
| `packages/daemon/tests/agy-np13-ecosystem.test.ts` | 新增测试 | 7 项综合后端测试（覆盖门控关闭、T01 三层来源与漂移、T15 1.5.16 优先级/同名覆盖/Custom Agent Fork、Rules `#1540`/Hooks/Plugins/MCP 脱敏与组织策略、同名 Profile 隔离与 `#1610`、T15/T17 路径与符号链接越界拦截、T17 Opt-in 查询来源护栏与 NP-06 目录注册回滚） |
| `packages/web/tests/np13-native-settings-ui.test.tsx` | 新增测试 | 4 项前端专项测试（五分区渲染与命名空间/可用性展示、门控关闭与 `#1610` 诚实降级、`AgySettingsSlot` 向后兼容与展开挂载、视图筛选与键盘 Tab 切换） |

---

## 3. 已实现能力、未覆盖事项与无原生 Feed 清单

### 3.1 覆盖的能力范围与规则落实

- **配置三层 scope 不漂移与读写范围公布**：`AccountDefaults` < `Session` < `Turn` 通过 `resolveAgyConfigWithProvenance` 精确记录每字段 `sourceTier`、`observedActual`、`drifted` 与 `restorePatch`，并公开 `AGY_CONFIG_READ_WRITE_BOUNDARIES` / `NP13_READ_WRITE_BOUNDARIES`（账号默认由 HM Profile 管理；会话覆写仅在 live ACP 广告时走配置 RPC；Turn 覆写用后自动还原；原生私有文件严格只读不写）。
- **单授权 Profile 与隔离**：缓存键绑定 `instanceId + canonicalGeminiDir + source + workspaceRoot + accountFingerprint`，两个同 `displayName`（如 `"Work Gmail"`）的隔离 Profile 严格分槽；`oauth-business` 明确提示上游 `#1610` 并发文件隔离限制；保留手动登录/登出/切换，不添加单活切换（U07），不自动换号、不读 OAuth token 文件。
- **Custom Agents（`AGY-W03`）**：只读扫描工作区（`.agents/agents` > `.agent/agents`）与 Profile（`<geminiDir>/config/agents` > `<geminiDir>/agents`），仅提取 frontmatter 元数据（丢弃正文），显式标注 `switchSemantics: 'new_session_or_fork_required'` 与 `--agent` / `agy agents` / `/agents` 官方入口。
- **Skills 1.5.16 优先级（`AGY-E01`）**：严格按 `工作区 (.agents > .agent，从 cwd 向上到 repo root) > Profile/.gemini > ~/.gemini > ~/.agents/skills` 排序，记录 `shadowedBy` 与 `duplicates` 冲突清单，允许指向 `~/.gemini` 的安全 junction 并拦截越界链接。
- **Rules（`AGY-E02`）**：按路径哈希去重读取工作区及 Profile 下的 `AGENTS.md`、`GEMINI.md`、`.agents/rules/*.md`、`rules.json`；显式标注受 `#1540` 影响 ACP 运行时应用尚待复验，且 `systemPromptInjectionProhibited: true`。
- **Hooks / AGY Plugins / MCP（`AGY-E03` / `AGY-E04` / `AGY-E05`）**：严格区分 `agy_native` 与 `harnessmate` 双轨命名空间；Hooks 仅提取事件名与处理器数量、绝不执行；MCP 剥离所有 `env`/`headers`/`args` 密钥；融合管理员政策（`disabledPlugins`、`blockedMcpServers`、`hooksDisabled`、`allowedModels`、`permissionCeiling`）。
- **Opt-in 官方查询**：`runOptInOfficialQuery` 须同时满足 `gates.officialOptInQueryEnabled === true`、`userOptInConfirmed === true`、通过 `assertAgyConsumerProvenance` 验证用户直接来源、非 `agy_desktop`（针对 `skills`/`agents`）、且已验证 Profile，方可调用注入的执行器且 `mutatedConversation: false`。

### 3.2 明确无原生 ACP Feed / 仅官方入口的条目

以下 Capability ID 已在 `NP13_NO_NATIVE_FEED_CAPABILITY_IDS` 与 `boundarySurfaces` 中诚实标注为无原生 ACP feed 或上游受限，HM 不代理或开启其原生控制：

- `AGY-W03`（Custom Agent 运行时切换 RPC 未暴露，仅支持只读发现与 `--agent` / `/agents` 指引）
- `AGY-S07`（Projects：`acp` 未暴露原生 project 对象，仅校验本地已授权工作区与附加目录）
- `AGY-S16`（Credits / Billing / Plans：无交易或购买接口，仅展示只读 Tier 与 `/credits` 指引）
- `AGY-E02`（Rules：无标准 ACP Rules feed，且受 `#1540` 影响需复验）
- `AGY-E03`（Hooks：无标准 ACP hook feed，绝不自动运行）
- `AGY-E04`（AGY Plugins：无标准 ACP 列表/控制规范，独立于 HM V5 插件）
- `AGY-E06`（MCP Apps：无原生 ACP iframe view schema）
- `AGY-E07`（Learn / `/agy-customizations`：仅官方入口引导，不自动修改私有规则）
- `AGY-E08`（App Sidecars 与 `agentapi`：App 私有后台进程，HM 禁止启动）
- `AGY-E09`（Antigravity SDK / IDE 旁系入口：不引入第二套非官方运行时）
- `AGY-E10`（AGY Marketplace：无原生 ACP 市场接口）
- `AGY-X01`（AGY Remote Control：独立于 HM-Remote，HM 不代为开启）
- `AGY-X02`（AGY Remote Agents：未验证远端 ACP 作用域，不做本地推断）
- `AGY-X03`（AGY SSH Workspace：App 远端工程，不跨边界复用凭据）

### 3.3 未覆盖事项与真实证据缺口

- **未执行真实授权账号与付费模型（U01）在线采样**：本工作包未触碰用户生产账号、默认 `~/.gemini` 或线上付费额度，未对真机运行 `agy models` / `agy agents` / `agy -p /skills` 或实时 ACP Rules 应用（`#1540`）采样；因此所有 Capability ID 的实机等级保持在既有的 `null` / `0` / `1`，不因合成测试通过而抬升任何矩阵等级。
- **未直接修改共享接线层**：REST 端点挂载（`server/app.ts`）、`wiring/composition.ts` 中的 `registerEcosystemCapabilityDescriptors` 挂接及 `PluginSlotSync.tsx` 取数接线留待第 5 节协作提议由各自 owner 审查合入。

---

## 4. 测试验证、验证类别、Capability ID 与回归结论

### 4.1 已执行命令与真实结果

所有命令均在提交 **`12777f0a8d54b7de736eca1ac4a2ee0f49c74798`** 对应源码上验证通过（D 盘临时目录 `$env:TEMP='D:\HarnessMate\np13-temp'`，离线依赖自 `D:\HarnessMate\agy-np-pnpm-store` 安装）：

| 命令 | 退出码 | 结果摘要 | 验证类别 |
| --- | --- | --- | --- |
| `pnpm build` | `0` | **6/6** workspace 包构建通过（`plugin-api`, `plugin-sdk`, `protocol`, `daemon`, `web`, `electron`） | `synthetic`（构建） |
| `pnpm typecheck` | `0` | **6/6** workspace 包零 TypeScript 错误 | `synthetic`（静态类型） |
| `pnpm contracts:check` | `0` | Plugin SDK 契约检查通过，零破坏性变更 | `synthetic`（契约） |
| `pnpm --filter @harnessmate/protocol exec vitest run --maxWorkers=1` | `0` | **2 files / 6 tests passed**（含 `agy-native-v1.test.ts` 5/5、`protocol.test.ts` 1/1） | `synthetic` |
| `pnpm --filter @harnessmate/web exec vitest run --maxWorkers=1` | `0` | **22 files / 110 tests passed**（含新增 `np13-native-settings-ui.test.tsx` **4/4**、回归 `phase-agy-ui.test.tsx` **5/5**、`np03-workbench-ui.test.tsx` **7/7**、`np06-native-commands-ui.test.tsx` **4/4** 等全量前端套件） | `synthetic` |
| `pnpm --filter @harnessmate/daemon exec vitest run --maxWorkers=1` | 见注 | **41/42 files passed（228/230 tests passed）**；含新增 `agy-np13-ecosystem.test.ts` **7/7**、`agy-config-scope.test.ts` **4/4**、`agy-launch-context.test.ts` **6/6**、`agy-replay-protocol.test.ts` **2/2**、`adapters-codex.test.ts` **5/5**、`adapters-claude.test.ts` **4/4**、`adapters-acp.test.ts` **4/4**、`phase3-external-adapters.test.ts` **5/5**、`unified-context-bridge.test.ts` **3/3**、`handoff-v2.test.ts`、`agy-np02-*` **9/9**、`agy-np04` **10/10**、`agy-np07` **12/12** 等全部通过；仅 `multi-harness-orchestrator.test.ts` 内 2 项 Git worktree 并发测试在并行 worktree 机器负载下触发其自身硬编码 `30000ms` 超时 | `synthetic` + `replay_with_provenance` |
| `pnpm --filter @harnessmate/daemon exec vitest run --maxWorkers=1 tests/multi-harness-orchestrator.test.ts`（单独复跑 2 次） | 见注 | 两次单独复跑中，第一次 **5/6 通过**（前两次超时的第 5、6 项均在 `27418ms`、`26298ms` 通过，第 3 项触发 30s 超时）；第二次 **4/6 通过**（第 3 项在 `18668ms` 通过，第 5、6 项触发 30s 超时）。6 项断言功能本身均有通过记录，无任何代码回归 | `synthetic` |
| `git diff --check` | `0` | 无空白符错误或冲突标记 | 静态检查 |

> 注：NP-13 未修改 `multi-harness-orchestrator.test.ts`（超出写入范围）及任何 `core/orchestrator-service.ts` 代码；其 `30000ms` 临界超时系多 Wave-2 worktree 并行工作期间 Windows Git worktree 创建 I/O 抖动所致，已如实完整记录。

### 4.2 覆盖的 Capability ID、源码审计与风险对应

- **Capability ID**：`AGY-W03`、`AGY-S07`、`AGY-S08`、`AGY-S10`、`AGY-S11`、`AGY-S12`、`AGY-S13`、`AGY-S14`、`AGY-S15`、`AGY-S16`、`AGY-E01`、`AGY-E02`、`AGY-E03`、`AGY-E04`、`AGY-E05`、`AGY-E06`、`AGY-E07`、`AGY-E08`、`AGY-E09`、`AGY-E10`、`AGY-X01`、`AGY-X02`、`AGY-X03`
- **源码审计与风险缓解**：`S11`、`S12`、`S13`、`S20`、`S21`；缓解 `R-05`（路径越界/符号链接逃逸拦截）、`R-06`（凭据/OAuth token/原始 home 路径严格脱敏）、`R-07`（Opt-in 查询 `assertAgyConsumerProvenance` 护栏）、`R-08`（同名 Profile 隔离与 `#1610` 标注）、`R-10`（组织策略上限与模型白名单校验）、`R-11`（门控默认关闭，旧端零回归）、`R-15`（严格写入范围隔离）。

### 4.3 数据与其他 Harness 回归结论

- **旧 DB / 既有 Profile 目录 / 既有 HM 功能**：未修改 SQLite schema，未改写任何用户 `~/.gemini` 文件；所有扩展本地扫描门控默认 `false`；`collectAgyEcosystemSnapshot` 与 `AgySettingsSlot`（默认 feature-off）输出与行为完全保留。
- **其他 Harness 与公共契约**：Codex（5/5）、Claude（4/4）、Strict ACP（4/4）、DeepSeek/OpenCode 外置适配器（5/5）、Unified Context Bridge（3/3）、Plugin SDK 契约与 V4/V5 插件测试、AGY 1.5.14 回放（2/2）及前端 110 项全量测试全部通过。

---

## 5. 共享接口协作与变更提议

NP-13 严格遵守所有权边界，未改动以下共享文件，现向对应 owner 提交最小接线提议：

1. **NP-02 / 总指挥（`packages/daemon/src/harnesses/agy/native/wiring/types.ts` & `composition.ts`）**
   - **提议**：在 `AgyNativeFeatureFlags` 中新增可选 `readonly nativeEcosystem?: boolean`（默认 `false`），在 `wireAgyNativeRuntime` 中实例化 `AgyNativeEcosystemService`，并在 `nativeEcosystem` 开启时调用 `registerEcosystemCapabilityDescriptors(catalog, ecosystemService.getGates())`（关闭时调用 disposer 卸载）；可将既有 `HarnessCommandTools.inspectUsage` / `listAgySkillsForSession` 接入 `OfficialCliQueryExecutor` 供手动 Opt-in 查询调用。
   - **已附验证**：`packages/daemon/tests/agy-np13-ecosystem.test.ts` 已验证 `registerEcosystemCapabilityDescriptors(catalog, gates)` 与 disposer 回滚不破坏 NP-06 既有动作。
2. **NP-02 / 总指挥（`packages/daemon/src/server/app.ts` — 只读生态与 Opt-in 查询 REST 路由）**
   - **提议**：保留 `GET /api/v1/sessions/:id/agy/ecosystem` 现有 `{ ecosystem: AgyEcosystemSnapshot }` 不变（兼容 `AgyArtifactReviewPanel`）；新增或按显式参数暴露：
     - `GET /api/v1/harnesses/agy/instances/:id/ecosystem-catalog?sessionId=...` → 返回 `{ catalog: AgyEcosystemCatalogSnapshot }`（经 `AgyNativeEcosystemService.collectSnapshot` 生成，`gatesClosed` 默认 `true`，无秘密/未脱敏路径）。
     - `POST /api/v1/harnesses/agy/instances/:id/ecosystem-query`（body `{ queryKind: 'usage' | 'skills' | 'agents', userOptInConfirmed: true, sessionId?: string }`）→ 在路由层铸造 `mintAgyDispatchProvenance('human_direct', 'desktop')` 后调用 `runOptInOfficialQuery`，拒绝时按 `reasonCode` 映射 `403 FORBIDDEN` / `422 UNPROCESSABLE_ENTITY` / `503 SERVICE_UNAVAILABLE`。
   - **回滚**：移除路由或保持 `nativeEcosystem = false` 即立即返回门控关闭快照。
3. **NP-06（`packages/daemon/src/harnesses/agy/native/commands/router.ts` — `readManagerSnapshot` 对齐）**
   - **提议**：在总指挥装配 `AgyNativeCommandRouter` 时，将 `readManagerSnapshot` 中 `inspect_agents` / `inspect_mcp` / `inspect_credits` 对接到 `AgyNativeEcosystemService.collectSnapshot` 的脱敏摘要，统一命令面板（`/agents`、`/mcp`、`/credits`）与 Settings 视图的数据来源。
4. **NP-03（`packages/web/src/slots/PluginSlotSync.tsx` & `packages/web/src/api/client.ts`）**
   - **提议**：在 `daemonApi` 新增 `getAgyEcosystemCatalog(instanceId, sessionId?)` 与 `runAgyOptInQuery(instanceId, body)`，在 `PluginSlotSync.tsx` 的 `agy-account-settings` 槽位中当 `agyNativeWorkbenchEnabled` 为真时传入 `ecosystemSnapshot` 与 `onRequestOptInQuery` 给 `<AgySettingsSlot />`。
5. **NP-15（Recovery / Attach 工作区作用域校验复用）**
   - **提议**：`session/load` / `session/resume` 与 attach 前置校验可复用 `validateAuthorizedDirectory` 与 `inspectAgyProfileScopeBoundary`，防止重连时附加目录或 Profile junction 越界。

---

## 6. 独立审查者复验命令与回滚方案

### 6.1 独立审查者复验命令

```powershell
$env:TEMP = 'D:\HarnessMate\np13-temp'
$env:TMP = $env:TEMP
$env:TMPDIR = $env:TEMP
git status --short --branch
git diff --name-status 9826359a46d0518c88d12ca45318bb5cb891a73a..12777f0a8d54b7de736eca1ac4a2ee0f49c74798
git diff --check 9826359a46d0518c88d12ca45318bb5cb891a73a..12777f0a8d54b7de736eca1ac4a2ee0f49c74798
pnpm build
pnpm typecheck
pnpm contracts:check
pnpm --filter @harnessmate/protocol exec vitest run --maxWorkers=1
pnpm --filter @harnessmate/daemon exec vitest run --maxWorkers=1 tests/agy-np13-ecosystem.test.ts tests/agy-config-scope.test.ts tests/agy-launch-context.test.ts tests/agy-replay-protocol.test.ts tests/adapters-codex.test.ts tests/adapters-claude.test.ts tests/adapters-acp.test.ts
pnpm --filter @harnessmate/web exec vitest run --maxWorkers=1 tests/np13-native-settings-ui.test.tsx tests/phase-agy-ui.test.tsx tests/np06-native-commands-ui.test.tsx
```

### 6.2 回滚策略与命令

1. **无损门控回退（保留既有 Profile 目录与全部 HM 功能）**：
   - 保持 `DEFAULT_AGY_ECOSYSTEM_FEATURE_GATES` 所有扩展开关为 `false`（即当前默认状态），`AgyNativeEcosystemService.collectSnapshot` 立即返回 `gatesClosed: true` 且不执行任何本地扩展扫描与 Opt-in CLI 查询；`AgySettingsSlot` 在 `agyNativeWorkbenchEnabled === false` 时渲染完全回退为原账号界面。
2. **代码提交回滚**：
   ```powershell
   # 先逆序回滚交付报告提交（若已合入），再回滚代码与测试提交：
   git revert --no-edit 12777f0a8d54b7de736eca1ac4a2ee0f49c74798
   ```
   若已通过 merge commit 合入集成分支，则执行：
   ```powershell
   git revert -m 1 <mergeCommitSha>
   ```
