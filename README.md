# Muse 自动审批助手 (Muse Auto Approve)

<p align="center">
  <img src="icons/icon128.png" alt="Muse Auto Approve Logo" width="96" height="96" />
</p>

<p align="center">
  <b>简体中文</b> · <a href="README_en.md">English</a>
</p>

<p align="center">
  <b>专为 <a href="https://muse.ai">Muse.ai</a> 打造的自动化权限审批工具</b><br>
  双模支持：Chrome 原生扩展 (Manifest V3) + 油猴用户脚本 (Tampermonkey)<br>
  穿透封闭组件 · 穿透 iframe 沙盒 · 真实合成事件流 · 迷你拖拽记忆胶囊
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Version-6.3-emerald?style=flat-square" alt="Version" />
  <img src="https://img.shields.io/badge/Manifest-V3-blue?style=flat-square" alt="Manifest V3" />
  <img src="https://img.shields.io/badge/Tampermonkey-Supported-green?style=flat-square" alt="Tampermonkey" />
  <img src="https://img.shields.io/badge/License-MIT-purple?style=flat-square" alt="License" />
</p>

---

## 动态演示 (Demo)

自动侦测 Muse 上传文件、执行操作等权限确认对话框，毫秒级响应并自动完成批准：

![Muse Auto Approve Demo](assets/demo.gif)

---

## 核心特性

- **Closed Shadow DOM 穿透**  
  在 `document-start` 极早生命周期重写 `Element.prototype.attachShadow`，将封闭模式降解为 `open`，穿透现代前端框架的 Web Component 封装。

- **全层级 Iframe 沙盒遍历与跨窗口广播**  
  深度递归主文档及所有同源嵌套 iframe；子窗口触发审批后，通过安全 `postMessage` 实时通知顶层窗口更新统计。

- **真实合成事件链 + React Props 直击**  
  不仅完整派发 `pointerdown` -> `mousedown` -> `pointerup` -> `mouseup` -> `click` 全流程事件，更直接调用 React 内部属性（`__reactProps$` / `__reactEventHandlers$`）的 `onClick` 处理函数，杜绝假点击与漏点击。

- **智能批量优先裁决**  
  优先匹配并点击 `全部允许一次` / `全部允许` / `始终允许` / `Allow all` 等批量选项，其次回落到单次 `允许` / `批准`，最大化加速多任务并发流转。

- **双重防抖与弱引用冷却锁**  
  使用 `WeakMap` 为每个按钮设置 1500ms 独立冷却时间，结合 500ms 全局节流，避免高频 DOM 重绘引发的暴力连击与请求风暴。

- **极简可拖拽悬浮胶囊**  
  - **按住拖动**：自由放置在屏幕任意位置，自动持久化记忆坐标，页面刷新不丢失。
  - **左键单击**：一键切换“自动运行 / 暂停”状态。
  - **右键单击**：一键清零审批累计计数。
  - **视觉体验**：毛玻璃磨砂质感与指示点，小巧不遮挡操作区。

---

## 安装与使用

本项目同时支持 Chrome / Edge 扩展与 Tampermonkey 油猴脚本两种运行方式，任选其一即可。

### 方式一：油猴脚本安装（推荐，简单快速）

