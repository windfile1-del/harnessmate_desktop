# B1-01 公共契约草案

共同基线待总指挥发布。B1-02 至 B1-05 可以用本文和 [JSON 夹具](fixtures/B1-01-peer-contracts.json) 开发契约替身。契约名与字段待接口确认，发行版路由和 SDK 导出以确认后的实现为准。

## 实例解析

建议原样使用同一个 `ServiceResolutionV1` 向业务、工作页和新 HTTP 适配器返回选择与状态。

```ts
type SelectionSource = 'explicit' | 'session' | 'workspace' | 'dependency'
  | 'composition' | 'single' | 'none';
type ServiceCandidate = { instanceId: string; pluginId: string; version: string };
type ServiceResolutionV1 = {
  contract: string;
  versionRange: string;
  candidates: ServiceCandidate[];
} & (
  | { instanceId: string; source: Exclude<SelectionSource, 'none'>; status: 'ready' }
  | { instanceId: string; source: Exclude<SelectionSource, 'none' | 'single'>;
      status: 'disabled' | 'unavailable' | 'incompatible' }
  | { instanceId: null; source: 'none'; status: 'unconfigured' | 'selection_required' }
);
```

- 优先级依次是显式实例、适用会话、适用工作区、调用方实例的依赖绑定、组合默认项。入口声明可用作用域及是否允许唯一候选自动选择。全局发现按实例枚举，会话入口从已授权会话取得工作区，工作区入口只读取当前工作区的选择。调用方依赖从宿主当前运行实例读取。
- 候选来自现有服务目录，保留当前运行中且版本兼容的实例，按实例 ID 稳定排序。同包两个实例分别列出。零候选且未选返回 `unconfigured`。多个候选，或只有一个但入口要求显式选择时，返回 `selection_required`。
- 首个适用的选择确定 `instanceId` 和 `source`。已知停用为 `disabled`，已有注册但契约版本不匹配为 `incompatible`，缺失、启动中、失败或没有注册目标服务为 `unavailable`。保留选中的 ID，直到用户改绑或清除。状态恢复后原绑定可直接使用。
- 新调用检查 `ctx.provide` 声明的服务语义版本，例如 `1.0.0` 与 `^1.0.0`。依赖入口可收窄版本范围。包版本和 SDK 版本各自独立。执行时固定所选实例及当前运行代次，在实例卸载或换代时交给现有失效处理。业务与 UI 均消费宿主的解析结果。

宿主触点建议为 `PluginManager.resolveServiceSelection(contract, options)`。`options` 由入口传入 `versionRange`、适用的 `sessionId` 或 `workspaceId`、`callerInstanceId`、`explicitInstanceId` 和 `allowSingleCandidate`。解析后复用实例服务查找与当前代次的 RPC 代理。新入口和已启用此契约的消费者使用该路径。既有 `ctx.get` 和无新选择参数的 `ctx.services.call` 保留兼容语义。

## 服务方法

每个方法接受一个 JSON 请求对象。时间戳为 Unix 毫秒，游标为提供方生成的不透明字符串，`nextCursor: null` 表示没有后页。示例中的 `1.0.0` 是 `ctx.provide` 的服务版本。

| 契约与方法 | 请求 | 成功响应 |
| --- | --- | --- |
| `history.source.v1` `discover` | `{ query?, workspaceId?, fromTs?, toTs?, cursor?, limit?, refresh? }` | `{ sessions: HistorySummary[], nextCursor }` |
| `history.source.v1` `read` | `{ ref: HistoryRef, cursor?, limit? }` | `{ ref, items: HistoryItem[], nextCursor, readStatus: 'complete' \| 'partial', warnings: string[] }` |
| `history.import.v1` `preview` | `{ input: ImportInput, workspaceId? }` | `{ input, existingSessionId: string \| null, targetWorkspaceId: string \| null, importable, items, readStatus, warnings }` |
| `history.import.v1` `import` | `{ input: ImportInput, workspaceId?, requestId }` | `{ sessionId, disposition: 'created' \| 'reused', partial, warnings }` |
| `session.search.v1` `query`（建议） | `{ q, workspaceId?, driverId?, fromTs?, toTs?, limit?, offset? }` | `{ hits: SearchHit[], nextOffset: number \| null, fallbackUsed, tookMs }` |
| `session.search.v1` `reindex`（建议） | `{}` | `{ jobId, status }`。初始状态为 `queued`、`running` 或 `completed`，以所选搜索实例为任务所有者 |

```ts
type HistoryRef = { sourceInstanceId: string; sourceId: string; nativeSessionId: string };
type HistorySummary = {
  ref: HistoryRef;
  title: string;
  harnessKind: string;
  updatedAt: number;
  workspaceHint?: { cwd?: string; label?: string };
};
type HistoryItem = { itemId: string; role: 'user' | 'assistant'; text: string; timestamp?: number };
type ImportInput =
  | { kind: 'native'; ref: HistoryRef; mode: 'attach' | 'mirror' }
  | { kind: 'bundle'; bundle: PortableSessionBundleV2; titleOverride?: string };
```

