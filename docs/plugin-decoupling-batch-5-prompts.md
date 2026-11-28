# HarnessMate 第五批：唯一一套三个任务提示词

日期：2026-11-28。对应[第五批详细方案](plugin-decoupling-batch-5-plan.md)。以下每个 B5-W 编号只有一份正式提示词；先后顺序不是不同方案。

## 共同基准与顺序

| 项目 | 固定值 |
| --- | --- |
| 基准工作树真实名字 | **`fix_b3_a8_performance`** |
| 完整路径 | `D:/AppDataCache/.gemini/antigravity/worktrees/harnessmate_desktop/fix_b3_a8_performance` |
| 规划分支 | `codex/b5-plan` |
| 三个开发工作树共同创建 SHA | **`9d40b5e71a8e1b6ad717cdc618982b4b312ef6a5`** |
| 该提交的业务源码 | 第四批候选 `9df22350c10905abc2805380f216fa0735059824`；新增内容仅是规划/交接文档 |
| 不使用 | 脏 main、旧 `3b20`、旧 `8ef6`，以及规划分支之后可能移动的最新 HEAD |

三个开发工作树均从上述固定 SHA 建立：W1 使用 `codex/b5-w1-shell`，W2 使用 `codex/b5-w2-management`，W3 使用 `codex/b5-w3-kernel`。本规划只给出分支安排，尚未创建这三个工作树。

**正式开发顺序：W1 完整交付 → W2 合入完整 W1 后开发交付 → W3 合入完整 W2 后开发并集成。** 可以提前开三个会话阅读，不能并行修改同一前置接口，也不能只合入 W1 的首个契约提交就当作 W1 已交付。前置 SHA 在交付后从实际分支及报告锁定，不提前编造。

本文件之后的文档提交仅保存这套提示词，不改变共同创建点。所有会话在自己的新工作树开发，不修改基准工作树、不合并 main、不强推覆盖。

## B5-W1：应用布局、导航与前端状态

```text
你负责 HarnessMate 第五批 B5-W1，独立完成应用布局、导航与前端状态解耦。请实际开发并交付，不停留在建议；不额外派共同基线任务或自动 worker。

【工作树与起点】
基准工作树真实名字：fix_b3_a8_performance。
路径：D:/AppDataCache/.gemini/antigravity/worktrees/harnessmate_desktop/fix_b3_a8_performance。
规划分支：codex/b5-plan；固定共同创建 SHA：9d40b5e71a8e1b6ad717cdc618982b4b312ef6a5。
从此 SHA 建立自己的新工作树，分支 codex/b5-w1-shell。核对包含 B4 候选 9df22350c10905abc2805380f216fa0735059824。不要在基准工作树或脏 main 开发，不使用旧 3b20/8ef6，不以之后移动的 HEAD 替代固定起点。

【先读】
阅读适用 AGENTS.md、docs/plugin-decoupling-batch-5-plan.md 全文，重点第 4–6、9–12 节，以及 B4 coordinator-handoff.md。以源码确认已有机制；方案中拟定的接口名不代表已经存在。沿用 B4 可信模块/iframe、共享 React/Zustand、实例绑定及可撤销生命周期，不另造前端框架。

【必须完成】
1. 在本任务内先交可运行的应用入口、导航、UI 贡献公共契约与外部布局夹具。这只是内部检查点，不是 W1 完整交付，也不需要另开会话完成。
2. 默认布局变成普通插件，接管 Sidebar、Inspector、全局弹窗框架、命令面板、布局选择、导航及业务快捷键/菜单。业务子面板仍由原领域插件提供。App 根仅按组合挂载入口、处理通用错误及恢复；默认和外部布局走同一加载路径，不保留默认组件特判或宿主布局 fallback。
3. 拆 app-store 和 shell-bridge 的所有权：内核仅装配/连接/恢复状态，布局持有呈现状态，领域状态回所属插件；用公开服务、导航、贡献替代固定业务 actions。不能把整个 app-store 搬进一个总插件后要求其他插件导入它。W2/W3 待迁适配明确列调用方、所有者和删除条件。
4. 导航支持目标实例/页面、领域上下文、位置和明确结果，布局自己解释位置。保留 Windows 盘符、file URI、相对路径、空格中文及行列号的侧栏预览，不能整页跳走。快捷键处理 IME/焦点，切换后撤销旧注册。
5. KernelRecoveryView 使用独立最小状态/API，不导入业务 app-store、ModalHost、Sidebar 或聊天。空组合、入口未绑定、坏修订、布局自停用都可进入；安装/管理完整流程留 W2，恢复不依赖管理页。
6. 提供 shell-lite，用相同公开能力打开真实会话、聊天、文件侧栏和领域页。切换布局不停止后台轮次，不自动发送草稿；原布局资源能释放，坏版本能回退，必要重启有明确状态。

【边界与验证】
不重写 B1–B4 领域实现；新增能力必须是公开通用原语，预装/外部平级，不加官方白名单或逐业务授权。不扩大既有来源信任和模型审批范围。
按 B5-A1/A2/A8 验证默认及外部布局、导航、停启、恢复、旧数据/草稿和后台输出，运行适用定向测试、契约/类型/构建检查，不重跑第四批整套验收。临时文件/运行数据只放 D 盘，建议 D:/HarnessMate/b5-tmp/w1。

【完整交付】
更新 SDK/相关开发文档与适用 AGENTS.md，写 docs/plugin-decoupling-batch-5/reports/W1.md：公共调用示例、状态/资源所有权、清掉的宿主入口、W2/W3 接缝和遗留适配、真实检查结果。
提交并推送 codex/b5-w1-shell，不合并 main、不强推。最终给出 W1 完整固定交付 SHA、报告和可供 W2 合入的明确状态；不能只交首个契约提交。你不负责 W2/W3 开发或打最终包。
```

