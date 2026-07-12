# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## 项目定位

Claude Bridge — 企业微信是 Claude Code 会话集群的**异步消息总线**。

mote-home 运行 Gateway（24/7 Node.js），通过 Windows Agent HTTP API 在你 Windows 电脑上执行 Claude Code。同一套 session store（`%USERPROFILE%\.claude\`），手机和电脑无缝双向同步。

### 四层架构

```
Git             = 事实层（唯一真相，代码状态）
共享 md 文件     = 黑板层（会话间共享知识）
  ├─ CLAUDE.md       — 项目架构 + 技术栈（静态，人维护）
  ├─ TASK_BOARD.md   — 谁在做什么、哪些文件被锁
  ├─ BRIDGE_LOG.md   — 每次执行的摘要日志（Gateway 自动追加）
  └─ REQUIREMENTS.md — 需求清单
Bridge          = 协调层（会话间通信、事件路由）
Claude 会话      = 执行层（各司其职的 Worker）
```

企微不只是远程终端——它是会话集群的异步消息总线。不同专长的 Claude 会话各司其职，通过企微总线异步协调，自动干活直到项目完成。

### 核心约束：会话默认彼此隔离

每个会话有独立的 JSONL，各自积累上下文，**彼此之间完全不知道对方的存在和做过的事**。唯一的共享信息是项目文件夹下的静态 md 文件（黑板层）。会话之间感知彼此的方式：
- **被动感知**：启动时读黑板层文件（特别是 BRIDGE_LOG.md），了解其他会话做了什么
- **主动通信**：调用 Agent API 给其他会话发消息（见下方「会话间通信 API」）
- **公开履历**：`.bridge/sessions/@会话名.md` — 每个会话的完整输入输出透明可见

### 会话间通信 API（★每个会话都会用）

给同项目下另一个会话发消息，**不要用 @bridge 文本语法**（那只在企微驱动时有效），直接调 Agent：

```bash
curl -X POST http://127.0.0.1:9877/api/bridge/ask \
  -H "Content-Type: application/json" \
  -d '{"projectPath":"项目路径","sourceName":"你的会话名","targetName":"目标会话名","message":"消息内容"}'
