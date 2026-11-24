# 插件开发任务说明书 10 · Approval, Question & Secret Center

| 属性 | 说明 |
| --- | --- |
| **插件名称 & Plugin ID** | Approval, Question & Secret Center · `hm.plugin.approval-center` |
| **功能定位** | 为跨 Harness 与多端（桌面 + HM-Remote 移动端）的运行时人工交互提供统一、诚实且高安全的呈现与决策中心，覆盖权限审批（命令/文件/补丁/MCP）、结构化用户提问（`user_question`）、敏感凭据私密输入（`secret_request`）及可插拔风险分级标注 |
| **参考来源 (T3 Code)** | `t3code/apps/web/src/components/chat/ComposerPendingApprovalActions.tsx`、`TimelinePendingApprovalRow.tsx`、`ChildThreadApprovals.tsx`、`apps/web/src/questionAttachments.ts`、`packages/contracts/src/orchestrationV2.ts`（`OrchestrationV2RuntimeRequest` 5 种结构化请求变体）（`[T3 Code 已验证实现]`） |
| **HarnessMate 当前状态** | **部分实现**：Core `ApprovalBroker` 与 `HM-Remote` 跨端原子审批锁已存在，Plugin SDK V4 已开放 `approval.annotate` 钩子；**缺口**：审批卡片仅零散呈现于当前会话且缺全局跨会话 Attention Strip 聚合、缺输入框上方固定锚定交互条、缺子任务审批跨树聚合、缺结构化多选项 `user_question` 卡片、缺禁止明文回显聊天的 `secret_request` 专属隐私输入流、缺本地声明式危险命令风险规则引擎 |
| **插件类型** | Built-in Plugin（默认启用第一方核心交互插件） |
| **开发难度与风险** | **中**（风险点：绕过审批安全红线——任何插件都不能自动批准；跨桌面/移动端并发点击同一审批引发竞态重复回复；敏感输入意外写入聊天记录或日志；海量并发子任务审批造成界面轰炸） |
| **开发优先级** | **P1**（Phase 2，多引擎并行与移动远程审批的核心安全体验组件） |

---

## 1. 职责范围

### 明确负责
- **全局注意力顶栏（Global Attention Strip）与跨会话审批聚合**：
  - 实时订阅 Core `ApprovalBroker` 的全部待决 `RuntimeRequest`，将当前会话、后台会话及子 Agent 会话的阻塞审批/提问聚合成顶部紧凑条，支持快捷键跳转与一键直达对应会话；
- **输入框锚定审批与提问条（Composer-Anchored Action Bar）**：
  - 借鉴 T3 Code `ComposerPendingApprovalActions.tsx`，在当前会话输入框正上方固定展示待决请求，避免用户在长对话滚动时错过卡住的权限审批；
  - 诚实映射底层 Harness 真实提供的决策选项（如 `allow_once` / `allow_session` / `deny`，或 `allow_with_reason`），**绝不捏造底层驱动不支持的“永久记住此规则”按钮**；
- **内置静态高危风险标注引擎（基于 V4 `approval.annotate`）**：
  - 对待审批的 Shell 命令、文件写入路径与 MCP 工具调用自动运行本地规则扫描，叠加风险徽标（`low` / `medium` / `high` / `critical`）与可读解释（例如识别 `rm -rf`、`git push --force`、越出工作区写入、`curl | sh`、读取 `~/.ssh` 或 `.env`）；
  - 允许企业或用户安装的第三方安全插件继续叠加自定义 `approval.annotate` 标注，统一按最高风险等级排序高亮；
- **结构化提问卡片（`user_question`）与私密凭据卡片（`secret_request`）**：
  - 渲染单选/多选/自由文本混合表单卡片（支持附带可选说明）；
  - 针对需要临时令牌/密码的 `secret_request`，提供密码掩码输入框，经独立加密 RPC 通道直交 Core `ApprovalBroker` 注入目标 Harness 内存/stdin，**绝不落盘 SQLite 消息表、绝不在聊天时间线回显明文、绝不广播给其他插件**。

### 明确不负责
- **绝不拥有也不暴露“自动批准”API**（审批最终决议只能由经鉴权的人类 UI 会话提交给 Core `ApprovalBroker` 原子裁决）；
- 不替代 Core `ApprovalBroker` 维护审批持久化状态或跨设备分布式锁（Core 永远是唯一权威状态机）；
- 不伪造或降级任何 Harness 的权限模式（诚实呈现 `approvalPolicy`）。

---

## 2. 依赖关系、SDK 接口与对外能力

- **依赖关系**（DAG Layer 1）：仅依赖 Core Runtime（`ApprovalBroker`、WebSocket/HM-Remote 同步通道），**零跨插件依赖**。
- **调用的 SDK 接口**：
  - V4 既有：`ctx.approval.annotate(handler)`、`ctx.events.on('approval.requested' | 'approval.resolved')`、`ctx.storage.plugin`（保存用户自定义高危命令正则规则）；
  - V5 增量：订阅 `runtime_request.updated` 与 `subagent.updated`、通过宿主 UI 桥发送带人类用户手势令牌的决议提交请求。
- **对外暴露能力**：
  - 通过标准 UI 插槽提供全局审批顶栏、输入框锚定交互条与时间线内联请求卡片；
  - 聚合展示任意第三方插件经 V4 `ctx.approval.annotate` 返回的 `ApprovalAnnotation`（风险等级、原因摘要、外链文档提示）。

---

## 3. 事件协议与数据模型

