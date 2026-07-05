我需要在 Windows 上从外部进程（Node.js Agent）干净关闭 VS Code 里某个特定的 Claude Code 会话标签页。

背景：
- 手机通过企业微信发给我的电脑，Agent pipe 执行 claude 命令
- 如果目标会话正在 VS Code 里开着，pipe 进的消息 VS Code 标签页不会自动刷新
- 关掉重开标签页后消息就显示，所以需要先关掉标签页

尝试过但不行：
1. taskkill /f /pid <claude进程序号> — 能杀进程但 VS Code 弹 error
2. taskkill /pid（不带 /f）— 控制台进程不理 WM_CLOSE，没反应
3. 写了一个 VS Code 扩展暴露 HTTP API 调 tabGroups.close() — 扩展根本不被加载
4. 全杀 code.exe — 太粗暴，集群模式下其他会话需要保持运行

约束：
- 只能关目标会话的标签页，不能动其他标签页
- 不能弹 error popup
- Agent 是 Node.js 外部进程，不在 VS Code 插件沙箱里

问题：有没有办法从外部干净关闭 VS Code 里的指定 Claude 标签页？
