# 插件浏览器预览

浏览器预览允许 V4 插件在面板中显示本机、局域网或远程 HTTP(S) 页面。桌面宿主启动独立的离屏 Chromium，把网页画面送给插件。插件可以自定义导航、显示和交互，也可以用它打开另一个无头浏览器或开发服务提供的 HTTP(S) 查看器。

## 从模板开始

1. 在桌面端打开「插件中心 → 开发 / 脚手架」，选「浏览器预览」并生成插件。保留「关联开发模式」即可保存后热重载。
2. 在该插件的权限设置中授权 `browser:preview`。如果经常修改自己的插件，可以选择「覆盖后续版本」。
3. 进入任意聊天，打开右侧「插件」面板并选中新插件，输入网址。需要更多空间时，点击侧栏顶部的展开按钮。

仓库开发时也可生成同一模板。

```powershell
pnpm create:plugin --id user.browser-preview --name "浏览器预览" --template browser-preview --dir D:/Dev/user.browser-preview
```

## 在自己的插件中接入

在 `harnessmate-plugin.json` 的 `permissions` 中加入 `browser:preview`，并在 `contributes.slots` 声明面板 HTML。该能力无需 `main` 入口。

## 带本地后端的浏览器工作页

在插件中心打开「开发 / 脚手架」，选择「浏览器工作页（本地后端）」并生成源码。生成后，目录会填到上方的关联栏。点击「关联并信任」，确认插件 ID 和目录。也可运行 `pnpm create:plugin --id user.browser-workspace --name "浏览器工作页" --template browser-workspace` 后选择生成的目录。

在「已安装」中为插件授权 `browser:preview`。开发期间可选择「覆盖后续版本」，声明的权限未增加时，编辑源码可沿用这项浏览器授权。从侧栏打开工作页，点击「打开本地查看器」。点画面里的输入框定位焦点，再通过预览下方的输入控件发送中文。

- `index.mjs` 使用 Node HTTP 模块在回环地址和随机端口上启动服务。它等待监听成功，通过 `ctx.effect` 登记关闭逻辑，再用 `ctx.slots.register` 注册 `workspace.pages` 和 `onMessage`。
- `ui/panel.*` 是宿主里的工作页。它通过 `window.harnessMate.sendToPlugin` 向当前后端查询地址，再交给浏览器桥加载。工作页也支持只有 HTML 的声明式插件。
- `viewer.html` 是后端返回的页面。更换后端或者修改页面时只需编辑源码目录。宿主从受管快照启动后端，工作数据应放在插件存储或单独的数据目录。
- 在插件中心可以停用或回退。开发页可以撤销本地信任。候选启动失败时，宿主会恢复上一个通过激活的运行副本，并在插件日志中显示错误。源码文件保留当前编辑内容。

代码可用 `requires = ['ui.workspace.pages', 'runtime.trustedLocal']` 声明对宿主版本的要求，用 `ctx.runtime.trustedLocal` 检查本次运行是否已经获准。可信本地后端拥有当前系统用户的文件、网络和进程权限。需要随插件可靠回收的外部 CLI 使用 `ctx.runtime.spawnCli`，自行分离的进程由插件负责清理。宿主桥与模型工具的授权独立生效。

```js
const browser = window.harnessMate.browser;
const preview = document.querySelector('img');

const stopFrames = browser.onFrame(({ dataUrl }) => {
  preview.src = dataUrl;
});
const stopStatus = browser.onStatus(({ state, url, message }) => {
  console.log(state, url, message);
});

if (browser.available) {
  await browser.open({ url: 'http://localhost:3000', width: 1000, height: 700 });
}
```

| 方法 | 行为 |
| --- | --- |
| `available` | 该环境有桌面浏览器桥接。实际授权结果由 `open` 返回。 |
| `open({ url, width?, height? })` | 创建预览或在当前实例打开新地址。加载结果通过 `onStatus` 报告。 |
| `onFrame(listener)` | 接收 JPEG data URL 和逻辑宽高，返回取消订阅函数。 |
| `onStatus(listener)` | 接收 `loading`、`ready`、`error`、`closed` 状态，返回取消订阅函数。 |
| `input(event)` | 接收点击、移动、滚动、按键和文本输入。坐标使用 `onFrame` 中的逻辑宽高。 |
| `back()`、`forward()`、`reload()` | 控制当前页面历史和重新加载。 |
| `close()` | 释放当前面板的浏览器。面板卸载、插件禁用、重新加载或授权撤销都会回收浏览器。 |

插件面板本身继续使用原有 iframe。浏览器页面使用独立的临时会话，支持网页脚本、子资源和 WebSocket。插件通过画面与输入接口交互。宿主保留自己的服务端口，拒绝浏览器访问这些端口、打开系统协议或继承宿主的 Electron 权限。

## 用聊天开发插件

在聊天输入区开启「插件开发」，直接描述要实现的定制。每轮请求附带 V4 清单、插槽、浏览器、安装和热重载说明，按普通用户消息发送。聊天保留原始需求，模型可在当前工作区创建插件文件。该模式沿用当前 CLI 的模型及权限设置，生成后通过插件中心关联或安装。
