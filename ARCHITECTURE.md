# 架构评审 — 最终方案

## 决策演进

| 版本 | 方案 | 否决原因 |
|------|------|----------|
| v1 | OpenClaw Gateway + DeepSeek | 过度设计，双 AI 竞争 |
| v2 | Node.js + tmux (WSL2) | WSL2 要另装 Claude Code，session 不共享 |
| v3 ✅ | Node.js + SSH → Windows claude --resume | 零额外安装，session 天然共享 |

## 最终架构

```
企业微信 → mote-home Gateway → Tailscale SSH → Windows claude --resume
```

Gateway 只做消息路由。Claude Code 是唯一 AI 层。交互通过 SSH stdin/stdout 管道，不需要 tmux。

## 关键设计决策

| 决策 | 理由 |
|------|------|
| 不走 WSL2 | 不另装 Claude Code，session 共享 |
| 不用 tmux | Windows 无 tmux，SSH 管道已够用 |
| 不用 OpenClaw | 本质是转发层，不需要 Agent 框架 |
| 用 `--resume` 而非长驻进程 | 上下文在 JSONL 里，resume 恢复完整 |
