# NP-01 独立评审 · dd190a9

评审日期 2026-11-25（Asia/Shanghai）。结论 **修改后复验，等待合并**。G0 基线 `a01280176348974a0ddc00fd491afddc1d985c9e`，审计源码 `0409bc8a4ea85d05ef6b0ee85fc2d0b980f06039`。审查 `np01_protocol_observatory @ dd190a98137b9b9fa906296d4978be1ead2fd656`，实现提交 `acfd18c9752c96c67da2a7489461c3315dc4a58f`。开发报告在该分支的 `docs/phase-agy-native-parity/handoffs/NP-01-report.md`。

## 合并前需修复

### R1 · P1 · 配置与协议输入可在脱敏失败后抵达输出端

`scripts/agy-np/observatory/recorder.mjs:209` 命中规则后只重建 `shape` 和诊断编号。`scenario`、`provenance`、`correlation` 或 `unknownKeys` 中的命中内容仍随记录交给 sink 和 `appendFileSync`。用虚构邮箱作为 `scenario` 并注入一条合成帧，观察到 `leakBlockedCount=1`、sink 含原值、事后校验失败。`sanitizer.mjs:67` 与 `:82` 的字符过滤也允许符合字符集的正文被放进标签或动态键。`cli.mjs:88` 将迁移结果写出后才判断 `validation.valid`，而 `migrator.mjs:36` 会把无效的 v1 输入连同校验结果原样返回。对含同一虚构邮箱的 v1 输入运行 `migrate`，stdout 与 `--out` 两种模式均退出 1，且都已输出原值。校验错误本身也要限制为字段路径和原因码，避免输出非法枚举或字段名的原值。

修复条件是为输出元数据、枚举和字段结构建立信任边界。动态键或未知值只保留符合契约的字段形状、别名或计数。输出须在校验成功后才进入 sink、stdout 或文件。失败只生成可验证的最小诊断或计数。批准交互保留用户判断需要的官方内容，放在操作终端的交互输出，禁止进入可复制或可重定向的证据流。以虚构输入覆盖顶层、相关性、未知字段名、provenance、迁移 v1、嵌套结构及不同输出方式，验证敏感原值和无效记录均未写出。现有版本在本评审中未检测到真实账号泄露。

### R2 · P1 · 四层归因会混合代次、通道和缺失观测

`scripts/agy-np/observatory/four-layer.mjs:145` 按 `connectionId + ingressOrdinal` 聚合且每层仅保留首条。用同连接同序号、不同 generation/channel 的两条合成帧复验，摘要只有一行。同包的四层 NDJSON 在 ordinal 10 记录 seq 54 入站审批与 seq 55 的出站 `cancelled`，同包 Markdown 摘要只显示入站。多条下游事件也会被折叠。`four-layer.mjs:95` 把所有缺少 normalized 的 server request 归为 `dropped_before_adapter`，即使只有 raw 层采集。独立最小输入复现了这一归因。`recorder.mjs:80` 的 pending RPC key 还缺少 generation/channel 作用域。

修复条件是按 `connectionId + generation + channel + ingressOrdinal` 建立相符的可观察范围，保留同 ingress 的多事件及应答或明确其语义。测试覆盖历史回放与 live 序号重复、重连和数字/字符串 RPC ID。区分该层根本未采集、观测中断、已采集且无匹配项，只有明确证据才能归因为丢失。NP-03 诊断编号及四层示例同步验证，供 NP-03 在 G1 复核，避免两条不同记录生成相同的可复制编号。

### R3 · P1 · U01 私有 Profile 与真实结果的边界应可验证

`scripts/agy-np/observatory/probe-live.mjs:61` 只检查盘符，`:172` 至 `:176` 对 scratch 与 Profile 只复核解析后是否在 D 盘。使用虚构的 `D:\qa\other-profile` 运行 `--dry-run --discover-confirmed`，被接受为 `authorizedProfile: true`。脚本还接受任意同名二进制路径。`:308` 至 `:330` 在 child close 前生成摘要。`cli.mjs:44` 仅以 capture 校验结果决定进程退出状态，所以模型拒绝、未发现或 deadline 也可能退出 0。v2 对照样本元数据写请求版本 2、握手写实际版本 1，摘要取首条的 `protocol`，容易误读。

