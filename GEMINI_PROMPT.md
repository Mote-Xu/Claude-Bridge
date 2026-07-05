两个未解决的问题，不需要项目背景，直接回答。

## 问题 1：从外部干净关闭 VS Code Claude 标签页

需要在 Windows 上从 Node.js 外部进程关闭 VS Code 里某个 Claude Code 会话标签页。

试过：
- `taskkill /f /pid <pid>`：能杀进程，VS Code 弹 error popup
- `taskkill /pid`（无 /f）：控制台进程不理
- VS Code 扩展 + `tabGroups.close()`：扩展不被加载（试了 `activationEvents: ["*"]`、named pipe、TCP server，都不行）
- `code --install-extension`：打包 vsix 安装，路径问题失败

约束：只关目标标签页、不弹 error、Node.js 外部进程。

## 问题 2：Pipe 模式的权限确认

Claude Code pipe 模式（`echo msg | claude --resume` + `CI=true`）是单向的——消息 stdin 进，一次性 stdout 出，中间无交互。

VS Code 里遇到高权限操作（如编辑全局文件）会弹框让用户点确认。Pipe 模式没有这个通道，操作直接被拒，Claude 只能在输出里告诉用户"被拒了"。

能否在不改变单向 pipe 模式的前提下，实现类似 VS Code 的确认机制？或者有什么替代方案？
