# Claude Bridge — 外部 AI 验证问题

> 先读完本文档，然后逐一回答后面的验证问题。你的答案用来确认你是否真正理解了这个项目。

---

## 项目是什么

手机（企业微信）是电脑前 Claude Code 的"第二屏幕"。不是新建一个 AI——电脑上已有的 Claude Code 会话，手机无缝续接，回到电脑继续，所有对话双向同步。

---

## 当前架构（v1.5 — 2026-07-04 凌晨验证完毕）

```
企业微信 App → Bot API (webhook)
  → Node.js Gateway (mote-home Linux, 24/7, :8933)
    → HTTP (主) → Windows Agent (:9877)
    → SSH (fallback)
      → claude --resume <id>
```

- Gateway：消息路由、会话管理、任务队列、企业微信加解密、定时 drain
- Agent：本地读写 Claude 的 session store、本地 pipe 执行 `claude.cmd`
- Claude Code：唯一 AI 决策层，Gateway 和 Agent 都不做推理

---

## 交互模型（最核心）

### 群聊 = 项目

- 一个企业微信群 = 一个项目文件夹（如 Stardust_Chat）
- 群内 @会话名 = 该项目的某个 Claude Code 会话
- 切项目 = 切群（微信原生体验）

### 会话 = Claude Code 的历史会话

- 会话来源是 `%USERPROFILE%\.claude\projects\`，和电脑上同一套
- 手机 `--resume` 续接，上下文完整保留
- 回到电脑 `claude --continue`，手机上的对话也在里面

### 交互流程

```
拉新群 → Bot 自动入群 → "请告诉我要接入的项目名"
  → 回复 "Stardust_Chat"
  → Bot: "已接入。历史会话: [1] 修复登录 [2] 重构用户。回复序号或 @会话名"

群内发消息              → Bot 路由到唯一活跃会话
群内 @会话名 <消息>      → 指定发给哪个会话
群内 @会话名 stop/done   → 中断/结束会话
群内 3                   → 续接历史会话 #3
群内 列表               → 查看所有会话
群内 预览 2              → 预览 #2 的话题和最近几轮
另拉一个群               → 另一个项目，独立上下文
```

---

## 代码结构

```
gateway/          ← mote-home 上运行
  index.js        ← Express webhook + 消息路由 + 群聊逻辑
  agent.js        ← HTTP 客户端，调 Windows Agent，SSH fallback
  ssh.js          ← SSH fallback（agent 不可用时）
  db.js           ← SQLite（群绑定/会话/任务队列/审计）
  wecom.js        ← 企业微信加解密 + 消息发送
  config.js       ← 配置（agent 地址、SSH 参数、项目列表）

agent/            ← Windows 本地运行
  index.js        ← Express :9877，5 个 API
  start.bat       ← 开机自启
```

---

## Windows Agent 的 5 个 API

| 接口 | 功能 |
|------|------|
| `GET /api/health` | 在线检测 |
| `POST /api/discover` | 扫描 `.claude\projects\`，读 JSONL 取 cwd，按最近修改时间排序 |
| `POST /api/list-sessions` | 接收 `{projectPath}`，读 JSONL 文件，返回 `[{id, date, summary}]` |
| `POST /api/run-claude` | 接收 `{sessionId, message, cwd}`，本地 pipe 调 `claude.cmd`，返回 stdout |
| `POST /api/session-preview` | 接收 `{projectPath, sessionId}`，返回话题消息、最近几轮、统计 |

---

## 已验证 ✅

### Agent API
- ✅ /api/health — `{"status":"ok"}`
- ✅ /api/discover — 返回 26 个项目，按最近活跃排序
- ✅ /api/list-sessions — 返回会话列表，含 aiTitle 作为摘要
- ✅ /api/run-claude — 本地 pipe 执行，中文正常（Gateway JSON 调用无编码问题）
- ✅ /api/session-preview — 话题消息 + 最近几轮 + 统计

### 部署 & 连通
- ✅ mote-home Gateway 通过 Tailscale 访问 Agent（`curl http://100.80.205.79:9877/api/health`）
- ✅ 企业微信端到端（Gateway → Agent → Claude → WeCom 全链路 30 秒内完成）
- ✅ Windows 防火墙放行（`setup-firewall.bat` 以管理员运行）
- ✅ Agent 开机自启（`start.bat` 快捷方式放 `shell:startup`）

