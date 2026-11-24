# 插件开发任务说明书 16 · Triage Inbox & Command Palette

| 属性 | 说明 |
| --- | --- |
| **插件名称 & Plugin ID** | Triage Inbox & Command Palette · `hm.plugin.triage-inbox` |
| **功能定位** | 借鉴 T3 Code 备受好评的高密度多任务驾驶舱交互，为并发管理 5–20+ 跨引擎会话的重度开发者提供：**Triage 待办收件箱**（按阻塞审批/未读结果/运行中/稍后处理自动分拣）、会话置顶/稍后提醒（Snooze）/标记已处理（Settled）与全局统一 **`Ctrl/Cmd+K` 命令面板**（一站检索会话、切换 Harness、执行全部已安装插件动作与快捷键导航） |
| **参考来源 (T3 Code)** | `t3code/apps/web/src/components/CommandPalette.tsx`、`CommandPaletteContent.tsx`、`CommandPalette.logic.ts`、`commandPaletteStore.ts`、`shortcuts/commandPaletteCommands.ts`、`components/chat/TriageDraftHero.tsx`、`hooks/useStartTriage.ts`、`lib/triageTarget.ts`（`[T3 Code 已验证实现]`） |
| **HarnessMate 当前状态** | **完全缺失**：现有侧边栏仅按时间线平铺展示会话列表，当用户同时推进多个不同 Harness 会话时缺少未读/待处理分拣机制，也缺少聚合所有插件斜杠指令与全局动作的统一 `Ctrl/Cmd+K` 命令面板 |
| **插件类型** | Optional Plugin（官方可选效率增强插件，零后端强侵入，纯侧栏徽标 + 全局快捷键交互层） |
| **开发难度与风险** | **低中**（风险点：全局快捷键与浏览器/操作系统原生快捷键或输入框中文 IME 组合输入法冲突；高频徽标状态刷新引发侧边栏重渲染抖动；命令面板聚合第三方插件动作时未做好排序与异常隔离） |
| **开发优先级** | **P3**（Phase 4，作为多会话并行工作流的终极效率收口） |

---

## 1. 职责范围

### 明确负责
- **Triage 智能待办收件箱（Triage Inbox）**：
  - 基于订阅核心只读状态事件，将所有活跃逻辑会话自动划分为 4 个优先级分组：
    1. **Needs Attention（红点置顶）**：存在待决审批、用户提问或限额/错误中断；
    2. **Unread Result（蓝点待阅）**：后台 Harness 已完成新轮次但用户尚未查看；
    3. **Running（脉冲运行中）**：正在流式生成或运行工具/子任务；
    4. **Snoozed / Settled（稍后处理/已收口）**：用户手动标记稍后提醒（如 30 分钟后 / 明天上午）或标记已完成，从主视线收起；
  - 支持对任意会话执行 **Pin（置顶）**、**Mark Unread（标为未读）**、**Snooze（延后提醒）** 与 **Mark Settled（标为已处理）**；
- **统一 `Ctrl/Cmd+K` 全局命令面板（Command Palette）**：
  - 借鉴 T3 Code `CommandPalette.tsx` + `commandPaletteCommands.ts`（注意严格处理中文/日文 IME `compositionstart/compositionend` 状态，避免输入法选词误触发回车提交！）；
  - 单入口模糊检索并直达：
    - 任意会话与工作区（优先展示未读与 Needs Attention 会话）；
    - 快速切换当前会话目标 Harness 实例（如输入 `switch claude` 或 `switch codex-work`）；
    - 自动索引所有已启用插件声明的动作、斜杠工作流与面板入口（如“预览交接包”、“打开 Git Diff”、“新建 Worktree”、“打开用量看板”）；
    - 主题切换、快捷键速查与新建空白/Triage 会话；
- **高频键盘导航体系**：
  - 提供可定制快捷键（如 `Alt+Up/Down` 切换下一个 Needs Attention 会话、`Ctrl/Cmd+K` 唤起命令面板、`Ctrl/Cmd+Shift+H` 快速切引擎），全键盘零鼠标即可驾驭 10+ 并发任务。

### 明确不负责
- 不修改 Core SQLite 会话主表结构（Triage 元数据属于用户个人工作流视图偏好，完全存于插件 KV 存储）；
- 不替代 `hm.plugin.session-explorer` 做百万字全文内容检索（`Ctrl/Cmd+K` 仅做毫秒级标题/动作/插件内存索引，用户可键入前缀 `? ` 委托给 `session-search` 跳转全文搜）；
- 不替用户执行任何高危操作（命令面板触发危险动作时依然遵循既有二次确认与审批流程）。

---

## 2. 依赖关系、SDK 接口与对外能力

- **依赖关系**（DAG Layer 1）：仅依赖 Core Runtime 与前端 `SlotRegistry`（若 `hm.plugin.session-explorer` 已启用，可通过可选发现跳转到全文搜索视图，**零硬依赖**）。
- **调用的 SDK 接口**：
  - V4 既有：`ctx.events.on`、`ctx.storage.plugin`（保存 Pin / Snooze / ReadCursor / 自定义快捷键）、`ctx.logger`；
  - V5 增量：`ctx.capabilities.listHarnesses()`、`session.sidebar.badge` UI 插槽（SDK V5 新增）、前端全局命令注册表读取接口。
