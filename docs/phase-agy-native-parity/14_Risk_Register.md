# 14 · 风险登记册

等级按影响从高到低。每项的评审结果进入 [MASTER_PROGRESS](MASTER_PROGRESS.md)，以新证据关闭或维持开放。

| ID / 级别 | 风险与触发 | 负责人、缓解与关闭条件 |
| --- | --- | --- |
| R-01 高 | 真实故障层尚未定位，1.5.16 不同模型的 wake 可能不同 | NP-01/04。先 T02 同场景四层录制。无上游帧而官方可复现时以证据标版本限制 |
| R-02 高 | v1 Prompt 提前结束、另一次响应污染新 turn、late request 未归属 | NP-02/04/07。generation 和 rpc context、单终态、T05–T08 重放与真机 |
| R-03 高 | 多任务/daemon 影响保活，取消后的 OS 进程可能残留 | NP-04/15。明确 lease 与 stop confirmations。T03/04/14 验证 finite/daemon/崩溃 |
| R-04 高 | toolCallId 和 child record ID 不同，父 transcript 错标，Approval 误授权 | NP-05/07。真实 lineage、作用域、uncertain 行为、同名子任务和转发测试 |
| R-05 高 | 私有 AGY 文件 schema 漂移、权限提升、reparse/junction 越界与 WAL 副作用 | NP-05/14/15/16。版本门槛、只读 parser、失败回滚到 unknown，验证 Windows ACL/打开路径 |
| R-06 高 | 观察器日志/Artifact 暴露代码、OAuth、账号或内部 paths | NP-01/14/16。opt-in 白名单输出、capture review、插件 scope 与资源隔离，secret fixture 不泄露 |
| R-07 高 | Consumer OAuth 通过插件/排队/HM 调度变成其他 Agent 后台 worker | NP-02/06/13/16。集中 provenance policy，禁止自动分发、换号和系统提示修改，对入口逐项负测。实践边界见 [Google #1493](https://github.com/google-antigravity/antigravity-cli/issues/1493) |
| R-08 高 | Profile 源错绑，App/CLI/IDE 被当同一会话，企业 keyring 共享 | NP-02/13/15。binding immutable、谨慎 T15，保留手动选择与跨源隔离。凭据由官方管理 |
| R-09 中高 | Dock/Studio 高估 Board、Boost、Teamwork、Workflow 结构化状态 | NP-08–NP-11。模式真实 trigger 与观察分离，workflow evidence condition，缺口可见且关闭不可用控件 |
| R-10 中高 | 付费模式额度大、方案因账号 tier/管理员而变 | 总指挥/各模式任务。按授权小样本，不依赖默认账户，实际资格矩阵；未验保持 Not Tested |
| R-11 中高 | 旧 Harness/客户端/插件收到不懂的事件或状态，水位被 detached 破坏 | NP-02/03/16。native 单独 feed/feature gates，测试旧 Contract/daemon SQL/Handoff/Orchestrator |
| R-12 中高 | 权限 double click 与过期或崩溃竞争，写响应成功被当行动已完成 | NP-07。CAS、封闭作用域、旧 connection 作废，T06 各竞态测试 |
| R-13 中 | 进程上限或密集事件消耗资源，VM 浏览/桌面抖动 | NP-04/03/16。限额、coalescing、分页和已有 UI 模式；实测基线后确定发布门槛 |
| R-14 中 | Preview 依赖和升级过早，错误重试触发双发送 | NP-02/15。codec negotiation/default v1、v2 gates、首个用户 prompt 前降级，幂等和动态版本跟踪 |
| R-15 中 | 多 Agent 越过文件所有权、冲突 migration、未审查代码提前出现在 main | 总指挥及 owners。Worktree、review checkpoint、Git diff scope、单一迁移 owner，灭火用 revert |
| R-16 中 | 前端将 native runtime 误显示 idle/done，手动补发掩盖原生缺陷 | NP-03/04/17。独立显示未知、真实状态、审批和原生续跑标识。验收运行无需补发的真机场景 |
| R-17 中 | 同步/重放重复发布工具、审批或后台任务，多个视图恢复瞬时状态不一致 | NP-02/03/15。event+snapshot 原子、cursor continuity、replay 不触发 side effects |
