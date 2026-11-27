# 第三批集成候选交付

候选历史包含完整 W1 `b7ad328e5cbb5861dbc3e2848485babed918cc65` 与完整 W2 `8378ad1c61edf513008d510f0623434a6eb1d113`，W3 运行时源码提交为 `98a3e41c7f441d9ecbe87a52b49eea8898a3a39b`。交付分支为 `codex/b3-w3-chat` 与 `codex/b3-integration`，最终固定候选 SHA 见交付回复及远端分支；未合 main、未强推。

[W1 报告](W1.md) · [W2 报告](W2.md) · [W3 报告](W3.md)

## 产物身份

| 项目 | 值 |
| --- | --- |
| Windows x64 portable EXE | `D:/HarnessMate/b3-tmp/w3/HarnessMate-Desktop-B3-portable.exe` |
| 字节大小 | 308440113 |
| SHA-256 | `3D529D01230430BC299A48B745D7CE15EBFCADF533A1DA2135971EAF111F2336` |
| B2 回退 EXE | `D:/HarnessMate/b2-fix-release/HarnessMate-Desktop-0.6.0-portable.exe` |
| B2 字节大小 | 306534907 |
| B2 SHA-256 | `045C52B8A7FF5D11C55E640A3228521637B7FFF8B3C695A95DD88B7EA529E48F` |
| 交付证据根 | `D:/HarnessMate/b3-tmp/w3/delivery-evidence/` |
| 正式性能原始数据 | `D:/HarnessMate/b3-tmp/w3/formal-performance/` |
| 最终升级/回退副本 | `D:/HarnessMate/b3-tmp/w3/rollback-final/` |

打包执行显式 `pnpm --filter @harnessmate/electron run stage` 后再运行 electron-builder（Windows portable x64、`compression=store`）。pnpm 11 的无 `run` 写法不是本项目 stage 脚本，早期原型未刷新资源，均不作为最终成品证据。成品仅在 D 盘解包/运行，fresh port/profile 避免同版本后台 daemon 复用。GUI 与性能启动参数含 `--disable-gpu`，不代表默认 GPU 路径已验证。

## 标准命令及原始日志

日志根为交付证据根的 `logs/`；工作树内也保留 `.tmp/w3/logs/`。

| 命令 | 退出码 / 结果 | 日志 |
| --- | --- | --- |
| `pnpm contracts:check` | 0 | `delivery-contracts.log` |
| `pnpm build` | 0 | `delivery-build.log` |
| `pnpm typecheck` | 0 | `delivery-typecheck.log` |
| 首轮 `pnpm test` | 1；daemon 314/325 passed，9 文件失败 | `verified-test.log` |
| 项目外临时根标准 `pnpm test` | 0；protocol 6 + daemon 325 + Web 141 = 472 passed；Electron 无测试文件 exit 0 | `standard-retest.log` / `standard-retest-exit.json` |
| Web 独立测试 | 0；31 files / 141 tests passed | `delivery-web-tests.log` |
| daemon 服务解析与 W3 桥定向测试 | 0；2 files / 6 tests passed | `targeted-final.log` |
| `git diff --check` | 0；最终提交前再次检查 | `delivery-final-diffcheck.log` |
| Electron stage / portable 打包 | 0 / 0 | `delivery-stage.log` / `delivery-package.log` |
| 六次成品性能执行 | 6/6 exit 0；性能预算未全部通过 | `formal-performance/runs.json` |
| 最终真实 EXE 升级/读回执行 | upgrade 0 / readback 0 | `rollback-final/upgrade.log` / `readback.log` |

首轮失败清单完整保留：AGY NP07 超时/cleanup EPERM；服务解析 golden 漏新 chat 绑定（已修复且定向通过）；B1 导入取消断言；B2 Git 工具超时；检查点外键；编排非 Git 拒绝与聚合唤醒；OpenCode external server 超时；plugin-sdk 和 triage-inbox cleanup EPERM。首轮 TEMP 位于源码仓库内，使非 Git 夹具继承了 Git 仓库；最终重跑改用 `D:/HarnessMate/b3-tmp/w3/standard-temp`。仅把经过重跑证实的项关闭，不认定所有错误均为环境问题。W1/W2 原报告的历史通过记录不覆盖本次集成结果。

