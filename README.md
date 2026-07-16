# 灵流 LingFlow

LingFlow 是一个跨平台双语阅读与翻译项目，目标是让网页阅读、桌面翻译和后续移动端翻译共享同一套核心能力。当前仓库采用 pnpm workspace + Turborepo 管理，已包含浏览器扩展、Tauri v2 桌面端、翻译调度核心、本地代理和网页 DOM 双语注入能力。

## 当前进度

已完成：

- Monorepo 基础骨架：`apps/app`、`apps/extension`、`packages/core`、`packages/dom`、`packages/firebase`。
- `@lingflow/core`：统一 Provider 接口、调度器、内存缓存、批量翻译、结构化错误。
- 官方翻译服务：Google Cloud、百度翻译、DeepL、Microsoft Translator、有道智云、腾讯云 TMT。
- AI 翻译：OpenAI-compatible Chat Completions，支持多个服务源、服务源拖拽排序、每个服务源多个模型、模型/服务源自动回退开关。
- `@lingflow/dom`：网页可读段落抽取、双语注入、重复注入去重和清理。
- 浏览器扩展：Chrome/Edge Manifest V3、popup、content script、background、页面双语翻译、网页选区辅助上报和输入框快捷翻译。
- Tauri 桌面端：Windows 客户端、系统级快捷键划词翻译、可移动/缩放的悬浮翻译窗、系统托盘、Rust HTTP 转发和本地代理。
- Android 端：Tauri Android 工程已初始化，移动端复用桌面端 React 控制台和翻译核心，但不提供全局划词功能。
- 配置持久化：非机密数据保存到 SQLite，桌面端密钥保存到系统凭据库，Android 端密钥随本机 app data 持久化。
- 扩展与桌面端同步：扩展默认通过 `127.0.0.1:47631` 读取桌面端配置，并由桌面端代理转发翻译请求。
- 在线更新：桌面端可从 GitHub Releases 检查最新版本并跳转下载发布包。
- 首次使用引导：首次启动时展示欢迎页；桌面端引导配置服务源、安装扩展和开启划词快捷键，Android 端引导配置服务源与移动端翻译工作台。
- Firebase：桌面端、Android 和浏览器扩展共享 Firebase App 初始化配置，并在运行环境支持时启用 Firebase Analytics。

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
  firebase/     Firebase App 与 Analytics 安全初始化
