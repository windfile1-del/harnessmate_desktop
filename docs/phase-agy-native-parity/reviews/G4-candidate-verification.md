# G4 候选联合审查

2026-11-26（Asia/Shanghai）。源码候选 `efe40ef503197c84885301a89fbc0f44f5252d95`，基于 `agy-np-g3-wave2`（`81393496ac1ad95afa6232111efa1b1e5c3ec792`）。

## 交付接收

| 工作包 | 固定交付 | 总指挥接收 |
| --- | --- | --- |
| NP-16 | `3d6679c906e660bc11d052956f6de569f91d3f9a` | 选择性接收防御回归、T18 基准、风险及交付摘要。按固定预期核验安全门控。 [交付](../handoffs/NP-16-report.md) · [审查](NP-16-security-isolation-review.md) |
| NP-17 | `0e2ca1dad2d02c3a81191d18450a4afded023786` | 接收独立端到端工具、四态 UI、69 项基线复核及 Windows 对照清单。四态进入 Web 常规套件。Runner 默认离线，可显式选择官方无身份 CLI 采样。 [交付](../handoffs/NP-17-report.md) · [原基线审查](NP-17-review-8139349.md) |

## 已修复并复验

- 个人 OAuth AGY 在 turn、steering、故障转移、原生命令和插件切换均核验实际目标的来源。桌面手动换号由本机路由签发证明。命中拒绝时，故障转移在更新会话或重试之前返回。HTTP 入口继续依赖现有认证和浏览器来源检查。 [SessionManager](../../../packages/daemon/src/core/session-manager.ts) · [HTTP 入口](../../../packages/daemon/src/server/app.ts) · [插件切换](../../../packages/daemon/src/plugin-host/isolation/rpc-router.ts)
- 插件框架使用自身 ID 路由命令。HTML 制品预览与插件框架先加载宿主 CSP 和桥接，再解析输入，覆盖完整 HTML 与片段。 [预览](../../../packages/web/src/components/HtmlRenderCard.tsx) · [插件 Frame](../../../packages/web/src/slots/SandboxedPluginFrame.tsx) · [Frame 文档构造](../../../packages/web/src/slots/sandbox-iframe-utils.ts)
- 附件读取纳入统一认证。本机预览、跨站本机拒绝和未经认证的远程请求均有回归。配对客户端的真机附件读路径待核验。 [回归](../../../packages/daemon/tests/daemon.test.ts)
- Goal/Schedule 观察器的独立构造默认关闭并启用严格解析。生产配置继续由 Native Tasks 实验门控决定。 [观察器](../../../packages/daemon/src/harnesses/agy/native/workflows/tasks/observer.ts) · [接线](../../../packages/daemon/src/harnesses/agy/native/wiring/composition.ts)

## 候选门禁

Windows x64，Node 24.18.0，pnpm 11.21.0。候选以固定源码提交复验，Native Parity 实验开关保持默认关闭并在独立合成测试中显式开启。

| 门禁 | 结果 |
| --- | --- |
| 构建、类型、插件契约和 Git diff 检查 | 通过 |
| 一次受限环境 `pnpm test` | Protocol 6/6，Web 125/125，Daemon 260/262。OpenCode 进程退出等待超时，AGY mock 的临时目录清理报 EPERM。Git Worktree 的 6 项编排测试本次均通过 |
| Windows 定向复跑 | 对上述两个用例解除执行限制，2/2 通过。分次覆盖全部 393 项 |
| NP-17 独立后端验收 | 离线 9 项通过，无身份 CLI 正式采样跳过。真实 HTTP、WS、SQLite 和 mock ACP 进程覆盖 Reactive、脱轮次审批、重复响应、1.5.14 回放、门控回退及 SQLite v99 隔离。 [结果 JSON](../evidence/g4/np17-candidate-offline.json) |
| NP-17 四态 Web | 4/4，覆盖可操作、只读、无数据和过期请求。使用 SSR |
| NP-16 T18 | 10,000 事件、100 个子 Agent、20 个请求。三轮 Daemon 的提交 p95 均值 0.65 ms、审批 CAS p95 均值 22.07 ms、峰值 RSS 260.74 MiB。五轮 Web 中 10k 投影 p95 9.70 ms、时间线窗口 17 项、100 个子 Agent 的 SSR p95 217.95 ms。真实 Electron 帧率与交互延迟仍待实测。 [基准结果](../evidence/g4/np16-candidate-t18.json) |

## 正式 G4 关闭顺序

1. **Plugin SDK、Web、HM-Remote 所有者**完成 `sessions.listItems/getItem` 公共投影的脱敏和兼容测试，明确插件 Frame 草稿与通知权限，核对配对客户端用到的旧制品、Handoff、Switch 和 Side Chat 路由。附件经真机配对客户端验证。总指挥负责公共入口和权限契约，按 [安全审查](NP-16-security-isolation-review.md) 逐项销账。
2. **总指挥与 NP-13/14/15 所有者**核验生态、制品 Workspace、主动恢复的生产接线及作用域。恢复增加 Windows junction 别名同目录和不同目录用例。未证实的控制能力继续关闭。 [生产接线安排](../handoffs/G4_Launch_Plan.md)
3. **U01** 在专用 Profile 完成人工登录后，用 Gemini 3.8 Flash 执行一次能力发现和一次 20 秒后台唤醒。按清单补 Windows 官方客户端对照，记录 uncaptured、错误和未观察到唤醒的结果。 [Profile 与命令](../handoffs/G0_Test_Profile.md) · [对照清单](../../../scripts/agy-np/e2e/fixtures/windows-comparison-checklist.json)
4. **NP-17** 在正式冻结 SHA 上独立执行回归、门控与回退、真实 Electron 性能和官方对照验收。使用 `02_Capability_Matrix.md` 的既有等级，按实际新证据更新。发布分支和标签由总指挥在门禁通过后处理。

NP-17 的 AGY 1.5.17 无身份握手与版本观察仍归档在原基线报告。候选复验未消耗授权模型额度，69 项能力矩阵保持原等级。