1. 确保浏览器已安装脚本管理器扩展：
   - [Tampermonkey (篡改猴)](https://www.tampermonkey.net/)
   - [Violentmonkey (暴力猴)](https://violentmonkey.github.io/)
   - [ScriptCat (脚本猫)](https://docs.scriptcat.org/)

2. **前置权限（针对 Chrome / Edge 最新版）**：  
   在基于 Chromium 的新版浏览器（Chrome 126+ 等）中，受安全策略限制，必须手动允许油猴运行用户脚本，否则脚本将无法注入页面：
   - 打开浏览器地址栏输入 `chrome://extensions/` 进入扩展管理页。
   - 找到已安装的 Tampermonkey（篡改猴），点击进入**“详细信息”**。
   - 找到并开启 **「允许运行用户脚本」** 开关（如下图所示；若未找到该选项，请先在扩展管理页右上角开启“开发者模式”）。

   <p align="center">
     <img src="assets/tampermonkey-permission.png" alt="允许运行用户脚本设置" width="600" />
   </p>

3. **添加并安装脚本（两种途径任选）**：

   - **途径 A：手动添加脚本（最稳妥，推荐）**
     1. 打开本仓库的 [`muse-auto-approve.user.js`](./muse-auto-approve.user.js) 文件，完整复制全部源码。
     2. 点击浏览器右上角工具栏的 Tampermonkey 图标，在弹出菜单中点击 **「添加新脚本...」**（如下图所示）。
     3. 清空编辑器中的原有模板内容，粘贴刚才复制的代码。
     4. 按快捷键 `Ctrl + S`（Mac 为 `Cmd + S`）或点击左上角“文件 -> 保存”即可完成安装。

     <p align="center">
       <img src="assets/tampermonkey-add-script.png" alt="油猴菜单添加新脚本" width="420" />
     </p>

   - **途径 B：在线一键安装**
     - 打开本仓库的 [`muse-auto-approve.user.js`](./muse-auto-approve.user.js) 页面，点击右上角的 **Raw** 按钮，Tampermonkey 将自动弹出安装界面，点击“安装”即可。

4. 打开 [muse.ai](https://muse.ai)，页面右上角即可看到控制胶囊。

### 方式二：Chrome 扩展安装（开发者模式）

1. 前往 [Releases 发布页](https://github.com/waw666waw666/MuseAutoApprove/releases) 直接下载打包好的 `MuseAutoApprove-v6.3.zip` 并解压（或直接下载/克隆本仓库）。
2. 在 Chromium 浏览器（Chrome、Edge、Brave、Arc 等）地址栏输入：
   ```text
   chrome://extensions/
   ```
3. 在右上角开启“开发者模式 (Developer mode)”。
4. 点击左上角“加载已解压的扩展程序 (Load unpacked)”。
5. 选择解压后的文件夹即可完成加载。

---

## 悬浮胶囊操作指南

| 操作 | 响应动作 | 视觉反馈 |
| :--- | :--- | :--- |
| **鼠标左键单击** | 切换运行状态（开启 / 暂停） | 绿色高亮（自动） / 灰色暗淡（暂停） |
| **鼠标按住拖拽** | 移动胶囊至屏幕任意位置 | 放开后自动保存当前屏幕像素坐标 |
| **鼠标右键单击** | 清空当前累计审批次数 | 计数徽章归零 `0` |

---

## 项目结构

```text
MuseAutoApprove/
├── manifest.json                  # Chrome 扩展配置文件 (Manifest V3)
├── content.js                     # 扩展端 Content Script
├── muse-auto-approve.user.js      # 油猴/用户脚本端源码 (带规范元数据头)
├── icons/                         # 扩展图标 (16x16, 48x48, 128x128)
├── assets/                        # 演示动图与截图素材
│   ├── demo.gif                   # 演示动图
│   ├── preview.png                # 高清截图
│   ├── tampermonkey-permission.png# 允许运行用户脚本权限配置示例图
│   └── tampermonkey-add-script.png# 油猴菜单点击“添加新脚本...”示例图
├── LICENSE                        # MIT 开源协议
├── README.md                      # 项目详细文档 (简体中文)
└── README_en.md                   # 英文说明文档 (English)
```

---

## 免责声明 (Disclaimer)

1. **用途限制**：本工具仅供技术研究、学习交流及个人合法工作流自动化提效使用，严禁用于任何破坏平台正当运营或违规行为。使用者应严格遵守目标平台（包括但不限于 Muse.ai）的服务条款（Terms of Service）与用户协议。
2. **账号与安全风险**：本工具通过模拟前端事件流执行自动化审批。因自动化操作引发的任何后果，包括但不限于**账号被封禁（封号）、权限冻结、功能降级、访问受限、接口限流或风控拦截**等，均由使用者自行承担全部责任。
3. **数据与资产变动**：自动化审批将在无人工干预的情况下极速放行操作请求（如文件上传、公开链接生成等）。作者不对因使用本扩展/脚本造成的任何意外误操作、数据变动、隐私泄露或潜在财产损失承担任何法律责任。
4. **软件现状提供**：本项目按“现状 (AS IS)”提供，不提供任何明示或暗示的担保。下载、安装或使用即代表您已充分阅读、知悉并完全同意本免责声明的全部条款。

---

## 开源许可

本项目遵循 [MIT License](./LICENSE) 开源协议。