```

## 技术栈

- Monorepo：pnpm workspaces、Turborepo
- 前端：Vite、React、Tailwind CSS
- 浏览器扩展：CRXJS、Manifest V3
- 桌面端：Tauri v2、Rust
- 云端基础设施：Firebase
- 测试：Vitest、happy-dom
- 代码检查：oxlint、TypeScript

## Firebase

`@lingflow/firebase` 统一维护 LingFlow 的 Firebase Web 配置。桌面端、Android WebView 和扩展 popup 会在 React 入口启动前初始化 Firebase App。

- Firebase Web 配置属于公开的客户端项目标识，可以随前端构建产物发布；服务账号私钥和其他服务端凭据不得写入该包。
- Analytics 初始化前会调用 Firebase 的运行环境支持检测。
- 当 Tauri WebView 或浏览器扩展运行环境不支持 Analytics 时会安全跳过，不会阻断应用启动。
- Android 端复用同一套 Tauri React 入口，因此无需复制 Firebase 配置；当前接入使用 Firebase Web SDK。若后续需要原生 Android Firebase SDK、FCM 或 Crashlytics，必须先在 Firebase 控制台为 `com.gloscai.lingflow` 注册 Android App，并下载真实的 `google-services.json`。
- 后续接入 Firebase Auth、Firestore、Crashlytics 替代方案或其他产品时，应继续从该共享包扩展，避免在各应用中重复配置。

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

- 非机密数据保存到 Tauri app data 目录下的 `lingflow.sqlite`，例如 provider、目标语言、region、endpoint、AI 服务源名称/Base URL/模型列表、划词快捷键、关闭到托盘开关、月度字符统计和翻译历史。
- 月度字符统计按自然月键保存，进入新自然月后会从当前月重新计数，旧月份数据不会继续累加到新月份。
- API Key / Secret 保存到系统凭据库。
- Windows 下对应 Windows Credential Manager。
- 点击 `Clear saved secrets` 可以清除本机保存的密钥。

浏览器扩展：

- 默认启用 `Desktop proxy`。
- 扩展只保存启用状态、本机代理地址和输入框快捷翻译设置，不保存服务商密钥。
- 选择 AI 翻译时，扩展沿用桌面端已配置的 AI 服务源、模型顺序和回退设置；扩展只覆盖当前选择的服务商及本次翻译的源/目标语言。
- 本地代理可以并发处理网页段落翻译请求；AI 翻译使用更长的后台响应窗口，避免多个较慢请求排队时被固定 15 秒超时提前中断。
- 默认代理地址：

```text
http://127.0.0.1:47631
```

桌面端本地代理：

- 监听 `127.0.0.1:47631`。
- `/settings`：供扩展读取当前桌面端配置。
- `/http-request`：供扩展通过桌面端转发外部翻译请求。
- `/usage`：供扩展回传浏览器侧翻译字符数，计入桌面端月度统计。
- `/selection`：供扩展把网页选中文本和屏幕坐标上报给桌面端，显示浏览器选区悬浮图标。
- 普通网页 `http/https` Origin 会被拒绝。
- 当前仍属于本机信任边界，后续建议增加扩展 ID 白名单或一次性配对令牌。

## 浏览器输入框快捷翻译

扩展可以在普通网页的文本输入框、`textarea` 和 `contenteditable` 编辑区域中直接翻译正在编辑的文字。默认快捷键为：

```text
Alt+R
```

使用方式：

1. 保持 LingFlow 桌面端正在运行，并在桌面端配置可用的翻译服务商。
2. 在扩展 popup 中开启“输入框快捷翻译”。
3. 将焦点放到网页输入框中；如需只翻译一部分文字，先在输入框内选中对应内容。
4. 按下 `Alt+R`：存在选区时仅替换选区，没有选区时翻译并替换整个输入内容。中文输入自动翻译为英文，英文输入自动翻译为简体中文，不受整页翻译目标语言影响。

可以在扩展 popup 中修改快捷键：点击快捷键输入框后直接按下新的组合键，再点击“应用”，不需要逐个输入按键名称。快捷键至少需要 `Ctrl`、`Alt`、`Shift` 中的一个修饰键，并支持字母、数字、`F1`～`F24` 和常用功能键。密码框、只读或禁用输入框以及非文本输入控件不会被处理。

翻译请求期间如果用户继续修改了输入内容，扩展会放弃回填，避免译文覆盖用户的新输入。输入框快捷翻译继续使用 background → LingFlow 桌面代理链路，API Key 不会暴露给网页，也不会保存到扩展中。

中英混合输入会根据中文字符数和英文单词数判断主要语言；只包含数字、标点或其他无法判断为中文/英文的内容不会发起翻译。

## 全局划词

桌面端采用显式快捷键触发，不再安装全局鼠标钩子，也不会在拖动窗口、图片、文件或普通鼠标抬起时自动取词。默认快捷键为：

```text
Ctrl+E
```

使用流程：

1. 在 `软件设置 -> 划词翻译` 中开启桌面划词快捷键。
2. 在任意桌面软件中选中文字。
3. 按下 `Ctrl+E`，LingFlow 会读取当前选区并直接打开完整的悬浮翻译窗。
4. 悬浮窗中可以修改原文、源语言、目标语言和已配置的翻译服务商，再点击“翻译”。

快捷键可以在设置中自定义。输入组合后点击“应用”或按 Enter 生效，也可以点击“恢复默认”。快捷键至少需要 `Ctrl`、`Alt`、`Shift` 中的一个修饰键，并支持字母、数字、`F1`～`F24` 和常用功能键，例如：

```text
Ctrl+E
Alt+Q
Ctrl+Shift+T
Alt+F8
Ctrl+Space
```

注册新快捷键时会先注销旧组合；如果快捷键已被其他软件占用，桌面端状态栏会显示注册错误。启用后，该组合会被 LingFlow 全局占用，如果影响其他软件的原有快捷键，请更换组合。

桌面端取词按以下顺序执行：

1. Windows UI Automation `TextPattern.GetSelection()`，依次检查鼠标位置元素、窗口元素、当前焦点元素和前台窗口。
2. 对标准编辑控件使用 `EM_GETSEL`，只在确实存在非空选区时读取文本。
3. 前两种方式均失败时，执行一次显式授权的安全复制兜底：备份剪贴板、发送一次 `Ctrl+C`、读取纯文本并恢复剪贴板。

安全复制只会在用户主动按下桌面划词快捷键，或悬浮图标缺少已上报文本而需要补取时执行，不会因鼠标移动、拖拽或轮询自动触发。当前快捷键模式不再使用进程黑名单。

浏览器网页中的选区由浏览器扩展辅助读取：content script 使用 `window.getSelection()` 获取网页选中文本，经桌面端本地代理 `/selection` 上报，由桌面端显示同一个悬浮图标。这样可以避开 Chrome/Edge/WebView 对 UI Automation 选区暴露不稳定的问题。

浏览器扩展继续使用“选中文字后显示半透明 LingFlow 图标”的交互；点击图标后展开悬浮翻译窗。浏览器方案与桌面快捷键方案彼此独立，浏览器不会因为桌面端取消鼠标钩子而失去选区图标。

如果快捷键已经触发但没有读到文本，LingFlow 仍会打开悬浮窗，并在底部显示选区读取或剪贴板访问错误，不再静默失败。

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
9. 测试输入框快捷翻译：
   - 在普通文本输入框或 `textarea` 中输入一段源语言文本，按 `Alt+R`，确认整个输入内容被译文替换。
   - 分别输入中文和英文，确认中文自动翻译为英文、英文自动翻译为简体中文。
   - 在输入框内仅选择部分文本后按快捷键，确认只替换选区，选区外文字保持不变。
   - 在 `contenteditable` 富文本编辑区域中按快捷键，确认译文写入且页面输入事件正常触发。
   - 在扩展 popup 中关闭“输入框快捷翻译”，确认快捷键不再拦截网页输入。
   - 点击快捷键输入框并直接按下新的组合键，再点击“应用”，确认新组合立即生效。
   - 在翻译请求完成前继续修改输入内容，确认扩展提示内容已变化且不会覆盖新输入。

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
- 开启“划词翻译”后，在桌面软件中选中文字并按 `Ctrl+E`，应直接打开完整悬浮翻译窗并填充原文。
- 将快捷键改为其他有效组合并点击“应用”，确认旧快捷键失效、新快捷键立即生效；点击“恢复默认”后恢复为 `Ctrl+E`。
- 在 UI Automation 支持不完整的自绘 UI 或 WebView 应用中按快捷键，确认安全复制兜底可以取词，并在完成后恢复原剪贴板内容。
- 在浏览器网页中选中文字会显示半透明 LingFlow 悬浮图标，点击后打开悬浮翻译窗。
- 拖动窗口、图片和文件时不会自动复制，也不会触发桌面端悬浮窗。
- 开启“关闭时最小化到托盘”后点击主窗口关闭按钮，窗口隐藏但程序和浏览器本地代理继续运行；通过托盘菜单可以重新显示或退出。
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

GitHub Actions Release 会使用 Organization secrets 构建并校验签名 APK：

- `ANDROID_KEY_ALIAS`：签名密钥别名。
- `ANDROID_KEY_BASE64`：Android JKS/keystore 文件的 Base64 内容。
- `ANDROID_KEY_PASSWORD`：keystore 与 key 使用的密码。

工作流不会将证书或密码写入仓库。签名完成的 Release 产物名称为：

```text
lingflow-android-arm64-v0.5.0.apk
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
- Windows 全局快捷键会占用对应按键组合；默认 `Ctrl+E` 如与其他软件冲突，可在软件设置中修改。
- 部分应用既不暴露 UI Automation/标准编辑控件选区，又会拦截复制命令，此时桌面快捷键可能只能打开带错误提示的悬浮窗。
- 本机代理目前还没有扩展 ID 白名单或配对令牌。
- 部分浏览器保护页面无法注入 content script，例如 `chrome://`、扩展商店、部分内置 PDF 页面。
- 跨域 iframe、浏览器内置页面或主动拦截键盘事件的编辑器可能无法使用输入框快捷翻译。
- iOS 初始化和构建需要 macOS + Xcode。
- Android 端已初始化并配置 GitHub Actions 签名 arm64 APK，尚未完成真机交互验收；移动端不提供全局划词。
