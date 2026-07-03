# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## 项目定位

Claude Bridge — 手机（企业微信）是电脑前 Claude Code 的"第二屏幕"。

mote-home 运行 Gateway（24/7 Node.js），通过 Tailscale SSH 在你 Windows 电脑上执行 Claude Code。同一套 session store（`%USERPROFILE%\.claude\`），手机和电脑无缝双向同步。

---

## 架构

```
企业微信 App → Bot API (webhook)
  → Node.js Gateway (mote-home, 127.0.0.1:8933)
    → Tailscale SSH → Windows (100.80.205.79)
      → claude --resume <id>
```

---

## 部署位置

```
mote-home:
  /mnt/data/clawd/                    ← Gateway 代码 + SQLite DB
  /etc/systemd/system/clawd-gateway.service
  /etc/systemd/system/cloudflared-clawd.service  (隧道，未使用)

Caddy + CF Tunnel:
  claude-tunnel.mote-pal.xyz → Caddy :80 → Gateway :8933
  (走主 Tunnel 87fc0324)

Windows (Mote-Office):
  OpenSSH Server (手动安装)
  Tailscale IP: 100.80.205.79
  Claude Code: C:\Users\Mote\AppData\Roaming\npm\claude.cmd
  SSH 免密: mote-home 公钥在 C:\ProgramData\ssh\administrators_authorized_keys
```

---

## 关键连接

| 目标 | 命令 |
|------|------|
| SSH mote-home | `ssh mote@100.118.10.0` |
| SSH Windows(Tailscale) | `ssh Mote@100.80.205.79` |
| Gateway 日志 | `ssh mote@100.118.10.0 'journalctl -u clawd-gateway -f'` |
| Gateway 重启 | `ssh mote@100.118.10.0 'sudo systemctl restart clawd-gateway'` |
| Gateway 健康 | `curl https://claude-tunnel.mote-pal.xyz/health` |

---

## 当前状态

### 已工作
- 企业微信消息接收/回复
- SSH 远程执行 Claude Code（管道 + base64 编码）
- `@会话名` 创建/续接会话
- `claude --resume` 跨消息续接（已验证可行）
- 电脑历史会话列表显示
- 多会话路由（@指定或唯一活跃自动路由）
- 退出项目 / 重新接入
- 电脑离线检测 + 任务排队

### 未完成
- **项目自动发现不稳定** — `getProjects()` 的 SSH findstr 命令有转义问题，当前回退到 config.js 手动维护
- 手机创建的新会话在 VS Code 不显示（pipe 模式创建的会话 VS Code 不认为是"活跃会话"）
- Claude Code PTY 持久进程不可行（TUI 交互太复杂）

### 核心限制
- `echo msg | claude` 创建的是"一次性查询"会话，VS Code 不显示但可用 `--resume` 续接
- 电脑上先用 VS Code 创建会话，手机 `--resume` 续接，上下文完全保留

---

## 技术选型

| 组件 | 选型 |
|------|------|
| Gateway | Node.js + Express + better-sqlite3 + ssh2 |
| 消息 | 企业微信自建应用 (AgentID 1000003) |
| 编码 | Base64 → PowerShell WriteAllBytes → cmd type pipe |
| 连接 | Tailscale SSH (WireGuard) |

---

## 约束

- Gateway 放 `/mnt/data/clawd/`，不放 `/home/mote/`
- 部署变更后提交 `/mnt/data/infra/` git 仓库（infra 配置）
- 本项目只做 Claude Bridge，不动 mote-home 其他服务
- Claude Code 是唯一 AI 层，Gateway 不推理
