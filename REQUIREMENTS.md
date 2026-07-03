# 需求文档

---

## v1.5 已完成

- [x] 企业微信消息接收/回复
- [x] SSH 远程执行 Claude Code（全部走 PowerShell EncodedCommand）
- [x] @会话名 创建/续接会话
- [x] 电脑历史会话列表（含 aiTitle 标题）
- [x] 多会话路由（@指定、序号选择、唯一活跃自动路由）
- [x] 退出项目 / 切换项目 / 重新接入
- [x] 离线检测 + 任务排队 + 定时 drain
- [x] 中文编码正常
- [x] 项目自动发现（Agent 本地 fs + SSH PS EncodedCommand 双通道，按最近活跃排序）
- [x] Windows Agent HTTP 服务（替代 SSH 主通道，开机自启 + 看门狗守护）
- [x] 群聊模型：一个群 = 一个项目，群内 @Bot 发消息
- [x] 切换项目命令
- [x] 项目列表（60 秒序号窗口 + 项目名输入）
- [x] Session lock 防护（手机消息触发关 VS Code 窗口，回来自动恢复）
- [x] CI=true + CLAUDE_NO_TUI=1 环境变量
- [x] 已删除会话自动隐藏（读 VS Code state.vscdb 的 hiddenSessionIds）
- [x] 手动隐藏/取消隐藏会话命令
- [x] 会话预览（话题消息 + 最近几轮对话 + 统计）
- [x] Agent 后台静默运行 + Windows Task Scheduler 看门狗
- [x] Agent `/api/reload` 热重载

## v1 待验证 / 已知限制

- [ ] 手机新建会话在 VS Code 可见（pipe 模式天生限制，电脑先创建然后手机续接可规避）
- [ ] Windows OpenSSH `command=` 限制与 EncodedCommand 不兼容（SSH fallback 保持完整权限）

## v2 候选

- [ ] 定时推送（日报/服务器健康）
- [ ] 流式输出（Claude 结果逐步推送到微信）
- [ ] 企业微信异步客服消息推送
- [ ] 群聊多项目并行（一个群绑定多个项目？）
- [ ] WOL 远程开机
- [ ] Web Dashboard
- [ ] Agent 鉴权（X-Auth-Token，Tailscale 隔离下暂时可接受）
