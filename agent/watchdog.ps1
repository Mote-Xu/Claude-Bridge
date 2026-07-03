# Clawd Agent 看门狗 — 每 5 分钟检查，挂了自启
$agentPort = 9877
try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$agentPort/api/health" -UseBasicParsing -TimeoutSec 5
    # Agent 正常，不做任何事
} catch {
    # Agent 挂了，重新启动
    $agentDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    if (-not $agentDir) { $agentDir = "e:\Desktop\Run_OpenClaw\agent" }
    Start-Process -FilePath node -ArgumentList "$agentDir\index.js" -WindowStyle Hidden
    Write-EventLog -LogName Application -Source "ClawdAgent" -EntryType Warning -EventId 1 -Message "Agent restarted by watchdog" -ErrorAction SilentlyContinue
}
