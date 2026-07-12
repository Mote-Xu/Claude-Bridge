# Claude Bridge

> **企业微信 ↔ Claude Code 消息桥接。**  
> 手机发消息，电脑跑 Claude。同一套 session store，双向无缝同步。
>
> 更深一层：它把多个 Claude 会话组成了**集群**——不同专长的会话各司其职、互相通信、自动协作。企微是总线，你是监工。

---

## 这是什么

Claude Bridge 把企业微信变成了 **Claude Code 会话集群**的协调层。

电脑上跑多个 Claude 会话（各有专长），手机企微是统一的输入通道和状态面板。会话之间通过 `@bridge:ask` / `@bridge:notify` 互相通信，通过项目目录下的共享文件（黑板层）感知彼此。Gateway 自动维护会话执行锁和公开履历。你在手机上发号施令、观察进度，集群自动干活直到项目完成。

更深一层：企微成了**多个 Claude 会话的异步消息总线**。不同专长的会话各司其职、互相通信、异步协调。

---

## 架构

```
企业微信 App
  │ Bot API (webhook)
  ▼
┌──────────────────────────────────────────────┐
│  mote-home (24/7 Ubuntu Server)              │
│  Gateway :8933 — 消息路由 + 会话管理         │
│  不做 AI 推理                                │
└──────────────┬───────────────────────────────┘
               │ HTTP (Tailscale WireGuard)
               ▼
┌──────────────────────────────────────────────┐
│  Mote-Office (Windows 11)                    │
│  Agent :9877 — 本地文件读写 + Claude 调用    │
│  不做 AI 推理                                │
└──────────────┬───────────────────────────────┘
               │ pipe (--resume)
               ▼
         Claude Code
        唯一 AI 层
```

- **Gateway**（mote-home）：接收企微 Webhook → 解密 → 路由 → 转发到 Windows Agent
- **Agent**（Windows）：读写 `~/.claude/projects/` → pipe 执行 `claude.cmd --resume` → 返回结果
- **Claude Code**：唯一的 AI 推理层。Gateway 和 Agent 都不推理。

**全部纯 HTTP，无 SSH 依赖。**

---

## 功能

| 功能 | 说明 |
|------|------|
| 🔗 跨消息续接 | `claude --resume` 保留完整上下文，手机和电脑同一套 JSONL session store |
| 📋 项目自动发现 | Agent 扫描本地 `~/.claude/projects/`，按最近活跃排序 |
| 💬 多会话路由 | 支持 @会话名、序号选择、唯一活跃自动路由 |
| 🔄 项目管理 | 切换项目、退出项目、重新接入 |
| 📴 离线排队 | 电脑关机时消息自动排队，开机后定时 drain 重试 |
| 🔒 Session lock 防护 | 精准关闭目标会话进程，不影响其他会话和 VS Code |
| 🚦 会话执行锁 | Busy/Idle 状态机 + 消息排队，防止同会话并发撞车 |
| 🙈 会话管理 | 隐藏/取消隐藏/预览会话，自动读取 VS Code 隐藏列表 |
| 🔗 `@bridge:notify` | 会话间单向通信（A→B→用户） |
| 🔄 `@bridge:ask` | 会话间双向通信（A→B→A→用户），含上下文缝合 |
| 📖 会话公开履历 | `.bridge/sessions/@会话名.md` 自动追加输入输出，集群内透明 |
| 📊 `/status` | 查询哪些会话正在执行（JSONL mtime + Agent busy） |
| 💻 `关vscode` | 远程关闭 VS Code，防止标签页撞 session |
| ♨️ 热重载 | Agent `/api/reload` 即时生效，VBS 守护 5 秒自动拉起 |
| 📊 TASK_BOARD | 集群任务板，多会话协作时避免冲突 |

---

## 连接方式

| 目标 | 方式 |
|------|------|
| Gateway 日志 | `ssh mote@100.118.10.0 'journalctl -u claude-bridge-gateway -f'` |
| Gateway 重启 | `ssh mote@100.118.10.0 'sudo systemctl restart claude-bridge-gateway'` |
| Gateway 健康 | `curl https://claude-tunnel.mote-pal.xyz/health` |
| Agent 健康 | `curl http://100.80.205.79:9877/api/health` |
| Agent 重载 | `curl -X POST http://127.0.0.1:9877/api/reload` |

---

## 使用方式

在企微私聊或群聊中，Bot 被拉入后：

| 命令 | 说明 |
|------|------|
| `项目列表` / `/projects` | 列出所有可用项目 |
| `<项目名>` | 接入一个项目（绑定当前聊天到该项目） |
| `列表` / `/list` | 查看当前项目所有会话 |
| `预览 <序号>` | 查看会话详情（话题 + 最近几轮） |
| `<序号>` | 续接/切换到指定会话 |
| `切换 <项目名>` | 换一个项目 |
| `退出` / `/leave` | 退出当前项目 |
| `@会话名 <消息>` | 给指定会话发消息 |
| `@会话名 stop` | 中断会话 |
| `@会话名 done` | 结束会话 |
| `隐藏 <序号>` / `取消隐藏 <序号>` | 隐藏/恢复会话 |
| `隐藏列表` / `/hidden` | 查看已隐藏的会话 |
| `关vscode` / `/kill-vscode` | 手动关闭 VS Code |
| `帮助` / `/help` | 显示帮助 |
| 直接发消息 | 发给当前唯一活跃会话 |

