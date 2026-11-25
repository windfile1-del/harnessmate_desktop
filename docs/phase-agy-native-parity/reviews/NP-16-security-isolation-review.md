# NP-16 安全、隔离与性能审查

审查主线为 `81393496ac1ad95afa6232111efa1b1e5c3ec792`。原交付为 `3d6679c906e660bc11d052956f6de569f91d3f9a`。候选采用默认关闭的生产门控，回归数据使用合成 Profile、会话和事件。

| 原编号 | 基线行为与影响 | 候选判定与验收条件 |
| --- | --- | --- |
| FINDING-01 | `core/session-manager.ts` 的声明式及隔离插件原生命令分支来源校验不一致。 `slots/SandboxedPluginFrame.tsx` 未将命令限定在自身插件。 | 共用目标来源校验，框架提交当前插件 ID。采用已注册命令和合成授权验证插件作用域。 |
| FINDING-02 | `core/session-manager.ts` 仅校验显式来源的 turn，旧原生命令和故障转移重试可缺少证明。 | 由实际派发目标校验，切换前阻断未验证的个人 AGY 目标。桌面本机手动切换与直接命令使用服务端证明。验证拒绝发生在状态变化之前。 |
| FINDING-03 | `plugin-host/isolation/rpc-router.ts` 的 `sessions.switchInstance` 缺少个人 AGY 目标校验。 `sessions.listItems/getItem` 的 V4/V5 `session:read` 授权返回 reasoning、正文、payload 和 rawRef。 | 切换已加来源守卫。读取仍是发布阻塞。需明确插件公开投影、正文切片及游标语义，过滤 reasoning 和私有引用，对正文与结构化负载实施脱敏，再复验跨 Harness SDK。 |
| FINDING-04 | `server/app.ts` 原先将附件 GET 排除在统一认证之外。已配对设备仍可访问部分旧会话入口。 | 附件使用统一认证，本机预览通过回归。需逐项核实 HM-Remote 旧制品、Handoff、Switch、Side Chat 的客户端依赖、授权范围和兼容迁移。 |
| FINDING-05 | `native/recovery/recovery-service.ts` 工作目录 guard 使用词法路径，Windows 顶层 junction 别名可能触发 scope mismatch。 | 主动恢复保持关闭。在生产接线验收中同时验证同目录别名、其他目录、数据根及子目录的边界。 |
| FINDING-06 | `native/workflows/tasks/observer.ts` 的独立构造默认开启及宽松解析。生产已有外层默认关闭。 | 独立构造默认关闭并采用严格解析。生产由实验门控控制接入。 |
| FINDING-07 | `components/HtmlRenderCard.tsx` 与 `slots/sandbox-iframe-utils.ts` 在输入标记中定位 CSP 注入位置，输入解析会影响策略加载。 | CSP 与桥接内容由宿主放在文档头部，先于输入。保留原沙箱属性。覆盖完整文档、HTML 片段和 Electron 本机预览。 |
| FINDING-08 | `slots/SandboxedPluginFrame.tsx` 中命令归属和草稿、通知桥是两类独立边界。 `server/app.ts` 已对插件写路由校验本机 principal 和 loopback。 | 命令归属已修。草稿和通知仍待 SDK 权限与用户手势评审，需用独立 Frame 实测。 |

## 性能与发布门槛

T18 的 REST、WS、SQLite、CAS、渲染窗口和状态清理有合成断言。SSR 数据涵盖节点生成耗时与输出规模。记录真实 Electron 窗口的交互帧、渲染提交和内存趋势后，才能核验桌面性能门槛。默认不启用新生态、制品工作台、主动恢复或预览 ACP v2。
