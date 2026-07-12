# Claude Bridge — 外部 AI 咨询记录

## 第二轮咨询结论（2026-07）

### 六个问题的共识答案

1. **BRIDGE_LOG.md 粒度**：不能逐条 append。双层结构 — CLUSTER_SNAPSHOT（覆盖写入，"谁忙谁闲、锁了哪些文件"）+ RECENT_LOGS（滚动保留最近 ~15 条）
2. **黑板并发写入**：必须 Agent 原子写入 API（`POST /api/board/update`，文件排它锁）。纯 Git 竞争是小时级的，AI 并发是秒级的，不够
3. **启动感知**：按需加载。Level 0 默认只读 CLAUDE.md + TASK_BOARD.md；Level 1 用户问进度才读 BRIDGE_LOG.md
4. **@bridge:ask 的 resume 语义**：已改为对称 API——回复方自己调 `/api/bridge/ask`，Gateway 不再自动注入回复
5. **防撞车**：人眼不够，必须 Gateway 级会话执行锁。会话 Busy 时新消息入队排队，Idle 后自动 drain。策略是队列化 + backpressure，不拒绝
6. **盲区**：缺"全局一致性层"。多 agent + 通信有了，但没一致世界模型。三个迟早踩的坑：认知分裂（A 和 B 对架构理解不同）、状态漂移（task board ≠ git ≠ reality）、幽灵任务

### 执行锁 — 两个 AI 唯一毫无保留的硬性要求

会话执行锁是 `@bridge:ask` 的安全前提，不做就上线会炸。

### 本阶段实现状态

1. ✅ 会话执行锁（Busy/Idle 状态机 + 消息排队）
2. ✅ `/api/bridge/ask` — 对称会话间通信 API（发起和回复走同一接口）
3. ✅ `.bridge/sessions/@会话名.md`（每个会话的完整输入输出公开透明）
4. ✅ `/status` / `状态` — 查询会话执行状态（JSONL mtime + Agent busy）
5. ✅ VS Code = 企微零区别（任何会话均可通过 API 自主通信）
6. ✅ 已在 MemeticChaos 项目实测验证：worker + auditor 双会话自主协同
7. ⏳ BRIDGE_LOG.md（双层结构：SNAPSHOT + RECENT_LOGS）

### 已验证：会话间通信模型

- **对称 API**：`POST /api/bridge/ask`，发起和回复是同一操作
- **来源标注**：`[bridge:from=会话名]` 前缀，接收方知道是谁发的
- **Fire-and-die**：调完立刻返回（结束本轮），对方回复自动唤醒
- **企微可见**：每次会话间通信在企微推送状态
- **VS Code = 企微**：任何会话无论怎么被驱动，都能自主调 API

核心问题：会话之间记忆独立，不能相互访问彼此在干什么。解决方案：Gateway 每次执行完自动往项目目录 `.bridge/sessions/@会话名.md` 追加输入+输出。任何会话 `cat .bridge/sessions/@XXX.md` 即可看到另一个会话的完整干活过程。标注来源（user/bridge），集群里不再有"暗箱会话"。

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

## 未解决问题

- **全局一致性层**（来自 GPT 反馈）：多 agent + 通信有了，但没一致世界模型。三个迟早踩的坑：认知分裂（A 和 B 对架构理解不同）、状态漂移（task board ≠ git ≠ reality）、幽灵任务。需要 SYSTEM_STATE.md 或类似机制。
