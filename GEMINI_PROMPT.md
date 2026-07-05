# Claude Bridge — 外部 AI 咨询记录

## 第二轮咨询结论（2026-07-05）

### 六个问题的共识答案

1. **BRIDGE_LOG.md 粒度**：不能逐条 append。双层结构 — CLUSTER_SNAPSHOT（覆盖写入，"谁忙谁闲、锁了哪些文件"）+ RECENT_LOGS（滚动保留最近 ~15 条）
2. **黑板并发写入**：必须 Agent 原子写入 API（`POST /api/board/update`，文件排它锁）。纯 Git 竞争是小时级的，AI 并发是秒级的，不够
3. **启动感知**：按需加载。Level 0 默认只读 CLAUDE.md + TASK_BOARD.md；Level 1 用户问进度才读 BRIDGE_LOG.md
4. **@bridge:ask 的 resume 语义**：`--resume` 是 context restore + new inference，不是 continuation。Gateway 必须显式缝合上下文（ASYNC EVENT 帧），否则 A 可能"重新推理"而非"继续"
5. **防撞车**：人眼不够，必须 Gateway 级会话执行锁。会话 Busy 时新消息入队排队，Idle 后自动 drain。策略是队列化 + backpressure，不拒绝
6. **盲区**：缺"全局一致性层"。多 agent + 通信有了，但没一致世界模型。三个迟早踩的坑：认知分裂（A 和 B 对架构理解不同）、状态漂移（task board ≠ git ≠ reality）、幽灵任务

### 执行锁 — 两个 AI 唯一毫无保留的硬性要求

会话执行锁是 `@bridge:ask` 的安全前提，不做就上线会炸。

### 本阶段实现顺序

1. 🔴 会话执行锁（Busy/Idle 状态机 + 消息排队）
2. `@bridge:ask` / `@bridge:reply`（双向通信 + 上下文缝合 + 企微状态推送）
3. BRIDGE_LOG.md（双层结构）

---

## 当前架构

```
企业微信 App → Bot API (webhook)
  → Node.js Gateway (mote-home 服务器, 24/7)
    → HTTP → Windows Agent (我电脑本地 :9877)
      → claude --resume <sessionId>
```

Gateway 纯路由，Agent 本地执行，企微是 Claude Code 会话集群的**异步消息总线**。

---

## 已实现

- 企微收发消息、@会话名 创建/续接、`--resume` 保持上下文
- 多项目自动发现、离线排队、会话隐藏/索引
- `@bridge:notify` — 单向会话间通信（A → B → 用户）

## 进行中：v1.7 两项新能力

### 1. `@bridge:ask` — 会话间双向通信

> `@bridge:notify` 是单向。`@bridge:ask` = A 问 B，B 回复回到 A，A 继续干，用户看最终结果。

**设计方案**：
- 每条跨会话消息带显式路由标记 `[from=<session_uuid>][to=<session_uuid>]`
- 机读层：JSONL 文件名 UUID（唯一不变），Gateway 纯路由，不维护状态
- 人读层：aiTitle（企微显示给用户）
- A 输出 `@bridge:ask B <消息>` → Gateway 解析 → 调 B 的 pipe，stdin 带 `[from=A的UUID] B的aiTitle asks: <消息>` → B 执行 → B 输出 → Gateway 把 B 的回复通过 `--resume A` 注回 → A 继续处理 → 最终结果给用户
- B 不知道是谁在问它（当前），靠 Gateway 转发时带的人类可读名感知

**防撞车机制**：会话间通信全程在企微群可见，Gateway 推送关键事件：

```
🔗 @项目架构师 → @数据库专家  (ask: 查users表)
👤 @数据库专家 处理中...
🔗 @数据库专家 → @项目架构师  (reply)
👤 @项目架构师 处理中...
✅ @项目架构师 完成
```

用户看到 B 正忙就知道不要此时给 B 发新消息，避免相互覆盖（撞车）。企微群不只是输入通道，也是集群的**实时状态面板**。

### 2. BRIDGE_LOG.md — 集群感知日志

**问题**：所有会话默认彼此隔离（独立 JSONL，不共享上下文）。一个会话完全不知道其他会话的存在和做过的事。唯一的共享信息是项目文件夹下的静态 md 文件。

**方案**：Gateway 每次执行完（无论用户直接创建的会话还是 Bridge 转发的），自动往项目目录 `BRIDGE_LOG.md` 追加一条摘要：

```md
## 2026-07-05 09:45 @数据库专家
- 用户/Direct: 查 users 表结构
- 结果: 成功 | 涉及文件: schema.sql
```

```md
## 2026-07-05 09:48 @数据库专家
- @bridge:ask 来自 @项目架构师: 查 orders 表索引
- 结果: 成功，已回复 | 涉及文件: schema.sql
```

会话启动时读 CLAUDE.md（里面写"去看 BRIDGE_LOG.md 了解集群动态"），就能知道谁做了什么、是否可以协作。

---

## 黑板模式（成型中）

项目文件夹下的共享 md 文件是会话集群的**黑板**——所有会话天然可读写，不需要额外通信层：

| 文件 | 作用 | 谁写 |
|------|------|------|
| `CLAUDE.md` | 项目架构 + 技术栈 + 集群规则 | 人 |
| `TASK_BOARD.md` | 谁在做什么、哪些文件被锁（状态机） | 会话 |
| `BRIDGE_LOG.md` | 每次执行的摘要日志 | Gateway 自动 |
| `REQUIREMENTS.md` | 功能需求 + 非功能约束 | 人 |

---

## 已放弃的方向

- Pipe 模式权限确认（⏸️ 暂缓）：检测不可靠（纯文本匹配）、重跑浪费 token、实际场景极少触发（CI 模式项目目录内基本不拦）

---

## 想请教的问题

1. **BRIDGE_LOG.md 的粒度**：每条执行都写会很快膨胀。要不要只保留最近 N 条，或者按"会话×任务"聚合？什么粒度最适合 AI 会话快速了解集群状态？

2. **黑板文件的并发写入**：多个会话同时读项目文件是安全的，但如果 B 在执行中修改了 CLAUDE.md，A 正在读——md 文件本身没有锁。需要 Agent 提供原子写入 API，还是"靠 git commit 竞争，只有一个能 push"就够了？

3. **会话启动时的"集群感知"策略**：会话启动后应该默认读哪些黑板文件？全读可能占太多上下文。是只在用户问"现在进度如何"时才去读，还是启动时自动扫描 BRIDGE_LOG.md？

4. **@bridge:ask 的异步模型**：A 发 ask 后挂起，B 完成后 Gateway 重新 `--resume A` 注入回复。但 A 的 pipe 执行已经结束了，再 `--resume` 实际上是一次新的 pipe 执行。这个"新执行"能否自然地接上之前的上下文，把 B 的回复当作新消息处理？有什么需要注意的吗？

5. **防撞车：Gateway 状态推送是否足够？**：当前设计是 Gateway 在企微群实时推送"谁在跟谁通信、谁正忙"，用户看到后不去打扰。但这是靠人眼看的，不是硬约束。如果用户没看到通知就发了消息，还是会撞车。需要 Gateway 层面做"会话执行锁"（正在执行中的会话拒绝接收新消息）吗？还是"人眼看 + BRIDGE_LOG 兜底"就够了？

6. **整体评价**：这个黑板 + 消息总线的架构方向，还有什么明显的盲区或改进点？
