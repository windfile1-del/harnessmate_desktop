# 插件开发任务说明书 12 · Message Studio, Traits & HTML Render

| 属性 | 说明 |
| --- | --- |
| **插件名称 & Plugin ID** | Message Studio, Traits & HTML Render · `hm.plugin.message-studio` |
| **功能定位** | 在主程序核心文本/Markdown 渲染器之上，提供面向多 Harness 差异化的高级呈现与交互层：可折叠多步工作组（`WorkGroup`）、结构化工具调用深度检视器（按需拉取省略的大输出）、数据驱动的动态 `TraitsPicker`（推理强度/服务档位/扩展开关）、双隔离沙箱交互式 HTML 实时渲染卡（`html_render`）与对话时间线小地图（Turn Minimap） |
| **参考来源 (T3 Code)** | `t3code/apps/web/src/components/chat/TimelineWorkGroupRows.tsx`、`TimelineWorkGroupRows.logic.ts`、`TraitsPicker.tsx`、`HtmlRenderFrame.tsx`、`HtmlRenderDialog.tsx`、`hooks/useHtmlRenderTheme.ts`、`TimelineMinimap.tsx`、`timelineMinimapItems.ts`（`[T3 Code 已验证实现]`） |
| **HarnessMate 当前状态** | **部分实现**：`packages/web/src/components/ChatStage.tsx` 与 `ModelPicker` 具备基础消息渲染、简单工具卡片与基础选模型控件，`packages/web/src/slots/slot-registry.ts` 已有 `SandboxedPluginFrame`；**缺口**：多步连续工具调用未聚合为可折叠 `WorkGroup`（长任务刷屏）、大命令输出缺基于 `outputOmitted` 的按需分页检视器、模型参数选择器仍写死各家推理选项而非动态消费 `ProviderOptionDescriptor[]`、缺安全的 `html_render` 交互预览卡与时间线 Minimap |
| **插件类型** | Built-in Plugin（默认启用第一方纯前端增强 + 轻量配置插件） |
| **开发难度与风险** | **中**（风险点：长会话 500+ 块渲染掉帧与滚动抖动；`html_render` iframe 引入 XSS 或伪造宿主通讯；未识别扩展块或第三方自定义渲染组件白屏拖垮主对话区） |
| **开发优先级** | **P1**（Phase 2，实现“新增 Harness 零修改主程序前端”的关键 UI 承载层） |

---

## 1. 职责范围

### 明确负责
- **数据驱动的动态参数选择器（`TraitsPicker`）**：
  - 挂载于 SDK V5 `composer.traits` 插槽，完全基于当前选中 Harness 实例上报的 `ProviderOptionDescriptor[]`（`select` / `toggle` / `slider`）自动生成控件（例如 Codex 的 `reasoningEffort` + `serviceTier`、Claude 的 `effort` + `fastMode`、DeepSeek 的 `thinkingBudgetTokens`、OpenCode 的 `agent`），**前端零 `if (driverId === ...)` 硬编码**；
  - 将用户选中的值按实例/会话记忆并透传至 Core `turnOptions`。
- **工作组合并（`WorkGroup`）与工具调用深度检视器（`Tool Call Inspector`）**：
  - 借鉴 T3 Code `TimelineWorkGroupRows.logic.ts`，将单轮中连续的非回复步骤（`reasoning` + `command_execution` + `file_read` + `mcp_tool_call` + `web_search`）自动折叠为单行紧凑进度条（如 `已完成 7 个步骤 · 读 4 文件 · 运行 2 命令 · 耗时 14.2s`），运行中自动展开最新一条步骤；
  - 当任意 `TurnBlock` 标记 `outputOmitted: true`（受线缆体积保护截断的大命令日志或大 JSON 工具返回）时，点击“展开完整输出”按需调用 `sessions.getItem(sessionId, itemId, { textOffset, maxChars })` 分页流式拉取，并支持一键复制、正则搜索与 ANSI 终端着色渲染；
  - 对未知的 `ext:*` 扩展块提供统一的 **Generic Fallback Card**（展示块类型、来源引擎与可折叠格式化 JSON），确保旧版客户端面对新插件永不白屏。
