# HarnessMate 第三批 · 三个独立会话提示词

本文件指定本轮推荐执行方式：**W1 完整交付 → W2 完整交付 → W3 开发并完成集成**。三个工作树可以提前建立；未到正式开工条件的会话只做阅读和准备，不依赖未完成接口进行正式接线。

## 基准工作区的真实身份

| 项目 | 已核对的值 |
| --- | --- |
| 现有工作树目录 | D:/Codex/OpenAI-Codex-data/worktrees/8ef6/harnessmate_desktop |
| 名称辨识 | harnessmate_desktop，位于 8ef6 目录下的第二批集成工作树 |
| 当前分支 | codex/b2-integration |
| 三任务共同创建起点 | 95788293e5af771ae601b4a6385bfefc5c16fecf |
| 使用该提交的原因 | 包含 B2 修复、最终验收记录和 B3 方案；后续本文件是纯文档补充 |
| 保留的主工作区 | D:/HarnessMate/harnessmate_desktop，main 有既有未提交改动，不作为本轮创建起点 |

三个新工作树都以固定提交 9578829 为共同祖先，分支分别使用下表名称。已打开的新工作树是各会话唯一开发目录，基准目录只用来辨认来源，不作为三人共用的写入目录。

| 会话 | 建议新分支 | 正式开工前要合入的交付 |
| --- | --- | --- |
| W1 | codex/b3-w1-session | 无；从固定基线开始 |
| W2 | codex/b3-w2-drivers | W1 完整交付的固定 SHA |
| W3 | codex/b3-w3-chat | W2 完整交付的固定 SHA，且包含 W1 |

最终由 W3 给出 codex/b3-integration 候选，不另开第四个统筹开发会话。本规划会话负责方案与独立验收。无需合并 main 来传递前置成果。

W1 早期契约提交仍是包内检查点，不能误认为 W1 已完整交付。W2/W3 从前置报告和对应任务分支查验固定 SHA，合入整个交付历史。

完整范围以[第三批实施方案](plugin-decoupling-batch-3-plan.md)为准；新增契约仍需落实成真实 SDK 与消费者接线。本文件只明确这三个手动会话的启动和交接方式，不重做 B1/B2 已完成任务。

## 会话一：B3-W1 会话数据与运行

