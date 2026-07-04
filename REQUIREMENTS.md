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

- [ ] 手机新建会话在 VS Code 可见（pipe 模式天生限制，先电脑创建再手机续接可规避）

## v2 候选

- [ ] 会话间通信（Claude 会话通过 Bridge 互发消息，企微变消息总线）
- [ ] 定时推送（日报/服务器健康）
- [ ] 流式输出
- [ ] 企业微信异步客服消息推送
- [ ] WOL 远程开机
- [ ] Web Dashboard
- [ ] Agent 鉴权（X-Auth-Token，Tailscale 隔离下暂时可接受）
