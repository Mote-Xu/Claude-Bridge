#!/bin/bash
# clawd session.sh — tmux + Claude Code 会话管理
# 由 mote-home Gateway 通过 SSH 调用
#
# 用法:
#   session.sh create <slug> <project-path> [claude-session-id]
#   session.sh resume <slug> <project-path> <claude-session-id>
#   session.sh send  <slug> <message>
#   session.sh stop  <slug>
#   session.sh kill  <slug>
#   session.sh list
#   session.sh pane  <slug> [lines]

set -e

TMUX_SOCKET="/tmp/clawd-tmux"
PIPE_DIR="/tmp/clawd"

mkdir -p "$PIPE_DIR"

cmd="$1"
slug="$2"
shift 2 || true

case "$cmd" in
  create|resume)
    project_path="$1"
    claude_session_id="$2"

    # 确保项目路径存在
    if [ ! -d "$project_path" ]; then
      echo "ERROR: project path not found: $project_path"
      exit 1
    fi

    pipe_file="$PIPE_DIR/${slug}.log"
    touch "$pipe_file"

    # 创建 tmux session
    tmux -S "$TMUX_SOCKET" new-session -d -s "$slug" 2>/dev/null || true
    tmux -S "$TMUX_SOCKET" send-keys -t "$slug" "cd '$project_path' && clear" Enter

    # 启动 Claude Code
    if [ -n "$claude_session_id" ]; then
      tmux -S "$TMUX_SOCKET" send-keys -t "$slug" \
        "claude --resume '$claude_session_id' 2>&1 | tee -a '$pipe_file'" Enter
    else
      tmux -S "$TMUX_SOCKET" send-keys -t "$slug" \
        "claude 2>&1 | tee -a '$pipe_file'" Enter
    fi

    echo "OK tmux=${slug} pipe=${pipe_file}"
    ;;

  send)
    message="$*"
    # 转义特殊字符
    escaped=$(printf '%s' "$message" | sed "s/'/'\\\\''/g")
    tmux -S "$TMUX_SOCKET" send-keys -t "$slug" "$escaped" Enter
    echo "OK"
    ;;

  stop)
    tmux -S "$TMUX_SOCKET" send-keys -t "$slug" C-c
    echo "OK"
    ;;

  kill)
    tmux -S "$TMUX_SOCKET" send-keys -t "$slug" C-d 2>/dev/null || true
    sleep 1
    tmux -S "$TMUX_SOCKET" kill-session -t "$slug" 2>/dev/null || true
    rm -f "$PIPE_DIR/${slug}.log"
    echo "OK"
    ;;

  list)
    tmux -S "$TMUX_SOCKET" list-sessions -F "#{session_name} #{?session_attached,A,} #I" 2>/dev/null || echo "NONE"
    ;;

  pane)
    lines="${1:-30}"
    tmux -S "$TMUX_SOCKET" capture-pane -t "$slug" -p -S "-${lines}" 2>/dev/null || echo "NONE"
    ;;

  tail-pipe)
    pipe_file="$PIPE_DIR/${slug}.log"
    touch "$pipe_file"
    tail -f -n 0 "$pipe_file"
    ;;

  *)
    echo "Usage: session.sh {create|resume|send|stop|kill|list|pane|tail-pipe} ..."
    exit 1
    ;;
esac
