# 灵流 LingFlow

LingFlow 是一个跨平台双语阅读与翻译项目，目标是让网页阅读、桌面翻译和后续移动端翻译共享同一套核心能力。当前仓库采用 pnpm workspace + Turborepo 管理，已包含浏览器扩展、Tauri v2 桌面端、翻译调度核心、本地代理和网页 DOM 双语注入能力。

## 当前进度

已完成：

- Monorepo 基础骨架：`apps/app`、`apps/extension`、`packages/core`、`packages/dom`。
- `@lingflow/core`：统一 Provider 接口、调度器、内存缓存、批量翻译、结构化错误。
- 官方翻译服务：Google Cloud、百度翻译、DeepL、Microsoft Translator、有道智云、腾讯云 TMT。
- AI 翻译：OpenAI-compatible Chat Completions，支持多个服务源、服务源拖拽排序、每个服务源多个模型、模型/服务源自动回退开关。
- `@lingflow/dom`：网页可读段落抽取、双语注入、重复注入去重和清理。
- 浏览器扩展：Chrome/Edge Manifest V3、popup、content script、background、页面双语翻译、网页选区辅助上报。
- Tauri 桌面端：Windows 客户端、全局划词悬浮窗、Rust HTTP 转发、本地代理。
- Android 端：Tauri Android 工程已初始化，移动端复用桌面端 React 控制台和翻译核心，但不提供全局划词功能。
- 配置持久化：非机密数据保存到 SQLite，桌面端密钥保存到系统凭据库，Android 端密钥随本机 app data 持久化。
- 扩展与桌面端同步：扩展默认通过 `127.0.0.1:47631` 读取桌面端配置，并由桌面端代理转发翻译请求。
- 在线更新：桌面端可从 GitHub Releases 检查最新版本并跳转下载发布包。
- 首次使用引导：首次启动时展示欢迎页；桌面端引导配置服务源、安装扩展和开启全局划词，Android 端引导配置服务源与移动端翻译工作台。

暂未完成：

- Android 真机验证与签名发布；iOS 初始化与真机验证。
- PDF 双语阅读器。
- 生产级扩展 ID 白名单或本机代理配对令牌。
- 账号同步体系。

## 项目结构

```text
apps/
  app/          Tauri v2 桌面 / Android 客户端
  extension/    Chrome/Edge 浏览器扩展
packages/
  core/         翻译 Provider、调度器、缓存和类型
  dom/          正文抽取与双语 DOM 注入
```

## 技术栈

- Monorepo：pnpm workspaces、Turborepo
- 前端：Vite、React、Tailwind CSS
- 浏览器扩展：CRXJS、Manifest V3
- 桌面端：Tauri v2、Rust
- 测试：Vitest、happy-dom
- 代码检查：oxlint、TypeScript

## 翻译 Provider

`@lingflow/core` 当前支持：

- `google-free`：Google Cloud Translation Basic v2 官方接口。
- `baidu-free`：百度翻译开放平台通用翻译 API。
- `deepl`：DeepL API Free / Pro。
- `microsoft`：Microsoft Azure Translator。
- `youdao`：有道智云文本翻译 API。
- `tencent`：腾讯云机器翻译 TextTranslate。
- `ai`：OpenAI-compatible Chat Completions。

说明：`google-free` / `baidu-free` 是早期命名保留，当前实现已接入官方接口。

## AI 多服务源

桌面端的 AI Provider 支持：

- 配置多个 OpenAI-compatible 服务源。
- 拖动服务源卡片调整优先级。
- 每个服务源可填写 Base URL、API Key，并配置多个模型。
- 模型按填写顺序尝试。
- 开启“AI 服务源与模型自动回退”后，当前模型失败会尝试同一服务源下一个模型，再尝试下一个服务源。
- 关闭回退后，只尝试优先级最高的第一个服务源和第一个模型。

普通 AI 配置保存到桌面端 SQLite，AI API Key 按服务源 ID 汇总保存到系统凭据库，不写入仓库、不写入 `.env`。

## 配置与密钥存储

Tauri 桌面端：

- 非机密数据保存到 Tauri app data 目录下的 `lingflow.sqlite`，例如 provider、目标语言、region、endpoint、AI 服务源名称/Base URL/模型列表、月度字符统计和翻译历史。
- 月度字符统计按自然月键保存，进入新自然月后会从当前月重新计数，旧月份数据不会继续累加到新月份。
- API Key / Secret 保存到系统凭据库。
- Windows 下对应 Windows Credential Manager。
- 点击 `Clear saved secrets` 可以清除本机保存的密钥。

浏览器扩展：