```text
你负责 HarnessMate 第三批 B3-W1：会话数据与运行。直接完成开发、测试和交付。

工作区与基线
- 基准现有工作树：D:/Codex/OpenAI-Codex-data/worktrees/8ef6/harnessmate_desktop。
- 固定起点：95788293e5af771ae601b4a6385bfefc5c16fecf，对应 codex/b2-integration，包含 B2 修复和第三批方案。
- 在从此提交建立的独立工作树工作，任务分支 codex/b3-w1-session。不修改基准工作树或脏 main。
- 开始先核对 git status -sb、git rev-parse HEAD、分支及基线祖先关系，保留已有改动。
- 先阅读当前工作树的 docs/plugin-decoupling-batch-3-plan.md，重点第 5、6、9、10、11、12 节，以及全量解耦设计。方案中的新 API 名称是草案，优先复用现有接口。
- 本轮执行顺序以本提示词为准；9578829 中旧方案的 C1 并行接线安排已由后续文档改为完整交付后串行接力。

目标
将会话数据与运行真正交给平级插件：数据由数据插件读写，轮次和句柄由运行插件管理，宿主仅负责通用资源与转发。交付可加载的默认实现及仅依赖公开 SDK 的外部替代样例。

实施
1. 首个可复用提交固定会话数据/运行 DTO、调用与事件语义、资源所有权、旧数据/模拟流夹具。该提交属于本任务，不另建共同基线任务。新类型优先分文件，交付实际可运行的接口。
2. 默认数据插件接管工作区、会话、事件、轮次块、运行记录、续接绑定、导入事务和已提交变更。沿用旧 SQLite 表、ID、seq、native ID 和导入水位。保留 hm.session-data.v1 的兼容语义，并接好 B1 导入/搜索及 B2 账本、Studio、收件箱、用量等消费者。
3. 会话数据、事件/块和变更日志按正确事务边界提交，提交后发布。外部实现可以使用自己的存储；游标包含数据提供方/流身份，不能把不同实例的 seq 当同一个全局游标。
4. 运行插件接管 liveHandles、activeTurnMeta、启动互斥、文本合并、发送、中断、关闭及崩溃恢复。发送回执支持 requestId 幂等；迟到输出不能污染新代次，结果不明的外部调用不自动重复发送。
5. 默认运行可先消费 B2 已注册驱动，通过现有公开 handle 或窄适配工作；为 W2 留好替换入口，不自行重写驱动及协作实现。配置区分请求值与驱动确认值，完成/中断前排空最后一段输出。
6. 改造 app.ts、旧 HTTP/WS、历史数据临时适配和 SessionManager。本批迁出操作的门面只做解析与转发，不能继续直接写业务库或创建备用服务。
7. 通过明确衔接面保留现有 AGY native、审批、provenance 和 held settlement 行为；AGY/审批完整领域迁移留第四批。尚未迁移的协作调用使用明确窄接口，交 W2 后续接管。
8. 新增通用存储/事务原语确有必要时，说明缺少能力的实际调用路径，补最小通用能力。沿用可信插件系统访问，不新增官方专用入口、每业务方法授权或同类实现数量限制。

范围
主负责 daemon 的 session-manager、会话/工作区路由、旧 WS 会话适配、history-import-adapter、session-change-feed、相关 SQLite 领域操作与数据/运行契约。驱动注册由 W2 改造，聊天视图由 W3 迁移；共用工厂和组合只修改本域段落。

验收与交付
- 默认和外部 session-data-lite、session-runtime-lite 能在两个工作区分别使用：旧会话打开→发送→持续流式→中断→再次发送→重启恢复。
- 覆盖重复发送、事件顺序、迟到回调、断线追补、停用/更新/崩溃、投影游标与其他实例继续运行。
- 保留旧 API、B1/B2 数据消费和 B2 旧包回退能力。不要用临时测试专用宿主实现代替产品接线。
- 运行契约/类型检查、受影响的 daemon 与 B1/B2 纵向回归；测试和所有临时文件放 D 盘，推荐独立根 D:/HarnessMate/b3-tmp/w1。
- 编写 docs/plugin-decoupling-batch-3/reports/W1.md，记录实现/插件/实例、数据唯一写入者、契约、后续 W2/W3 消费示例、真实命令与日志、未验证项。
- 完成后提交并推送 codex/b3-w1-session；不合并 main，不覆盖 B2 固定分支。
- 最终明确给出 W1 完整交付 SHA、报告路径和“可供 W2 合入”的状态。只交首个契约提交不算本任务完成。
```

## 会话二：B3-W2 通用驱动与协作

