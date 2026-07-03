@echo off
REM 恢复被手机打断的 Claude Code 会话
REM 回来坐到电脑前后双击此文件

set RECOVERY=%USERPROFILE%\.claude\phone-recovery.json

if not exist "%RECOVERY%" (
  echo 没有需要恢复的会话。
  pause
  exit /b
)

echo === 以下会话被手机操作打断，选择恢复： ===
echo.

setlocal enabledelayedexpansion
set IDX=0
for /f "tokens=*" %%A in ('powershell -NoProfile -Command "(Get-Content '%RECOVERY%' -Encoding UTF8 | ConvertFrom-Json).Count"') do set TOTAL=%%A

powershell -NoProfile -Command "$sessions = Get-Content '%RECOVERY%' -Encoding UTF8 | ConvertFrom-Json; for ($i=0; $i -lt $sessions.Count; $i++) { Write-Host ('  ' + ($i+1) + '. [' + $sessions[$i].cwd.split('\')[-1] + '] ' + $sessions[$i].name + '  (' + $sessions[$i].id.Substring(0,8) + '...)') }"

echo.
set /p CHOICE="输入序号恢复 (1-%TOTAL%)，或 q 退出: "

if /i "%CHOICE%"=="q" exit /b

REM 从 JSON 提取选中的 session ID 并调 claude --resume
for /f "usebackq tokens=*" %%S in (`powershell -NoProfile -Command "$s = Get-Content '%RECOVERY%' -Encoding UTF8 | ConvertFrom-Json; $idx = %CHOICE% - 1; if ($idx -ge 0 -and $idx -lt $s.Count) { Write-Output $s[$idx].id }"`) do set SID=%%S

if "%SID%"=="" (
  echo 无效的序号
  pause
  exit /b
)

echo.
echo 正在恢复会话 %SID% ...
start "Claude Code" cmd /c "C:\Users\Mote\AppData\Roaming\npm\claude.cmd --resume %SID%"
echo 已在新窗口启动。关闭此窗口。

REM 恢复后删除 recovery 文件
del "%RECOVERY%" 2>nul
pause
