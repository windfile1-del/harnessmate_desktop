# 插件 SDK V2

在插件中心的目录安装「项目验收台」，打开任意会话后，从侧栏、输入区或右侧「插件」标签页打开。聊天中的 `/acceptance` 将当前工作区的轮次摘要复制到剪贴板。

自定义插件可以把下列清单粘贴到插件中心校验并安装，也可保存为插件目录中的 `harnessmate-plugin.json`。已有 V1 清单和手动信任的 JavaScript 插件继续使用原有接口。V2 使用声明式清单，事件、面板和动作由宿主执行。

```json
{
  "id": "user.failed-turns",
  "name": "失败轮次",
  "description": "在工作区内查找失败的轮次",
  "apiVersion": 2,
  "version": "1.0.0",
  "category": "ui",
  "contributes": {
    "projections": [{ "id": "failures", "scope": "workspace", "events": ["turn.failed"] }],
    "dataPanels": [{
      "id": "recent-failures",
      "title": "工作区失败轮次",
      "projection": "failures",
      "columns": [
        { "field": "session", "label": "会话" },
        { "field": "harness", "label": "Harness" },
        { "field": "verifications", "label": "验证记录" }
      ],
      "filters": ["harness"],
      "counts": true,
      "openTurn": true,
      "placements": ["sidebar_tool"],
      "copySummary": { "label": "复制失败统计", "command": "failed-turns" }
    }]
  }
}
```

| 字段 | 行为 |
| --- | --- |
| `projections[].scope` | `session` 只读取当前会话，`workspace` 查询当前会话所属工作区。 |
| `projections[].events` | 支持 `turn.completed`、`turn.failed` 和 `turn.cancelled`。同一会话、同一轮次以最新的终态为准。维护命令轮次会从统计中排除。 |
| `dataPanels[].columns` | 可配置顺序和标题，字段为 `time`、`session`、`harness`、`status`、`changed_files` 和 `verifications`。 |
| `dataPanels[].filters` | `harness` 或 `status`。筛选在 Daemon 分页前应用。 |
| `dataPanels[].placements` | `sidebar_tool` 或 `composer_action`。已启用面板也会出现在右侧「插件」标签页。 |
| `counts`、`openTurn`、`copySummary` | 展示全范围分组计数、定位原轮次、复制全范围摘要。`copySummary.command` 可为复制动作注册本地斜杠命令。 |

投影查询使用 Daemon 中的已持久化事件，独立于聊天页的事件分页。打开的面板每四秒刷新。导入的轮次会显示「已导入」。改动文件来自记录中的成功编辑或 diff，验证状态来自带匹配工具结果的测试、构建或检查命令。缺少验证记录时显示「待确认」。

面板 ID 在插件内唯一，投影引用必须指向同一插件。复制命令和已有插件命令、原生命令共用名称空间。更新清单时保留插件 ID，递增版本并重新预览安装。启停、热更新、失败保留与回退沿用插件中心的版本管理。
