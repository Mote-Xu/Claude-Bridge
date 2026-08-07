# Claude Bridge — TG 流式输出架构设计请求

> 把这个文件内容发给外部 AI（Gemini / GPT / DeepSeek / Claude），请它给出架构方案。
> 回答完后删掉本文件。

---

## 项目概述

Claude Bridge：手机通过 Telegram Bot 给 Claude Code（Windows 本机）发消息，Claude 执行后返回结果。

```
Telegram Bot API
  ↑↓ webhook
Node.js Gateway (Linux 服务器 mote-home, Express :8933)
  ↑↓ HTTP JSON over Tailscale
Node.js Agent (Windows Mote-Office, Express :9877)
  ↑↓ child_process spawn
Claude Code CLI (claude.cmd --resume <sessionId>)
```

- Gateway = 消息路由 + 会话管理 + offlin 队列
- Agent = 在 Windows 上 spawn Claude 进程
- 双通道接入：企业微信（webhook 加解密）+ Telegram（webhook 明文 JSON）
- 企业微信不需要流式（一次性返回即可）；TG 需要流式

## 当前流式方案（v1，刚实现，bug 多）

### Agent 端

`POST /api/run-claude` 新增 `stream: true`：

```
res.writeHead(200, {'Content-Type': 'application/x-ndjson'})
child = spawn('claude', ['--resume', sessionId], {stdio: ['pipe','pipe','pipe']})
child.stdin.write(message); child.stdin.end()

child.stdout.on('data', chunk => {
  if (detectPermissionPrompt(accumulated)) {
    res.write('{"type":"permission_needed",...}\n'); res.end(); return;
  }
  res.write('{"type":"chunk","text":"...")}\n');
})
child.on('exit', code => { res.write('{"type":"done",...}\n'); res.end(); })
res.on('close', () => { taskkill child })  // Gateway disconnect → kill claude
```

### Gateway 端

新增 `execClaudeStream()`：HTTP request → 逐行 parse NDJSON → 调回调 onChunk/onPermission/onDone

`handleSessionMessage` TG 分支：
```
1. sendMessage "⏳ 处理中..." + [⏹ 停止] button
2. execClaudeStream()
   onChunk: accumulate text → 500ms throttle → editMessageText("...\n\n⏳ 生成中...")
   onPermission: fallback to non-stream writeStdin flow
   onDone: editMessageText(final output, remove "生成中" suffix)
```

### 已部署后的 bug 现状（5 个问题）

1. **`[🌉]` 标注错误**：通过 TG 发消息创建的会话被错误标注为 Bridge 会话
2. **键盘残留**：TG 中选完项目/会话后，inline keyboard 按钮不清除（但 /leave 后正常清除，说明 clearAllKeyboards 在部分路径没调用）
3. **重试排队任务缺停止按钮**：drainSessionQueue 重试时没有 [⏹ 停止] 按钮
4. **TG 消息发送不工作**：上一版部署后 `trackKeyboardMsg is not defined`（函数作用域 bug，已修复），但整体 TG 消息通道仍不稳定
5. **流式输出未验证通过**——上述 bug 导致 TG 通道崩溃，流式效果从未被看到

### 已识别但未触发的设计问题

6. **权限交互 + 流式割裂**：检测到权限 → 终止流 → 回退非流式 → 完成用 sendMessage 新发一条，体验不连贯
7. **断连即杀**：HTTP 连接断开 → Agent 端 taskkill。网络抖动就会丢结果
8. **chunk = 任意字节切分**：可能在 UTF-8 多字节字符中间断开，也可能在单词中间切断。TG 显示无句子边界语义
9. **500ms 节流 = 跳过中间帧**：chunk 来得快时用户只能看到跳跃的片段
10. **TG editMessageText 频率限制**：快速编辑可能被 TG 限流，当前 `.catch(() => {})` 静默吞错

## 关键约束

- Gateway (Linux) ↔ Agent (Windows) 通过 Tailscale WireGuard 直连，延迟 <10ms
- Claude CLI 只能通过 `--resume` 续接会话；stdin 写入消息，stdout 流式输出
- TG 消息上限 4096 字符；编辑消息有隐式频率限制
- 不能引入新基础设施（Redis、MQ 等）
- 企业微信路径保持一次性输出，不要改动
- Gateway 代码 `gateway/index.js` ~1200 行，Agent `agent/index.js` ~500 行

## 当前代码结构速览

### Gateway (gateway/index.js) 核心函数