- **订阅事件**：`approval.requested`、`approval.resolved`、`runtime_request.updated`、`subagent.updated`、`session.closed`。
- **发布事件**：无控制面写事件（仅通过 `approval.annotate` 返回纯只读风险注解；人类交互决议由前端直连 Core `ApprovalBroker` REST/WS 端点）。
- **核心数据模型（对齐 03/06 号文档统一运行时请求模型）**：
```ts
export type RuntimeRequestKind =
  | 'command_approval'
  | 'file_change_approval'
  | 'mcp_tool_approval'
  | 'user_question'
  | 'secret_request';

export interface RiskAnnotationView {
  sourcePluginId: string;
  severity: 'info' | 'medium' | 'high' | 'critical';
  title: string;
  detail: string;
  matchedPattern?: string;
}

export interface PendingRuntimeRequestView {
  requestId: string;
  sessionId: string;
  parentSessionId?: string;          // 标识是否来自子 Agent 委托任务
  instanceId: string;
  kind: RuntimeRequestKind;
  title: string;
  payload: Record<string, unknown>;  // 已做脱敏与大 diff 摘要处理
  supportedDecisions: string[];      // 严格由目标 Harness 驱动声明
  annotations: RiskAnnotationView[];
  status: 'pending' | 'resolved' | 'expired' | 'cancelled';
  resolvedByDevice?: 'desktop' | 'mobile_remote';
  createdAt: number;
}
```
- **持久化方式**：待决/历史请求状态全部由 Core SQLite 托管；本插件仅在 `ctx.storage.plugin` 存用户自定义风险规则集 JSON。

---

## 4. UI 扩展、权限需求与生命周期

- **UI 扩展点与交互形式**：
  - `header_status` / 顶栏插槽：**Global Attention Strip**（显示 `2 个待审批 · 1 个子任务提问`，点击弹出队列抽屉）；
  - `composer_action` 锚定区：**Pending Request Bar**（按风险等级着红/橙/蓝边框，支持键盘快捷键审阅，`critical` 级别强制禁用单键误触并要求二次确认）；
  - `chat.block`（key: `runtime_request`）：历史时间线内联只读回执卡（记录审批时间、操作端“桌面端/移动端”及决议；`secret_request` 永远仅显示 `已安全提供凭据（内容已隐藏）`）；
  - `modal`：风险规则编辑器（允许用户增删自定义高危命令正则）。
- **权限需求**：内置受信任交互插件；声明 `events:approval`、`approvals:annotate`。**不存在也不开放任何后台自动批准权限**（仅前端人类已鉴权通道可向 Core `ApprovalBroker` 提交决议）。
- **生命周期**：
  - **安装/启用**：注册内置高危规则标注器并挂载 UI 插槽；拉取 Core 当前全量 `pending` 请求列表完成冷启动水合；
  - **更新**：支持热更新内置危险模式规则库，不影响当前待决请求；
  - **禁用**：若被显式禁用，前端回退到主程序内置的最简原始审批确认框，确保核心审批永不失灵。

---

## 5. 异常处理、恢复与降级机制

1. **跨端并发决议竞争（桌面端与 HM-Remote 手机端同时点击）**：Core `ApprovalBroker` 使用 `UPDATE ... WHERE request_id = ? AND status = 'pending'` 原子锁；慢到一端收到 `409 Already Resolved` 后前端平滑收起审批条并展示 `"已由移动端处理"`，绝不报错弹窗；
2. **第三方 `approval.annotate` 钩子崩溃或超时**：每个插件标注器强制 300ms 超时与错误隔离，失败时在卡片追加灰色提示 `"部分安全规则检查未响应"`，绝不阻塞审批卡片渲染；
3. **底层 Harness 崩溃或轮次中断**：Core 自动将关联 `pending` 请求结算为 `cancelled`，UI 立即撤下审批条防僵尸弹窗；
4. **`secret_request` 内存安全**：输入框组件 unmount 时立即清空 React state，传输载荷标记 `noLog: true` 跳过所有日志与诊断导出管道。

---

## 6. 测试方案与可验证验收标准

- **单元测试**：
  - 内置风险规则引擎对 20 组典型危险命令（`rm -rf /`、管道执行远程脚本、越界写 `../`、读取密钥目录、合法 `npm test`）的准确分级与零误报；
  - `secret_request` 序列化断言测试（确认提交响应后事件日志、SQLite 文本列与诊断导出均零出现凭据明文）。
- **集成测试**：
  - 模拟桌面客户端与 HM-Remote 客户端并发对同一 `requestId` 提交相反决议（批准 vs 拒绝），验证 Core 仅生效首次决议且双方 UI 最终一致；
  - 验证任意第三方插件尝试调用未授权自动批准方法被权限层 100% 拒绝。
- **端到端测试**：
  - 启动子 Agent 触发高危命令审批 → 父会话顶部 Attention Strip 亮起 → 点击跳转并拒绝 → 验证子任务收到拒绝回执并收敛状态。
- **可验证验收标准**：
  1. 100% 的 `critical` 级危险命令审批呈现醒目红色风险说明且禁止一键误批准；
  2. 桌面与移动端并发审批竞争测试 100 次零重复回复底层 CLI；
  3. 全链路审计（SQLite + 控制台日志 + Markdown 导出）中 `secret_request` 输入明文泄露次数为 **0**；
  4. 第三方 `approval.annotate` 抛错或死循环时，审批卡片仍在 < 400ms 内正常渲染。
