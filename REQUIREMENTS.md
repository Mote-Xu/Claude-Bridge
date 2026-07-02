# 需求文档

---

## v1 功能

### F1. 历史会话无缝续接
- 读 `%APPDATA%\claude\projects\` 自动发现所有项目和会话
- `claude --resume` 恢复上下文
- 手机聊完回到电脑 `claude --continue` 包含手机内容

### F2. 多会话并行
- 群 = 项目，@会话名 = 指定会话
- 所有会话并行，互不干扰

### F3. 流式输出
- SSH stdin/stdout 管道实时推送

### F4. 离线处理
- Tailscale 状态检测 → 离线入 SQLite 队列 → 上线恢复

---

## v1 不做
- 多消息渠道（仅企业微信）
- Claude API 费用监控
- 定时任务
