# ProviderManager

一个本地 Web 工具，用来查看并管理 Codex Desktop/CLI 的 provider 会话记录。

## 功能

- 汇总 `state_5.sqlite` 中所有 provider 的对话列表，并读取 rollout JSONL 首行校验 provider。
- 点击对话列表项可查看该 rollout 中的用户/助手聊天记录。
- 可按模型名称、更新时间范围、状态筛选对话。
- 批量移动、删除、同步对话。
- 一键把所有逻辑对话补齐到所有 provider。
- 删除 provider 配置，可选择同时删除该 provider 下的对话。
- 每次写操作都会在 `.codex/provider-manager-backups` 下创建备份；删除的 rollout 文件会移到 `.codex/provider-manager-trash`。

## 使用

直接双击：

- `dist\ProviderManager.exe`

这个 exe 会自动启动本地管理服务，并打开一个无地址栏的桌面窗口。关闭窗口后，管理服务会随之退出。

开发模式：

```powershell
npm start
```

默认地址：

```text
http://127.0.0.1:3767
```

如需指定 Codex 数据目录或端口：

```powershell
$env:CODEX_HOME="C:\Users\you\.codex"
$env:PORT="3768"
npm start
```

## 各平台打包命令

桌面应用必须在目标平台上打包。`build:desktop:windows` 只能打 Windows 包，不能在 Windows 上生成 macOS 或 Linux 安装包。

### Windows

在 Windows 上执行：

```powershell
npm install
npm run build:desktop:windows
```

该命令会使用 Windows 原生工具链构建 sidecar，再用 Tauri 打包桌面应用。生成内容统一放在根目录 `dist` 下：

- `dist\ProviderManager.exe`
- `dist\ProviderManager_0.1.0_x64-setup.exe`
- `dist\provider-manager.exe`
- `dist\sidecar\...`
- `dist\tauri-target\...`

### macOS

在 macOS 上执行：

```bash
npm install
npm run build:desktop
```

生成内容会放在根目录 `dist` 下，Tauri 的 `.app`、`.dmg` 等平台包会位于 `dist/tauri-target/release/bundle/`。

### Linux

在 Linux 上执行：

```bash
npm install
npm run build:desktop
```

生成内容会放在根目录 `dist` 下，Tauri 的 Linux 平台包会位于 `dist/tauri-target/release/bundle/`。Linux 需要提前安装 WebKitGTK、GTK、AppIndicator、rsvg、patchelf 等 Tauri 原生依赖；不同发行版的包名可能不同。

Ubuntu/Debian 可参考：

```bash
sudo apt update
sudo apt install -y libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf
```

### 仅构建服务端 sidecar

如只需要构建服务端可执行文件，不打包 Tauri 桌面应用：

```powershell
npm install
npm run build:exe
```

生成内容位于 `dist\sidecar`。这个命令不会生成最终桌面窗口程序或安装包。

### GitHub Actions 三平台构建

仓库包含 `.github/workflows/desktop-build.yml`，会在 push、pull request、tag `v*` 和手动触发时运行 CI matrix：

- Windows runner 构建 NSIS 安装包，artifact 名称为 `provider-manager-windows`。
- macOS runner 构建 DMG，artifact 名称为 `provider-manager-macos`。
- Linux runner 构建 AppImage 和 DEB，artifact 名称为 `provider-manager-linux`。

CI 中的构建产物同样统一位于 `dist` 下，并由 `actions/upload-artifact` 上传到对应 workflow run 的 Artifacts。

Tauri 构建前需要安装对应平台的原生工具链：

- Windows：Rust、Microsoft C++ Build Tools、WebView2 Runtime。
- macOS：Rust、Xcode Command Line Tools。
- Linux：Rust、WebKitGTK 和系统打包依赖。

## 数据位置

工具会读取和修改：

- `%USERPROFILE%\.codex\state_5.sqlite`
- `%USERPROFILE%\.codex\sessions\...\rollout-*.jsonl`
- `%USERPROFILE%\.codex\archived_sessions\rollout-*.jsonl`
- `%USERPROFILE%\.codex\config.toml`
- `%USERPROFILE%\.codex\session_index.jsonl`

同步副本的映射信息保存在：

- `%USERPROFILE%\.codex\provider-manager-state.json`

## 打包说明

`npm run build:exe` 使用 Node 22 Single Executable Application 打包服务端 sidecar，前端资源和 sqlite3 运行文件会嵌入可执行文件。

`npm run build:desktop:windows` 使用 Tauri 打包真实 Windows 桌面应用。`npm run build:desktop` 用于在当前系统上打包当前系统的桌面应用。Tauri 在 Windows 上基于 WebView2；在 macOS 上使用 WKWebView；在 Linux 上使用 WebKitGTK，因此可以保持比 Electron 更小的体积。