- **沙箱交互式 HTML 渲染卡片（`html_render`）**：
  - 借鉴 T3 Code `HtmlRenderFrame.tsx` + `useHtmlRenderTheme.ts` 与 HarnessMate 现有 `SandboxedPluginFrame`：注册 `chat.block`（key: `html_render`）渲染器，允许 AI（或通过 `hm_render_html` MCP 工具）输出交互式图表、SVG 架构图或 UI 原型；
  - 强制双层安全隔离：`sandbox="allow-scripts"`（禁止 `allow-same-origin`、`allow-top-navigation`、`allow-popups`）、严格 CSP（禁止外网脚本与数据外泄）、动态注入当前亮/暗色 CSS 主题变量、支持全屏弹窗展开（`HtmlRenderDialog`）与 `ResizeObserver` 高度自适应。
- **时间线小地图（Turn Minimap）与阅读位置记忆**：
  - 借鉴 T3 Code `TimelineMinimap.tsx`，在长对话右侧悬浮轻量轮次导览条（用不同色点标记当前运行引擎、文件修改轮次与跨引擎交接分割点），支持鼠标滚轮快速跳转与切回会话时自动恢复上次滚动位置。

### 明确不负责
- 不负责核心纯文本/Markdown 流式气泡的基础渲染（留于 `packages/web` 主核，即使本插件关闭仍可正常聊天）；
- 不管理任何后端会话数据持久化或原生协议转换；
- 不允许 `html_render` 沙箱执行宿主 RPC、访问工作区文件或发起未授权网络请求。

---

## 2. 依赖关系、SDK 接口与对外能力

- **依赖关系**（DAG Layer 1）：仅依赖 Core Runtime 与前端 `SlotRegistry`，**零跨插件依赖**。
- **调用的 SDK 接口**：
  - V4 既有：`ctx.tools.register`（注册只读渲染工具 `hm_render_html`）、`ctx.storage.plugin`（记忆各实例偏好与折叠设置）；
  - V5 增量：`ctx.sessions.getItem()`（按偏移分页拉取被省略的大工具输出）、`ctx.capabilities.listHarnesses()`（获取 `ProviderOptionDescriptor[]` 与视觉呈现元数据）、5 个新 UI 插槽中的 `composer.traits` 与 `chat.block`。
- **对外暴露能力**：
  - 向 `chat.block` 插槽注册内置高精度块渲染器：`work_group`、`tool_call_inspector`、`html_render`、`unknown_ext_fallback`；
  - 向 `composer.traits` 插槽提供通用 `TraitsPicker`；
  - 提供 MCP 模型工具 `hm_render_html`（`readOnly: true`，输出标准 `html_render` 块）。

---

## 3. 事件协议与数据模型

- **订阅事件**：前端 WebSocket 投影流（`turn_item.updated`、`command_output.delta` 经 `CommandOutputHub` 按需订阅活跃终端流、`session.harness_switched`）。
- **核心数据模型（零后端数据库表，纯前端投影与轻量本地偏好）**：
```ts
export interface WorkGroupProjection {
  groupId: string;
  turnSeq: number;
  status: 'running' | 'completed' | 'failed';
  items: Array<{
    itemId: string;
    kind: 'reasoning' | 'command_execution' | 'file_change' | 'mcp_tool_call' | 'web_search' | 'ext';
    title: string;
    status: 'running' | 'completed' | 'failed' | 'interrupted';
    durationMs?: number;
    outputOmitted?: boolean;
    omittedBytes?: number;
  }>;
  collapsedByDefault: boolean;
}

export interface HtmlRenderBlockPayload {
  title: string;
  html: string;               // 经大小上限（≤ 512KB）校验的独立 HTML 文档
  preferredHeightPx?: number;
  allowFullscreen?: boolean;
}
```
- **持久化方式**：仅将用户偏好（默认展开/折叠工作组、每会话上次阅读轮次索引、各实例 Trait 默认值）存前端 `localStorage` 与 `ctx.storage.plugin`。

