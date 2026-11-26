# 开发提示词 · B1-01 实例装配与公共契约

你是 HarnessMate Desktop 第一批解耦的插件宿主开发人。请在 `D:\HarnessMate\harnessmate_desktop` 的可复现开发基线上**实现 B1-01 并自测**。总指挥负责接口裁定、独立验收和合并结论。以第一批任务单为交付边界。 [任务单](../../plugin-decoupling-batch-1-tasks.md) · [总设计](../../plugin-decoupling-implementation-plan.md)

## 开工

运行 `git status -sb` 和 `git rev-parse HEAD`，核对总指挥发给你的基线提交或快照确实包含平级插件实现。当前共享工作区可能有未提交的基线改动。保全原有文件和未提交工作，使用团队已分配的分支或隔离目录。缺少共同基线时，先核对现有实现并交付契约建议，注明哪些文件或提交尚待对齐。临时文件和测试数据放 D 盘。

从 [服务生命周期](../../../packages/daemon/src/plugin-host/runtime/lifecycle.ts)、[绑定解析](../../../packages/daemon/src/plugin-host/composition/bindings.ts)、[组合配置](../../../packages/daemon/src/plugin-host/composition/profile.ts) 和 [公共 SDK](../../../packages/plugin-api/src/context.ts) 入手。先用已有调用审查实际回落行为，再确定需要改动的入口。

## 实现要求

1. 复用当前服务目录、`ctx.provide`、`ctx.services.list/call`、实例路由和工作页注册。把选定实例、选择来源和可用状态作为同一解析结果传给业务和 UI。按适用作用域处理显式实例、会话或工作区选择、调用方依赖绑定、组合默认项。多个兼容候选且无选择时返回候选。唯一候选仅在入口允许时自动选择。已选实例停用或不兼容时保留绑定和状态。
2. 把源码中的出厂提供方选择迁到发行组合数据。保留旧组合和旧 SDK 的兼容语义，列出实际仍调用旧解析的入口。让可信本地插件与预装插件对等使用本批所需的服务、路由和工作页注册能力。每项实现都通过现有宿主原语落地。
3. 先向总指挥和 B1-02 至 B1-05 交付可用契约和最小夹具，包含 `history.source.v1`、`history.import.v1`、搜索契约建议、实例解析结果及错误语义。会话读写适配由 B1-03 设计并与 B1-04 对齐。确认请求、响应、状态、版本后再让下游接真实端点。更新公共 API 时运行 `pnpm contracts:generate`。
4. 负责插件宿主与公共契约文件。B1-06 负责最终 daemon 路由挂载和发行组合集成。历史读取、会话导入、索引和 UI 交给各任务所有者。共用改动给出触点、实际调用方和集成方式。

## 自测与交付

- 用专项回归验证注册顺序反转、同包多实例、无绑定多候选、停用和重新启用、不兼容版本、旧组合加载和空组合恢复。复跑浏览器、查看器和审批策略的现有绑定用例。
- 运行 `pnpm contracts:check`、适用的 daemon 和 Web 测试、`pnpm typecheck`、`git diff --check`。记录实际命令、退出码和未跑项。
- 交付基线、任务提交或 PR、契约版本及最小示例、旧解析调用方清单、测试结果和重跑步骤。列明 B1-02 至 B1-06 可开始使用的接口，以及需要总指挥协调的差异。仅提交本任务拥有的文件，最终合并由总指挥决定。
