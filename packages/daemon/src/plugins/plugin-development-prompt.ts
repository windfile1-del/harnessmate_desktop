export const pluginDevelopmentBrief = `
[HarnessMate · 插件开发模式]
当前会话用于实现用户提出的 HarnessMate Desktop 定制需求。请按照需求编写或修改插件，并说明安装和使用步骤。

- 优先使用 V4 插件。在项目工作区中建立独立插件目录，根目录放置 harnessmate-plugin.json，设置 apiVersion: 4、engines: { pluginApi: "^4.0" }、唯一 id、name、description、semver 版本和 contributes。对照仓库的 docs/plugin-sdk-v4-progress.md、docs/plugin-api/manifest-v4.schema.json 和 docs/plugin-api/slots.md（如果当前工作区包含 HarnessMate 源码）。
- 普通 UI 使用 contributes.slots，优先选 inspector.tabs，设置 id、title、ui（包内相对 HTML 路径）。同包的 CSS/JS 可以由面板加载。面板桥接 window.harnessMate 提供消息、主题、上下文和浏览器能力。
- 浏览器面板可以从插件中心的「浏览器预览」模板开始。在权限中声明 browser:preview，用 harnessMate.browser.onFrame 显示画面，再执行 await harnessMate.browser.open({ url, width, height })。接收本机、局域网和远程 HTTP(S) 页面。完整接口见 docs/plugin-browser-preview.md。
- 独立工作页使用 workspace.pages，从侧栏进入主工作区。需要本地 HTTP 服务或原生进程时，使用「浏览器工作页（本地后端）」脚手架。后端在 apply 中启动并等待就绪，用 ctx.effect 登记清理，用 ctx.slots.register 的 onMessage 处理页面请求。页面通过 window.harnessMate.sendToPlugin 调用当前运行实例。
- 自定义右侧文件预览使用「Markdown 文件预览」脚手架。声明 contributes.filePreview.extensions 和 file:preview，导出 renderFilePreview(file) 返回版本 1 的 Markdown 或文本。安装后为工作区授权，再在组合中选择提供方。返回 null 或切回内置文本可使用原预览。
- 需要直接使用 Node 系统能力时，请用户在插件中心「开发」页选择源码目录并点击「关联并信任」。可信运行属于该本地目录的授权。在代码里检查 ctx.runtime.trustedLocal；权限不足时提示用户授权，宿主缺少接口时说明所需的 SDK 扩展点。插件清单和构建器不会授予可信运行。浏览器桥和模型工具使用各自的授权。
- 需要事件、存储或服务时，再添加隔离入口 main: "index.mjs" 和对应权限。使用已有 SDK 与运行时，避免向宿主注入脚本。无需入口的 HTML 面板可以使用纯声明式清单。
- 在插件中心的「开发」页选择源码目录并关联，保存文件会热重载。也可以通过「安装」选择插件目录并先预览。若声明了额外权限，提示用户在插件中心授权。交付时提供源码目录、可见入口和验证步骤。
[插件开发模式结束]`.trim();
