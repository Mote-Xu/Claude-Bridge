# OpenClaw × mote-home — 项目完整总结

> 请阅读以下项目描述，然后给出你的建议：架构是否合理、有没有更好的方案、发现了什么我没有考虑到的风险或机会。

---

## 我想做什么

**用手机远程管理我本地电脑上的所有 Claude Code 会话。** 就像坐在电脑前用 VS Code 一样，但在手机上通过 Telegram 发消息就能完成。

## 当前情况

我有一台 **24/7 在线的小服务器**（mote-home）和一台 **主力开发笔记本**（Mote-Office）。

### 服务器 mote-home
- Ubuntu 24.04, i5-6500 4C4T, 7.7GB RAM
- GTX 1050 Ti 4GB（但目前是 nouveau 开源驱动，CUDA 不可用）
- /mnt/data 有 108GB 空闲
- 已配置：Caddy 反代 + Cloudflare Tunnel（有公网域名 mote-pal.xyz）
- 已配置：Tailscale（设备间组网）
- 已配置：UFW 防火墙
- **没有 Node.js**（需要装）
- 已运行的服务：amechan-daily (Flask :8930), MemeticChaos (:8931), finance-flask (:5000), Docker (homepage/uptime-kuma/adguard), Cockpit

### 本地 Mote-Office
- Windows 11 Pro, i5-13500H 16 线程, 16GB RAM, RTX 3050 4GB
- Node.js v20.15.1（需升级到 22+）
- 已安装：Claude Code CLI, Docker Desktop
- E:\Desktop\ 下有多个项目：Stardust_Chat, Mobile_Dev, Deepseek_V4_API, Note 等
- 不是 24/7 开机，随用随开

## 我的方案

```
手机 Telegram
  → Cloudflare Tunnel (TLS)
    → Caddy
      → OpenClaw Gateway :18789 (mote-home, 仅 localhost)
        → Tailscale SSH
          → 本地 Claude Code 执行命令
```

- **AI 模型**：DeepSeek V4-Pro API（便宜，中文好，我已有关联 API key）
- **Gateway**：OpenClaw 跑在 mote-home 上，24/7 常驻
- **消息渠道**：Telegram Bot + 企业微信
- **核心机制**：定义一个 `/cc` 命令的 Skill，收到消息后 SSH 到本地执行 Claude Code

## 关键问题

1. **架构是否合理？** Gateway 放在 mote-home 而不是本地，靠 Tailscale SSH 桥接执行——会有延迟问题吗？
2. **OpenClaw 跟 Claude Code 的关系？** OpenClaw 本身也是 AI Agent，Claude Code 也是。我不想让 OpenClaw 自己在 mote-home 上写代码，我只想让它把命令转发给我本地的 Claude Code。这个"转发"模式合理吗？还是 OpenClaw 应该直接用 DeepSeek 模型写代码、不经过 Claude Code？
3. **本地离线处理？** 笔记本关机时怎么优雅降级？
4. **安全性？** Gateway 绑 loopback + CF Tunnel + Tailscale 三层够不够？还有什么我没考虑到的？
5. **有没有更好的方案？** 也许根本不需要 OpenClaw？用 Telegram Bot + 简单的 Node.js 服务直接 SSH 会不会更简单？
6. **GTX 1050 Ti 值得装驱动吗？** 4GB 显存能跑什么本地模型？跑 Ollama 7B 量化模型够不够？
7. **你有什么额外的建议？** 有没有我应该做但还没想到的事情？

## 参考

- OpenClaw: https://github.com/openclaw/openclaw（MIT 开源，347K+ stars）
- 我的 CLAUDE.md: 见同目录下 CLAUDE.md
- 需求文档: 见同目录下 REQUIREMENTS.md