- 默认启用 `Desktop proxy`。
- 扩展只保存启用状态和本机代理地址，不保存服务商密钥。
- 默认代理地址：

```text
http://127.0.0.1:47631
```

桌面端本地代理：

- 监听 `127.0.0.1:47631`。
- `/settings`：供扩展读取当前桌面端配置。
- `/http-request`：供扩展通过桌面端转发外部翻译请求。
- `/usage`：供扩展回传浏览器侧翻译字符数，计入桌面端月度统计。
- `/selection`：供扩展把网页选中文本上报给桌面端，触发同一个全局划词悬浮窗。
- 普通网页 `http/https` Origin 会被拒绝。
- 当前仍属于本机信任边界，后续建议增加扩展 ID 白名单或一次性配对令牌。

## 全局划词

桌面端全局划词默认使用 Windows UI Automation 和标准编辑控件读取选中文本，不会主动模拟 `Ctrl+C`，因此不会污染剪贴板。

浏览器网页中的选区由浏览器扩展辅助读取：content script 使用 `window.getSelection()` 获取网页选中文本，经桌面端本地代理 `/selection` 上报，由桌面端显示同一个悬浮图标。这样可以避开 Chrome/Edge/WebView 对 UI Automation 选区暴露不稳定的问题。

对于自绘 UI 或 WebView 桌面应用，如果 Windows UI Automation 无法暴露选中文本，可以在 `软件设置 -> 全局划词` 中开启“兼容剪贴板兜底”。该模式只在 UIA/标准控件读取失败且前台进程未命中“进程黑名单”时临时发送 `Ctrl+C`；浏览器、资源管理器、图片查看器等不希望触发划词的程序应加入同一个黑名单。

调试全局划词时，可以在桌面端开发者工具控制台执行：

```js
await window.__lingflowSelectionDiagnostics()
```

该命令会输出最近一次捕获的前台进程、鼠标坐标、读取策略和失败原因。

## 在线更新

桌面端 `软件设置 -> 在线更新` 会请求：

```text
https://api.github.com/repos/glosc-ai/LingFlow/releases/latest
```

应用会比较当前版本与最新 Release tag，显示是否有新版本，并列出发布页和前几个下载资产。当前实现负责检查和引导下载，安装包替换仍由用户手动完成；后续如启用 Tauri 官方签名更新器，可在此基础上改为静默下载和重启安装。

## 环境要求

- Node.js `20.19+` 或 `22.12+`
- pnpm `10+`
- Rust 工具链：`rustc`、`cargo`、`rustup`
- Windows WebView2 Runtime
- Visual Studio C++ Build Tools

## 安装依赖

```powershell
cd E:\LingFlow
pnpm install
```

## 常用命令

完整验证：

```powershell
pnpm typecheck
pnpm test
pnpm lint
pnpm build
```

单独构建扩展：

```powershell
pnpm --filter extension build
```

启动 Tauri 桌面端：

```powershell
cd E:\LingFlow\apps\app
pnpm tauri dev
```

注意：命令末尾不要加 `/`。`pnpm tauri dev/` 会被 Tauri CLI 识别为不存在的 `dev/` 子命令。

也可以从仓库根目录启动：

```powershell
cd E:\LingFlow
pnpm --filter app tauri dev
```

构建 Tauri 安装包：

```powershell
cd E:\LingFlow\apps\app
pnpm tauri build
```

Rust 检查：

```powershell
cd E:\LingFlow\apps\app\src-tauri
cargo check
```

## 浏览器扩展验收

1. 构建扩展：

   ```powershell
   cd E:\LingFlow
   pnpm --filter extension build
   ```

2. 打开扩展管理页：

   ```text
   chrome://extensions
   edge://extensions
   ```

3. 加载未打包扩展，目录选择：

   ```text
   E:\LingFlow\apps\extension\dist
   ```

   不要选择 `E:\LingFlow\apps\extension` 源码目录。源码目录是 CRXJS 开发模式，未启动 Vite dev server 时会出现 `CRXJS DEV MODE` 或 `src/content.ts-loader.js` 注入失败。

4. 启动 Tauri 桌面端：

   ```powershell
   cd E:\LingFlow\apps\app
   pnpm tauri dev
   ```

5. 在桌面端选择 Provider 并填写密钥。
6. 打开扩展 popup，保持桌面端代理开启。
7. 点击“检查本地代理”或“测试服务源”。
8. 打开普通网页，测试：
   - 点击网页右侧 LingFlow 按钮：开启视口懒翻译。
   - 再次点击网页右侧 LingFlow 按钮：撤销当前页面翻译。
   - 在扩展 popup 中点击“整页翻译”：开启当前页面翻译。
   - 在扩展 popup 中点击“清除页面翻译”：清理注入的双语内容。

