# 需求文档

---

## v1 已完成

- [x] 企业微信消息接收/回复
- [x] SSH 远程执行 Claude Code
- [x] @会话名 创建/续接会话
- [x] 电脑历史会话列表
- [x] 多会话路由
- [x] 退出项目 / 重新接入
- [x] 离线检测 + 任务排队
- [x] 中文编码正常
- [x] 项目自动发现（Agent 本地 fs 扫描 + SSH PowerShell EncodedCommand 双通道）
- [x] Windows Agent HTTP 服务（替代 SSH 主通道）
- [x] 群聊模型：一个群 = 一个项目
- [x] 切换项目命令
- [x] Session lock 防护（taskkill 杀残留 Claude 进程）
- [x] CI=true 环境变量（尝试改善 VS Code 会话可见性）

## v1 待验证

- [ ] 手机新建会话在 VS Code 可见（已设 CI=true + CLAUDE_NO_TUI=1，待实际测试）

## v2 候选

- [ ] 定时推送（日报/服务器健康）
- [ ] 企业微信异步客服消息推送（避免 5 秒超时边缘情况）
- [ ] 群聊多项目并行（一个群绑定多个项目？）
- [ ] WOL 远程开机
- [ ] Web Dashboard
- [ ] Agent 开机自启一键配置脚本
- [ ] Agent 鉴权（X-Auth-Token）
