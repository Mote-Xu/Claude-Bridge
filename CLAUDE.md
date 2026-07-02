# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## 项目定位

**手机（企业微信）是电脑前 Claude Code 的"第二屏幕"。**

不是新开一个 AI Agent。你电脑上已有的 Claude Code 历史会话，手机无缝续接。回到电脑前继续——所有对话双向同步。

Gateway 不做 AI 推理，只做三件事：消息路由、tmux 会话管理、任务队列。

---

## 架构

```
企业微信 App
  → 企业微信 Bot API (webhook)
    → Node.js Gateway (mote-home, 24/7)
      → Tailscale SSH
        → WSL2 tmux session
          → Claude Code（唯一 AI 执行体）
```

---

## 技术栈

| 组件 | 选型 |
|------|------|
| 消息渠道 | 企业微信 Bot |
| Gateway | Node.js + grammY + better-sqlite3 |
| 连接 | Tailscale SSH（WireGuard 加密） |
| AI 推理 | Claude Code CLI（Anthropic API）— Gateway 不做推理 |
| 会话保持 | tmux (WSL2) + Claude Code 原生 session store |
| 输出回传 | 管道文件 tail（实时流式） |

---

## 关键设计决策（已 grill 确认）

| # | 决策 |
|---|------|
| 1 | 输出回传：管道文件 tail，非 tmux capture-pane 轮询 |
| 2 | Claude Code 启动：tmux send-keys 交互式，非 `claude -p` |
| 3 | 会话来源：`~/.claude/projects/` 的历史会话，`claude --resume` 续接 |
| 4 | 进程生命周期：按需唤醒，idle 24h 自动清理 |
| 5 | 弹窗：settings.json 预配置权限 + capture-pane 盲操兜底 |
| 6 | 离线：Tailscale status 检测 → SQLite 队列 → 上线后自动恢复 |
| 7 | 中断：tmux send-keys C-c → SIGINT → 上下文保留 |
| 8 | 多会话：并行 tmux session，有输出主动推送通知 |

---

## 关键连接

| 目标 | 方式 |
|------|------|
| SSH mote-home | `ssh mote@100.118.10.0`（Tailscale）或 `192.168.1.4`（内网） |
| mote-home 配置 | `~/infra/` → `/mnt/data/infra/`（git 仓库） |

---

## 部署位置

```
mote-home:
  /mnt/data/clawd/              ← Gateway 代码 + SQLite DB
  /etc/systemd/system/clawd.service

本地 WSL2:
  ~/clawd-agent/                ← session.sh + healthcheck.sh
  /tmp/clawd/                   ← Claude Code 输出管道文件
```

---

## 本仓库结构

```
Run_OpenClaw/
├── CLAUDE.md              ← 本文件
├── REQUIREMENTS.md         ← 功能/非功能需求
├── ARCHITECTURE.md         ← 三方 AI 架构评审
├── GEMINI_PROMPT.md        ← 发给外部 AI 的项目总结
├── gateway/                ← mote-home Gateway (~300 行)
│   ├── index.js            ← 企业微信 webhook 入口
│   ├── bot.js              ← 消息收发
│   ├── session.js          ← tmux session 生命周期
│   ├── pipe.js             ← 管道文件 tail + 流式推送
│   ├── queue.js            ← SQLite 任务队列
│   └── config.js           ← 白名单、路径映射
└── agent/                  ← 本地 WSL2 脚本
    ├── session.sh           ← tmux 创建/恢复/关闭
    └── healthcheck.sh       ← Tailscale 在线检测
```

> `gateway/` 和 `agent/` 是计划结构，代码尚未编写。

---

## 常用命令

```bash
# Gateway 管理
ssh mote@100.118.10.0 'sudo systemctl restart clawd'
ssh mote@100.118.10.0 'journalctl -u clawd -f'

# 本地 tmux 管理（WSL2）
tmux ls                              # 列出所有 session
tmux attach -t clawd-s1              # 接入指定 session
~/clawd-agent/session.sh resume <project> <session-id>  # Gateway 调用的恢复命令

# 健康检查
ssh mote@100.118.10.0 'tailscale status | grep mote-office'
```

---

## 约束

- Gateway 代码放 `/mnt/data/clawd/`，不放在 `/home/mote/`
- Claude Code 是**唯一** AI 执行体，Gateway 不做推理
- 部署变更后同步更新 CLAUDE.md / REQUIREMENTS.md / ARCHITECTURE.md
- 修改系统配置后提交到 `/mnt/data/infra/`
- 本项目只做远程 Claude Code 管理，不动 mote-home 其他服务
