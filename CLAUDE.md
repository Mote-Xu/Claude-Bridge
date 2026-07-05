# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## 项目定位

Claude Bridge — 企业微信是连接多个 Claude Code 会话的**消息总线**。

mote-home 运行 Gateway（24/7 Node.js），通过 Windows Agent HTTP API 在你 Windows 电脑上执行 Claude Code。同一套 session store（`%USERPROFILE%\.claude\`），手机和电脑无缝双向同步。

更深一层：既然你可以通过企微给任意 Claude 会话发消息，任意会话也可以通过 Bridge 回复你，那任意会话之间也能互相通信。企微变成了 Claude 会话的异步协调总线。

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
  /mnt/data/claude-bridge/            ← Gateway 代码 + SQLite DB
  /etc/systemd/system/claude-bridge-gateway.service

Caddy + CF Tunnel:
  claude-tunnel.mote-pal.xyz → Caddy :80 → Gateway :8933
  (走主 Tunnel 87fc0324)

Windows (Mote-Office):
  Claude-Bridge Agent: agent/index.js  (Express :9877, 后台静默运行 + VBS 守护)
  Claude Code:  C:\Users\Mote\AppData\Roaming\npm\claude.cmd
  Tailscale IP: 100.80.205.79
```

---

## 关键连接

| 目标 | 命令 |
|------|------|
| Gateway 日志 | `ssh mote@100.118.10.0 'journalctl -u claude-bridge-gateway -f'` |
| Gateway 重启 | `ssh mote@100.118.10.0 'sudo systemctl restart claude-bridge-gateway'` |
| Gateway 健康 | `curl https://claude-tunnel.mote-pal.xyz/health` |
| Agent 健康 | `curl http://100.80.205.79:9877/api/health` |
| Agent 启动 | Windows 上 `wscript agent\start-hidden.vbs`（后台静默 + 崩溃自愈） |
| Agent 重载 | `curl -X POST http://127.0.0.1:9877/api/reload`（VBS 5 秒自动拉起） |

---

## 当前状态 (v1.5 — 2026-07-05)

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
- Session lock 防护（精准关闭目标会话进程，不动其他会话和 VS Code）
- VS Code 隐藏会话自动同步（读 state.vscdb 的 hiddenSessionIds）
- 手动隐藏/取消隐藏会话命令
- Agent 后台静默运行 + VBS 守护循环（崩溃 5 秒自愈）
- Agent `/api/reload` 热重载
- 会话间迁移（项目重命名后批量改 JSONL cwd + 移动文件）
- list-sessions 不限行数扫描（修复大文件会话漏显）
- `@bridge:notify` — 会话间通信（Gateway 拦截 → 转发 → 结果返回用户）
- `关vscode` 命令 — 手动关闭 VS Code（企微发指令即关）
- TASK_BOARD.md 集群任务板（多会话协作时避免冲突）
- 会话索引自动注册（Bridge 访问过的会话在 VS Code 可见，含 aiTitle 命名）
- pipe/VS Code 双格式兼容（`getMessageText` 同时支持字符串和数组 content）

### 未完成
- 手机创建的新会话在 VS Code 不显示（pipe 模式天生限制）

### 核心限制
- 电脑上先用 VS Code 创建会话，手机 `--resume` 续接，上下文完全保留
- 企微发消息不关 VS Code 标签页；发 `关vscode` 手动全关，重开自动恢复

### ⚠️ 已知陷阱（2026-07-05 踩坑记录）

1. **pipe 模式的 JSONL 格式不同** — `content` 是字符串 `"hello"`，不是数组 `[{text:"hello"}]`。所有读 JSONL 的代码必须兼容两种格式（用 `getMessageText()`）。
2. **DB 更新后变量不自动刷新** — `updateClaudeSessionId()` 改了 SQLite 但 JS 对象还是旧值。更新 DB 后必须重新 `getSessionByName()` 取最新数据。
3. **精准关闭 + alreadyIndexed 互斥** — kill 会话进程后 VS Code 异步清理索引，检查 `alreadyIndexed` 可能读到旧条目然后跳过注册。现已改为每次必写 + 删旧。
4. **先看数据再看代码** — 遇到 bug 不要猜代码逻辑，先 `Read` JSONL/DB 看看实际数据是什么。

### 🆕 新洞察：Bridge = 会话间通信总线
- Gateway 已在中间，双向都能走消息
- 任意 Claude 会话之间可以通过 Bridge 互相通信
- 企微变成"消息总线"，不同专长的 Claude 会话各司其职、异步协调
- 技术上只需给 Claude 输出加路由约定（如 `@bridge:send <会话名> <消息>`）

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

README.md           — 项目 README（架构、功能、使用、部署）
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

- Gateway 放 `/mnt/data/claude-bridge/`，不放 `/home/mote/`
- Agent 放 Windows 任意位置，`wscript start-hidden.vbs` 开机自启
- 部署变更后提交 `/mnt/data/infra/` git 仓库（infra 配置）
- 本项目只做 Claude Bridge，不动 mote-home 其他服务
- Claude Code 是唯一 AI 层，Gateway 和 Agent 都不推理