```text
你负责 HarnessMate 第三批 B3-W2：通用驱动与协作。直接完成开发、测试和交付。

工作区、基线与顺序
- 基准现有工作树：D:/Codex/OpenAI-Codex-data/worktrees/8ef6/harnessmate_desktop。
- 三个任务共同起点：95788293e5af771ae601b4a6385bfefc5c16fecf，codex/b2-integration。
- 使用从此提交建立的独立工作树，任务分支 codex/b3-w2-drivers，保留已有改动，不修改基准工作树或 main。
- 本任务正式开发排在 W1 完整交付之后。先核对状态/分支/HEAD，再从本地或 origin/codex/b3-w1-session 找到完整交付提交，核对 W1 报告，记录固定 SHA，并把该完整提交合入当前任务分支。不能只合首个契约草案。
- 若前置交付尚不存在，明确报告缺少什么，可先阅读和准备，不凭空重做 W1。
- 阅读 docs/plugin-decoupling-batch-3-plan.md 的第 5、7、9、10、11、12 节及 W1 报告，以 W1 实际契约接线。
- 本提示词的完整交付后串行接力要求优先于 9578829 旧方案中的 C1 并行接线安排。

目标
Codex、Claude、通用 ACP 驱动和会话协作都由平级插件实现；默认与第三方同类驱动能并存、按实例选择。交接、压缩、分叉/合并、Side Chat、编排可以分别关闭和替换。

实施
1. 把 CodexAppServerAdapter、ClaudeStreamJsonAdapter、通用 AcpAdapter 的创建、CLI 配置、会话句柄及销毁归入各自插件，使用公开 SDK 注册和调用。
2. 驱动目录按“插件实例＋声明 ID”管理，取消第三方不得提供 codex/claude/acp 等内置类别的硬编码限制；同时调整 registry、isolated-manager、runner-bootstrap、RPC 和旧测试。不能只删报错但仍由一个全局 codex 键决定实现。
3. 区分 pluginId、插件 instanceId、harnessId/账号、driverId、runId 和 nativeSessionId。旧 harnessId 和配置通过组合/别名延续。正在运行的句柄固定提供方和代次，不随绑定修改换到另一实例。
4. 同包两个实例可使用不同 CLI 路径、home、账号与配置；默认与外部同类实现从标准会话入口可选。模型、Plan、Goal、压缩、额度、原生插件与 Skills 的操作依据驱动真实能力及回执展示。
5. 将 ContextCompiler、上下文快照/脱敏/投递业务归入交接插件，保留 pending/确认/结果不明的投递语义；压缩插件拥有后台 rollup 和生命周期。
6. 从 SessionExplorerService 迁出剩余分叉、合并、Side Chat、导出业务；OrchestratorService 通过 W1 公开数据/运行契约创建、发送和取消子任务，接 W1/B2 Git 与账本能力。
7. 与 W1 的门面接线配合，清除本域 fallbackExplorer、fallbackOrchestrator、fallbackCompressor；旧 URL 可保留转发，宿主不重建停用的功能。
8. 编排深度、并发、超时和工作树策略是默认插件的行为/配置，不变成内核对所有实现的限制。各协作插件分别启停，原实例结算已开始的任务和写操作。
9. AGY 原生完整迁移和审批策略重设计留第四批；保持现有 AGY ID、native 路由、权限/审批及恢复回归。

范围
主负责 harnesses 的 registry/types/Codex/Claude/ACP、公开驱动 DTO、隔离驱动 RPC，以及 context-compiler、outbound-gate、compression、session-explorer 剩余协作、orchestrator。本域工厂/组合自己接线；W1 数据与运行实现保持其所有权，前端整块迁移交 W3。

验收与交付
- 外部插件仅依赖公开 SDK 即可提供同类驱动；两个工作区使用不同实现，改变加载顺序不改变绑定。
- 完成默认 Codex→外部 Codex 实现→Claude→通用 ACP 的模拟/协议回放链，验证恢复、持续输出、配置回执、取消及代次隔离。
- 覆盖交接不明状态、压缩停启、分叉/合并、Side Chat、子任务取消/重启/结算与工作树保留。
- 默认与外部样例、安装入口、数据/配置别名迁移、撤销和恢复必须是真实产品链路。
- 运行契约/类型检查、受影响的驱动/协作和 W1/B1/B2 集成回归。mock、协议回放、真实 CLI 和真实账号分别记录；临时根放 D:/HarnessMate/b3-tmp/w2 等 D 盘位置。
- 编写 docs/plugin-decoupling-batch-3/reports/W2.md，记录已合入的 W1 完整 SHA、契约变化、插件/实例、旧 ID 映射、在途/数据归属、测试证据、给 W3 的消费示例和未验证项。
- 完成后提交并推送 codex/b3-w2-drivers。该分支历史必须包含完整 W1 交付，不 cherry-pick 零散片段，不合并 main。
- 最终给出 W2 完整交付 SHA、包含的 W1 SHA、报告路径与“可供 W3 合入”的状态。
```

## 会话三：B3-W3 聊天界面、性能和集成

