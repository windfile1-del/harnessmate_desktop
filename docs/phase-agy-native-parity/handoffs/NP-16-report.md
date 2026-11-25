# NP-16 交付摘要 · 性能、安全与隔离

交付分支 `np16_performance_security_review`，原始 HEAD `3d6679c906e660bc11d052956f6de569f91d3f9a`，基线 `81393496ac1ad95afa6232111efa1b1e5c3ec792`。集成采用选择性接收，保留可复跑的防御回归、性能脚本、合成基准和审查结论。

| 交付 | 内容 |
| --- | --- |
| T15 | 同名 Profile 隔离、环境净化、只读 SQLite 与目录边界用例 |
| T17 | 个人 OAuth 来源、插件与 HTML 边界的源码发现，以及审批与制品安全视图的防御回归 |
| T18 | 10,000 事件、100 个子 Agent、20 个请求，覆盖 REST 分页、WS 溢出、审批 CAS、前端窗口化与作用域切换 |
| G3 第二批门控 | Native Tasks、生态、制品和恢复默认配置与既有 Codex/Claude 回归 |

脚本与报告格式见 [T18 基准说明](../../../scripts/agy-np/bench/README.md)。`baseline-latest.json` 保存交付分支的原始测量。Web 测量使用 React 服务端渲染。原分支报告的门禁结果适用于原始提交，候选独立复验见 [G4 候选审查](../reviews/G4-candidate-verification.md)。

安全项的源码位置、核验结论和发布条件见 [NP-16 审查](../reviews/NP-16-security-isolation-review.md)。