## B5-W2：设置、插件中心与 AI 插件开发

```text
你负责 HarnessMate 第五批 B5-W2，独立完成设置、插件中心和 AI 插件开发工具解耦。请实际开发并交付，不额外派共同基线任务或自动 worker。

【工作树与前置】
基准工作树真实名字：fix_b3_a8_performance。
路径：D:/AppDataCache/.gemini/antigravity/worktrees/harnessmate_desktop/fix_b3_a8_performance。
规划分支：codex/b5-plan；固定共同创建 SHA：9d40b5e71a8e1b6ad717cdc618982b4b312ef6a5。
从此 SHA 建自己的新工作树，分支 codex/b5-w2-management，不修改基准或脏 main，不使用旧 3b20/8ef6。
正式开发前，查验 codex/b5-w1-shell 或 origin 同名分支及 W1 报告，锁定 W1 完整交付 SHA，记录并完整合入，核对祖先关系。首个契约提交不算完整交付；W1 未完成时只阅读准备，不猜测接口或重做 W1。不要合并 main 传递代码。

【先读】
阅读适用 AGENTS.md、docs/plugin-decoupling-batch-5-plan.md 全文，重点第 4–5、7、9–12 节，以及 W1 报告。使用 W1 真实公共入口/导航/贡献，不继续调用私有 app-store。沿用现有安装、修订、信任、生命周期、恢复及 B4 前端机制。

【必须完成】
1. 设置、插件中心、实例/绑定/组合编辑、来源浏览和管理弹窗迁入普通管理插件。内核保留安装/修订/信任/装配机制；第三方管理页面使用同一 API，不能依赖官方 ID 或私有 registry/store。
2. 配置按所有者分开：启动端口/数据根等由通用宿主机制管理；模型、账号、策略、终端、远程、主题等由插件声明 schema 或提供设置视图。迁移旧字段和实例绑定，不再扩充中央厂商配置枚举。
3. 将 PluginAuthoring、PluginBuilderV2 的模板、生成/构建任务、诊断、预览及相关路由交给开发工具插件生命周期，删除 app.ts 的直接创建。不能只是用插件页面调用常驻宿主 Builder 单例。
4. 插件开发模式通过用户消息/模式上下文提供 SDK 版本、可用能力、结构、开发/安装/停用信息；不替换系统提示词，不持续污染普通模式。
5. 打通“需求→生成文件→构建诊断→安装开发修订→预览/选实例或绑定→热加载”。用此流程制作真实可运行的新页面/服务贡献插件。需要新进程或重启时给出可执行入口；缺少能力则补最小公开原语，不加业务特判。
6. 沿用首次来源信任，处理构建错误、生成取消、页面关闭、插件停用及重连的任务语义。坏修订只影响该修订，支持停用、上一修订与组合回退。
7. 管理插件自停用或坏自更新后，内核恢复仍可安装、停用和恢复；不把完整管理 UI 变成内核必需依赖。提供外部替代管理示例，能列实例、改绑定、安装、启停与回退。

【边界与验证】
预装/外部平级，不新增逐业务授权墙，不重做已迁领域功能。清掉属于本包的宿主路由、配置及 shell 适配，不能只移动目录。
按 B5-A3/A4/A8 完成开发链、外部替代、失败取消、停启和恢复验证，运行受影响测试及契约/类型/构建检查；不重跑第四批整套验收。临时文件/数据只放 D 盘，建议 D:/HarnessMate/b5-tmp/w2。

【完整交付】
更新 SDK/开发文档与适用 AGENTS.md，写 docs/plugin-decoupling-batch-5/reports/W2.md：完整 W1 SHA、公开 API、配置映射、任务所有权、生成/替代插件示例、检查和 W3 接缝/待清理清单。
提交推送 codex/b5-w2-management，历史必须包含完整 W1；不合并 main、不强推。最终给 W2 完整固定 SHA、报告和 W3 可合入状态，不以某个中间检查点代替完整交付。你不负责 W3 最终集成打包。
```

## B5-W3：远程、内核收尾、性能与最终交付