如果扩展提示找不到旧的 `assets/content*.js`，说明浏览器仍在运行旧 manifest。请在扩展管理页删除 LingFlow 后重新加载 `apps/extension/dist`。

## Tauri 桌面端验收

```powershell
cd E:\LingFlow\apps\app
pnpm tauri dev
```

检查项：

- 窗口正常启动。
- Provider、目标语言、region、endpoint 等普通配置能持久化。
- API Key / Secret 关闭重开后仍能回填。
- AI 服务源可以新增、删除、拖拽排序。
- AI 服务源可以配置多个模型，开启回退后会按顺序尝试模型和服务源。
- 点击 `Translate` 可翻译文本。
- 开启“全局划词”后，在浏览器网页中选中文本会显示半透明 LingFlow 悬浮图标，点击后打开悬浮翻译窗。
- 在自绘 UI 或 WebView 桌面应用中划词失败时，可只为对应进程开启“兼容剪贴板兜底”，确认悬浮图标能出现且剪贴板内容会被恢复。
- 点击 `Clear saved secrets` 后密钥被清除。
- 扩展能通过 `http://127.0.0.1:47631` 使用桌面端配置。
- 首次启动会显示引导页；点击“开始使用”后进入翻译工作台，点击“配置服务源”后进入服务源配置页。

## Android 安装测试用例

构建 arm64 APK：

```powershell
cd E:\LingFlow
pnpm --filter app tauri android build --apk --target aarch64 --ci
```

生成产物：

```text
apps/app/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk
```

安装到真机：

```powershell
adb devices -l
adb install -r apps\app\src-tauri\gen\android\app\build\outputs\apk\universal\release\app-universal-release-unsigned.apk
```

如需验证首次安装流程，先清除本机数据。调试包通常是 `com.gloscai.lingflow.debug`，Release 包通常是 `com.gloscai.lingflow`，可先用 `adb shell pm list packages | findstr lingflow` 确认实际包名：

```powershell
adb shell pm clear com.gloscai.lingflow.debug
adb shell pm clear com.gloscai.lingflow
```

安装测试项：

| 编号 | 场景 | 操作 | 期望结果 |
| --- | --- | --- | --- |
| A-01 | 全新安装启动 | 清除 app 数据后启动 Android 端 | 展示移动端引导页，不显示桌面窗口标题栏和窗口控制区。 |
| A-02 | 首次进入工作台 | 在引导页点击“开始使用” | 进入移动端首页，底部显示控制台、服务源、历史、设置导航。 |
| A-03 | 默认服务源 | 全新安装后进入服务源配置页 | “默认服务源”默认选中 `AI 翻译`。 |
| A-04 | 服务源页面顺序 | 进入底部“服务源”页 | 卡片顺序为“默认翻译” -> “服务源配置” -> “本机状态”。 |
| A-05 | 外部浏览器打开 Key 页面 | 点击“没有 Key？现在获取” | 使用系统默认浏览器打开 `https://one.gloscai.com/keys`，应用 WebView 不应跳转到该网页。 |
| A-06 | 服务源持久化 | 修改目标语言或 AI 服务源配置后退出并重启 | 普通配置保留；Android 端密钥随本机 app data 持久化。 |
| A-07 | 翻译工作台 | 填写可用 AI 服务源和模型后输入文本并点击“翻译” | 显示译文，状态变为翻译完成或显示明确错误。 |
| A-08 | 复制译文 | 翻译完成后点击“复制译文” | 状态提示已复制，系统剪贴板中存在译文。 |
| A-09 | 历史记录 | 完成一次翻译后进入“历史”页 | 新翻译记录出现在列表中，点击记录可回填到翻译页。 |
| A-10 | 移动端功能边界 | 进入“设置”页 | 不出现桌面端“全局划词”和“本地代理”配置。 |

## 本地密钥调试

根目录 `.env` 仅用于本地接口测试，不参与应用运行时配置，且不应提交到仓库。可参考：

```text
.env.example
```

不要把真实 API Key / Secret 提交到 GitHub。

## 已知限制

- 浏览器扩展依赖正在运行的桌面端代理时，桌面端必须保持开启。
- 本机代理目前还没有扩展 ID 白名单或配对令牌。
- 部分浏览器保护页面无法注入 content script，例如 `chrome://`、扩展商店、部分内置 PDF 页面。
- iOS 初始化和构建需要 macOS + Xcode。
- Android 端已初始化并可构建 arm64 APK，尚未完成真机交互验收和签名发布；移动端不提供全局划词。
