# 第四批插件解耦集成交付报告

候选历史包含完整 W1 `5ba2da21f149de667412231e6039868eabd009ac`（含 D1 `19a30d34d73c7a269ef7d911f40bb865a28c568a`）与完整 W2 `ed5b7f1cbddacedd50ec32dbf1df47426673f379`，W3 运行时与测试源码提交为 `9d90a06a72c0f8fc6b7af26e11e3d06bce3b086b`。交付分支为 `codex/b4-w3-performance` 与同一候选的 `codex/b4-integration`；未合并 `main`，未强推覆盖。

[W1 报告](W1.md) · [W2 报告](W2.md) · [W3 报告](W3.md) · [第四批方案](../../plugin-decoupling-batch-4-plan.md)

---

## 1. 候选与产物身份

| 项目 | 值 |
| --- | --- |
| 共同创建基线提交 | `9cfdb1b401416702355ef62cfe1f775267b4ea4e`（提示词文档 `728313a63dd8208fc0afe8261f9666c75b6bb545`） |
| W1 完整交付 SHA | `5ba2da21f149de667412231e6039868eabd009ac` |
| W2 完整交付 SHA | `ed5b7f1cbddacedd50ec32dbf1df47426673f379` |
| W3 运行时与测试源码 SHA | `9d90a06a72c0f8fc6b7af26e11e3d06bce3b086b` |
| 最终候选分支 | `codex/b4-w3-performance`、`codex/b4-integration`（最终固定 SHA 见交付回复与远端分支） |
| Windows x64 便携 EXE（B4） | `D:/HarnessMate/b4-tmp/w3/HarnessMate-Desktop-B4-portable.exe` |
| B4 EXE 大小 / SHA-256 | `309,538,131` bytes / `D5A91840DB42CC7019FC40D25C712C6BD2DF787AD50BCBA5CBA08316FEDB5FC0` |
| 历史对照与回退 EXE（B3） | `D:/HarnessMate/b3-tmp/w3/HarnessMate-Desktop-B3-portable.exe` |
| B3 EXE 大小 / SHA-256 | `308,440,113` bytes / `3D529D01230430BC299A48B745D7CE15EBFCADF533A1DA2135971EAF111F2336` |
| 交付日志与证据根（项目外 D 盘） | `D:/HarnessMate/b4-tmp/w3/delivery-evidence/logs/` |
| 剖析轨迹（Baseline & Post-fix） | `D:/HarnessMate/b4-tmp/w3/profiles/{baseline,optimized-1,optimized-2}/` |
| 正式性能原始样本 | `D:/HarnessMate/b4-tmp/w3/formal-performance/b4-{1,2,3}/raw.json`（复用 B2/B3 六次 raw） |
| 成品与回退运行根 | `D:/HarnessMate/b4-tmp/w3/product-and-rollback/` |

---

## 2. 插件与资源所有权核对

| 领域 / 资源 | 唯一所有者插件 | 公开契约 | 宿主与旧入口状态 |
| --- | --- | --- | --- |
| AGY 驱动、多账号、Native 运行时、收据与 outbox | `core.harness.agy`（默认实例 `harness-agy`；外部平级 `hm.plugin.agy-driver-lite`） | `harness.driver.agy.v1`、`agy.runtime.v1`、`agy.accounts.v1` | 内核无保留驱动类别（`isReserved()` 恒返回 `false`，`FORBIDDEN_DRIVER_IDS` 为空）；`app.ts` 仅转发旧 REST/WS，停用后契约状态 `disabled`、`/harnesses/agy/profiles` 返回 `404`，无宿主补建 |
| AGY 原生工作台前端 | `hm.plugin.agy-workbench-default` | `agy.workbench.v1`（`session.stage.embedded` + `when: { harnessKinds: ['agy'] }`） | 仅按 AGY 会话按需挂载，无备用审批按钮，无宿主 `AgyWorkbenchShell` fallback |
| 请求事实、决策 CAS、送达账本、到期与恢复、风险规则 | `hm.plugin.approval-center` | `runtime.requests.v1`、`runtime.request-delivery.v1` | `SessionManager` 无 `fallbackApprovalCenter`/`approvalTimers`；旧 `/api/v1/approvals*` 与 `/api/v1/approval-center/*` 仅转发，停用显式拒绝（HTTP `500`），无宿主 fallback |
| 权限模式默认策略 | `hm.plugin.approval-policy-default`（外部平级 `hm.plugin.request-policy-lite`） | `approval.policy.v1` | 策略决定 `manual`/`accept_edits`/`auto`/`plan`；`AgyAdapter` 不再私自本地自动批准 |
| 请求与审批队列 UI | `hm.plugin.requests-view-default`（外部平级 `hm.plugin.request-view-lite`） | `runtime.requests.view.v1`（`requests-queue`） | 独立构建（同时提供 `iframe` 与 `trusted-module`），宿主与默认聊天无 `pendingApprovals` 写 store；空闲时无 2 秒轮询 |
| 默认聊天、数据与运行 | `hm.plugin.chat-default`、`hm.plugin.session-data-default`、`hm.plugin.session-runtime-default` | `chat.view.v1`、`session.data.v1`、`session.runtime.v1` | 沿用第三批所有权；本批新增快照边界尾分页、`eventChunksBySession` 结构共享、`ChatSlotSync` 瘦身与可信模块挂载 |
| 前端模块共享运行时 | 宿主 `TrustedPluginModuleHost` + `shared-runtime.ts` | 同一公开桥 API + `module`/`mountMode` | 仅冻结共享 React/ReactDOM/Zustand，不暴露宿主私有 `useAppStore`；外部插件可用，保留 `iframe` 可选与可撤销；不宣称进程内硬隔离任意死循环 |