```text
你负责 HarnessMate 第五批 B5-W3，独立完成远程解耦、最小内核收尾、性能保留项和最终集成打包。请完成实际开发与交付，不额外派 worker。

【工作树与前置】
基准工作树真实名字：fix_b3_a8_performance。
路径：D:/AppDataCache/.gemini/antigravity/worktrees/harnessmate_desktop/fix_b3_a8_performance。
规划分支：codex/b5-plan；固定共同创建 SHA：9d40b5e71a8e1b6ad717cdc618982b4b312ef6a5。
从此 SHA 建新工作树，分支 codex/b5-w3-kernel。正式开发前从 codex/b5-w2-management 或 origin 同名分支及报告锁定 W2 完整固定 SHA，完整合入，核对其中包含 W1 完整交付；记录两个 SHA。前置未完成时只阅读准备，不重做 W1/W2。不修改基准工作树、脏 main 或第四批交付分支。

【先读】
阅读适用 AGENTS.md、docs/plugin-decoupling-batch-5-plan.md 全文，重点第 4–5、8–12 节；阅读 W1/W2 报告及第四批 coordinator-handoff.md。本批不重跑第四批整套验收，检查新候选和受影响链路。

【必须完成】
1. 配对、设备/撤销、远程订阅/同步、远程 UI 和旧协议适配归普通远程插件。内核只保留通用认证、身份、路由、WS/IPC/连接原语，不枚举远程领域帧。停用远程业务后本地仍可运行和恢复；实际设备身份测试不能被 loopback 自动本地授权掩盖，不向远程页面泄露本地全权令牌。提供 remote-lite 公共能力示例。
2. 按领域完成旧 HarnessMateStore 的查询、DDL/迁移和任务归属。现有 context.storage 是 KV，不能假装已有 SQL API；复用现有资源或补最小公开连接/事务/迁移原语。新空组合只建内核表，不能先构造完整业务 store；旧库表和 ID/seq/native 绑定、水位、审批终态保留。不能用一个总 store 插件代替逐域所有权。
3. 取消 builtin/services 静态领域工厂和 PluginManager.firstParty 的专用业务装配路径，捆绑/外部都走普通包入口。清理 app.ts、WS、Electron/Web 直接业务初始化、shell actions 和 fallback；旧 REST/WS 业务适配归可停用的普通兼容插件。
4. 更新 EXE staging/前端构建入口，业务资源可分发但空组合不导入执行。用模块可达图和运行记录证明：新空库/旧库空组合只有内核与独立恢复；没有领域后台任务/子进程或新建领域表。恢复默认组合装回功能，坏入口和管理自停用可恢复。列全量功能→插件→入口→表/任务→停用/回退所有权表。
5. 接续 B4-PERF-01：firstSegmentProxyMs 的 B2 中位数 144ms，B4 中位数 167ms，原上限 158.4ms。修首段路径及汇总判定，所有原方案可比指标均参与，不能删指标、换口径或改阈值。保留 B2/B3/B4 原始证据。
6. 对新候选沿方案固定 fixture（10k 历史、60 秒、25 批/秒、2 后台会话和草稿）同机测至少三次，正式对比沿用 --disable-gpu，默认 GPU 单列。首段中位数≤158.4ms，页面 P95≤100ms，精确运行 P95≤200ms，无>500ms可见停顿，历史中位数≤1290.3ms，原预 GC 总堆中位数≤24,133,564 bytes，其余可比项对 B2 回归≤10%；逐项判定并附原始数据。

【最终检查与交付】
按 B5-A1–A12 对最终新候选收口，覆盖受影响 B1–B4 链路；执行实际 pnpm contracts:check、pnpm build、pnpm typecheck、根 pnpm test、git diff --check。如根命令失败，修复后如实记录复跑结果，不能把分包通过写成根命令通过。
打 Windows x64 便携 EXE，在项目目录外的 D 盘隔离数据运行。用数据副本验证 B4→B5 新写会话/事件/绑定/规则或审批→真实 B4 EXE 读回；B4 回退包为 D:/HarnessMate/b4-tmp/w3/HarnessMate-Desktop-B4-portable.exe。不可操作用户原数据；进程外副作用不宣称自动撤销。
临时文件/依赖缓存/性能证据只放 D 盘，建议 D:/HarnessMate/b5-tmp/w3。更新 SDK/相关开发文档与适用 AGENTS.md，写 docs/plugin-decoupling-batch-5/reports/W3.md 和 integration.md，登记前置 SHA、所有权清单、性能每项结论、检查、回退、EXE 路径/大小/摘要和未验证范围。真实云端 CLI/OAuth/手机未测则保留未验证，不以 mock 冒充。
推送 codex/b5-w3-kernel 及同一完整候选 codex/b5-integration；已有分支先核对历史，不强推覆盖、不合并 main。最终给候选完整 SHA、EXE、两份报告和各完成/未完成项，交回规划会话判断。
```
