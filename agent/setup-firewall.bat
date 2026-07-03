@echo off
REM 为 Clawd Agent 开放 Windows 防火墙端口 9877
REM 需要管理员权限运行

echo Adding firewall rule for Clawd Agent (port 9877)...
netsh advfirewall firewall add rule name="Clawd Agent" dir=in action=allow protocol=TCP localport=9877

if %ERRORLEVEL% EQU 0 (
  echo [OK] Firewall rule added successfully.
) else (
  echo [FAIL] Please run this script as Administrator.
)

pause
