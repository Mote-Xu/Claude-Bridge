# 架构评审

## 最终架构

```
企业微信 App → Bot API (webhook)
  → Node.js Gateway (mote-home, 127.0.0.1:8933)
    → HTTP → Windows Agent (100.80.205.79:9877)
      → claude --resume <sessionId>
```

Gateway 和 Agent 都不做 AI 推理。Claude Code 是唯一 AI 层。

## 四层模型

```
Git             = 事实层（唯一真相，代码状态）
共享 md 文件     = 黑板层（CLAUDE.md / TASK_BOARD.md / BRIDGE_LOG.md / REQUIREMENTS.md）
Bridge          = 协调层（@bridge:ask / @bridge:notify / 执行锁 / 公开履历）
Claude 会话      = 执行层（各司其职的 Worker）
```

## 关键决策

| 决策 | 理由 |
|------|------|
| Windows Agent + HTTP | 消灭 SSH 转义地狱。Agent 本地读写文件、调 child_process，Gateway 与 Agent 之间标准 HTTP JSON |
| 纯 HTTP，无 SSH | Windows sshd 已 stop + disabled。Agent 仅暴露 12 个 API，无远程 Shell 访问 |
| `echo msg \| claude --resume` + `CI=true` | Pipe 模式单向 stdin→stdout，与 VS Code 同一套 JSONL session store |
| `--resume` | 会话上下文通过 JSONL 持久化，跨消息续接 |
| Gateway 做执行锁 | Busy/Idle 状态机 + 消息排队，防止同一会话并发撞车 |
| 黑板模式 | 项目共享 md 文件是会话间唯一共享上下文，所有会话天然可读写 |
| 会话公开履历 | `.bridge/sessions/@name.md` 每次执行自动追加输入输出，集群内透明 |
| `/api/bridge/ask` 对称 API | 发起和回复走同一接口，每次独立调用，fire-and-die |
| 两层身份 | 机读层用 UUID（路由），人读层用 aiTitle（企微显示） |
| Tailscale 内网通信 | Gateway → Agent 走 Tailscale WireGuard，无需公网暴露 Windows |

## 已放弃的方向

| 方向 | 原因 |
|------|------|
| SSH 远程执行 | 多层转义（企微 XML → cmd → PowerShell → Claude），中文和引号频繁损坏 |
| PTY 持久进程 | 与 Claude TUI 冲突，且无法实现执行锁 |
| Base64 + PowerShell 写文件 | Agent 本地 `fs.writeFileSync` 彻底消灭编码问题 |
| Pipe 模式权限确认 | 检测不可靠（纯文本匹配）、重跑浪费 token、CI 模式下实际极少触发 |

## 已知问题与限制

1. 手机创建的会话在 VS Code 不可见（pipe 模式天生限制）
2. Claude Code `--resume` 是新 inference 而非 continuation，需上下文缝合
3. 会话默认彼此隔离（独立 JSONL），集群感知靠黑板文件 + 公开履历
