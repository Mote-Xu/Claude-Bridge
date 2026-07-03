# 收紧 SSH：限制 mote-home 公钥只能执行 EncodedCommand
# 需管理员权限运行

$authFile = "$env:ProgramData\ssh\administrators_authorized_keys"
$backupFile = "$env:ProgramData\ssh\administrators_authorized_keys.bak"

if (-not (Test-Path $authFile)) {
    Write-Host "ERROR: $authFile not found"
    exit 1
}

$content = Get-Content $authFile -Raw -Encoding UTF8

# 查找 mote-home 的公钥行
$lines = $content -split "`r`n|`n"
$newLines = @()
$changed = $false

foreach ($line in $lines) {
    if ($line -match "mote-home" -and $line -notmatch "^command=") {
        # 加命令限制
        $prefix = 'command="powershell -NoProfile -NonInteractive -EncodedCommand ${SSH_ORIGINAL_COMMAND}",no-port-forwarding,no-agent-forwarding,no-pty '
        $newLines += $prefix + $line.Trim()
        $changed = $true
        Write-Host "Locked: mote-home key"
    } elseif ($line -match "mote-home" -and $line -match "^command=") {
        Write-Host "Already locked: mote-home key"
        $newLines += $line
    } else {
        $newLines += $line
    }
}

if ($changed) {
    # 备份
    Copy-Item $authFile $backupFile -Force
    Write-Host "Backup: $backupFile"

    # 写入
    $newContent = $newLines -join "`r`n"
    [IO.File]::WriteAllText($authFile, $newContent, [Text.Encoding]::UTF8)

    # 修复权限（必须只有 SYSTEM 和 Administrators 可读）
    icacls $authFile /inheritance:r /grant "SYSTEM:(R)" /grant "BUILTIN\Administrators:(R)" 2>&1 | Out-Null

    Write-Host "Done. SSH fallback now restricted to EncodedCommand only."
    Write-Host "Backup saved to: $backupFile"
} else {
    Write-Host "No changes needed."
}