---

## 3. 标准检查与原始日志

所有标准命令在 `TEMP=TMP=TMPDIR=HARNESSMATE_TEST_TMP=D:/HarnessMate/b4-tmp/w3/standard-temp` 下执行，日志位于 `D:/HarnessMate/b4-tmp/w3/delivery-evidence/logs/`：

| 检查项 | 退出码 | 日志文件 | 说明 |
| --- | ---: | --- | --- |
| `pnpm contracts:check` | `0` | `final-contracts-check.log` | `docs/plugin-api/*` 契约生成物一致 |
| `pnpm build` | `0` | `final-build.log`、`web-rebuild-subscribe.log` | 6 包及全部捆绑插件 iframe + trusted-module 构建通过（含防耦合守卫） |
| `pnpm typecheck` | `0` | `final-typecheck-3.log` | 全仓 6 包 `tsc --noEmit` 通过 |
| `pnpm test`（全仓首轮 + 定向复跑） | 首轮 `1` → 修复后全绿 `0` | `test.log`、`daemon-fixed-8-retest.log`、`peer-assembly-and-w2.log`、`protocol-tests.log`、`final-web-tests.log`、`web-np17-recheck.log` | daemon 66/66 文件全通（首轮 58/66，修复 8 文件集成缺陷后全部复跑通过，含 `b4-w2-requests` 19/19、`b4-w3-performance-diagnostics` 2/2）；protocol 全通；web 34/34 文件 149/149 用例全通 |
| W2 浏览器验收 `scripts/b4-w2/requests-browser.mjs` | `0` | `w2-requests-browser.log` | 真实 Edge 无头浏览器 + 真实 AGY stdio 夹具 + 可信模块请求队列审批/到期/关闭/重启全通过 |
| `git diff --check` | `0` | `final-git-diff-check.log` | 零空白/冲突标记问题 |
| Electron `run stage` / `electron-builder` | `0` / `0` | `electron-stage.log`、`electron-package.log` | Windows x64 portable（`compression=store`） |
| B4 三次正式性能 + 短交互 + 默认 GPU | `0`（交互复测 `0`） | `formal-performance.log`、`interactions-v2.log` | 见第 4 节与 [performance-summary.json](evidence/performance-summary.json) |
| B4 成品功能 + 真实 B3↔B4 回退读回 | `0` | `product-and-rollback.log` | 7/7 成品与回退检查全部通过，见 [product-and-rollback.json](evidence/product-and-rollback.json) |

---

## 4. 性能汇总与原 B3-A8 状态

