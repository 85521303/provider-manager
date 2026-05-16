# Codex Provider Manager

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

- `dist\CodexProviderManager.exe`

这个 exe 会自动启动本地管理服务，并打开一个无地址栏的桌面窗口。关闭窗口后，管理服务会随之退出。

重新打包：

```powershell
npm run build:exe
```

生成文件：

- `dist\CodexProviderManager.exe`

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

## 数据位置

工具会读取和修改：

- `%USERPROFILE%\.codex\state_5.sqlite`
- `%USERPROFILE%\.codex\sessions\...\rollout-*.jsonl`
- `%USERPROFILE%\.codex\archived_sessions\rollout-*.jsonl`
- `%USERPROFILE%\.codex\config.toml`
- `%USERPROFILE%\.codex\session_index.jsonl`

同步副本的映射信息保存在：

- `%USERPROFILE%\.codex\provider-manager-state.json`

## 轻量打包说明

当前 exe 使用 Node 22 Single Executable Application 打包，不引入 Electron。前端资源和 sqlite3 运行文件已嵌入 exe；窗口使用系统已安装的 Microsoft Edge app 模式打开。

如果需要真正的 `.exe` 安装包，建议继续做 WebView2 或 Neutralino 包装；Electron 也可行，但体积明显更大。