- **对外暴露能力**：
  - 挂载 `session.sidebar.badge` 为侧栏每一条会话渲染状态徽标（未读圆点、阻塞红标、Snooze 闹钟、置顶图钉）；
  - 向全局挂载 `Ctrl/Cmd+K` 命令面板弹窗与顶部/侧栏 Triage 过滤器切换条；
  - 提供轻量前端命令注册契约，使未来任何第三方插件贡献的命令自动出现在 `Ctrl/Cmd+K` 面板中。

---

## 3. 事件协议与数据模型

- **订阅事件**：`turn.started`、`turn.completed`、`turn.failed`、`approval.requested`、`approval.resolved`、`session.viewed`（前端切入某会话时更新本地 `lastViewedSeq` 消除未读点）、`session.archived`。
- **发布事件**：`triage.snooze_expired`（延后提醒到期时把会话顶回待办并弹出轻量提示）。
- **核心数据模型（全部存于 `ctx.storage.plugin` 轻量 JSON，零新增 SQLite 表）**：
```ts
export interface SessionTriageMeta {
  sessionId: string;
  pinned: boolean;
  settled: boolean;
  forceUnread: boolean;
  lastViewedTurnSeq: number;
  snoozedUntilMs: number | null;
  updatedAt: number;
}

export interface CommandPaletteEntry {
  id: string;
  sourcePluginId: string;
  category: 'session' | 'harness' | 'plugin_action' | 'navigation' | 'theme';
  title: string;
  subtitle?: string;
  keywords: string[];
  shortcutHint?: string;
  execute: () => Promise<void> | void;
}
```

---

## 4. UI 扩展、权限需求与生命周期

- **UI 扩展点与交互形式**：
  - `session.sidebar.badge`（SDK V5 插槽）：在会话列表项右侧呈现精准状态徽章与悬停快捷按钮（Pin / Snooze / Mark Settled）；
  - `sidebar_tool` 顶部切换胶囊：**`[全部 | 待处理 (3) | 已延后]`** 过滤器；
  - `modal`（全局快捷键 `Ctrl/Cmd+K` 唤起）：高对比度模糊搜索 **Command Palette**，支持键盘上下选择、分类标签与高频最近使用加权（MRU）。
- **权限需求**：最小只读权限 `session:read` 与 `storage:plugin`（零文件写权限、零进程派生权限、零网络权限）。
- **生命周期**：
  - **安装/启用**：从 `ctx.storage.plugin` 恢复 Pin/Snooze 状态，启动 30s 轻量定时器检查到期 Snooze，绑定 `Ctrl/Cmd+K` 快捷键并注册侧栏徽标插槽；
  - **更新**：保留全部用户置顶、未读游标与快捷键自定义；
  - **禁用/卸载**：解绑全部全局快捷键监听器、卸载侧栏徽标插槽，恢复主程序默认平铺会话列表。

---

## 5. 异常处理、恢复与降级机制

1. **中文/日文/韩文 IME 输入法组合态保护**：严格监听 `isComposing`（借鉴 T3 Code `CommandPalette.composition.browser.test.tsx`），IME 选词期间按 `Enter` / `Escape` 绝不误执行选中命令或关闭弹窗；
2. **第三方命令执行抛错隔离**：在 `CommandPalette` 内调用任何外部插件注册的 `execute()` 均包裹 `try/catch` 并显示温和 Toast 错误提示，绝不卡死弹窗或主界面；
3. **跨设备或历史清理产生的幽灵 `sessionId`**：后台启动时比对 Core 存活会话集合，自动垃圾回收已被删除会话的孤儿 `SessionTriageMeta` 条目；
4. **定时器休眠补算**：电脑休眠唤醒后立即触发一次 Snooze 到期扫描，确保已过期的延后提醒及时浮现。

---

## 6. 测试方案与可验证验收标准

- **单元测试**：
  - 4 级 Triage 分组排序逻辑（Needs Attention > Unread > Running > Pinned > Normal > Snoozed/Settled）；
  - 模糊搜索打分算法与 MRU（最近高频使用）加权排序；
  - 休眠后 Snooze 过期补算与已删会话元数据自动 GC。
- **浏览器组件测试**：
  - 复刻 T3 Code `CommandPalette.composition.browser.test.tsx` 校验 IME 组合输入期间 `Enter` 不误触发；
  - 模拟 200 条会话 + 50 个插件动作下 `Ctrl/Cmd+K` 键入过滤延迟与键盘导航测试。
- **可验证验收标准**：
  1. 200 条会话规模下，`Ctrl/Cmd+K` 唤起与每次按键模糊过滤延迟 < 16ms（60 FPS 无掉帧）；
  2. 中文输入法组合态按 `Enter` 上屏词组时命令误触发率为 **0%**；
  3. 任意后台会话触发审批请求或轮次完成，1 秒内自动置顶至 Triage `Needs Attention` / `Unread` 分组，点击切入后准确消红点；
  4. 禁用插件后全局无残留键盘事件监听，且主程序会话列表 100% 正常使用。
