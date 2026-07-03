@echo off
REM 后台静默启动 Clawd Agent（无窗口）
cd /d "%~dp0"
start "" /B node index.js
echo Clawd Agent 已在后台启动 (http://0.0.0.0:9877)
