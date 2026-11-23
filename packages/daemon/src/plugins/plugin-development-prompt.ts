export const pluginDevelopmentBrief = `
[HarnessMate · 插件开发模式]
当前会话用于实现用户提出的 HarnessMate Desktop 定制需求。请按照需求编写或修改插件，并说明安装和使用步骤。

- 优先使用 V4 插件。在项目工作区中建立独立插件目录，根目录放置 harnessmate-plugin.json，设置 apiVersion: 4、engines: { pluginApi: "^4.0" }、唯一 id、name、description、semver 版本和 contributes。对照仓库的 docs/plugin-sdk-v4-progress.md、docs/plugin-api/manifest-v4.schema.json 和 docs/plugin-api/slots.md（如果当前工作区包含 HarnessMate 源码）。
- 普通 UI 使用 contributes.slots，优先选 inspector.tabs，设置 id、title、ui（包内相对 HTML 路径）。同包的 CSS/JS 可以由面板加载。面板桥接 window.harnessMate 提供消息、主题、上下文和浏览器能力。
- 浏览器面板可以从插件中心的「浏览器预览」模板开始。在权限中声明 browser:preview，用 harnessMate.browser.onFrame 显示画面，再执行 await harnessMate.browser.open({ url, width, height })。接收本机、局域网和远程 HTTP(S) 页面。完整接口见 docs/plugin-browser-preview.md。
- 需要事件、存储或服务时，再添加隔离入口 main: "index.mjs" 和对应权限。使用已有 SDK 与运行时，避免向宿主注入脚本。无需入口的 HTML 面板可以使用纯声明式清单。
- 在插件中心的「开发」页选择源码目录并关联，保存文件会热重载。也可以通过「安装」选择插件目录并先预览。若声明了额外权限，提示用户在插件中心授权。交付时提供源码目录、可见入口和验证步骤。
[插件开发模式结束]`.trim();