修复条件是把真实登录和采集绑定到 G0 专用测试目录与官方已验来源，输出和 scratch 按实际目标限制在允许位置并保留现有测试登录。显式记录实际协商版本、终止原因、是否发送 Prompt、进程退出和截断状态。对失败路径返回明确结果。无身份的预期认证失败、v2 降级可有各自的观测成功语义。验证 dry-run、空白 Profile、拒绝指定账号路径与 mock server 的模型未广告/拒绝/成功路径。正式 U01 仍遵守 Gemini 3.8 Flash、一次发现、一次 20 秒复现、人工确认 Prompt 和原生审批。

### R4 · P2 · Recorder 的限制只覆盖部分内存与 IO

`scripts/agy-np/observatory/recorder.mjs:109` 在构造记录时才检查记录数。RPC 跟踪和 alias 构造已在 `:299` 与 `:350` 执行。用 `maxRecords=2` 注入 20 个不同 RPC ID，保留 3 条（含 drop 事件）但已分配 20 个 alias。直接使用 `enabled=false` 的 recorder 也创建 pending 请求。opt-in 回调在 `:683` 同步运行，`:235` 会执行同步磁盘追加。异常隔离只保护调用端免于同步异常传播。`scripts/agy-np/observatory/probe-live.mjs:350` 在换行前无界累计 stderr。

修复条件是限制所有输入缓冲、关联表和原始输入长度，关闭和统计饱和后尽早返回。验证长行、唯一 ID 序列和 slow sink。若接入 Daemon，让即时工作有硬上限并隔离存储 IO，按丢样原因导出计数。NP-02 可以设计接缝和测试替身，正式接线需 G1 审查。

### R5 · P2 · v1 校验与 T03 回放门禁需要可重复

`scripts/agy-np/observatory/schema-validator.mjs:95` 是手工校验器。把一条记录的 `shape` 改为字符串、`provenance` 加入未声明字段、`correlation.generation` 改为数字后，校验仍成功。JSON Schema 在 `schema/capture-v1.schema.json:124` 至 `:160` 拒绝这三处。校验由单一 Schema 驱动，或对运行时实现增加一致性用例。v1 样本更新须明确版本兼容语义。

独立定向运行 12/13。T03 的 `verdict.passed` 在 `agy-np-observatory.test.ts:339` 为 false。同一夹具随后单独运行 4 次均通过。原失败日志只给布尔值。当前 1500 ms watchdog 从启动子进程即计时，可能与 Windows 的子进程启动和 stderr/exit 时序竞争。先在断言中输出 failed checks，再把场景事件的时序与 watchdog 分离，验证超时时等待退出和流关闭再生成最终 verdict。以慢启动和正常模式验证 T03 都能稳定观察合成超时、stderr 和退出码 137。

## 范围与证据

- 27 个新增文件符合 NP-01 允许范围。工作树干净，`git diff --check a012801 HEAD` 成功。旧 `agy-1.5.14` fixture、共享生产代码和数据库均未改动。没有迁移或产品接线。
- 独立运行 `node scripts/agy-np/observatory/cli.mjs validate --in <file>`。三份已提交 NDJSON 分别通过 56、9、5 条记录的内置检查。R1、R5 为这些检查之外的反例。
- NP01-E01/E02 保留 Windows AGY 1.5.16 无身份握手证据。v1 会话请求返回 `-32000`，请求 v2 收到 v1。NP01-E03/E04 是合成或回放，E03 使用真实基线适配器及合成对端，canonical/UI 为夹具投影。当前尚无真实后台完成、唤醒、审批或 child 的 U01 帧，能力矩阵等级沿用 G0。
- 独立全量复跑 `pnpm test` 退出 0，插件契约及 198 项测试通过（protocol 1、web 50、daemon 147），其中 NP-01 为 13/13。T03 仍保留此前定向失败记录。`pnpm build` 和 `pnpm typecheck` 来自开发报告，本次未独立重复。

## 复验和协调

NP-01 在原交付分支追加修复提交，更新交付报告并提供新 HEAD。保留已提交脱敏证据的来源标记，重生成的摘要明确注明工具版本。用定向测试和全量门禁复验，附 R1–R5 的对照结果。总指挥审核通过后收录到集成分支。NP-02 和 NP-03a 的 G0 工作可继续，录制回调与诊断编号先作候选。G1 按 [依赖图](../10_Task_Dependency_Graph.md) 检查。U01 登录可使用 [G0 官方登录步骤](../handoffs/G0_Test_Profile.md)，使用本交付采集需等待 R1 与 R3 的复验。
