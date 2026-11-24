# 插件开发任务说明书 11 · Multi-Instance Usage & Failover

| 属性 | 说明 |
| --- | --- |
| **插件名称 & Plugin ID** | Multi-Instance Usage & Failover · `hm.plugin.usage-failover` |
| **功能定位** | 将现有配额看板与限额接力合二为一：按 **Harness 实例（账号）维度**聚合实时速率限额、Prompt Cache 命中率与 TTL 倒计时、上下文窗口占用率与本地 Token 成本账本，并在触发 `usage_limit` / 限流 / 异常中断时提供一键或策略化无缝接力（Failover）与限额恢复提醒 |
| **参考来源 (T3 Code)** | `t3code/apps/server/src/orchestration-v2/Adapters/CodexTurnTokenUsage.ts`、`packages/provider-opencode/src/server/v2/usageLimits.ts`、`packages/contracts/src/provider.ts`（`ServerProviderUsageLimits` / `usage_limit` 错误分类）、`docs/internals/03_providers.md`（`[T3 Code 已验证实现]`）+ `[HarnessMate 原创设计]`（自动跨实例/跨引擎接力闭环） |
| **HarnessMate 当前状态** | **部分实现但强耦合**：现有 `core.account-usage` + `core.auto-failover` 两个独立清单及 `packages/daemon/src/core/usage-service.ts`（239 行）；**硬伤**：`usage-service.ts` 内部硬编码 `[codex, agy, claude]` 并写死 `adapter instanceof CodexAppServerAdapter`，无法扩展多账号实例或第三方适配器；缺上下文窗口占比仪表与 Prompt Cache 失效倒计时；Failover 未接入 Handoff Protocol v2 与限额重置自动提示 |
| **插件类型** | Built-in Plugin（默认启用第一方上层自治插件，提供公共服务 `usage` 与 `failover`） |
| **开发难度与风险** | **中**（风险点：轮询各引擎限额接口触发限流或后台冷启 CLI 拖慢系统；自动接力误触发导致未经用户知情消耗高价付费 API 额度；估算美元成本与官方账单口径偏差） |
| **开发优先级** | **P1**（Phase 2，解决多账号与多引擎额度切换的核心痛点） |

---

## 1. 职责范围

### 明确负责
- **消除厂商硬编码的多实例用量聚合（`usage` 服务）**：
  - 遍历 `HarnessInstanceRegistry` 全部已注册实例，统一调用驱动标准可选方法 `readUsageLimits(instanceId)`（绝不 `instanceof` 任何具体适配器类），结合 Core SQLite `session_runs` 汇总的本地 `input/output/cached/reasoning` Token 与估算成本，按实例维度输出实时面板；
  - 实现**懒加载 + TTL 缓存**（默认 60s 缓存，用户打开看板或刚发生 `usage_limit` 报错时才强制刷新，**严禁后台无节制高频轮询**）；
- **会话级上下文窗口与 Prompt Cache 仪表**：
  - 实时消费 `usage.updated` 事件中的 `modelContextWindow`、`contextTokens`、`cachedInputTokens` 与最后活跃时间，在界面渲染上下文水位进度条（70% 警告、85% 建议压缩或切新线程）及 Prompt Cache 热缓存剩余窗口提示；
- **智能限额/异常接力闭环（`failover` 服务）**：
  - 监听 `turn.terminal` 中的 `failureClass: 'usage_limit' | 'rate_limited' | 'provider_unavailable'` 与明确超时中断；
  - 依据用户预先配置的 **Failover 优先级链**（如 `codex-work → codex-personal → claude-max → deepseek-api`），自动筛选下一个健康且未触达限额的备选 `instanceId`；
  - 默认采用 **“一键确认接力”** 模式（在出错轮次下方弹出醒目横幅：`Codex (Work) 5h 限额已满，预计 42 分钟后重置 → [一键携上下文切至 Claude Code 续跑]`），同时支持用户按工作区显式开启 **“同档位自动接力”**（带单次会话最大自动切换次数上限与成本护栏）；
  - 触发接力后记录原实例 `resetsAt` 时间戳，额度恢复时发出温和桌面提醒，方便用户一键切回原主力实例（由 `context-handoff` 走场景 B 增量同步）。

### 明确不负责
- 不直接解析各家 CLI 私有配置文件或执行 `codex app-server` 探活（全部通过驱动标准 `readUsageLimits()` 委托）；
- 不自己拼接跨引擎上下文交接文本（通过可选服务 `ctx.get('handoff')` 完成交接预览与切换）；
- 不在未经用户明确授权的情况下自动从包月订阅账号切换至按量计费付费 API。

---

## 2. 依赖关系、SDK 接口与对外能力

- **依赖关系**（DAG Layer 4，严格无环）：
  - 强依赖：Core Runtime（`HarnessInstanceRegistry`、SQLite 用量聚合只读接口）；
  - 可选依赖：`hm.plugin.context-handoff`（`optional: ['handoff']`，用于在发起接力前展示预计交接 Token 摘要并协同推进切换；缺省时仍可展示限额看板与普通切换）。
- **调用的 SDK 接口**：
  - V4 既有：`ctx.events.on`、`ctx.storage.plugin`、`ctx.get('handoff')`、`ctx.logger`；
  - V5 增量：`ctx.harnesses.listInstances()`、`ctx.sessions.switchInstance()`（需显式权限 `session:switch`）、`ctx.sessions.postNotice()`。