最终标准流程原样执行，无 timeout/worker 额外覆盖：2026-11-27 23:33:02–23:49:56（Asia/Shanghai），exit 0。daemon 62 files / 325 tests，944.55s；Web 31 files / 141 tests，50.76s。除新增 chat 绑定的 golden 修正外，没有为首轮失败修改 W1/W2 业务源码或测试断言/预算。原始失败记录与中途被终止的探索性命令均保留，不计为最终通过证据。

## 六次同机成品性能

机器：Intel i7-1165G7，4 核 / 8 线程，物理内存 16,969,424,896 bytes，Windows 10 10.0.19045，Electron 35.7.5。使用打包后的两个 EXE，交替 B2/B3 各三次，不与构建/测试并行。每次独立 data/user/workspace，10,000 条历史事件（2,500 轮），60 秒、25 批/秒的中文/代码/工具输出，另有两个后台会话，同期持续输入未发送草稿。

夹具驱动 digest：`0c6e535cb7511c17c53503a45ded4ca031c4c275938187f996f51f540e110d29`。原始 JSON 的 `fixture` 记录历史序列化字节数和固定参数。所有六次都捕获 1,500 个可见标记，记录到的 Runtime exception 均为 0。早期误选后台会话的失败和并行负载下的 pilot 不纳入六次正式样本。

| 样本 | 历史就绪 ms | 首段代理 ms | 页面接收→渲染 P95 ms | WS→渲染 P95 ms | 驱动发出→渲染 P95 ms | 最大更新间隔 ms | >50ms 长任务数 / 最大 ms | 总 V8 堆结束 bytes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| B2-1 | 1091 | 144 | 81 | 81 | 138 | 597 | 18 / 536 | 26685572 |
| B2-2 | 1173 | 128 | 84 | 84 | 138 | 527 | 9 / 462 | 21939604 |
| B2-3 | 2065 | 161 | 93 | 93 | 153 | 611 | 30 / 528 | 21682108 |
| B3-1 | 1654 | 181 | 50 | 80 | 153 | 524 | 3 / 387 | 34776240 |
| B3-2 | 1858 | 105 | 52 | 99 | 173 | 606 | 6 / 405 | 35486276 |
| B3-3 | 1582 | 92 | 42 | 70 | 142 | 756 | 3 / 578 | 40026352 |

B2 的“页面接收”是宿主 WS 接收；B3 是 iframe 桥收到批事件，因此不能将两列直接解释为同一接收边界的相对改善。可比的 WS→渲染 P95 中位数为 84→80ms。可见更新时间取 DOM 变化后的两次 rAF，不是 Windows compositor 的实际呈现时间。

| 指标中位数 | B2 | B3 | 相对变化 / 结论 |
| --- | ---: | ---: | --- |
| 历史就绪 | 1173ms | 1654ms | +41.01%，超过 10% |
| 首段代理 | 144ms | 105ms | -27.08% |
| WS→渲染 P95 | 84ms | 80ms | -4.76% |
| 驱动发出→渲染 P95 | 138ms | 153ms | +10.87%，超过 10% |
| 更新间隔 P95 | 110ms | 115ms | +4.55% |
| 最大更新间隔 | 597ms | 606ms | +1.51%；绝对值仍超过 500ms |
| 页面最大长任务 | 528ms | 405ms | -23.30%；仍存在 >500ms 单次样本 |
| 总 V8 堆结束 | 21939604 bytes | 35486276 bytes | +61.75%，超过 10% |