### 关键修复
- ✅ `--resume` 需要 `cd /d` 到项目目录才能找到会话（根因：Claude Code 用 cwd 定位 session store）
- ✅ 会话标题：优先读 Claude Code 的 `aiTitle` 字段（如「Claude Bridge 远程架构重构」），VS Code 显示的也是这个
- ✅ 排序：项目列表按最近活跃、会话列表按最近修改（mtime）
- ✅ Session lock 防护：续接前 `Get-CimInstance` 查命令行杀残留 Claude 进程
- ✅ 会话去重：活跃会话不再出现在历史列表里，避免序号串位
- ✅ 选号后自动路由：清理旧活跃会话，下条消息唯一定向
- ✅ 空会话过滤：VS Code 自动创建的无用户消息会话不显示
- ✅ 定时 drain：每 30 秒检测电脑在线状态，自动重试 pending 任务
- ✅ `CI=true` + `CLAUDE_NO_TUI=1` 环境变量已设（对 pipe 模式 VS Code 可见性效果有限）

### 命令清单
- ✅ `/help` / `帮助` — 列出可用命令
- ✅ `切换 <项目名>` — 换项目
- ✅ `退出` / `/leave` — 退出当前项目
- ✅ `列表` / `/list` — 查看当前项目会话（含标题）
- ✅ `预览 <序号>` — 预览会话话题和最近几轮
- ✅ `<序号>` — 选会话
- ✅ `<消息>` — 自动路由到唯一活跃会话
- ✅ `@会话名 <消息>` — 发给指定会话

---

## 待改进

- 🔲 群聊多项目并行测试（拉多个群同时用）
- 🔲 流式输出（Claude 结果逐步推送到微信，不等 3 分钟一次性返回）
- 🔲 Agent 鉴权（`X-Auth-Token`，Tailscale 隔离下暂时可接受）
- 🔲 VS Code 会话可见性（pipe 模式天生限制，电脑先创建、手机续接可规避）

---

## 验证问题

**对以下每个问题，先给出你的答案，再解释你的推理路径。**

1. 用户在企业微信群里发了 `@重构 把用户模块换成 TypeScript`。从这条消息发出到 Claude Code 收到、执行、返回结果的完整路径是什么？涉及哪些进程、网络跳、文件操作？

2. 用户在电脑上用 VS Code 先创建了一个会话（session ID: `abc-123`），和 Claude 聊了 3 轮。然后出门，手机发 `@导出 继续`——这个"继续"能否接到刚才那个会话？为什么？

3. 用户同时开着 Stardust_Chat 群和 Mobile_Dev 群。他在 Mobile_Dev 群里发了一条消息。Stardust_Chat 群的会话会受影响吗？为什么？

4. 用户的 Windows 电脑关机了（但 mote-home 还在跑）。他在手机上发了一条消息。这条消息会发生什么？当电脑重新开机后会发生什么？

5. 现在 Gateway 有两条路可以执行 Claude：HTTP Agent（主）和 SSH（fallback）。Agent 不可用时（比如 agent 进程挂了），Gateway 应该怎么做？Agent 恢复后呢？

6. Agent 当前没有加认证保护（任何人能调 `http://100.80.205.79:9877`）。这个风险在 Tailscale 的隔离下是否可接受？如果要加固，最低成本的做法是什么？

7. **最关键的验证**：这套方案中，Claude Code 是唯一 AI 决策层。Agent 和 Gateway 做了哪些事但绝对不能做 AI 推理？如果有人在 Agent 里加了一段 `const answer = await openai.chat(...)` 的代码，违反了什么原则？