- `sourceInstanceId` 用于定位和调用。`sourceId` 由来源生成并标识同一原生记录命名空间，与 `nativeSessionId` 共同用于识别记录。同一 Codex 记录从 CLI 和桌面发现时共享记录身份。独立账户或来源可各自拥有同名记录。B1-02 确认身份生成与旧枚举映射。来源自行解释磁盘路径和账户，工作区线索只作展示与匹配输入。
- `readStatus: 'complete'` 表示本次读取没有因上限或格式问题丢失数据，仍可能有 `nextCursor`。`partial` 表示截断、格式损坏等导致内容不可完整读取，`warnings` 说明原因，续读能力由 `nextCursor` 表达。`itemId` 在同一记录内稳定，便于分页合并。
- 导入固定到 `ref.sourceInstanceId`。归档包复用协议的 `PortableSessionBundleV2`。同一导入意图的重试复用 `requestId`，同 ID 不同请求体返回 `E_CONFLICT`。旧 `attach` 的映射兼容、主动新建镜像的意图、归档包去重与会话写入提交规则由 B1-03 确认。提交开始前允许取消，事务开始后按事务结果返回。
- `SearchHit` 沿用 `SessionSearchHit` 的会话、轮次、条目、驱动及展示字段，插件页以纯文本和 `highlights` 偏移渲染。索引状态、进度订阅、取消和续跑的具体接口由 B1-04 与 B1-05 确认，旧重建响应由 B1-06 适配。

## 失败与取消

业务方法返回 `{ ok: true, value }` 或 `{ ok: false, error: { code, message } }`。建议业务错误码为 `invalid_request`、`source_unreadable`、`not_importable`、`cancelled`、`conflict`。`source_unreadable` 表示所选提供方已接到请求，但无法读到记录；发现列表中的其他实例可继续返回数据。业务取消由任务所有者使用可串行化的操作 ID 转发到拥有请求的实例，确认后才接入真实端点。

需要选择或所选实例无法调用时先返回 `resolution`。SDK 调用失败沿用 `PluginApiError`，建议歧义映射 `E_CONFLICT`、不兼容映射 `E_NOT_SUPPORTED`、未配置或停用映射 `E_SERVICE_UNAVAILABLE`，运行代次失效使用 `E_STALE_RUN`。新 HTTP 适配器携带 `resolution`，HTTP 状态和旧端点错误体由 B1-06 按既有约定对齐。

## 最小调用

夹具以方法的 `request` 和 `response` 为替身输入输出。插件清单的 `provides` 声明契约，`apply(ctx)` 用现有原语注册。以下为当前 SDK 已支持的显式实例调用，在草案替身中可逐字使用。

```js
// provider 的 apply(ctx) 中
ctx.provide('history.source.v1', {
  discover: () => fixture.source.discover.response,
  read: () => fixture.source.read.response,
}, { version: '1.0.0' });

// caller 的 apply(ctx) 中或插件请求处理器中
const providers = await ctx.services.list('history.source.v1');
const selected = providers.find(({ instanceId }) => instanceId === 'history.sample.a');
if (selected) {
  await ctx.services.call('history.source.v1', 'read', [fixture.source.read.request], {
    instanceId: selected.instanceId,
  });
}
```

工作页通过清单 `contributes.slots` 或 `ctx.slots.register` 注册 `workspace.pages`。服务路由通过 `ctx.routes.register` 挂到仅本机可访问的 `/api/v1/plugin-instances/:instanceId/routes/*`，工作页按 `<instanceId>:<slotId>` 导航。可信开发目录和预装包经同一个 `IsolatedPluginManager` 握手登记这些注册项。可信本地仍由用户授权，加载方式、权限和沙箱规则沿用现有宿主。真实调用用新解析检查版本与状态，夹具的显式调用只演示已存在的原语。

## 下游交接

| 任务 | 可消费的替身与待裁定项 |
| --- | --- |
| B1-02 | `source.discover`、`source.read`、两个同包来源实例。确认来源身份、旧来源映射、分页和取消。 |
| B1-03 | `import.preview`、`import.import`、创建与复用场景。与 B1-04 确认事务、快照和已提交变更读模型。 |
| B1-04 | `search.query`、`search.reindex`、不兼容与停用状态。与 B1-05 确认任务进度、取消和续跑。 |
| B1-05 | `resolution` 及方法响应、工作页键和稳定跳转 ID。状态直接显示宿主选择，切换或停用时取消旧页在途操作。 |
| B1-06 | 组合数据与旧端点映射。当前 `harnessmate-core` 是源码内生成的特殊层，发行组合需声明默认提供方，并保留旧 profile、旧 `extensions.filePreviewProvider`、手工绑定和空组合恢复。 |