每秒可见更新约 B2 11.88–12.13、B3 11.98–12.45，25 批驱动输出被已有链路合并；并非每批都独立刷新。B3 两个服务订阅峰值（数据 + 视图），B2 使用旧会话订阅，通用服务订阅数为 0，不能理解为 B2 没有订阅。堆记录含前后快照；B3 总量合计 shell 与 iframe isolate，没有强制 GC，不能由负增量或单次快照推断泄漏/无泄漏。队列上限是实现约束，未处理队列长度未完成实测。

**B3-A8 失败，预算不变。** 页面收到至渲染 P95 三次均≤100ms；驱动发出至渲染代理三次均≤200ms，可作为含驱动传输的保守证据，但不能替代精确“运行插件接收”时间。三次均出现 >500ms 更新间隔，历史、驱动发出代理与堆指标超过相对 10%。B2 本身超 500ms 不作为放行理由。

精确四点遥测尚不完整：旧 B2 二进制未暴露 runtime-entry / post-commit 时间与内部队列；canonical `createdAt` 不是提交时间；B3 服务 envelope `emittedAt` 是提交后发布代理，其 P95 为 103/133/91ms。短交互（切会话、打开文件、停止输出）已做功能检查，但没有三次同机独立延迟采样。完整预算不能宣布通过。

进一步核对原始序列：B3 三次驱动标记的最大发出间隔为 93/126/88ms，前台标记的 WS 接收最大间隔为 145/199/139ms，均没有出现相同的 >500ms 空档。可见停顿的主要调查范围因此是 WS 接收后的呈现链；不能仅归因于固定驱动不按频率发出。相关指标已写入汇总。

目前能确定的是插件页面接收后的 P95 达标，新增 iframe 冷启动/序列化与双 React isolate 存在成本；后者是堆回归的合理推断，不是完成 CPU/heap profile 后的归因。下一步应分别剖析历史抓取/投影、shell 与 iframe 重复运行时、>500ms 长任务，再决定优化或提出有测量支持的预算修订。本交付未修改阈值，也未声称该分析已修复性能失败。

六个完整 `raw.json` 与各自 setup/measurement 日志在正式性能目录，精简汇总已提交：[performance-summary.json](evidence/performance-summary.json)。正式采样结束的清理曾使用 PowerShell 缺少 JSON Content-Type 的关闭请求，随后由本任务拥有的进程树结束完成隔离；这不改变采样窗口，但不声称六次都是优雅退出。执行器现已修正关闭请求，最终数据回退使用正确 JSON 关闭并等待端口释放。

## 真实 B2 数据副本升级与回退

数据来源为实际 B2 EXE 的首个正式样本，不是手写 SQLite；未提供生产用户数据，因此结论限于这个有历史与新输出的 B2 测试数据副本。最终脚本另复制工作区，B3 新轮次的账本写入也位于副本中。

- 原会话 `sess_9a890c7926ca`：13,408 条事件、序号 1–13,408，B3 读取的新增尾部与 B2 原始采样一致。B3 与回退 B2 的全量规范化事件摘要均为 `b5a89dc55c4f5eb6cc259d90251dc43e80264283d7b4dfd69fee4da168ff903e`。
- B3 新会话 `sess_0f795f6ee12f`：39 条事件、序号 1–39，用户消息 1、结算 1；真实 B2 读回摘要 `366a367aa1366f73ec03941dc096fde6463dab2dce6d574d637734aaa4c8bad2` 与 B3 相同。
- 两个会话导出成功，原 4 个会话均仍存在，含新会话共 5 个；两版本搜索均命中新消息 `B3_ROLLBACK_NEW`。
- B2 读回旧/新账本，旧 version 2502、新 version 2，`summarizedUpToSeq` 均为 0（本夹具未执行摘要，0 不冒充事件消费末尾游标）。更完整的导入幂等、搜索水位和账本消费者游标由 W1/W2 集成测试覆盖，不能用本次两次 GET 代替。
- 原 B2 `harnessmate.db*` 文件前后摘要一致，`source-integrity.json` 为 unchanged=true；只在副本上升级与回退，不撤销外部 CLI/Git/账号副作用。

