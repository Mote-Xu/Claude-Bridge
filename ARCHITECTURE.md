# 架构评审 — 三方 AI 意见综合

> 综合 Claude Code（我）、Gemini、GPT 三家意见

---

## 架构演进

### 初始方案（已否决）
```
手机 → CF Tunnel → Caddy → OpenClaw Gateway → SSH → Claude Code
```
**问题**：过度分层、双 AI 竞争（OpenClaw + Claude Code）、OpenClaw 杀鸡用牛刀

### 最终方案
```
手机 Telegram → Bot API → Node.js Gateway (mote-home) → Task Queue (SQLite)
                                                          → Tailscale SSH + tmux
                                                            → Claude Code (本地 WSL2)
```

---

## 三方共识

| 议题 | Claude Code | Gemini | GPT | 结论 |
|------|:--:|:--:|:--:|------|
| 架构合理性 | ✅ | ✅ | ⚠️ 过度分层 | 去掉 OpenClaw，简化 |
| OpenClaw 必要性 | 默认要用 | ❌ 不必要 | ❌ 不必要 | **不用 OpenClaw** |
| Claude Code 定位 | 执行体 | 唯一智能体 | 唯一智能体 | **Claude Code 是唯一 AI** |
| Gateway 职责 | 路由 | 翻译官 | Message Broker | **纯路由，不做推理** |
| tmux 持久会话 | 未提及 | ✅ 关键 | ✅ 关键 | **必须加** |
| 任务队列 | 未提及 | 建议 WOL | ✅ 关键 | **必须加** |
| 命令注入风险 | 未提及 | ✅ 关键 | ✅ 关键 | **结构化协议** |
| 审计日志 | 未提及 | 未提及 | ✅ 关键 | **必须加** |
| Telegram 白名单 | 未提及 | ✅ chat_id | ✅ chat_id | **必须加** |
| GTX 1050 Ti | 可跑 7B | ❌ 不够 | ⚠️ 勉强可跑 7B | v2 再议，当前不用 |

---

## 意见分歧

| 议题 | Gemini | GPT | 我的判断 |
|------|--------|-----|----------|
| GTX 1050 Ti 7B 模型 | ❌ 不够，4GB 会 OOM | ⚠️ Q4/Q5 量化可跑 | GPT 更准确。Q4_K_M 7B ≈ 4-5GB，borderline 但可用 |
| Gateway 实现 | 建议 Node.js | 建议 Node.js | 一致，Node.js + grammY |
| 协议格式 | Shell 拼接（有限制） | JSON 结构化 | 采纳 GPT，JSON Schema 更安全 |

---

## 关键设计决策

### 为什么不用 OpenClaw？
1. 我们这个场景本质是**远程 CLI 控制器**，不是 AI Agent
2. OpenClaw 是 Agent 框架（40K+ 代码），我们只需要 ~500 行
3. OpenClaw 自带 AI 推理能力（DeepSeek），会和 Claude Code 形成双智能体竞争
4. 交互式 CLI (Claude Code) 的流式输出，OpenClaw Skill 机制不擅长处理

### 什么时候该用 OpenClaw？
- 需要多渠道统一接入（Telegram + 微信 + QQ + Discord…）
- 需要 Skills 生态（社区现成能力）
- Agent 需要自己做决策、自主执行多步任务
- 需要 Memory/SOUL 等持久化人格

### 为什么选 Telegram Bot 而非 CF Tunnel 暴露端口？
- Telegram Bot 是**出站连接**，Gateway 无需监听公网端口
- 天然隔离：只有拿到 Bot Token + 在 chat_id 白名单的人才能发指令
- 不需要 Caddy 反代、不需要新增域名路由

### 为什么用 tmux 而不是直接 SSH？
- Claude Code 是交互式 CLI，需要持续的标准输入输出
- `ssh ... "claude -p 'xxx'"` 每次都是新会话，丢失上下文
- tmux 提供持久化 session，可以在任何时候 attach/send-keys/capture-pane

---

## 技术选型对照

| 组件 | 初始方案 | 最终方案 |
|------|----------|----------|
| AI 框架 | OpenClaw | ❌ 不用 |
| Gateway | OpenClaw Gateway | Node.js (grammY) ~300 行 |
| 任务队列 | ❌ 无 | better-sqlite3 |
| 消息渠道 | Telegram + 企业微信 | 仅 Telegram（v1） |
| 会话保持 | ❌ 无 | tmux (WSL2) |
| 命令协议 | 自然语言 | JSON Schema |
| 安全 | CF Tunnel + Tailscale | chat_id 白名单 + SSH 脚本限制 + JSON 协议 |
| 审计 | ❌ 无 | SQLite 全量日志 |

---

## 参考

- Gemini 评审：反对 OpenClaw，建议 tmux + 简单 Bot，认为 GTX 1050 Ti 不够跑 LLM
- GPT 评审：反对 OpenClaw，强调结构化协议和任务队列，认为 1050 Ti 可跑小模型
- 我的评审：初始方案默认用了 OpenClaw，经两方纠正后同意简化