---

## 4. UI 扩展、权限需求与生命周期

- **UI 扩展点与交互形式**：
  - `composer.traits`：动态模型扩展参数控件组；
  - `chat.block`：WorkGroup 折叠条、Tool Call Inspector 抽屉/卡片、沙箱 `HtmlRenderFrame` 与全屏 `HtmlRenderDialog`、未知 `ext:*` 安全降级卡；
  - `chat_stage_overlay`：右侧悬浮 `TimelineMinimap`（按引擎主题色分段指示，悬停显示该轮摘要与文件变动数）。
- **权限需求**：内置受信任前端增强插件；声明 `session:read`、`tools:model`。
- **生命周期**：
  - **安装/启用**：向 `SlotRegistry` 批量注册渲染器与 `TraitsPicker`，启用 React `ErrorBoundary` 单卡片故障隔离；
  - **更新**：支持热更新渲染模板与样式变量，无需刷新全页丢失输入草稿；
  - **禁用**：自动卸载高级插槽渲染器，主程序 `ChatStage` 无缝退回到内建的基础纯文本/简版工具块渲染器。

---

## 5. 异常处理、恢复与降级机制

1. **单块渲染异常隔离（Per-Block ErrorBoundary）**：任意自定义渲染器或畸形工具载荷抛出 React 异常时，仅该卡片降级显示“渲染异常（点击查看原始 JSON）”并上报日志，**绝不导致整个会话页白屏**；
2. **`html_render` 安全与死循环防护**：强制剥离无授权外链脚本（严格 CSP `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:`）、屏蔽同步 `alert/confirm/prompt`、单文档上限 512KB，超限拒渲并退回源码代码块展示；
3. **海量终端日志渲染卡顿**：Tool Call Inspector 内采用固定行高虚拟滚动与按 64KB 分页拉取，流式输出仅在用户展开卡片时订阅对应 `CommandOutputHub` 频道，关闭卡片立即退订释放内存；
4. **过时 Trait 参数自动清理**：切换模型或升级 CLI 后若本地记忆的某旧 Trait 值已不在新的 `ProviderOptionDescriptor.options` 枚举中，自动回落至新描述符的 `defaultValue` 并消除无效参数，避免底层 CLI 报 400 校验错误。

---

## 6. 测试方案与可验证验收标准

- **单元测试**：
  - `WorkGroup` 归并算法测试（连续工具步合并、用户文本/助手正文打断分组、运行中自动展开与完成后自动折叠）；
  - `TraitsPicker` 动态消费 4 种不同 Harness 的 `ProviderOptionDescriptor[]`（含非法旧缓存值自动重置）；
  - `TimelineMinimap` 轮次锚点计算与跨引擎色带映射。
- **浏览器组件测试**：
  - `HtmlRenderFrame` 安全沙箱测试（验证 iframe 无法访问 `window.parent.document` / `localStorage` / 发起外部 `fetch`，且能正确跟随亮/暗色主题切换）；
  - 注入畸形 `ext:future.unknown_block` 载荷验证自动落入 Generic Fallback Card 且主页面无崩溃；
  - 模拟 200 轮对话（2,000+ 块）滚动与按需分页拉取 5MB 截断日志，验证帧率稳定且内存受控。
- **可验证验收标准**：
  1. 接入新的 `hm.adapter.deepseek` 与 `hm.adapter.opencode` 后，**零修改本插件及 `packages/web` 代码**即可自动呈现其专有模型参数与扩展块；
  2. `HtmlRenderFrame` 通过全部 XSS / 同源逃逸 / 外联泄露安全断言；
  3. 200 轮长会话冷打开首屏渲染 < 150ms，展开 `outputOmitted` 大日志首屏分页加载 < 100ms。