### @bridge:notify — 会话间单向通信

在 Claude 回复中包含以下指令，Gateway 会拦截并转发给同一项目下的目标会话：

```
@bridge:notify <目标会话名> <消息>
```

### @bridge:ask — 会话间双向通信

A 问 B 后，B 的回复自动回到 A 继续处理，用户只看最终结果：

```
@bridge:ask <目标会话名> <消息>
```

Gateway 自动注入上下文缝合，A 无缝继续。全程在企微推送状态：`🔗 A→B` / `👤 处理中` / `🔗 reply` / `✅ 完成`。

---

## 文件结构

```
Claude-Bridge/
├── gateway/
│   ├── index.js          # Express 服务 + 消息路由 + 群聊逻辑
│   ├── agent.js          # HTTP 客户端，调用 Windows Agent
│   ├── db.js             # SQLite（群绑定/会话/任务队列/审计/隐藏）
│   ├── wecom.js          # 企业微信加解密 + 消息发送
│   └── config.js         # 配置文件
├── agent/
│   ├── index.js          # Windows Agent Express 服务 (12 个 API)
│   ├── start.bat         # 开机自启脚本
│   ├── start-hidden.vbs  # 后台静默 + VBS 守护循环
│   └── setup-firewall.bat # 防火墙规则（一次性管理员运行）
├── .bridge/sessions/     # 会话公开履历（运行时自动生成）
├── CLAUDE.md             # 项目上下文（新会话自动加载）
├── REQUIREMENTS.md       # 需求与功能清单
├── GEMINI_PROMPT.md      # 发给外部 AI 的项目总结
├── ARCHITECTURE.md       # 架构评审与关键决策记录
├── TASK_BOARD.md         # 集群任务板（多会话协作）
└── README.md             # 本文件
```

---

## Agent API

| 接口 | 功能 |
|------|------|
| `GET /api/health` | 在线检测 |
| `POST /api/discover` | 扫描 `~/.claude/projects/` 返回项目列表 |
| `POST /api/list-sessions` | 列出项目会话（含 aiTitle 摘要） |
| `POST /api/run-claude` | pipe 执行 `claude.cmd --resume` |
| `POST /api/session-preview` | 会话详情（话题 + 最近几轮 + 统计） |
| `GET /api/hidden-sessions` | 读 VS Code state.vscdb 取隐藏会话 |
| `POST /api/chronicle` | 写会话公开记录到 `.bridge/sessions/@name.md` |
| `POST /api/bridge/ask` | 会话间通信（解析目标 UUID，转发 Gateway） |
| `POST /api/sync-chronicles` | 扫描项目 JSONL，同步 chronicle |
| `GET /api/busy-sessions` | 查询当前正在执行的会话 |
| `POST /api/reload` | 退出进程（VBS 守护自动拉起 = 热重载） |
| `POST /api/kill-vscode` | 手动关闭 VS Code |

---

## 部署

### mote-home — Gateway

```bash
# Gateway 代码位置
/mnt/data/claude-bridge/ → ~/claude-bridge/ (symlink)

# systemd 管理
sudo systemctl status claude-bridge-gateway
sudo systemctl restart claude-bridge-gateway
```

公网入口：Cloudflare Tunnel (`claude-tunnel.mote-pal.xyz`) → Caddy `:80` → Gateway `:8933`

### Windows — Agent

```bash
# 启动（开机自启推荐）
wscript agent\start-hidden.vbs

# 防火墙（仅首次，管理员运行）
agent\setup-firewall.bat

# 热重载
curl -X POST http://127.0.0.1:9877/api/reload
```

Agent 监听 `0.0.0.0:9877`，Gateway 通过 Tailscale IP (`100.80.205.79`) 连接。

---

## 技术栈

| 组件 | 技术 |
|------|------|
| Gateway | Node.js + Express + better-sqlite3 |
| Agent | Node.js + Express (Windows) |
| 消息系统 | 企业微信自建应用 (AgentID 1000003) |
| 通信 | HTTP JSON (Gateway → Agent) |
| 网络安全 | Tailscale WireGuard |
| 公网入口 | Cloudflare Tunnel → Caddy |
| AI 推理 | Claude Code（唯一 AI 层） |

---

## 核心设计原则

1. **Claude Code 是唯一 AI 层** — Gateway 和 Agent 只做路由和 I/O，不调用任何 AI API
2. **纯 HTTP，无 SSH** — Windows sshd 已关闭，所有通信走 HTTP JSON
3. **Session store 共享** — 手机和电脑同一套 `~/.claude/` 目录，同一条 JSONL，两边随时切换
4. **黑板 + 消息总线** — 项目共享 md 文件是感知层，`@bridge:ask` 是通信层，Git 是真相层
5. **会话透明** — 每个会话的输入输出公开在 `.bridge/sessions/`，集群内无暗箱

---

## 已知限制

- 手机创建的新会话在 VS Code 不可见（pipe 模式天生限制）
- 解决方法：电脑上先用 VS Code 创建会话，手机 `--resume` 续接

---

## 相关文档

| 文档 | 内容 |
|------|------|
| [CLAUDE.md](./CLAUDE.md) | 完整项目上下文（架构、状态、连接方式） |
| [REQUIREMENTS.md](./REQUIREMENTS.md) | 功能需求与版本规划 |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 架构评审与关键决策 |
| [TASK_BOARD.md](./TASK_BOARD.md) | 集群任务板 |
