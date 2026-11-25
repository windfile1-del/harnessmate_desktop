# G1 首批修复联合复验

复验日期 2026-11-25（Asia/Shanghai）。集成源码基线为 G0 `a01280176348974a0ddc00fd491afddc1d985c9e`。三个修复分支均干净。联合评审结论为 **G1 暂缓冻结**。NP-03a 的窄屏焦点复验通过。批准范围以本页列出的观察为准。

| 工作包 | 被审 HEAD | 独立复验 |
| --- | --- | --- |
| NP-01 | `51e3b3bae36b49b2910d867d64aa8e91caa8c811` | 18 项通过，含脱敏反例、慢启动 T03、四层保留审批应答和 U01 测试路径。U01 唤醒判定见 J1 |
| NP-02 | `a183adca8e8c0c13f74b18bedeb28b73b27036e4` | Protocol 6 项、Daemon 专项 9 项通过。独立用例确认同一 runtime 换代后拒绝旧事件和旧审批、禁止并发同键重复执行、未开放控制不到达 port、501 条积压完整回放至新事件衔接。跨 Profile 情况见 J2 |
| NP-03 | `e582fa8c168f58c18677a564f85ff26fd627e1d0` | Web 全量 13 文件、67 项通过。本机 Chrome 的 480px 夹具中，打开时焦点进入抽屉，外部按钮无法获焦，ArrowRight 后选中态和焦点一致，Escape 关闭并回返。Connected 条件见 J3 |

NP-02 源码的 `NativeCaptureRecordV1Schema` 校验了 NP-01 五份 NDJSON 的 84 条脱敏记录，全部通过。样本覆盖 56 条四层合成记录和 AGY 1.5.16/1.5.17 无身份握手采集。此次没有运行官方 AGY、登录账号、发送模型请求或访问生产数据。样本兼容属于格式验证，U01 和真机矩阵沿用当前验收等级。

## G1 尚需解决的事项

### J1 · P1 · NP-01 将普通 Prompt 结束和 RPC 错误标为已观察到唤醒

`scripts/agy-np/observatory/probe-live.mjs:778` 收到 Prompt 的响应就启动 observation window，错误与成功共用路径。`:238` 仅判断窗口结束且 Prompt 已发送，返回 `reactive_observed`。独立测试直接调用现有 `runLiveRecord`，使用 Node 桩对端，没有启动 AGY。对端确认模型后分别返回 Prompt RPC error，或返回 `end_turn` 且没有任何后台或唤醒事件。两次都返回 `success=true`、`outcome=reactive_observed`。

区分采集完成、Prompt 被拒绝、未观察到 wake、有充分 wake 证据。只有观察到约定的同会话后台化、任务结束和原生后续活动才标为 `reactive_observed`。无证据的有效采样仍可保存并标明缺失，RPC 错误返回失败结果。以这两条合成场景复验，再与已授权的 [U01 范围](../handoffs/G0_Test_Profile.md) 衔接。禁止自动补发 Prompt。

### J2 · P1 · NP-02 换 Profile 后仍可向历史 runtime 写入

`packages/daemon/src/harnesses/agy/native/wiring/persistence.ts:394` 创建新 binding 时作废旧审批并设置旧 runtime disconnected。旧 runtime 的 generation 保持原值。`:315` 的事务栅栏只校验传入值与按旧 runtimeId 查询到的旧行是否匹配。`:606` 因此接收已被替换的 binding。独立内存 SQLite 用例先对同一会话及实例切换 Profile，确认 runtimeId 变化，再把旧 binding 的 `native.runtime.changed` 提交为 attached。事件仍写入旧 runtime 的 seq 2。路由按当前 runtime 读取并不能阻止后台持有的旧 binding 写入和发布。

明确数据库中当前 binding 的判定，替换和作废须原子进行，普通写入按当前 runtime、实例及 generation 共同检查。旧 binding 可读作历史，保留终态。使用两个 runtime 复验拒绝旧回调、事件、mutationKey 及收据写入，并确保旧事件不会使新 WS 订阅收到无意义的换代通知。原同 runtime 换代回归继续保留。

### J3 · P1 · NP-02 / NP-03 成功响应和审批事件尚未对接

1. NP-02 的 `packages/protocol/src/agy-native-v1.ts:1270` 用 `kind` 区分命令回执。NP-03 的 `packages/web/src/lib/native-client.ts:698` 仍要求 `status`。把通过 NP-02 Zod 的 `kind: accepted` HTTP 202 响应交给 NP-03 的实际 HTTP transport，客户端报 `INVALID_RESPONSE`。服务端已接受的动作可能被界面显示为失败。
2. NP-02 的 `native.request.changed` 提供扁平的审批与收据字段。NP-03 的 `native-client.ts:1030` 读取 `payload.receipt`。实际调用 reducer 处理通过 NP-02 Zod 的 `pending` 事件，抛出 `TypeError`。
3. NP-03 的 `native-client.ts:1283` hydration 直接合并 capability 响应，未比较其绑定。独立用例并发返回新代投影和旧代 capability 目录，最终控制器标为 Live，且保留了全部 9 条旧代描述。需要按 binding/generation/revision 验证整个读取批次。

NP-02 和 NP-03 用一份共同的协议类型和运行时校验，优先让 NP-03 消费 `@harnessmate/protocol`。如果 stub 仍需独立形状，适配集中在 transport 边界。联测应把 Daemon 的命令回执、请求变化、代际不一致的能力响应送进实际 Web transport/reducer，并覆盖取消、重复和过期作用域。用桩 AGY 验证独立 WS 订阅闭环与重连。真实原生动作仍按 G2 验收。

## 集成处置

- NP-01、NP-02、NP-03b 在原分支处理各自剩余事项。NP-03a 的 R4 窄屏交互已通过，可保留独立修复提交供最终审查。当前 NP-03 初始提交同时包含 03a 和 03b，待合并按审查后的范围执行。
- J2、J3 属 G1 共享契约关键路径。候选协议及已通过的 [NP-01](NP-01-review-dd190a9.md)、[NP-02](NP-02-review-e58948f.md)、[NP-03](NP-03-review-fb91c9c.md) 上轮修复继续作为复验输入。
- 复验后用新 HEAD 跑跨包验收与组合分支门禁，按 [DAG](../10_Task_Dependency_Graph.md) 合入并登记稳定 G1 SHA。当前集成分支仅接收本复验和进度文档，NP-04 至 NP-07 等待正式 G1。