证据：[rollback-readback.json](evidence/rollback-readback.json)、[rollback-source-integrity.json](evidence/rollback-source-integrity.json)，完整最终执行日志位于 `rollback-final/`。先前的启动/执行器诊断保留在 `rollback/` 与日志中，不替代最终从头通过的结果。

## B3-A1–A9 验收矩阵

| 编号 | 状态 | 证据、边界与归属 |
| --- | --- | --- |
| B3-A1 平级替换 | 通过 | W1 双数据/运行实现、W2 同类驱动及反转加载顺序的集成场景；成品两工作区分别使用默认/外部聊天，实际发送/流式/中断/恢复/文件导航。账号联网不在此离线结论内。 |
| B3-A2 真实所有权 | 通过 | W1/W2 完整插件业务实现与 HTTP/WS 接线；W3 独立前端构建守卫、插件 KV、共享通用批桥和绑定挂载；实际停用无宿主聊天 fallback。宿主保留的 B4/B5 范围已单列。 |
| B3-A3 完整会话链 | 未验证 | 历史、创建、发送、流式、中断、附件、文件导航、成品 Enter/终端引用、模型/模式持久化、中文代码复制和 Markdown 下载均已覆盖；驱动配置/命令回执有 W1/W2 mock 结果。成品重试及完整斜杠命令链、插件开发命令执行尚未逐项验证；开关切换不能冒充命令执行。 |
| B3-A4 生命周期 | 未验证 | 聊天逐实例停用/恢复、运行中热更新、旧代次 409、一次结算、草稿不自动发送均有成品证据；W1/W2 崩溃/重启/驱动句柄有 mock 集成证据。两工作区并行运行时逐域崩溃与所有在途资源组合尚未完成成品矩阵。各所有者继续验收。 |
| B3-A5 协作链 | 未验证 | W2 完整交付与编排、handoff、压缩、分叉/合并、审批套件保留并重跑；不把协议/Mock 扩写为完整成品人工交接、Side Chat、子任务取消/恢复链。W2 业务所有者核对剩余项。 |
| B3-A6 数据与旧包 | 通过 | 真实 B2→B3 副本写入→真实 B2 读回，完整事件摘要/序号/会话集合/导出/搜索/账本相符，原 DB 不变；导入/搜索/变更水位的更广范围见 W1/W2/B1 标准套件。只覆盖生成的旧格式测试数据，无生产数据或外部副作用回滚。 |
| B3-A7 迁移回归 | 通过 | 最终标准套件覆盖 B1 导入/搜索与 B2 工具；默认/外部用量和 MCP 以实际浏览器操作固定后端通过，成品真实 pipe 终端及外部终端达到 65,536 字节后继续 WS 推送、上下文与重订阅通过；Windows 文件 URI/第 2 行成品侧栏导航通过。限本表注明层级，非真实账号/ConPTY/线上审批放行。 |
| B3-A8 性能 | 失败 | 六次同机成品已完成，页面 P95 达标但 >500ms 更新间隔、历史/堆/驱动发出代理回归超预算；精确旧包内部四点和短交互测量缺失。预算未改，W3/最终集成性能工作继续。 |
| B3-A9 内核改动可关闭 | 未验证 | 通用桥取消/代次与订阅释放有专项，实际空组合无页面并可恢复，会话不变；坏修订保留既有恢复测试。尚未对所有新增原语做成品任务/队列/订阅资源完全归零测量，不能声明最终空组合只含内核。 |

### B2 页面补验（浏览器 + 固定后端）

`scripts/b3-w3/b2-pages-browser.mjs` 使用当前构建启动独立 daemon 和实际 Edge 页面，账号/配置后端为固定夹具；不是最终 EXE 或真实账号配置写入。默认用量页读取 fixture 账号、保存策略；默认 MCP 页实际点击检查/确认安装、停用、确认移除；停用默认提供方后，两个外部页面分别从自己的 `/value` 路由获取实例 ID 与数据并显示，实例为 `user.b3-usage` 和 `user.b3-mcp`。不是只检查 manifest 或标题。