组合迁移建议把三个出厂选择写入 `harnessmate-core` 发行组合层的数据，profile 的 `bindings` 优先于旧 `extensions.filePreviewProvider`，两者都优先于发行层默认。旧解释器可把发行层默认映射为旧 `source: 'default'` 并继续按启用状态判定，新增路径保留默认指向的停用实例。空组合无发行层默认，恢复时加载恢复快照引用的组合数据。B1-06 确认组合资源在源码运行和便携包中的定位。

## 当前调用路线与回落

| 路线 | 实际调用方与行为 |
| --- | --- |
| `resolveCapabilityBinding` | workspace、session 的绑定 GET/PUT，浏览器打开路由，`PluginManager.renderPeerFilePreview`，`PluginCapabilities.invokeTool`。会话优先于工作区，再取 profile 绑定。显式浏览器或查看器在各自入口覆盖解析；旧结果的 `source` 仍来自绑定查询。审批策略按绑定调用，选中但进程失效时拒绝工具调用。 [绑定](../../packages/daemon/src/plugin-host/composition/bindings.ts) · [HTTP](../../packages/daemon/src/server/app.ts) · [查看器](../../packages/daemon/src/plugins/plugin-manager.ts) · [审批](../../packages/daemon/src/plugins/plugin-capabilities.ts) |
| `DEFAULT_BUNDLED_PROVIDERS` | 浏览器 `hm.plugin.browser-desktop`、查看器 `hm.plugin.file-preview-text`、审批 `hm.plugin.approval-policy-default`，各自须有启用中的组合条目。已有 session、workspace 或 profile 绑定在该条件之前返回，即使目标停用。旧 profile 的 `extensions.filePreviewProvider` 映射进 `filePreview.v1`，同名 `bindings` 优先。 [绑定](../../packages/daemon/src/plugin-host/composition/bindings.ts) · [组合](../../packages/daemon/src/plugin-host/composition/profile.ts) |
| `PluginHost.resolveRecord` | 进程内 `ctx.get/has`、隔离 SDK `ctx.get` 对应的 `service.call`、隔离 SDK `ctx.services.call` 对应的 `services.call`。显式实例和调用方依赖绑定未注册时返回无服务。组合默认未注册或未配置时取第一个注册实例。`services.list` 单独按实例 ID 排序，依赖就绪只检查注册存在，未比较依赖版本。 [生命周期](../../packages/daemon/src/plugin-host/runtime/lifecycle.ts) · [RPC](../../packages/daemon/src/plugin-host/isolation/rpc-router.ts) |
| `PluginHost.get` | daemon HTTP 的 Usage、Failover、Triage、Git、ACP；会话管理的 Checkpoint、Ledger、`session-search`、Approval Center、Orchestrator、Compressor、Git、Handoff、Native Commands、Failover 和通用 `requireService`；插件管理的 ACP、清单 `inject` 诊断；RPC 的 Native Commands、Git、Handoff、Ledger。内建服务对 Git、Ledger、Compressor、Usage 使用同一旧回落。 [HTTP](../../packages/daemon/src/server/app.ts) · [会话管理](../../packages/daemon/src/core/session-manager.ts) · [插件管理](../../packages/daemon/src/plugins/plugin-manager.ts) · [RPC](../../packages/daemon/src/plugin-host/isolation/rpc-router.ts) · [内建服务](../../packages/daemon/src/plugin-host/builtin/services.ts) |
| 旧业务 HTTP | `/api/v1/harnesses/discovered-sessions`、`/api/v1/harnesses/import-session`、`/api/v1/sessions/import-bundle`、`/api/v1/search/sessions`、`/api/v1/search/reindex` 走会话管理，`getExplorerService` 在旧 `session-search` 缺失时直接创建 `SessionExplorerService`。B1-06 切换这五处入口，并与 B1-03 核对仍共用该类的 Fork、Side Chat 和导出调用。 [HTTP](../../packages/daemon/src/server/app.ts) · [会话管理](../../packages/daemon/src/core/session-manager.ts) |
| Web 浏览器入口 | `PluginWorkspaceLinks` 在 store 中没有浏览器绑定 ID 时从候选取首项。`InspectorDrawer` 和 `StudioModals` 使用旧绑定或查看器状态。B1-05 的新工作页直接消费 `resolution`，不用旧浏览器选择逻辑推导导入或搜索实例。 [工作页](../../packages/web/src/slots/PluginWorkspace.tsx) · [查看器](../../packages/web/src/components/InspectorDrawer.tsx) · [插件中心](../../packages/web/src/components/StudioModals.tsx) |

