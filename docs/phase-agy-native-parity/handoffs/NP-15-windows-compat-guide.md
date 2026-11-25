# NP-15 · Windows 运行兼容与崩溃恢复指南

本指南面向 HarnessMate Desktop Windows 运行环境、独立审查者及后续 G3/G4 集成，记录 AGY CLI 版本适配、ACP 协议分线、Windows 进程树清理、只读历史读取边界与崩溃/断网/重启恢复操作约束。

## 1. Windows AGY CLI 版本适配矩阵

依据 `packages/daemon/src/harnesses/agy/native/recovery/protocol-adapter.ts` 的 `evaluateCliVersionCompatibility` 与已有真实证据（`E01`–`E06`、`1.5.15` 发行边界、Windows `1.5.16` / `1.5.17` 握手实录）：

| 版本区间 | 兼容等级 (`CliVersionCompatBand`) | `session/cancel` | `session/close` | 载入策略与降级行为 |
| --- | --- | --- | --- | --- |
| `< 1.5.10` | `legacy_unverified` | 不保证可靠 | 禁用 | 自动降级为安全只读模式（`degradedToSafeMode = true`），退出直接走 Windows 进程树清理。 |
| `1.5.10 – 1.5.14` | `pre_1515_finite_compat` | 支持通知 | 禁用 | `session/load` 启用 replay idle-gap 保护；退出跳过 `session/close`，回退到 `taskkill /PID <pid> /T /F`。 |
| `1.5.15` | `boundary_1515` | 支持通知 | 若握手声明则可用 | 覆盖 `1.5.15` 延长有限后台 prompt 行为边界；保持固定 RPC 超时保护，未确认响应不伪造完成。 |
| `1.5.16+`（含 `1.5.17`） | `verified_handshake_v1` | 支持通知 | 若握手声明则可用 | 本机 Windows 实证握手 `protocolVersion: 1`，声明 `loadSession` + `sessionCapabilities.{resume, close, load, list, additionalDirectories}`。 |
| 已知坏版本（`quarantinedCliVersions`） | `quarantined_bad_version` | 跳过 | 禁用 | 阻断工作流控制，允许只读历史，记录 `CompatIncidentRecord`（`bad_cli_version_degraded`），退出强制按归属进程树回收。 |

> [!NOTE]
> 所有已实证握手（`E02`、`E03`、`windows-1.5.17-clean-v1.ndjson`、`windows-1.5.17-request-v2.ndjson`）均在 Windows 返回 `protocolVersion: 1`。即使客户端请求 `protocolVersion: 2`，只要服务端返回 `1`，必须在发送第一条用户 Prompt 前无条件降级回 `v1` 并禁止实例化 `AcpV2PreviewProtocolCodec`。

## 2. ACP v1 默认与 v2 Preview 受控分线

1. **默认 v1**：`buildInitializeRequest()` 默认发 `protocolVersion: 1`，`allowV2Preview` 默认 `false`。
2. **严格双确认**：`createAcpV2PreviewCodec()` 仅在同时满足以下条件时实例化：
   - 配置开关 `allowV2Preview === true`；
   - `initialize` 返回 `protocolVersion === 2`；
   - `sessionCapabilities` 明确声明 `replayCursor` / `replayFrom` / `stateStream`（`v2SchemaConfirmed === true`）。
3. **跨协议防污染**：
   - v1 编解码器（`AcpV1ProtocolCodec`）拒收任何 v2 专属帧（`state_update`、`replay_complete`、`prompt_accepted`、`session/replay_complete`），返回 `unsupported_protocol_version`。
   - v2 Preview 编解码器在 `replayFrom` 之后、`replay_complete` 之前处于 `history_replay` 通道，严格拦截服务端 `session/request_permission` / 表单请求，不产生实时审批或保活租约；重复 `replay_complete` 按非法帧拒绝。
4. **类型化 `RpcId`**：数值型与字符串型 `RpcId`（如 `9001` 与 `"9001"`）在协议层保持原始类型，防止回复错配。

## 3. Windows 进程树与 `cmd.exe` 包装器清理