- **对外暴露能力（`provides: ['usage', 'failover']`）**：
  - `usage.getDashboard(opts)`：获取全部实例配额窗口、每日 14 天趋势、缓存命中率与本地成本汇总；
  - `usage.getSessionContextMeter(sessionId)`：返回当前会话上下文占用比与建议动作；
  - `failover.getPolicy()` / `failover.setPolicy(policy)`：读写实例接力链与自动接力护栏；
  - `failover.execute(sessionId, targetInstanceId, opts)`：执行受控一键接力（可选自动重放中断前的最后一条用户指令）。

---

## 3. 事件协议与数据模型

- **订阅事件**：`usage.updated`、`turn.completed`、`turn.failed`、`session.harness_switched`。
- **发布事件**：`usage.limit_approaching`（窗口占用 ≥ 90%）、`usage.limit_reset_ready`（受限实例到达 `resetsAt`）、`failover.suggested`、`failover.executed`。
- **核心数据模型**：
```ts
export interface InstanceUsageSnapshotV2 {
  instanceId: string;
  driverId: string;
  displayName: string;
  billingTier: 'subscription' | 'api_payg' | 'local_free' | 'unknown';
  loggedIn: boolean;
  accountLabel: string | null;
  rateLimits: Array<{
    label: string;              // 如 "5h window" / "7d window"
    usedPercent: number;
    resetsAt: number | null;
  }>;
  localStats: {
    sessionCount: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
    dailyBuckets: Array<{ date: string; tokens: number; costUsd: number }>;
  };
  fetchedAt: number;
  error?: string;
}

export interface FailoverPolicy {
  mode: 'manual_one_click' | 'auto_same_tier' | 'auto_any';
  priorityChain: string[];      // instanceId 有序列表
  maxAutoSwitchesPerSession: number; // 默认 2，防乒乓死循环
  autoRetryInterruptedPrompt: boolean;
  notifyOnQuotaReset: boolean;
}
```
- **持久化方式**：各轮次原始 Token 明细持久存于 Core SQLite `session_runs` 表；`FailoverPolicy` 与实例冷却/重置时间戳存入 `ctx.storage.plugin`。

---

## 4. UI 扩展、权限需求与生命周期

- **UI 扩展点与交互形式**：
  - `sidebar_tool` + `modal`：**Multi-Instance Usage & Failover 看板**——展示所有实例卡片（双账号 Codex 并列显示独立 5h/7d 进度条与倒计时）、14 天 Token 柱状图、Prompt Cache 省费统计，以及拖拽排序的 **Failover 接力优先级链配置器**；
  - `composer_action`：紧凑 **上下文水位胶囊**（如 `42k / 200k · 21% · Cache 78%`），点击展开本会话按引擎拆分的 Token 账单；
  - `chat.block`（key: `ext:failover.banner`）：限额/断流触发时的行内接力行动条（展示首选备选实例、预计交接开销及重置倒计时，一键完成切换与续跑）。
- **权限需求**：内置受信任插件；声明 `session:read`、`session:switch`（执行接力切换所需）。
- **生命周期**：
  - **安装/启用**：统一接管旧清单 `core.account-usage` 与 `core.auto-failover`（保留旧服务别名与用户配置迁移）；
  - **更新**：支持热更新模型单价估算表与接力策略，不丢失历史统计；
  - **禁用**：停止自动接力建议与定时重置提醒，保留 Core 数据库内全部历史 Token 统计。

---

## 5. 异常处理、恢复与降级机制

1. **乒乓切换死循环防护（Ping-Pong Guard）**：当全部候选实例均处于限额冷却期内，或本会话自动切换次数超过 `maxAutoSwitchesPerSession` 时，**立即停止自动接力**，展示所有实例距离最近一次 `resetsAt` 的最短等待时间，严禁在两个满额实例间无限往返；
2. **第三方驱动未实现 `readUsageLimits()`**：优雅降级为展示 Core SQLite 记录的本地会话 Token 与趋势，隐藏远程配额进度条，绝不报错崩溃；
3. **订阅账号切付费 API 成本护栏**：在 `auto_same_tier` 模式下严格比对 `billingTier`，若下一备选实例为 `api_payg`（按量付费）而当前为 `subscription`（包月），强制降级为 `manual_one_click` 弹出确认，杜绝意外账单；
4. **时钟漂移与未知 `resetsAt`**：若远端未返回精确重置时间戳，默认采用指数退避冷却（5min → 15min → 30min）并允许用户手动点“立即重测”。

---

## 6. 测试方案与可验证验收标准

- **单元测试**：
  - `FailoverPolicy` 优先级筛选、同档位付费护栏与乒乓死循环拦截；
  - 多实例并存（如 `codex-work` + `codex-personal` + `claude-default` + `deepseek-api`）聚合无硬编码验证；
  - Prompt Cache 命中率与上下文占比阈值边界计算。
- **集成测试**：
  - 模拟 `codex-work` 触发 `turn.terminal(failureClass: 'usage_limit', resetsAt: now + 60s)` → 验证弹出推荐 `claude-default` 接力横幅 → 点击一键接力调用 `handoff` 完成上下文移交并继续任务 → 60s 后触发重置提醒通知。
- **可验证验收标准**：
  1. `usage-service.ts` 中全部 `instanceof CodexAppServerAdapter` 与 `[codex, agy, claude]` 硬编码彻底清零；新增第 4、5 个适配器插件后看板自动呈现，零代码修改；
  2. 双 `CODEX_HOME` 账号并发运行时，看板准确展示各自独立的账号邮箱、5h/7d 限额与本地统计；
  3. 连续触发双实例满额场景时，自动接力次数严格不超过 `maxAutoSwitchesPerSession` 且零无限循环；
  4. 看板 60s 缓存生效，后台闲置时零主动探活 CLI 进程创建。