完整数据见 [performance-summary.json](evidence/performance-summary.json)、[interactions-summary.json](evidence/interactions-summary.json) 与 [W3.md](W3.md#4-性能验收结果与原-b3-a8-关联关闭)。

- **原 `B3-A8` 历史失败**：B3 历史就绪中位数 1,654ms（+41.01%）、驱动发出→渲染 P95 153ms（+10.87%）、最大可见更新间隔 524/606/756ms（>500ms）、总 V8 堆结束 35.49MB（+61.75%）。
- **本批 `B4-A8` 修复提交 `9d90a06a72c0f8fc6b7af26e11e3d06bce3b086b` 新证据（三次同机 `--disable-gpu` 成品）**：
  - `historyReadyMs`：1004 / 1036 / 945 ms（中位数 **1,004 ms**，相对 B2 **-14.41%**，上限 1,290.3 ms）→ **通过**
  - `pageReceiptToRenderedP95Ms`：84 / 85 / 85 ms（中位数 **85 ms**，相对 B2 **+1.19%**，上限 ≤ 100 ms）→ **通过**
  - `wsToRenderedP95Ms`：83 / 83 / 84 ms（中位数 **83 ms**，相对 B2 **-1.19%**）→ **通过**
  - `exactRuntimeReceiveToRenderedP95Ms`：135 / 130 / 131 ms（中位数 **131 ms**，上限 ≤ 200 ms）→ **通过**
  - `exactPostCommitToRenderedP95Ms`：105 / 102 / 107 ms（中位数 **105 ms**，与 `createdAt` 区分）→ **已实测**
  - `driverEmitToRenderedP95Ms`：144 / 134 / 127 ms（中位数 **134 ms**，相对 B2 **-2.90%**）→ **通过**
  - `maxUpdateGapMs`：166 / 175 / 166 ms（中位数 **166 ms**，相对 B2 **-72.19%**，**零 >500ms 停顿**）→ **通过**
  - `pageLongestTaskMs`：57 / 55 / 51 ms（中位数 **55 ms**，相对 B2 **-89.58%**）→ **通过**
  - `totalHeapAfter`（原预 GC 总 V8 堆口径）：21.51 / 21.56 / 21.24 MB（中位数 **21.51 MB / 21,512,864 B**，相对 B2 **-1.95%**，上限 24.13 MB）→ **通过**
  - 补充 GC 后保留堆：18.65 / 18.71 / 18.64 MB；补充 `firstSegmentProxyMs`：139 / 224 / 167 ms（中位数 167 ms，+15.97%，透明披露）。
- **短交互与默认 GPU 路径**：`--disable-gpu` 冷启→页面 20,230ms / 重载 1,091ms / 切会话中位数 1,108ms（热切 328–348ms）/ 打开文件 871ms / 停止输出 **297ms** / 堆 19.78MB；**默认 GPU（不带 `--disable-gpu`）** 冷启→页面 31,122ms / 重载 1,355ms / 切会话中位数 **421ms**（热切 280–421ms）/ 打开文件 1,557ms / 停止输出 **251ms** / 堆 20.58MB。
- **原 `B3-A8` 结论**：**已修复并通过（关联关闭）**。

---

## 5. 本批验收矩阵（B4-A1 至 B4-A10 及原 B3-A8）

| 编号 | 状态 | 证据、验证层级与边界说明 |
| --- | --- | --- |
| **B4-A1 AGY 平级替换** | **通过（离线/成品）；真实线上多账号未验证** | W1 套件验证双工作区/双账号、反转加载顺序不变与零保留类别；B4 便携 EXE 实测 `harness-agy` 与外部 `hm.plugin.agy-driver-lite` 平级安装注册。未在真实联网 Google OAuth 多账号下发轮次。 |
| **B4-A2 Native 真实归属** | **通过** | W1 契约/路由/工作台集成测试 + B4 便携 EXE 实测 `agy.runtime.v1` 归属 `harness-agy`，停用后契约状态 `disabled`、`/harnesses/agy/profiles` 返回 `404` 无宿主补建，旧 ID 与 `native_runtime_bindings` 连续。 |
| **B4-A3 权限模式有效** | **通过（mock/回放/浏览器）；真实联网 CLI 未验证** | W2 套件（`b4-w2-requests` 19/19）+ W2 真实无头浏览器 + 真实 AGY stdio 夹具验证 `manual`/`accept_edits`/`auto`/`plan` 真实回执、选项校验与文件系统执行结果；W3 补修隔离工具 `toolName` 策略拒绝。未发真实在线云模型工具轮次。 |
| **B4-A4 请求唯一决策** | **通过** | W2 SQLite immediate TX CAS、多端/策略/到期竞争、旧代次 409 与 `unknown` 送达恢复单测与集成测试全部通过；W3 补通 `agy-np02` 统一 CAS 闭环。 |
| **B4-A5 过期与界面** | **通过** | W2 浏览器脚本在当前 B4 候选可信模块模式下通过：到期退出 pending、`pendingApprovalCount` 归零、关闭按 ID 持久化、重启后不复活；B4 便携 EXE 重启验证悬挂 pending 收敛为 `cancelled`、会话回到 `idle`。 |
| **B4-A6 插件独立启停** | **通过** | W1/W2 域测试 + B4 便携 EXE 实测停用 `harness-agy`（`404`/`disabled`）与 `hm.plugin.approval-center`（`500`）均明确拒绝且无备用审批中心，重启用后规则（`custom.c543334b`）与服务恢复；工作台/请求 UI 停用不终止后台轮次。 |
| **B4-A7 数据回退** | **通过（测试副本，不撤销外部副作用）** | B4 便携 EXE + 真实 B3 EXE（`3D529D01...`）在隔离 D 盘副本完成 B3 种子（`sess_9880b799fede`）→ B4 升级与新写会话（`sess_d89e1a688b24`）/ `native_runtime_bindings`（`rt_b4_written_1`）/ `approvals`（`appr_b4_written_1`）/ 审批规则 → 真实 B3 读回全量通过，原种子 DB SHA-256（`34794973...`）零变动；未操作生产数据。 |
| **B4-A8 关联原 B3-A8** | **通过（关闭原 B3-A8）** | 三次同机 `--disable-gpu` 便携 EXE 正式测量全预算达标（历史 1004ms / 页面 P95 85ms / 精确运行 P95 131ms / 最大间隔 166ms / 原预 GC 堆 21.51MB）+ 队列/订阅/定时器实测 + 短交互与默认 GPU 另列。 |
| **B4-A9 功能边界** | **通过** | `hm.plugin.agy-workbench-default` 按 `when.harnessKinds: ['agy']` 按需加载（非 AGY 会话 0 次 `readWorkbenchState`），停用/卸载释放资源；`ChatSlotSync` 与构建守卫排除跨领域重复代码；通用可信模块（0 iframe）与 `iframe` 回退（1 iframe）对外部插件平等开放。 |
| **B4-A10 可恢复** | **通过** | B4 便携 EXE 实测坏绑定/坏包路径安全拒绝（404/400）且默认组合（`hm.plugin.approval-center`）不受破坏；重启恢复收敛在途 pending 并保留已结算事实；`plugin-peer-assembly` 验证候选升级失败保留旧修订与空组合恢复。 |
| **原 B3-A8** | **已修复并通过（关联关闭）** | 保留原 B3 失败记录，关联 W3 修复提交 `9d90a06a72c0f8fc6b7af26e11e3d06bce3b086b` 与本批三次成品性能证据关闭。 |

---

## 6. 分层验证汇总

| 验证层级 | 本批实际执行范围与诚实边界 |
| --- | --- |
| **Mock / Daemon & Web 单元与集成** | `pnpm contracts:check`、`pnpm build`、`pnpm typecheck`、`git diff --check`、daemon 66 文件（含 W1 AGY、W2 请求/策略/CAS、W3 尾分页与诊断、多引擎编排与恢复）、protocol、web 34 文件 149 用例全通过。 |
| **离线协议 / 固定驱动回放** | `hm.plugin.fixed-replay` 10k 历史 + 60s 25 批/秒流式压测、`agy-replay-protocol` 7 场景离线 ACP 回放、`agy-permission-peer.mjs` 真实 stdio 权限交互回放。 |
| **真实无头浏览器（Edge CDP）** | `scripts/b4-w2/requests-browser.mjs` 在当前构建的 `trusted-module` 模式下通过（真实点击审批、执行文件副作用、到期、历史关闭与守护进程重启不复活）。 |
| **成品便携 Electron EXE** | `D:/HarnessMate/b4-tmp/w3/HarnessMate-Desktop-B4-portable.exe` 在项目外 D 盘独立 `user/data/workspace` 通过：默认/外部 AGY、审批规则与策略/视图插件、停启恢复、坏组合拒绝、`trusted-module` 与 `iframe` 回退、重启 pending 收敛、短交互与默认 GPU 路径、真实 B3↔B4 副本升级读回。 |
| **性能（同机成品）** | 三次 `--disable-gpu` 正式测量 + 五点校准遥测 + 队列/订阅/定时器统计 + V8 CPU/Heap profile；另列默认 GPU 与切会话/打开文件/停止输出短交互时延。 |
| **真实联网 CLI / 云端账号** | **未验证**（无真实线上 AGY/Codex/Claude OAuth 云账号实机多轮与线上审批工具执行，如实保留，不以回放/mock 冒充）。 |
| **历史第三批其他未验证项** | 按方案不重开 B3-A1 至 A9 全套验收，保留原 B3 报告状态。 |

---

## 7. 剩余第五批范围与交接结论

第四批完成后，AGY 原生功能组与统一请求/审批均已归入可替换平级插件，且遗留 `B3-A8` 性能债已实证修复。以下范围按计划明确留归第五批：
- 应用整体布局、侧边栏/导航/Inspector/Modal 宿主壳层解耦；
- 设置页、插件中心、插件开发工具与远程访问迁移；
- 剩余宿主 `shellActions` 与数据库底座初始化彻底拆分（第四批空组合结论仅针对已迁业务领域，不提前宣称“空组合仅含纯内核”）。

本候选（`codex/b4-w3-performance` 与 `codex/b4-integration`）已满足第四批代码、性能、打包、成品验收与回退交付条件（除真实联网云账号/CLI 实机轮次外），交回规划会话做本批最终结论；未合并 `main`。