| 函数 | 作用 |
|------|------|
| `handleMessage(chatId, userId, text, platform)` | 消息总入口，路由命令 (/list /switch /status /help /leave 等) |
| `handleSessionMessage(chatId, userId, existingSession, message, group, sessionName)` | 把用户消息发给指定 Claude 会话并返回结果 |
| `bridgeRoute(chatId, userId, output, group, sourceName)` | 解析 @bridge:ask / @bridge:notify，跨会话转发 |
| `drainSessionQueue(chatId, sessionId, group)` | 递归执行排队任务 |
| `renderPreviewPage(chatId, userId, num, page, detail, platform, msgId)` | TG 会话预览分页 |
| `selectSessionByIndex(chatId, userId, idx, cached, group)` | TG 按钮选择会话 |
| `resolveTargetSession(chatId, targetName, group)` | 按名称找目标会话（DB → Agent 扫描） |
| callback_query handler | 处理 TG inline keyboard 按钮 (x:stop, y:ok, n:no, s:N, v:N:p 等) |

### Agent (agent/index.js) 核心 API

| 接口 | 功能 |
|------|------|
| `POST /api/run-claude` | 执行 Claude（stream=true 走 NDJSON，否则积累完一次性返回） |
| `POST /api/stop-claude` | taskkill Claude 进程 |
| `POST /api/discover` | 扫描 ~/.claude/projects/ 找所有项目 |
| `POST /api/list-sessions` | 列出项目下所有会话 |
| `POST /api/chronicle` | 写会话公开记录到 .bridge/sessions/@name.md |
| `POST /api/sync-chronicles` | 批量同步所有项目 JSONL → chronicle |
| `POST /api/bridge/ask` | 会话间通信（转发到 Gateway） |
| `GET /api/health` | 健康检查 |
| `GET /api/busy-sessions` | 查询正在执行的会话 |

### Gateway ↔ Agent 通信模式

- 所有请求：HTTP POST，JSON body，JSON response
- 超时：185s（被 TG webhook 超时约束）
- 流式：HTTP 长连接，NDJSON 逐行响应
- Agent 端 `runningProcs` Map 跟踪所有活跃 Claude 进程

## 请你回答的问题

### A. 传输协议 — 最关键的决定

NDJSON over HTTP 长连接，在当前约束下（Tailscale 直连、单 Agent、无中间件）是合适的选择吗？

替代方案的利弊：
- **SSE (Server-Sent Events)**：浏览器原生支持，但 Gateway 是 Node.js HTTP client，不是浏览器。SSE 和 NDJSON 本质差不多
- **WebSocket**：全双工、可发送 stdin 继续交互。但增加了连接管理复杂度（心跳、重连）。值得吗？
- **轮询**：Agent 写文件，Gateway 定时读。最简单但延迟高、文件 IO 重
- **分块 HTTP (Transfer-Encoding: chunked)**：单个 HTTP 响应分多块发送，但需要自定义分块格式

**请给出推荐方案并说明理由**（不是列优缺点，是选一个）。

### B. 分块策略

chunk 到了 Gateway 后，什么时候编辑 TG 消息？

- 按时间（每 N ms）？
- 按字符数（每 N 字符）？
- 按句子边界（检测 `。\n.!?` 等）？
- 组合策略？

### C. TG 呈现

TG 消息 4096 字符硬上限。Claude 一次输出可能 5000-10000 字符。如何呈现？
- 只显示末 3500？用户看不到开头
- 显示头部摘要 + 末 3500？
- 多消息拼接？
- 最终结果用 Telegraph/文件？

### D. 可靠性

1. HTTP 连接断开时，Agent 是否应该继续执行？执行完结果怎么返回？
2. TG 编辑失败（限流/消息被删）怎么处理？重试？放弃？
3. 用户按停止 → Gateway destroy HTTP → Agent kill Claude。这个链条所有环节都有竞态条件（比如 Agent 刚写完 done 准备 end 时连接被 destroy）。如何保证一致性？

### E. 权限交互

Claude 运行时可能弹出 `/permission` 提示。当前方案是检测到就终止流。有没有办法在流式过程中同时处理权限交互？

核心矛盾：TG 消息只能编辑，不能"附加按钮到正在编辑的消息"。而权限按钮（批准/拒绝）必须出现在消息上。

### F. 简化方案

如果完整流式太复杂，有没有"看起来像流式"的简化方案？比如：
- 不追求实时逐字刷新，改成"每 3 秒汇报一次当前进度"的伪流式
- 或者只流式输出"里程碑"（如"正在分析...""正在生成代码...""正在运行..."），最终结果一次性返回

---

**请给出清晰的架构方案。选型要有理由，拒绝要有替代。不要泛泛而谈"可以考虑 X 或 Y"，要给出明确的推荐。**
