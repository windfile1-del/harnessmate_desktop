# 插件 SDK V3

从「插件中心 → 扩展市场」安装「会话工具箱」。在插件的「工作区授权」中选择工作区，并勾选要用的动作或模型工具。`/unique-lines` 可以整理聊天输入中的文本行。`/toolkit-usage`、`/toolkit-compact` 和 `/toolkit-plan` 调用当前会话的原生能力。聊天的斜杠菜单会显示需要授权、当前 CLI 不支持或缺少原生上下文等原因。

V3 继承 [V2 面板和投影](plugin-sdk-v2.md)。可在插件中心交给 AI 编写或修改 V3 清单，预览时可以给处理程序输入样本。安装后，动作和模型工具各自授权，授权绑定工作区、能力及当前安装包摘要。新版内容需要重新授权。撤销会立即阻止后续调用，会话的工具列表在下一轮启动时刷新。

## 清单示例

```json
{
  "id": "user.sorted-failures",
  "name": "失败日志整理",
  "description": "筛出失败项并排序去重",
  "version": "1.0.0",
  "apiVersion": 3,
  "category": "tool",
  "contributes": {
    "programs": [{
      "id": "failures",
      "description": "筛出包含 FAIL 的文本行，再排序去重",
      "exposeToModel": true,
      "steps": [
        { "op": "trim" },
        { "op": "lines", "contains": "FAIL", "ignoreCase": true, "unique": true, "order": "asc", "limit": 40 }
      ]
    }],
    "actions": [
      { "kind": "program", "command": "sort-failures", "description": "整理失败日志", "program": "failures" },
      { "kind": "harness", "command": "enter-design", "description": "进入计划模式", "nativeCommand": "plan", "args": "" }
    ]
  }
}
```

| 字段 | 行为 |
| --- | --- |
| `programs[].steps` | 顺序执行 `trim`、`case`、`replace`、`wrap`、`lines`。`replace` 匹配字面文本，`lines` 支持过滤、去重、排序和限制行数。每个程序最多 16 步，输入和各步结果最多 12,000 个 UTF-16 代码单元。 |
| `actions[].kind` 为 `program` | 使用命令参数作为文本输入，结果直接显示在聊天，节省模型调用。 |
| `actions[].kind` 为 `harness` | 由用户主动调用 `compact`、`usage`、`model`、`plan`、`goal`、`skills` 或 `skill`。填写 `args` 固定参数，省略 `args` 时读取聊天命令参数。 |
| `programs[].exposeToModel` | 单独授权后，通过本机、会话级 HTTP MCP 提供同一个文本处理程序。工具接收 `{ "text": "…" }`。 |

处理程序只操作收到的文本，支持的操作由宿主实现。需要调用原生 CLI 能力时使用显式的聊天动作。V1 JavaScript 仍走本地目录信任流程，其 Worker 使用当前系统用户权限。

## CLI 接入

- Codex app-server 使用当前进程的 MCP 配置。 [Codex 配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)
- Claude Code 使用当前会话进程的 `--mcp-config`。 [Claude Code CLI 参考](https://code.claude.com/docs/en/cli-reference)
- AGY 和其他 ACP 适配器根据初始化时的 `mcpCapabilities.http` 声明选择 HTTP 或本机 stdio 转接。 [ACP 会话设置](https://agentclientprotocol.com/protocol/v1/session-setup)

插件工具使用会话自己的临时连接凭证，复用 [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) 的 JSON 请求响应。升级、禁用和撤销都会重新检查权限。聊天会显示已授权工具数和当前会话的接入状态。
