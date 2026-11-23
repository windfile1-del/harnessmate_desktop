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
