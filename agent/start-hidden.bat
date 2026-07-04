@echo off
REM 后台静默启动 Claude-Bridge Agent（无窗口）
cd /d "%~dp0"
start "" /B node index.js
echo Claude-Bridge Agent 已在后台启动 (http://0.0.0.0:9877)
