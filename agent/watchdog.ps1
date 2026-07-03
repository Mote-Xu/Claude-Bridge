# Clawd Agent 看门狗 — 完全静默
$agentPort = 9877
try {
    $null = Invoke-WebRequest -Uri "http://127.0.0.1:$agentPort/api/health" -UseBasicParsing -TimeoutSec 5
} catch {
    Start-Process -FilePath node -ArgumentList "e:\Desktop\Claude-Bridge\agent\index.js" -WindowStyle Hidden -NoNewWindow
}
