@echo off
REM 右键 → 以管理员身份运行
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0lock-ssh.ps1"
pause
