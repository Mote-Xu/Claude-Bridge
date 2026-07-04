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
    → HTTP → Windows Agent (100.80.205.79:9877)
      → claude --resume <id>
```

### 为什么用 Agent

- **消灭转义地狱**：Agent 本地读写文件、调 child_process，不存在远程 shell 多层转义
- **JSON 原生通信**：Gateway 和 Agent 之间是标准 HTTP JSON
- **可限定权限**：Agent 仅暴露 7 个 API，无远程 Shell 访问

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
  Clawd Agent: agent/index.js  (Express :9877, 后台静默运行 + VBS 守护)
  Claude Code:  C:\Users\Mote\AppData\Roaming\npm\claude.cmd
  Tailscale IP: 100.80.205.79
```

---

## 关键连接

| 目标 | 命令 |
|------|------|
| Gateway 日志 | `ssh mote@100.118.10.0 'journalctl -u clawd-gateway -f'` |
| Gateway 重启 | `ssh mote@100.118.10.0 'sudo systemctl restart clawd-gateway'` |
| Gateway 健康 | `curl https://claude-tunnel.mote-pal.xyz/health` |
| Agent 健康 | `curl http://100.80.205.79:9877/api/health` |
| Agent 启动 | Windows 上 `wscript agent\start-hidden.vbs`（后台静默 + 崩溃自愈） |
| Agent 重载 | `curl -X POST http://127.0.0.1:9877/api/reload`（VBS 5 秒自动拉起） |

---

## 当前状态 (v1.5 — 2026-07-04)

### 已工作
- 企业微信消息接收/回复
- Windows Agent HTTP 执行 Claude Code（纯 HTTP，无 SSH）
- `@会话名` 创建/续接会话
- `claude --resume` 跨消息续接（含 `cd /d` CWD 修复）
- 电脑历史会话列表显示（含 aiTitle 标题、会话预览）
- 多会话路由（@指定、序号选择、唯一活跃自动路由）
- 退出项目 / 切换项目 / 重新接入
- 项目列表（60 秒序号窗口 + 项目名输入）
- 电脑离线检测 + 任务排队 + 定时 drain
- 项目自动发现（Agent 本地 fs 扫描，按最近活跃排序）
- Session lock 防护（手机消息触发关 VS Code 窗口，回来自动恢复）
- 已删除会话自动隐藏（读 VS Code state.vscdb 的 hiddenSessionIds）
- 手动隐藏/取消隐藏会话命令
- Agent 后台静默运行 + VBS 守护循环（崩溃 5 秒自愈）
- Agent `/api/reload` 热重载

### 未完成
- 手机创建的新会话在 VS Code 不显示（pipe 模式天生限制）

### 核心限制
- 电脑上先用 VS Code 创建会话，手机 `--resume` 续接，上下文完全保留
- 手机发消息会关 VS Code 窗口，回电脑重开 VS Code 自动恢复所有会话

---

## 技术选型

| 组件 | 选型 |
|------|------|
| Gateway | Node.js + Express + better-sqlite3 |
| Agent | Node.js + Express（Windows 本地 :9877） |
| 消息 | 企业微信自建应用 (AgentID 1000003) |
| 通信 | HTTP JSON（Gateway → Agent） |
| 连接 | Tailscale (WireGuard) |

---

## 文件结构

```
gateway/
  index.js      — Express server + 消息路由 + 群聊逻辑
  agent.js      — HTTP 客户端，调 Windows Agent
  db.js         — SQLite 数据层（群绑定/会话/任务队列/审计/隐藏）
  wecom.js      — 企业微信加解密 + 消息发送
  config.js     — 配置文件

agent/
  index.js          — Windows Agent Express 服务 (7 API)
  start.bat         — 开机自启脚本
  start-hidden.vbs  — 后台静默启动 + VBS 守护循环
  setup-firewall.bat — 防火墙规则（一次性管理员运行）
```

---

## Agent API

| 接口 | 功能 |
|------|------|
| `GET /api/health` | 在线检测 |
| `POST /api/discover` | 扫描 `.claude\projects\`，读 JSONL 取 cwd，按最近活跃排序 |
| `POST /api/list-sessions` | 列 JSONL 文件，含 aiTitle 摘要 |
| `POST /api/run-claude` | 本地 pipe 调 `claude.cmd --resume` |
| `POST /api/session-preview` | 话题消息 + 最近几轮 + 统计 |
| `GET /api/hidden-sessions` | 读 VS Code state.vscdb 取隐藏会话 ID |
| `POST /api/reload` | 退出进程（VBS 守护自动拉起 = 热重载） |

---

## 约束

- Gateway 放 `/mnt/data/clawd/`，不放 `/home/mote/`
- Agent 放 Windows 任意位置，`wscript start-hidden.vbs` 开机自启
- 部署变更后提交 `/mnt/data/infra/` git 仓库（infra 配置）
- 本项目只做 Claude Bridge，不动 mote-home 其他服务
- Claude Code 是唯一 AI 层，Gateway 和 Agent 都不推理
