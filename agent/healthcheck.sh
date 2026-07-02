#!/bin/bash
# clawd healthcheck.sh — 检测本地机器是否在线并可用
# 由 mote-home Gateway 调用

# 1. Tailscale 在线检查
if command -v tailscale &>/dev/null; then
  tailscale status &>/dev/null || {
    echo "OFFLINE tailscale_not_running"
    exit 1
  }
fi

# 2. tmux socket 存在检查
if [ -S /tmp/clawd-tmux ]; then
  echo "ONLINE tmux_ready"
else
  echo "ONLINE tmux_not_initialized"
fi

# 3. Claude Code 可用性
if command -v claude &>/dev/null; then
  echo "CLAUDE available"
else
  echo "CLAUDE not_found"
fi

exit 0
