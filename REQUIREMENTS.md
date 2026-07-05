# 需求文档

---

## v1.5 已完成

- [x] 企业微信消息接收/回复
- [x] @会话名 创建/续接会话
- [x] 电脑历史会话列表（含 Claude Code aiTitle 标题）
- [x] 多会话路由（@指定、序号选择、唯一活跃自动路由）
- [x] 退出项目 / 切换项目 / 重新接入
- [x] 离线检测 + 任务排队 + 定时 drain
- [x] 中文编码正常
- [x] 项目自动发现（Agent 本地 fs 扫描，按最近活跃排序）
- [x] Windows Agent HTTP 服务（纯 HTTP 架构，无 SSH 依赖）
- [x] Agent 开机自启 + 后台静默运行 + VBS 守护循环（崩溃 5 秒自愈）
- [x] Agent `/api/reload` 热重载
- [x] 项目列表（60 秒序号窗口 + 项目名输入）
- [x] 切换项目命令
- [x] Session lock 防护（taskkill 关 VS Code 窗口，回来自动恢复）
- [x] CI=true + CLAUDE_NO_TUI=1 环境变量
- [x] 已删除会话自动隐藏（读 VS Code state.vscdb 的 hiddenSessionIds，零依赖）
- [x] 手动隐藏/取消隐藏会话命令
- [x] 会话预览（话题消息 + 最近几轮对话 + 统计）
- [x] SSH 服务已关闭（Windows sshd stopped + disabled，mote-home 公钥已删除）
- [x] 项目重命名 → 会话迁移（批量改 JSONL cwd + 移动目录）
- [x] list-sessions 不限行数扫描（修复大文件会话漏显 bug）
- [x] Clawd → Claude-Bridge 全量重命名（代码、systemd unit、目录、DB）
- [x] 看门狗精简（删除 Task Scheduler + watchdog.vbs，只留 VBS 自守护）

## v1 已知限制

- [x] Bridge 访问过的会话在 VS Code 可见（Agent 自动写索引条目）
- [x] pipe/VS Code 双格式兼容（`getMessageText` 统一处理）

## v1.6 已完成（2026-07-05）

- [x] `@bridge:notify` — 会话间通信 MVP（Gateway 拦截 + 转发）
- [x] 精准 session close（替代 taskkill 全杀）
- [x] Session 索引自动注册（每次必写，唯一文件名，aiTitle 命名）
- [x] `upsertSession` — 防重复 DB 条目
- [x] `getMessageText()` — pipe/VS Code 双格式兼容
- [x] list-sessions 不限行数 + session-preview 双格式
- [x] Clawd → Claude-Bridge 全量重命名（代码/server/systemd/DB）
- [x] TASK_BOARD.md 集群协作机制

## ⚠️ 已知陷阱（2026-07-05）

1. pipe 模式 `content` 是字符串，VS Code 是数组 —— 必须用 `getMessageText()`
2. DB 更新后 JS 变量不自动刷新 —— 必须重新查询
3. 先看数据再看代码 —— 查 JSONL/DB 比猜代码逻辑快

## v1.7 进行中（2026-07-05）

- [ ] ~~Pipe 模式权限确认~~（⏸️ 暂缓）
- [ ] 🔴 **会话执行锁**（前置条件）— Gateway Busy/Idle 状态机 + 消息排队 + 企微排队通知
- [ ] `@bridge:ask` / `@bridge:reply` — 双向 RPC + 上下文缝合（ASYNC EVENT 帧）+ 环形依赖检测
- [ ] 企微群实时状态推送 — `🔗 A→B` / `👤 处理中` / `✅ 完成`
- [ ] `BRIDGE_LOG.md` 双层结构 — CLUSTER_SNAPSHOT（覆盖写入）+ RECENT_LOGS（滚动 15 条）
- [ ] 会话启动按需感知 — Level 0 默认（CLAUDE.md+TASK_BOARD）→ Level 1 按需（BRIDGE_LOG）
- [ ] CLAUDE.md 结构化分区 — 架构区只读 / 决策区追加

## v2 候选（集群协作）

- [ ] TASK_BOARD.md 状态机 — status / owner / lease_expire / scope 字段
- [ ] Agent CAS 原子认领 API — 同时只有一个会话能认领任务
- [ ] `@bridge:broadcast` — 广播通知（如"接口已变更"）
- [ ] Feature branch 自动切 — 认领任务 → `git checkout -b feature/xxx`
- [ ] 任务 lease 租约 — 过期自动释放，防止会话 crash 永久占用

## v3 候选（角色分工 + 事件驱动）

- [ ] PM/Dev/QA 角色会话
- [ ] Reviewer 验收流程（2PC：Worker 提交 → Reviewer 合入）
- [ ] `@bridge:barrier` — 等待多个会话完成再继续
- [ ] 事件总线 — task_completed / code_merged 事件驱动
- [ ] Task Auction — 会话竞标任务（bid confidence）
- [ ] 定时推送（日报/服务器健康）
- [ ] 流式输出
- [ ] Web Dashboard
- [ ] WOL 远程开机
- [ ] Agent 鉴权
