# Claude Bridge — 外部 AI 讨论

> 先把本文档读完，再回答最后的验证问题和设计问题。

---

## 项目是什么

Claude Bridge — 企业微信是连接多个 Claude Code 会话的**消息总线**。

手机（企微）→ Gateway（mote-home 24/7）→ Windows Agent → `claude.cmd --resume`。电脑上已有的 Claude 会话，手机无缝续接，回到电脑继续，双向同步。

更深一层：**既然人可以给任意会话发消息，会话也能回复人，那会话之间也应该能互发消息。** 企微变成了 Claude 会话的异步协调总线。

---

## 当前架构（v1.5 — 2026-07-05）

```
企业微信 App → Bot API (webhook)
  → Node.js Gateway (mote-home, 127.0.0.1:8933)
    → HTTP → Windows Agent (100.80.205.79:9877)
      → claude --resume <id>
```

- **Gateway**：消息路由、会话管理、任务队列、企业微信加解密、定时 drain。**不做 AI 推理。**
- **Agent**：本地读写 `~/.claude/projects/`，pipe 执行 `claude.cmd`。**不做 AI 推理。**
- **Claude Code**：**唯一 AI 层。**
- 纯 HTTP，无 SSH。Windows sshd 已关闭。

---

## 交互模型

```
私聊/群聊 → 绑定一个项目文件夹
  ├── 会话 A（active）  ← @重构 消息
  ├── 会话 B（idle）    ← @导出 消息
  └── 会话 C（ended）

命令：
  项目列表 / <项目名> / 切换 / 退出 / 列表 / 预览 / 隐藏 / 序号 / @会话名
```

Agent 7 个 API：health / discover / list-sessions / run-claude / session-preview / hidden-sessions / reload

---

## 🆕 核心要讨论的问题

### 问题 1：会话间通信总线

**现状**：

```
你 ──→ Gateway ──→ Agent ──→ 会话 A（返回结果给你）
你 ──→ Gateway ──→ Agent ──→ 会话 B（返回结果给你）
```

**发现**：Gateway 已经在中间，双向都能走。只要 Gateway 收到 Claude 输出后**不发给你的企微，而是转发给另一个会话**，就实现了会话间通信。

```
会话 A（架构设计）──→ "@bridge:send 数据库专家 帮我查表结构"
                      ↓
               Gateway 解析 @bridge:send
                      ↓
                  Agent → 会话 B（数据库专家）
                      ↓
               结果发回给你（或转回给会话 A）
```

**这意味着**：
- 不再是你和单个会话一对一
- 你在**协调一支 Claude 团队**，各司其职
- 企微变成异步消息总线，会话是挂在总线上的节点

### 问题 2：协议设计

最简单的 v1 协议：Claude 输出中包含特殊标记，Gateway 解析后路由。

```
@bridge:send <目标会话名> <消息内容>
@bridge:ask  <目标会话名> <问题>  ← 把回答发回给发起方
@bridge:broadcast <消息>           ← 发给当前项目所有活跃会话
```

**需要讨论的**：
1. 这个协议应该怎么设计？越简单越好，但要能覆盖核心场景。
2. 会话间通信的"身份"问题——会话 A 怎么知道自己该和谁对话？需要"团队配置"文件吗？
3. 安全性——会话 A 能不能给其他项目的会话发消息？应该限制在当前项目内还是全局？
4. 这个方案和 Claude Code 原生的 Task/tool 机制（sub-agent spawn）之间是什么关系？互补还是冲突？

### 问题 3：Agent 的瓶颈

当前 Agent 的一个限制：`run-claude` 会先 `taskkill code.exe`（关 VS Code 防止 session lock 冲突），然后 pipe 执行 Claude。这意味着：

- **每次只能跑一个会话**（因为 VS Code 被关了，所有会话都要通过 Agent pipe 续接）
- 如果会话 A 想调会话 B，会话 B 也需要 --resume —— 而 A 正在 pipe 中运行

**需要讨论的**：
1. 是否应该放弃 taskkill 策略，转而用 session lock 超时等待？
2. 如果保留 taskkill，会话间通信是否只能走"排队"模式（A 执行完 → Gateway 再触发 B）？
3. 有没有办法让多个 Claude 进程同时运行（不关 VS Code）？

### 问题 4：这是不是过度设计？

1. Claude Code v2 可能已经内置了多 agent 协作（sub-agent spawn、Task tool）。等官方方案成熟后，Bridge 的会话间通信会不会变成重复造轮子？
2. 但 Bridge 的价值在于**异步 + 跨项目 + 移动端消息总线**——Claude Code 原生方案可能只限于同一项目内的同步 spawn。这两者是否有本质区别？
3. 如果真的要做，最小可行实现是什么？不要画大饼，给出能在一个晚上写出来的方案。

---

## 验证问题（确认你理解了现有系统）

1. 用户在企业微信群里发了 `@重构 把用户模块换成 TypeScript`。从这条消息发出到 Claude Code 收到、执行、返回结果的完整路径是什么？

2. 电脑关了，手机发消息会发生什么？电脑重新开机后呢？

3. Gateway 和 Agent 都不做 AI 推理。如果有人往 Agent 里加了 `const answer = await openai.chat(...)` 代码，违反了这条项目的什么核心原则？

4. 用户发消息时 VS Code 会被 taskkill 关掉。为什么？如果改成不关 VS Code，会遇到什么问题？

5. 当前 Agent 用 VBS 守护循环（`start-hidden.vbs`，进程退出 5 秒后拉起）。把这个和 Task Scheduler 每 5 分钟轮询的方案对比：VBS 方案的优缺点？
