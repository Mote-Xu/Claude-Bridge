@echo off
REM Clawd Agent 启动脚本
REM 放到 shell:startup 文件夹即可开机自启
cd /d "%~dp0"
node index.js
pause
