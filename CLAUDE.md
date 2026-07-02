# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## 项目定位

手机（企业微信）是电脑前 Claude Code 的"第二屏幕"。同一套 session store（`%APPDATA%\claude\`），手机和电脑无缝双向同步。

本质是一层转发：企业微信消息 → mote-home → SSH Windows → `claude --resume` → 输出原样返回。

---

## 架构

```
企业微信 App
  → Bot API (webhook)
    → Node.js Gateway (mote-home, 24/7)
      → Tailscale SSH → Windows (100.80.205.79)
        → claude --resume <id>
```

Gateway 不做 AI 推理。Claude Code 是唯一智能层。

---

## 用户体验

- 企业微信群 = 项目文件夹
- 群内 @会话名 = 该项目的某个 Claude Code 会话
- 会话名 = 第一次说的话
- 所有会话来自 `%APPDATA%\claude\projects\`，自动发现
- 回到电脑 `claude --continue` → 手机上的对话全在里面

---

## 技术栈

| 组件 | 选型 |
|------|------|
| 消息 | 企业微信 Bot API |
| Gateway | Node.js + Express + better-sqlite3 |
| 连接 | Tailscale SSH |
| 执行 | Windows OpenSSH Server + Claude Code CLI |

---

## 部署位置

```
mote-home:  /mnt/data/clawd/
本地:       E:\Desktop\Run_OpenClaw\（本仓库）
```

---

## 关键连接

| 目标 | 方式 |
|------|------|
| SSH mote-home | `ssh mote@100.118.10.0` |
| mote-home SSH Windows | `ssh mote@100.80.205.79` (Tailscale) |
| mote-home 配置 | `~/infra/` → `/mnt/data/infra/` |

---

## 约束

- Gateway 不放 `/home/mote/`，放 `/mnt/data/clawd/`
- Claude Code 是唯一 AI 层，Gateway 不推理
- 部署变更同步更新文档
- 只做 Claude Bridge，不动 mote-home 其他服务