服务登记的代次清理依赖宿主 `ctx.provide` 的 disposer。隔离插件主动 `service.unprovide` 的 RPC 目前传包 ID，`onDynamicUnregister` 尚未处理 `service` 分支。后续实现应核对按实例主动撤销的目录准确性。现有回归验证的是停用实例和停止该代运行。

## 共同基线需要对齐的文件

实测工作区 `main` 的 HEAD 为 `9eee7916930ee4afc222670482d447e4aa77e3a7`，领先 `origin/main` 两个提交。HEAD 只有旧组合文件，平级插件实现、测试和本批任务单出现在未提交工作区。任务单第 6 节仍待填写共同基线，已有分支和 worktree 未找到指向 B1 的基线。

- daemon 宿主和装配包括 `plugin-host/{runtime,composition,isolation,compat}`、`plugins/plugin-manager.ts`、`plugins/plugin-capabilities.ts`，以及依赖它们的 `db/sqlite.ts`、`server/app.ts`。
- B1-01 编译和文档基线包括 `packages/plugin-api`、`packages/plugin-sdk`、`packages/protocol/src/canonical.ts`、`scripts/plugin-contracts.mjs` 和 `docs/plugin-api` 的现有改动。
- 回归还依赖 `plugins/bundled/`、`packages/daemon/tests/plugin-peer-assembly.test.ts`、`packages/web/tests/peer-plugins.test.tsx`，以及未提交的 Electron 和 Web 平级装配代码。

总指挥需给出包含上述实现与测试的共同提交，或明确快照位置、文件清单和基线测试结果。仓库中的草案与 JSON 夹具可用于替身联调。宿主实现、生成契约、任务代码提交和真实端点联调以该基线及接口确认结果为前提。

## 当前快照验证

Windows Node `v24.18.0`、pnpm `11.21.0`。测试副本从共享工作区复制 686 个 Git 已跟踪或未忽略的文件。复现目录为 `D:\HarnessMate\harnessmate_desktop\data\b1-01-audit-7bf56bc7\src`，专项探针位于副本的 `packages/daemon/tests/b1-01-baseline-probe.test.ts`。标准输出保存在其上一级目录。`TEMP`、`TMP`、依赖缓存及测试用户目录均指向 D 盘，未使用实际历史数据。

| 实际命令 | 退出码与结果 |
| --- | --- |
| `pnpm --filter @harnessmate/protocol --filter @harnessmate/plugin-api --filter @harnessmate/plugin-sdk build` | `0`，三包依赖构建通过 |
| `pnpm contracts:check` | `0`，现有公共快照匹配 |
| `pnpm typecheck` | `0`，六个工作区包通过 |
| `pnpm --filter @harnessmate/daemon test tests/plugin-peer-assembly.test.ts tests/session-explorer-approval.test.ts` | `1`，9/11。Fork、Side Chat 和归档往返用例与敏感请求用例超过默认 5 秒 |
| 同一 daemon 命令加 `--maxWorkers=1 --testTimeout=20000` | `1`，10/11。敏感请求用例通过，Fork 相应用例超时 |
| `pnpm --filter @harnessmate/daemon test tests/session-explorer-approval.test.ts -t 'supports native & portable Fork' --maxWorkers=1 --testTimeout=60000` | `0`，单独重跑目标用例通过 |
| 同一 daemon 双文件命令加 `--maxWorkers=1 --testTimeout=60000` | `0`，11/11。浏览器、查看器、审批策略绑定和会话回归均通过 |
| `pnpm --filter @harnessmate/web test tests/peer-plugins.test.tsx tests/phase2-explorer-approval.test.tsx` | `0`，8/8 |
| `pnpm --filter @harnessmate/daemon test tests/b1-01-baseline-probe.test.ts` | `0`，3/3。确认反转注册顺序改变旧 SDK 首项回落，显式实例稳定，依赖当前忽略版本，旧组合绑定在清空和恢复后保留 |
| `git diff --check` | `2`，共享区原有 `packages/plugin-api/src/index.ts:10` 存在末尾空白行。两份交付物使用 `git -c core.autocrlf=false diff --no-index --check -- NUL <文件>` 分别检查，退出 `1` 表示文件有差异，均无空白错误输出 |

从同一副本进入根目录即可重跑。新副本可先以 `pnpm install --frozen-lockfile --ignore-scripts --store-dir <D盘存储目录>` 安装依赖，再运行表内三包构建和验证命令。首次离线安装因缺少 registry 元数据退出 `1`，联网使用锁文件重装退出 `0`。JSON 夹具已通过 Node 解析和语义断言，包括来源引用一致、重试复用会话 ID、检索结果指向导入会话和八种实例状态。

`pnpm contracts:generate` 待公共 API 源码变更时运行。本次只针对当前平级实现与契约替身验证。新解析专项验收、整库构建和测试、桌面打包和真实端点联调留待共同基线及实现就绪。
