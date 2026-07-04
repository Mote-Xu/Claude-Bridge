# Claude Bridge — 外部 AI 验证问题

> 先读完本文档，然后逐一回答后面的验证问题。你的答案用来确认你是否真正理解了这个项目。

---

## 项目是什么

手机（企业微信）是电脑前 Claude Code 的"第二屏幕"。不是新建一个 AI——电脑上已有的 Claude Code 会话，手机无缝续接，回到电脑继续，所有对话双向同步。

---

## 当前架构（v1.5 — 2026-07-04 已完成）

```
企业微信 App → Bot API (webhook)
  → Node.js Gateway (mote-home Linux, 24/7, :8933)
    → HTTP → Windows Agent (:9877)
      → claude --resume <id>
```

- Gateway：消息路由、会话管理、任务队列、企业微信加解密、定时 drain
- Agent：本地读写 Claude 的 session store、本地 pipe 执行 `claude.cmd`
- Claude Code：唯一 AI 决策层，Gateway 和 Agent 都不做推理
- 纯 HTTP 架构，无 SSH 依赖。Windows sshd 已停止并禁用，mote-home 公钥已删除

---

## 交互模型

### 私聊 = 一个项目

- 一个企业微信私聊 → 绑一个项目文件夹
- 发「切换 <项目名>」换项目
- 发「项目列表」→ 60 秒内回复序号接入

### 会话 = Claude Code 的历史会话

- 会话来源 `%USERPROFILE%\.claude\projects\`，和电脑上同一套
- 手机 `--resume` 续接，上下文完整保留
- 回电脑 `claude --continue`，手机对话也在里面

### 命令

```
项目列表               → 列出项目（60s 序号窗口）
<项目名>               → 接入项目
切换 <项目名>           → 换项目
退出                   → 退出项目
列表                   → 查看所有会话（含 aiTitle）
预览 <序号>             → 话题 + 最近几轮
隐藏 <序号>             → 隐藏（同步 VS Code）
<序号>                 → 选择会话
@会话名 <消息>          → 指定会话
直接发消息              → 唯一活跃会话自动路由
```

### 桌面同步

```
手机发消息 → taskkill 关 VS Code → --resume → 结果返回微信
回电脑 → 重开 VS Code → 全部会话和终端自动恢复
```

---

## 代码结构

```
gateway/          ← mote-home 上运行
  index.js        ← Express webhook + 消息路由 + 群聊逻辑
  agent.js        ← HTTP 客户端，调 Windows Agent
  db.js           ← SQLite（群绑定/会话/任务队列/审计/隐藏）
  wecom.js        ← 企业微信加解密 + 消息发送
  config.js       ← 配置

agent/            ← Windows 本地运行
  index.js        ← Express :9877，7 个 API
  start-hidden.vbs — 后台静默 + VBS 守护（崩溃 5s 自愈）
```

---

## Agent 7 个 API

| 接口 | 功能 |
|------|------|
| `GET /api/health` | 在线检测 |
| `POST /api/discover` | 扫描 `.claude\projects\`，按最近活跃排序 |
| `POST /api/list-sessions` | 列 JSONL 文件，含 aiTitle 摘要 |
| `POST /api/run-claude` | pipe 调 `claude.cmd --resume` |
| `POST /api/session-preview` | 话题消息 + 最近几轮 + 统计 |
| `GET /api/hidden-sessions` | 读 VS Code state.vscdb 取 hiddenSessionIds |
| `POST /api/reload` | 退出进程（VBS 守护拉起 = 热重载） |

---

## 已验证 ✅

- ✅ 企业微信端到端全链路
- ✅ Agent HTTP 纯架构（无 SSH，Windows sshd 已关）
- ✅ `--resume` + `cd /d` 修复
- ✅ 会话标题 = Claude Code aiTitle（与 VS Code 一致）
- ✅ VS Code 删除会话自动隐藏（state.vscdb hiddenSessionIds，零依赖）
- ✅ taskkill 关 VS Code → 重开自动恢复会话
- ✅ VBS 守护循环（零窗口闪现，崩溃 5 秒自愈）
- ✅ `/api/reload` 热重载
- ✅ 离线排队 + 30 秒 drain
- ✅ 项目按最近活跃排序（mtime，已修复 projectName bug）

## 待改进

- 🔲 流式输出
- 🔲 Agent 鉴权（Tailscale 隔离下暂时可接受）
- 🔲 VS Code 会话可见性（pipe 模式限制）

---

## 验证问题

1. 用户在企业微信群里发了 `@重构 把用户模块换成 TypeScript`。从这条消息发出到 Claude Code 收到、执行、返回结果的完整路径是什么？

2. 用户在电脑上用 VS Code 先创建了一个会话（session ID: `abc-123`），和 Claude 聊了 3 轮。然后出门，手机发 `@导出 继续`——这个"继续"能否接到刚才那个会话？为什么？

3. 用户同时开着 Stardust_Chat 群和 Mobile_Dev 群。他在 Mobile_Dev 群里发了一条消息。Stardust_Chat 群的会话会受影响吗？为什么？

4. 用户的 Windows 电脑关机了（但 mote-home 还在跑）。他在手机上发了一条消息。这条消息会发生什么？当电脑重新开机后会发生什么？

5. 现在 Gateway 只有一条路执行 Claude：HTTP Agent。Agent 不可用时（比如 Agent 进程挂了），Gateway 怎么做？Agent 恢复后呢？

6. Agent 当前没有加认证保护（任何人能调 `http://100.80.205.79:9877`）。这个风险在 Tailscale 的隔离下是否可接受？如果要加固，最低成本的做法是什么？

7. **最关键的验证**：这套方案中，Claude Code 是唯一 AI 决策层。Agent 和 Gateway 做了哪些事但绝对不能做 AI 推理？如果有人在 Agent 里加了一段 `const answer = await openai.chat(...)` 的代码，违反了什么原则？
