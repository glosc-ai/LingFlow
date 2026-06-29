# 灵流 LingFlow

LingFlow 是一个跨平台双语阅读与翻译项目，目标是让网页阅读、桌面翻译和后续移动端翻译共享同一套核心能力。当前仓库采用 pnpm workspace + Turborepo 管理，已包含浏览器扩展、Tauri v2 桌面端、翻译调度核心、本地代理和网页 DOM 双语注入能力。

## 当前进度

已完成：

- Monorepo 基础骨架：`apps/app`、`apps/extension`、`packages/core`、`packages/dom`。
- `@lingflow/core`：统一 Provider 接口、调度器、内存缓存、批量翻译、结构化错误。
- 官方翻译服务：Google Cloud、百度翻译、DeepL、Microsoft Translator、有道智云、腾讯云 TMT。
- AI 翻译：OpenAI-compatible Chat Completions，支持多个服务源、服务源拖拽排序、每个服务源多个模型、模型/服务源自动回退开关。
- `@lingflow/dom`：网页可读段落抽取、双语注入、重复注入去重和清理。
- 浏览器扩展：Chrome/Edge Manifest V3、popup、content script、background、划词/页面双语翻译。
- Tauri 桌面端：Windows 客户端、剪贴板读取、系统信息命令、Rust HTTP 转发、本地代理。
- 配置持久化：普通配置保存到 localStorage，桌面端密钥保存到系统凭据库。
- 扩展与桌面端同步：扩展默认通过 `127.0.0.1:47631` 读取桌面端配置，并由桌面端代理转发翻译请求。

暂未完成：

- Android / iOS 初始化与真机验证。
- PDF 双语阅读器。
- 生产级扩展 ID 白名单或本机代理配对令牌。
- 账号同步体系。

## 项目结构

```text
apps/
  app/          Tauri v2 桌面客户端
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

普通 AI 配置保存到 localStorage，AI API Key 按服务源 ID 汇总保存到系统凭据库，不写入仓库、不写入 `.env`。

## 配置与密钥存储

Tauri 桌面端：

- 普通配置保存到 `localStorage`，例如 provider、目标语言、region、endpoint、AI 服务源名称/Base URL/模型列表。
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
- 普通网页 `http/https` Origin 会被拒绝。
- 当前仍属于本机信任边界，后续建议增加扩展 ID 白名单或一次性配对令牌。

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

4. 启动 Tauri 桌面端：

   ```powershell
   cd E:\LingFlow\apps\app
   pnpm tauri dev
   ```

5. 在桌面端选择 Provider 并填写密钥。
6. 打开扩展 popup，保持 `Desktop proxy` 开启。
7. 点击 `Test provider connection`。
8. 打开普通网页，测试：
   - `Selection`：翻译选中段落。
   - `Page`：翻译当前页面可读段落预览。
   - `Clear page translations`：清理注入的双语内容。

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
- 点击 `Clear saved secrets` 后密钥被清除。
- 扩展能通过 `http://127.0.0.1:47631` 使用桌面端配置。

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
- Android 端尚未初始化。
