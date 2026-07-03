@echo off
REM 安装 Clawd Agent 看门狗计划任务（需管理员权限）
set SCRIPT=%~dp0watchdog.ps1

schtasks /create /tn "ClawdAgent-Watchdog" /tr "powershell -NoProfile -ExecutionPolicy Bypass -File \"%SCRIPT%\"" /sc minute /mo 5 /ru "Mote" /f

if %ERRORLEVEL% EQU 0 (
  echo [OK] Watchdog installed — runs every 5 minutes
) else (
  echo [FAIL] Run as Administrator or check permissions
)
pause
