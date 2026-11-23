# 公共 UI 插槽

由 `pnpm contracts:generate` 生成。插件 API 4.0.0。

第一方与内核级插件可直接注册 React 组件；第三方插件在 `contributes.slots` 或 `ctx.slots.register()` 中声明包内 HTML 入口，由宿主在 `sandbox="allow-scripts"` 沙箱 iframe 中渲染。

| 插槽 | 基数 | 作用域 | 说明 |
| --- | --- | --- | --- |
| `session.header.title` | `single` | `session` | 会话顶栏标题区域（按 order 最小者优先） |
| `sidebar.tools` | `list` | `session-maybe` | 左侧栏快捷工具区 |
| `composer.actions` | `list` | `session` | 输入区操作栏 |
| `inspector.tabs` | `list` | `session` | 右侧检视抽屉标签页与面板 |
| `statusbar.items` | `list` | `session-maybe` | 状态栏扩展项 |
| `chat.node` | `keyed` | `session` | 按事件或节点类型渲染自定义聊天节点 |
| `tool.result` | `keyed` | `session` | 按工具名渲染自定义工具结果视图 |
| `approval.detail` | `chain` | `session` | 按审批类型链式选择审批详情渲染器 |
| `chat.message.wrapper` | `hoc` | `session` | 包裹聊天消息内容的容器组件 |
