@echo off
REM Clawd Agent 启动脚本
REM 开机自启：此文件快捷方式放到 shell:startup（Win+R → shell:startup）

echo === Clawd Agent v1.5 ===
echo.

REM 尝试添加防火墙规则（可能失败，需管理员）
netsh advfirewall firewall show rule name="Clawd Agent" >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
  echo [!] Firewall rule not found. Run setup-firewall.bat as Administrator once.
  echo.
)

cd /d "%~dp0"
node index.js
pause