```

**注意**：会话名以企微「列表」命令显示的名称为准。

**流程**：你调 API → 立刻返回（你结束本轮）→ Gateway 异步驱动目标会话 → 目标回复自动注入回你 → 你被唤醒继续 → 全程企微可见。

收到的消息前缀 `[bridge:from=会话名]` 说明来自另一个会话；无此前缀说明来自用户。

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

## 当前状态 (v1.7 — 2026-07-12)

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
- `/api/bridge/ask` — 对称会话间通信 API（发起/回复同一接口，来源标注、企微可见）
- 会话执行锁（Busy/Idle 状态机 + 消息排队）
- `.bridge/sessions/@会话名.md` — 会话公开履历（Agent 同步所有 JSONL）
- `/status` / `状态` — 查询当前正在执行的会话（JSONL mtime + Agent busy）
- CAST_OF_SESSIONS.md 会话角色名册（项目根，gitignore）— 分清谁是主线 worker / 谁是留档 auditor / 谁是墓碑 retired
  - 交互会话：全局 SessionStart hook（`~/.claude/hooks/cast-of-sessions.js`）建文件 + 提醒会话自登记（源=交互）
  - Bridge 会话：Agent `run-claude` 汇合点 `upsertCastBridge()` 机械登记（源=🌉 Bridge），不靠 hook 在 pipe 模式触发
  - upsert 幂等：按 UUID8 匹配，Agent 只刷新名称/时间，**保留会话自己声明的角色/在做**
  - 设计动因：进程活性可嗅探（查 `--resume` UUID），但「谁是主线 vs 谁是审计」是角色语义，机器推不出，只能由会话自己声明

### 未完成
- 手机创建的新会话在 VS Code 不显示（pipe 模式天生限制）

### 🚧 进行中（v1.7 — 2026-07-12）

**问题 1：Pipe 模式权限确认**（⏸️ 暂缓）
- 暂缓原因：检测不可靠（纯文本匹配）、状态管理复杂、重跑浪费 token、实际场景极少触发

**会话执行锁** ✅
- Gateway 维护会话级 Busy/Idle 状态机
- 会话执行中标记 Busy，新消息自动入队排队（复用现有离线排队机制）
- 执行完毕变回 Idle，自动 drain 队列
- 企微推送排队通知：`📥 消息已排队（会话正忙）`

**@bridge:ask 双向通信** ✅
- 路由：显式 `[from=<uuid>][to=<uuid>]`，Gateway 纯路由
  - 机读层：JSONL 文件名 UUID（唯一不变）
  - 人读层：aiTitle（企微显示）
- 上下文缝合：Gateway 注入 B 的回复时必须带完整事件帧——
  ```
  [ASYNC EVENT] 你在上一轮向 @B 发起了 ask。
  你的问题是："..."
  B 的回复如下：...
  请基于此继续你未完成的任务。
  ```
  否则 `--resume` 是全新 inference，A 可能"重新推理"而非"继续"
- 企微群实时状态推送：`🔗 A→B` / `👤 B 处理中` / `🔗 B→A reply` / `✅ A 完成`
- 环形依赖检测：A→B→A 时直接报错截断

**`.bridge/sessions/@会话名.md` — 会话公开履历** ✅
- Gateway 每次执行完自动往项目 `.bridge/sessions/@会话名.md` 追加输入+输出
- 任何会话 `cat .bridge/sessions/@XXX.md` 即可看到另一个会话的完整干活过程
- 标注来源（user/bridge），bridge 消息显示 `[bridge:ask from @XXX]`
- 消除"暗箱会话"——集群里每个会话都对团队完全透明

**BRIDGE_LOG.md — 双层状态文件**
- 不是逐条 append 的日志，是**工作记忆压缩**，回答"项目现在什么状态"
- 双层结构：
  - `CLUSTER_SNAPSHOT`（顶部，Gateway 覆盖写入）— 谁忙谁闲、锁了哪些文件
  - `RECENT_LOGS`（滚动保留最近 ~15 条摘要）
- 会话启动**按需感知**：
  - Level 0（默认）：只读 CLAUDE.md + TASK_BOARD.md
  - Level 1（用户问进度）：读 BRIDGE_LOG.md
  - Level 2（debug/冲突）：读原始事件
- CLAUDE.md 加行为规则：改文件前先 `cat TASK_BOARD.md`，迷茫时 `cat BRIDGE_LOG.md`

**CLAUDE.md 结构化分区**
- 架构/技术栈区：只读，只有人能改
- 决策区（DECISIONS）：会话追加，不覆盖已有决策
- 防止多会话对架构的理解产生"认知分裂"

### 集群协作路线图

**第一层：通信增强（当前）**
- [x] 会话执行锁 — Busy/Idle 状态机 + 消息排队
- [x] `@bridge:ask` / `@bridge:reply` + 上下文缝合 + 企微状态推送
- [x] `.bridge/sessions/@会话名.md` — 会话公开履历
- [ ] BRIDGE_LOG.md 双层结构（SNAPSHOT + RECENT_LOGS）
- [ ] CLAUDE.md 分区（架构只读 / 决策追加）

**第二层：集群协作基础**
- [ ] TASK_BOARD.md 状态机：status / owner / lease_expire / scope
- [ ] Agent 原子写入 API（`POST /api/board/update`，文件排它锁）
- [ ] `@bridge:broadcast` 广播

**第三层：角色分工 + Git 自动化**
- [ ] Feature branch 自动切
- [ ] PM/Dev/QA 角色会话
- [ ] Reviewer 验收流程（2PC）
- [ ] 全局一致性层（SYSTEM_STATE.md：repo state + active sessions + invariants）

### 核心限制
- 电脑上先用 VS Code 创建会话，手机 `--resume` 续接，上下文完全保留
- 企微发消息不关 VS Code 标签页；发 `关vscode` 手动全关，重开自动恢复

### ⚠️ 已知陷阱（2026-07-05 踩坑记录）

1. **pipe 模式的 JSONL 格式不同** — `content` 是字符串 `"hello"`，不是数组 `[{text:"hello"}]`。所有读 JSONL 的代码必须兼容两种格式（用 `getMessageText()`）。
2. **DB 更新后变量不自动刷新** — `updateClaudeSessionId()` 改了 SQLite 但 JS 对象还是旧值。更新 DB 后必须重新 `getSessionByName()` 取最新数据。
3. **精准关闭 + alreadyIndexed 互斥** — kill 会话进程后 VS Code 异步清理索引，检查 `alreadyIndexed` 可能读到旧条目然后跳过注册。现已改为每次必写 + 删旧。
4. **先看数据再看代码** — 遇到 bug 不要猜代码逻辑，先 `Read` JSONL/DB 看看实际数据是什么。
5. **chronicle sync 会「诈尸」已删项目文件夹**（2026-07-09 修复）— `writeChronicle` 从 JSONL 读出老 `cwd`，用 `mkdirSync(recursive)` 建 `.bridge/sessions/`。若用户已删该项目文件夹，recursive 会把整条路径**连同已删的顶层文件夹一起重建**（只剩一个含 `.bridge/` 的空壳）。因为历史会话 JSONL 永远躺在 `~/.claude/projects/`，每次 Bridge 活动 sync 一跑就复活一次。**修复**：`writeChronicle` / `upsertCastBridge` 写入前先 `fs.existsSync(projectPath)`，项目没了就跳过，绝不 mkdir 复活。教训：任何"从持久化的死路径重建目录"的逻辑都要先校验目标是否仍存在。
6. **chronicle sync 同步全量读是潜在阻塞源（附一次误诊教训）**（2026-07-12 改进）— Agent `syncChronicles()` 每 60 秒被 Gateway 触发，**同步 `readFileSync` 把所有项目所有 JSONL 整个重读一遍**。会话 JSONL 涨大后（马拉松会话可达 MB 级），单线程会被这堆同步读卡住、阻塞 Agent 其它 HTTP 响应——是真实隐患。**改进**：① `fs.statSync` 比大小，JSONL 只追加、大小没变就跳过不读；② 改 `await fs.promises.readFile` 异步读，让出事件循环。**⚠️ 误诊教训**：排查"企微回复变慢/不回"时，我一度咬定是这个 sync 阻塞（还先后错怪过 IPv6、mihomo），全错——真因是**断电后服务器出站网络劣化**（`ping 223.5.5.5` 100% 丢包、qyapi TCP 连不上），重启路由器即好，与代码无关。教训：①定时全量同步读确是事件循环杀手，该修；②但别把"自己能想到的代码问题"当成症状的因，先用证据（`curl -w`/`ping` 一测）定位真因，这次真因在网络层。

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

CAST_OF_SESSIONS.md — 会话角色名册（项目根，gitignore，Agent + hook 维护）
~/.claude/hooks/cast-of-sessions.js — 全局 SessionStart hook（建名册 + 提醒交互会话自登记）
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
