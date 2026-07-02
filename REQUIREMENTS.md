# 需求文档

> 最终更新：2026-07-03，grill 后确认

---

## v1 核心功能

### F1. 历史会话无缝续接（P0）
- 手机直接续接电脑上已有的 Claude Code 会话
- 读 `~/.claude/projects/` 自动发现所有项目+会话
- `claude --resume` 恢复上下文，电脑上的对话不丢失
- 手机聊完回到电脑，`claude --continue` 包含手机上的内容

### F2. 多会话并行（P0）
- 多个 tmux session 同时跑，各自独立
- `/cc <项目>` 新建会话，`/cc <session>` 切换
- 后台 session 有输出主动推送通知（带 `[session]` 标签）

### F3. 交互式控制（P0）
- tmux send-keys 喂入消息（非 `claude -p` 一次性模式）
- `/stop` → tmux C-c 中断（上下文保留）
- 弹窗盲操：permissions 预配置 + tmux capture-pane 兜底

### F4. 流式输出（P0）
- Claude Code stdout/stderr → 管道文件 → Gateway tail → 企业微信逐块推送
- 非轮询，实时推送

### F5. 离线队列（P0）
- 笔记本关机/休眠 → 企业微信提示"💻 离线，任务已排队"
- Tailscale status + SSH timeout 双重检测
- 本地上线后自动 dequeue + 推送通知

### F6. 会话生命周期管理（P1）
- 首次发消息自动创建 tmux session
- `/cc done` 手动关闭
- idle 24h 自动提醒清理

---

## v1 不做

- 企业微信之外的其他渠道
- Claude API 费用面板
- WOL 远程开机
- GTX 1050 Ti 驱动 / Ollama

---

## v2 候选

- [ ] 企业微信消息卡片（按钮式 session 切换，不用打字）
- [ ] Claude API 费用统计 + 熔断告警
- [ ] WOL 远程开机
- [ ] Web Dashboard（任务历史、session 状态）
- [ ] mote-home Ollama 本地 fallback（Qwen2.5-3B）
