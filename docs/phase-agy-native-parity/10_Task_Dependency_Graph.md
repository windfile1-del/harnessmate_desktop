# 10 · 任务依赖与集成检查点

[任务规格和提示词](11_Parallel_Development_Plan.md) 使用此图的合并依赖。实测资格和上游限制是每条证据门，不要求所有试验成功才能开发降级路径。未出现过的 wire schema 先在观测任务登记。

~~~mermaid
flowchart LR
  O["NP-01 观测"] --> G1["G1 核心契约冻结"]
  C["NP-02 契约与接入缝"] --> G1
  U1["NP-03a UI 壳与组件预演"] --> U2["NP-03b 接通通用投影"]
  G1 --> U2
  G1 --> R["NP-04 Reactive"]
  G1 --> I["NP-05 Child Identity"]
  G1 --> D["NP-06 Command Router"]
  G1 --> P["NP-07 Approvals"]
  R --> G2["G2 运行时联合验收"]
  I --> G2
  D --> G2
  P --> G2
  U2 --> G2
  G2 --> S["NP-08 Swarm"]
  G2 --> B["NP-09 Boost"]
  G2 --> T["NP-10 Teamwork"]
  G2 --> W["NP-11 Dynamic Workflow"]
  G2 --> SC["NP-12 Goal / Schedule"]
  G2 --> RC["NP-15 Recovery"]
  D --> EC["NP-13 Ecosystem"]
  G2 --> A["NP-14 Artifacts / Browser"]
  S --> G3["G3 模式和上游边界"]
  B --> G3
  T --> G3
  W --> G3
  SC --> G3
  RC --> G3
  EC --> G3
  A --> G3
  G3 --> QA["NP-16 性能安全"]
  QA --> F["NP-17 集成与独立验收"]
~~~

## 检查点与关键路径

| 检查点 | 入场 / 验收 / 合并 |
| --- | --- |
| G0 基线 | 用户选择建集成分支，NP-00 文档进入该分支并固定 commit。首批 NP-01 / NP-02 / NP-03a 三个 Worktree 可并行 |
| G1 契约冻结 | NP-01 CLI/fixture 与 evidence format 可用，NP-02 schema/接入缝/迁移 skeleton 经过独立审查。NP-03a 用合成状态走通窄屏、键盘与空态。NP-02 先提供 API mock contract；实际 transport recorder 接线由 NP-02 review 后合入 |
| G2 基础运行时 | 并行的 NP-04/05/06/07 各跑本模块测试，NP-03b 连接版本化快照和通用壳。联合场景为单次真实 wake→child 或工具→审批→Stop/完成→主/后台 UI 对照。没有授权录制时可合入关闭的功能，生产标记保持 Not Tested |
| G3 模式与恢复 | NP-08/09/10/11/12/14/15 各对照实录；NP-13 可于 NP-06 契约完成后提前并行，COMMIT 并入 G3。Teamwork 与 Artifact review、Schedule 与 Recovery 分别联测。各证据缺口给已验证降级或明确结案 |
| G4 发布审查 | NP-16 独立安全/性能回归；NP-17 核对源码、复放、Windows E2E 和老客户端，汇总等级与发布边界 |

产品关键路径是 NP-01/02 → NP-04（联合 NP-05/07）→ G2 → NP-15 与原生工作流 → NP-16/17。账号授权及 Windows 1.5.16 的对照数据可能先决定 G2 可发布等级。Boost、Swarm、Teamwork、Workflow 用共享 typed port 并行开发。在真机未验证原生命令/审批的阶段，把模式功能门控关闭。

### 并行而无需等待全部后端

- NP-03a 可以从各原生产品资料和 [设计](09_Frontend_Design.md) 完成确定的 UI 结构与 mock props，NP-03b 在 G1 接通 runtime feed。G2 以前不合并带未证实原生控制的 UI。
- NP-04/05/06/07 共享 G1 契约。NP-07 可用已冻结的 Child Session Router stub 独立实现。从实时 child route 启用到 post-settle 问答需跨模块验收。
- NP-14 的只读审阅、NP-12 的 Goal/Schedule 投影、NP-15 的 reconcile 分别拥有专有目录。Teamwork 批准接通时联合 NP-14，Schedule 续跑联合 NP-15，前期不互相等待。
- NP-16 可以早写性能夹具与攻击面用例，正式验收对 G3 集成快照执行。NP-17 验收使用固定的集成提交及批准的 Windows 运行环境。