1. **所有权栅栏**：`AgyProcessTreeTeardownCoordinator` 仅接管由当前 `(runtimeId, generation, connectionId)` 显式登记的 `pid`。对未登记或属旧代次的 PID 拒绝终止（`refusedNotOwned: true`）。
2. **分层退出顺序**：
   - 若存在活跃 turn/工作且版本支持可靠取消：发送 `session/cancel` 并等待有界宽限期（`cancelGraceMs`）。
   - 若进程仍存活且版本与握手能力支持 `session/close`：发送 `session/close` 并等待有界宽限期（`closeGraceMs`）。
   - 若仍存活或处于坏版本/旧版本分支：调用 `packages/daemon/src/harnesses/process.ts` 的 `killProcessTree`，在 Windows 上执行 `taskkill.exe /PID <pid> /T /F`（覆盖 `.cmd`/`.bat` 经 `cmd.exe /d /s /c` 派生出的子进程树）。
3. **跨进程存活诚实原则**：进程崩溃、重启或断网后，Daemon 绝不凭旧生成记录宣称原生 daemon 仍在跨进程存活；只有新连接 `live_protocol` 或未过期 `native_snapshot` 才能将工作恢复为 `confirmed_continuable`。

## 4. Windows 路径、Junction 与零副作用只读历史

1. **路径与大小写规范**：`evaluateBindingGuard` 对工作区根路径在 Windows 上执行大小写不敏感的规范路径比对（`path.resolve` + `/` 归一化），阻止跨工作区错误 attach。
2. **Junction 与重解析点防护**：`packages/daemon/src/harnesses/history-scanner.ts` 的 AGY 路径校验（`resolveSafeAgyPath`）允许已知顶层 `.gemini` 入口解析一次 `realpathSync`，随后逐级检查 `lstatSync().isSymbolicLink()` 并校验 `realpathSync` 仍位于根目录下，阻断任何子目录符号链接或 Windows Junction 逃逸。
3. **SQLite 零 WAL/SHM 副作用**：`openAgyReadOnlySqlite` 仅在 `-wal` 与 `-shm` 同时存在时直连只读打开；当冷库缺少 `-shm`/`-wal` 时，使用 `${pathToFileURL(dbPath).href}?immutable=1` 只读打开，经 Node `v24.18.0` 实测不会在只读或测试目录生成新的 `-wal` / `-shm` 文件，并强制单库大小与消息条数/字节数上限。

## 5. 崩溃、断网、Windows 重启恢复与回滚

| 场景 | 自动/只读行为 | 控制与审批门控 | 用户可见状态 |
| --- | --- | --- | --- |
| Daemon 崩溃/Windows 重启（`activeReconcileEnabled: true`） | 将 `attached` 绑定标为 `reconciling`，发送幂等 `native.recovery.changed` | `pending` 审批转 `connection_lost`，`claimed` 转 `delivery_unknown`；禁止重放旧审批/Prompt，关闭工作流控制 | `连接恢复中`、`最后见时间`、`失效审批`、`只读历史可用` |
| 同代换连接 (`conn_1 -> conn_2`) | 立即退役 `conn_1` 并拦截其迟到帧/迟到响应 | `conn_1` 的迟到 `handleTransportLost` 不影响 `conn_2` 新连接与新审批 | 新连接恢复为 `已连接`，旧审批保持失效 |
| 旧代次 / 乱序 attach / 前端刷新 | 丢弃乱序与旧代请求；旧游标返回 `410 RESYNC_REQUIRED` | 旧代次无法写库或执行 `/native/control` | 前端重取 `/snapshot` + 新游标续接 |
| 未认证或 `-32000` | 阻断 attach，保留本地历史可读 | **绝不自动弹出登录或切换账号** | `需手工接入 / 请通过官方 AGY 登录` |
| 关闭主动恢复（`activeReconcileEnabled: false`） | 不执行启动写入与状态变更 | 仅提供只读 `native_runtime_events` / `indexed_sqlite` 查询 | 历史数据完整保留，老客户端与 Handoff 不受影响 |
