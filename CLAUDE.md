# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## 项目定位

Claude Bridge — 手机（企业微信）是电脑前 Claude Code 的"第二屏幕"。

mote-home 运行 Gateway（24/7 Node.js），通过 Windows Agent HTTP API 在你 Windows 电脑上执行 Claude Code。同一套 session store（`%USERPROFILE%\.claude\`），手机和电脑无缝双向同步。

---

## 架构

```
企业微信 App → Bot API (webhook)
  → Node.js Gateway (mote-home, 127.0.0.1:8933)
    → HTTP → Windows Agent (100.80.205.79:9877)   ← 主通道
    → SSH fallback (Agent 不可用时)                 ← 备用
      → claude --resume <id>
```

### 为什么用 Agent 替代 SSH

- **消灭转义地狱**：Agent 本地读写文件、调 child_process，不存在 SSH → cmd.exe → PowerShell 多层转义
- **JSON 原生通信**：Gateway 和 Agent 之间是标准 HTTP JSON，不再拼 shell 字符串
- **Session lock 防护**：Agent 本地管理 Claude 进程，可精确杀残留

---

## 部署位置

```
mote-home:
  /mnt/data/clawd/                    ← Gateway 代码 + SQLite DB
  /etc/systemd/system/clawd-gateway.service

Caddy + CF Tunnel:
  claude-tunnel.mote-pal.xyz → Caddy :80 → Gateway :8933
  (走主 Tunnel 87fc0324)

Windows (Mote-Office):
  Clawd Agent: agent/index.js  (Express :9877, 开机自启)
  Claude Code:  C:\Users\Mote\AppData\Roaming\npm\claude.cmd
  Tailscale IP: 100.80.205.79
  SSH 免密:     mote-home 公钥在 C:\ProgramData\ssh\administrators_authorized_keys
```

---

## 关键连接

| 目标 | 命令 |
|------|------|
| SSH mote-home | `ssh mote@100.118.10.0` |
| SSH Windows(Tailscale) | `ssh Mote@100.80.205.79` |
| Gateway 日志 | `ssh mote@100.118.10.0 'journalctl -u clawd-gateway -f'` |
| Gateway 重启 | `ssh mote@100.118.10.0 'sudo systemctl restart clawd-gateway'` |
| Gateway 健康 | `curl https://claude-tunnel.mote-pal.xyz/health` |
| Agent 健康 | `curl http://100.80.205.79:9877/api/health` |
| Agent 启动 | Windows 上 `node agent/index.js`（或 start.bat 快捷方式放 shell:startup） |

---

## 当前状态 (v1.5 — 2026-07-03)

### 已工作
- 企业微信消息接收/回复
- Windows Agent HTTP 执行 Claude Code（主通道）
- SSH 自动 fallback（Agent 不可用时）
- `@会话名` 创建/续接会话
- `claude --resume` 跨消息续接
- 电脑历史会话列表显示
- 多会话路由（@指定或唯一活跃自动路由）
- 退出项目 / 切换项目 / 重新接入
- 电脑离线检测 + 任务排队
- 项目自动发现（Agent 本地 fs 扫描，无转义问题）
- 群聊模型：一个群 = 一个项目，群内 @Bot 发消息
- Session lock 防护（续接会话前自动杀桌面端残留 Claude 进程）
- CI=true + CLAUDE_NO_TUI=1 环境变量尝试改善 VS Code 会话可见性
- 群事件自动欢迎（Bot 被拉入群时列出可用项目）

### 未完成
- 手机创建的新会话在 VS Code 不显示（pipe 模式天生限制，设 CI=true 可能改善但未验证）
- 企业微信异步客服消息推送（目前靠 webhook 立即返回 200，处理异步）

### 核心限制
- `echo msg | claude` 创建的是 pipe 模式会话，VS Code 可能不显示但可用 `--resume` 续接
- 电脑上先用 VS Code 创建会话，手机 `--resume` 续接，上下文完全保留
- Agent 和电脑桌面端 Claude 不能同时操作同一会话（已加 taskkill 防护）

---

## 技术选型

| 组件 | 选型 |
|------|------|
| Gateway | Node.js + Express + better-sqlite3 |
| Agent | Node.js + Express（Windows 本地 :9877） |
| 消息 | 企业微信自建应用 (AgentID 1000003) |
| 通信 | HTTP JSON（主）+ Tailscale SSH（fallback） |
| 编码 | Agent 本地无编码问题；SSH fallback 用 Base64 → PowerShell |
| 连接 | Tailscale (WireGuard) |

---

## 文件结构

```
gateway/
  index.js      — Express server + 消息路由 + 群聊逻辑
  agent.js      — HTTP 客户端，调 Windows Agent（SSH fallback）
  ssh.js        — SSH 远程执行（fallback 用）
  db.js         — SQLite 数据层（群绑定/会话/任务队列/审计）
  wecom.js      — 企业微信加解密 + 消息发送
  config.js     — 配置文件
  session.js    — PTY 会话管理（实验性，未使用）

agent/
  index.js      — Windows Agent Express 服务
  start.bat     — 开机自启脚本
```

---

## 约束

- Gateway 放 `/mnt/data/clawd/`，不放 `/home/mote/`
- Agent 放 Windows 任意位置，start.bat 快捷方式放 shell:startup 开机自启
- 部署变更后提交 `/mnt/data/infra/` git 仓库（infra 配置）
- 本项目只做 Claude Bridge，不动 mote-home 其他服务
- Claude Code 是唯一 AI 层，Gateway 和 Agent 都不推理
