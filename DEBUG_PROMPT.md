我正在修 Claude-Bridge 的 TG 通道，但遇到了一个卡了很久的问题。

## 背景

TG 基本消息通道原本是工作的。之前一个会话尝试加「流式输出」功能，结果把整个 TG 通道搞坏了。之后又尝试修 `trackKeyboardMsg` 作用域问题，也没修好。

Git 历史：
```
44b6920 fix: trackKeyboardMsg 作用域错误 — 提取为模块级函数   ← 修坏的
27dd8aa feat: TG 流式输出 — Claude 实时结果逐段刷新到 Telegram ← 加流式的
48e575b fix: VBS 切换到 Node 24 (v24.15.0)
3f3b401 fix: revert VBS to original Node.js path
4412097 fix: TG 权限检测增强 + Bridge 体验修复
3ad765d feat: TG 权限交互 — spawn stdin 保持 + y:ok/n:no 按钮
5cd7db9 fix: TG editMessageText 默认清除 Inline Keyboard
988c918 feat: Telegram Bot 双通道支持 + stdin 直连 + /api/stop-claude  ← 最早 TG 提交
```

用户说稳定版本的特征是：「中断且保留中断前生成的输出」是工作的（即 kill Claude 进程后，stdout 缓冲区里已有的输出能正确返回给 TG）。

## 当前症状

`/projects` → 项目列表能正常发送（带 inline keyboard）。但用户点击项目按钮（`p:N`）后，**TG 上没有任何输出**。

Gateway 日志显示：
```
[KBD] Tracked msg XXX ← /projects 的键盘记录了
[KBD] Clearing 1 keyboards for chat XXX: [XXX]  ← p:N 回调触发
TG webhook error: Request failed with status code 400  ← 关键错误
[KBD] Failed to clear msg XXX: Request failed with status code 400
```

## 已尝试

1. 已把 gateway/index.js, agent/index.js, gateway/agent.js, gateway/telegram.js 全部 revert 到 `988c918`（最早 TG 提交）。checksum 与 git 一致。
2. 已重启 Gateway（systemctl）和 Agent（/api/reload，VBS 自动拉起）。
3. 已验证 Agent 健康（/api/health OK，/api/list-sessions 正常返回 21 个会话）。
4. 已验证 TG Bot Token 正确，webhook 正常（getWebhookInfo 返回 ok）。
5. 手动 curl sendMessage 到同一 chat ID 成功（含 HTML parse_mode + inline keyboard）。
6. 在 telegram.js 的 apiCall 里加了详细错误日志，但 **[TG:API] log 从未出现**——说明 apiCall 根本没被调到，或者错误发生在 apiCall 之外。

## 请帮我

1. 回忆一下 `988c918` 这个版本 TG 通道是否完整工作过？选项目→显示会话列表这个流程走通了吗？
2. 网关和 Agent 之间还有什么我没有 revert 到的文件或配置吗？
3. 有没有可能是 mote-home 上 Node.js 版本、npm 包、或 .env 配置导致的？
4. 当前的 gateway/index.js 在 p:N handler 里加了 `[DBG:pN]` 前缀的调试 log，如果 log 都没出现，说明 handleMessage 根本没进入 p:N 分支——那可能是上游的 `platform === 'telegram'` 判断或 `cached?.projects` 有问题。
