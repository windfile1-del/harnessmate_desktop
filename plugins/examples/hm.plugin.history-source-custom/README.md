# 第三方自定义历史来源样例 (`user.history-source-custom`)

本样例演示如何仅使用公开插件契约 `history.source.v1`（`1.0.0`）实现一个可独立安装、启停、与预装历史来源（Codex / Claude / AGY CLI / AGY Desktop）并行运行的第三方历史来源插件。

## 目录结构

- `harnessmate-plugin.json`：V4 清单，声明 `"provides": ["history.source.v1"]` 与 `"permissions": ["fs:cli_histories:read"]`。
- `index.mjs`：通过 `registerHistorySourcePlugin` 注册 `history.source.v1` 服务与 `/discover`、`/read`、`/cancel`、`/status` 实例路由。
- `history-source-runtime.mjs`：纯 Node ESM 运行时（零外部 npm 依赖）。
- `samples/*.jsonl`：包内只读 JSONL 样例记录（在非 `trustedLocal` 沙箱 `--allow-fs-read=<packageRoot>` 模式下亦可直接发现与读取）。

## 独立安装与启停步骤

1. **预览本地目录安装包**：
   - API：`POST /api/v1/plugins/install/preview`
   - 请求体：`{ "mode": "local_dir", "dirPath": "<仓库根>/plugins/examples/hm.plugin.history-source-custom" }`
   - 记录返回的 `digest` 与 `installedDigest`。
2. **确认信任并安装**：
   - API：`POST /api/v1/plugins/install`
   - 请求体：`{ "mode": "local_dir", "dirPath": "<仓库根>/plugins/examples/hm.plugin.history-source-custom", "trustCode": true, "expectedDigest": "<digest>", "expectedInstalledDigest": null }`
3. **验证服务注册与读取**：
   - 查询候选：`GET /api/v1/plugins/services?contract=history.source.v1`
   - 发现记录：`POST /api/v1/plugin-instances/user.history-source-custom/routes/discover`（请求体 `{ "limit": 20 }`）
   - 读取正文：`POST /api/v1/plugin-instances/user.history-source-custom/routes/read`（请求体 `{ "ref": { "sourceInstanceId": "user.history-source-custom", "sourceId": "custom:default", "nativeSessionId": "custom-session-001" }, "limit": 10 }`）
4. **独立目录/多实例配置（可选）**：
   - 若通过开发模式可信本地挂载（`POST /api/v1/plugins/dev/link`，`trustedId: "user.history-source-custom"`），可在组合实例中配置 `config: { "rootDir": "D:\\path\\to\\custom-jsonl", "sourceId": "custom:team-a" }`，与预装来源及另一自定义实例并行工作。
5. **停用与卸载**：
   - 停用：`POST /api/v1/plugins/user.history-source-custom/toggle`（`{ "enabled": false }`），会停止接收新请求并取消在途读取，不影响其余预装历史来源。
   - 卸载：`DELETE /api/v1/plugins/user.history-source-custom`。