```text
你负责 HarnessMate 第三批 B3-W3：聊天界面、性能和最终集成。直接完成开发、测试、打包和交付。

工作区、基线与顺序
- 基准现有工作树：D:/Codex/OpenAI-Codex-data/worktrees/8ef6/harnessmate_desktop。
- 三个任务共同起点：95788293e5af771ae601b4a6385bfefc5c16fecf，codex/b2-integration。
- 使用从此提交建立的独立工作树，任务分支 codex/b3-w3-chat，保留已有改动，不修改基准工作树或脏 main。
- 本任务正式开发排在 W2 完整交付之后。核对状态/分支/HEAD，从本地或 origin/codex/b3-w2-drivers 取得完整交付，阅读 W1/W2 报告，验证其中包含 W1 完整提交，记录固定 SHA 后合入当前分支。
- 不能只合契约草案，也不能自行重写 W1/W2。前置交付缺失时先指出缺口，进行不依赖它的阅读/准备。
- 阅读 docs/plugin-decoupling-batch-3-plan.md，重点第 5、8、9、10、11、12 节，以 W1/W2 实际接口接线。
- 本提示词的完整交付后串行接力要求优先于 9578829 旧方案中的 C1 并行接线安排。

目标
默认聊天、Composer、消息投影和聊天业务状态由普通可替换插件拥有；外部聊天通过同一公开入口完整工作。最终形成包含 W1/W2/W3 的可运行候选、性能证据及旧包回退记录。

实施
1. 将 ChatStage、Composer、消息与工具渲染、草稿、会话命令及业务 store 迁入默认聊天插件。App 根据作用域和绑定挂载所选贡献，默认/外部走同一路径，不保留默认插件 React 特判或宿主 ChatStage fallback。
2. 优先复用现有页面资源机制，将原 React 界面构建为插件自身前端产物。不得重新打包整个宿主 app-store、依赖私有 Zustand 对象或在每个页面启动第二套独立全局连接。
3. 数据和运行通过 W1 公共契约，驱动命令/配置及协作通过 W2 契约调用。服务调用和订阅缺能力时补通用桥：明确实例、快照边界、游标、批量事件、取消和代次。底层不增加逐项聊天业务开关或权限弹窗。
4. 处理历史加载与实时输出的竞争、重复、间隙和断线续读。跨桥按批传递，避免逐字符 RPC、全历史反复复制与整页重投影。
5. 切换/停用聊天页面不停止后台轮次；恢复按已提交事件追补。草稿、附件引用、滚动位置可保存/交接，不自动发送恢复的草稿。
6. 完整保留输入、附件、终端引用、Windows 文件 URI/行号侧栏导航、Markdown/代码块、复制导出、模型/权限模式、插件开发模式、命令及流式状态。整体布局/设置/插件中心/远程完整迁移留第五批。
7. 外部 chat-lite 必须实际完成历史读取、发送、持续流式、中断、恢复与文件导航，验证两个工作区使用不同聊天实例。
8. 用固定驱动回放比较 B2 与 B3：10,000 条历史事件，60 秒、25 批/秒混合中文/代码/工具输出及后台会话，至少三次同机成品运行。记录驱动接收、提交、WS 接收、可见更新，首段/P95、刷新间隔、长任务、堆内存和队列/订阅数量。沿方案预算验收：页面收到至显示 P95≤100ms，运行接收至显示 P95≤200ms，有输入时无超过500ms的停顿，相对B2回归≤10%。这些是待实测预算，需调整时先给测量和理由，不能为通过测试静默改阈值。
9. 完成 W1/W2 与聊天的最终接线。集成发现业务缺陷按所有者记录修复，不因自己负责打包就把另两包的残缺交付写成完成。

验收与交付
- 按方案 B3-A1 至 A9 逐项给出通过/失败/未验证。检查实际默认/外部替换、两工作区、运行中停用/更新/恢复，不能只检查 manifest、注册成功或源码文本。
- 回归 B1 导入/搜索和 B2 工具、默认/外部用量/MCP 页面、终端满64KiB后持续输出、文件链接与侧栏导航、AGY/审批原有链路。
- 运行最终标准 pnpm contracts:check、pnpm build、pnpm typecheck、pnpm test、git diff --check，保留日志与真实退出码。
- 打包 Windows x64 便携 EXE，在项目目录外、D盘隔离用户/数据目录运行，验证普通启动、默认/空组合恢复、核心操作和逐实例停用。
- 使用 B2 回退包 D:/HarnessMate/b2-fix-release/HarnessMate-Desktop-0.6.0-portable.exe，实测旧数据副本升级到 B3、新写入会话/事件，再由真实 B2 EXE 读回。只操作副本。临时根可用 D:/HarnessMate/b3-tmp/w3，禁止 C 盘临时目录。
- 真实 CLI/账号、mock、协议回放、浏览器、成品 Electron、性能和 Windows 通知分别记录；未验证项不能用其他层证据顶替。
- 编写 docs/plugin-decoupling-batch-3/reports/W3.md 与 integration.md，记录 W1/W2 固定 SHA、最终源码、插件/数据/资源归属、测试、性能对照、EXE 路径/大小/SHA-256、回退结果和第四/五批保留项。
- 提交并推送 codex/b3-w3-chat；让 codex/b3-integration 指向同一完整候选并推送。若该集成分支已存在，先核对历史，只正常合入/快进，禁止强推覆盖。候选历史包含 W1 和 W2，不合并 main。
- 最终明确给出候选 SHA、任务与集成分支、可点击 EXE 路径、报告和剩余验收项，交回原规划会话独立验收。
```