结果及截图在 `D:/HarnessMate/b3-tmp/w3/b2-pages-browser/`，精简结果为 [b2-pages-browser.json](evidence/b2-pages-browser.json)。`b2-pages-browser.log` exit 0。

### 成品终端与 Composer 补验

`scripts/b3-w3/product-terminal.mjs` 连接最终便携 EXE 的独立配置（API 51071 / debug 51072），不是开发服务器。真实 PowerShell 执行 `TERM_B3_EXEC_42`，上下文引用读回成功；实际 backend 为 `pipe`，没有把它记为 ConPTY。外部终端达到 65,536 字节后，原订阅累计帧从 10 增至 11，新中文标记出现在 WS、公开 context 的 `excerpt` 与重订阅快照中。原生引用 DTO 的文本字段为 `cleanText`，两个 DTO 没有混写。

`scripts/b3-w3/composer.mjs` 在同一成品的默认聊天 iframe 中操作：插件开发按钮开/关；选择权限 auto 与模型 replay，并从公开会话读取持久化结果；经公开 `chat.view.v1.editViewState` 添加终端引用，实际 Enter 发送，canonical 用户事件包含文本与引用 ID；回放到标记 49；点击代码块复制后读 Windows 剪贴板，中文代码一致；实际 Markdown 下载到独立 D 盘目录且包含用户输入。最终两脚本均 exit 0。插件开发开关通过不等于完整开发命令/发布流程已验证。

前置诊断保留在日志中：终端 chip 的折叠展示只显示标题/行号，最初检查整段 cleanText 的 selector 不正确；剪贴板首次检查的窗口处于 hidden、无焦点，宿主明确返回 `Document is not focused`。恢复本任务窗口后复制通过；脚本增加可见/焦点前提，PowerShell 剪贴板读取显式 UTF-8，下载按 session 分目录避免旧文件误判。没有因此修改运行时代码。

结果：[product-terminal.json](evidence/product-terminal.json)、[composer.json](evidence/composer.json)。完整日志 `product-terminal-complete.log`、`product-composer-final.log`，输出/下载目录 `D:/HarnessMate/b3-tmp/w3/product-regressions/`。两次检查均使用离线固定驱动，不代表真实模型账号。

## 验证层级

| 层级 | 本次证据与限制 |
| --- | --- |
| Mock / daemon 集成 | W1/W2、桥、B1/B2、审批/AGY 套件实际结果见标准测试；不代表线上工具执行 |
| 离线协议 / 固定驱动回放 | 三轮 B2/B3、工具/中文/代码/后台会话；无真实模型网络请求 |
| 浏览器 DOM | CDP 操作打包 Electron 页面与 iframe；非单纯 manifest/注册检查 |
| 成品 Electron | 普通启动、默认/外部聊天、两工作区、附件/文件导航、停用/恢复、热更新、空组合按钮恢复、真实旧包回退 |
| 性能 | 六次 finished product，A8 失败；缺少旧包精确四点内部遥测 |
| 真实 CLI / 账号 | 本次未发真实联网多轮；W2 报告中的只读 probe 是其历史证据，不升级为本次成品实测 |
| 审批 / AGY | 保留原链，离线回放与 mock 结果单列；真实审批工具执行、完整 native 人工操作链未验证 |
| Windows 通知 | 未目视验证系统原生横幅，不能以事件测试或 DOM toast 替代 |

## 交接与保留范围

本候选交回原规划会话独立验收；未合 main。第四批保留 AGY/native/审批领域， 第五批保留整体布局、设置、插件中心、远程和宿主 shell 管理。当前不会把 W1/W2 历史交付的覆盖空白写成已由 W3 完成。性能失败与未验证实机项目仍是放行前的剩余门槛。
