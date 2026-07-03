# 架构评审

## 最终架构

```
企业微信 → mote-home Gateway → Tailscale SSH → Windows claude --resume
```

Gateway 只做消息路由。Claude Code 是唯一 AI 层。

## 关键决策

| 决策 | 理由 |
|------|------|
| SSH 直连 Windows | 不另装 Claude Code |
| echo pipe 模式 | PTY 持久进程与 Claude TUI 冲突 |
| --resume | 会话上下文通过 JSONL 持久化 |
| Base64 + PowerShell 写文件 | cmd echo 无法可靠传输中文 |
| 反斜杠路径 | Windows pipe 不支持正斜杠 |

## 已知问题

1. `getProjects()` SSH 命令转义不稳定，回退 config.js
2. pipe 模式创建的会话在 VS Code 不显示
3. Windows SSH Server 有并发连接限制
