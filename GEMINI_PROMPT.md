当前两个待解决问题：

## 问题 1：Pipe 模式下的权限确认

Claude Code pipe 模式（`echo msg | claude --resume` + `CI=true`）是单向的——消息 stdin 进，一次性 stdout 出，中间无交互通道。

VS Code 里遇到高权限操作会弹框让用户点确认。Pipe 模式没有这个通道，操作直接被拒。

已放弃的方向：`acceptEdits`、`bypassPermissions`——都不适合。

问：能否在不改变单向 pipe 模式的前提下，实现类似 VS Code 的权限确认机制？

## 问题 2：会话间双向通信

当前 `@bridge:notify` 是单向——A 通知 B，B 的结果返回用户。下一步需要 `@bridge:ask`——A 问 B，B 的回复回到 A 继续干活，用户只收到最终结果。

Gateway 已能拦截和转发，缺的是双向路由。有没有简洁的实现方案？
