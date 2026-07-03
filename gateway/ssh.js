// SSH Fallback — 所有命令走 PowerShell EncodedCommand
// 配合 Windows authorized_keys 命令限制：仅允许 EncodedCommand 执行
const { Client } = require('ssh2');
const fs = require('fs');
const config = require('./config');

function sshExec(cmd, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const { host, username, privateKey } = config.ssh || config.local;
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { conn.end(); reject(new Error('SSH timeout')); }, timeout);
    conn.on('ready', () => {
      conn.exec(cmd, { pty: false }, (err, stream) => {
        if (err) { clearTimeout(timer); conn.end(); return reject(err); }
        stream.on('data', (d) => stdout += d.toString());
        stream.stderr.on('data', (d) => stderr += d.toString());
        stream.on('close', (code) => { clearTimeout(timer); conn.end(); resolve({ stdout, stderr, code }); });
      });
    });
    conn.on('error', (err) => { clearTimeout(timer); reject(err); });
    conn.connect({ host, port: 22, username, privateKey: fs.readFileSync(privateKey), readyTimeout: 10000 });
  });
}

// 执行 PowerShell 脚本（自动 EncodedCommand 封装）
function psExec(script, timeout = 30000) {
  const enc = Buffer.from(script, 'utf16le').toString('base64');
  return sshExec(`powershell -NoProfile -NonInteractive -EncodedCommand ${enc}`, timeout);
}

// 执行 Claude Code
async function execClaude(sessionId, message, options = {}) {
  const claudeBin = 'C:\\Users\\Mote\\AppData\\Roaming\\npm\\claude.cmd';
  const msgFile = 'C:\\Users\\Mote\\AppData\\Local\\Temp\\clawd-msg.txt';

  // Step 1: 写消息文件
  const msgB64 = Buffer.from(message, 'utf-8').toString('base64');
  await psExec(`$f='${msgFile}'; [IO.File]::WriteAllBytes($f,[Convert]::FromBase64String('${msgB64}'))`, 10000);

  // Step 2: 杀所有 node 进程，防止 session lock
  if (sessionId) {
    try {
      await psExec(`Get-CimInstance Win32_Process -Filter "name='node.exe'" -EA 0 | Stop-Process -Force -EA 0`, 5000);
    } catch {}
  }

  // Step 3: pipe 消息到 Claude
  const cdFlag = options.cwd ? `Set-Location '${options.cwd}'; ` : '';
  const resumeFlag = sessionId ? ` --resume '${sessionId}'` : '';
  return await psExec(`${cdFlag}\$env:CI='true'; \$env:CLAUDE_NO_TUI='1'; Get-Content '${msgFile}' | & '${claudeBin}'${resumeFlag}`, 180000);
}

async function healthCheck() {
  try { await psExec('Write-Output ok', 5000); return true; } catch { return false; }
}

// 自动发现项目
async function getProjects() {
  try {
    const script = `[Console]::OutputEncoding = [Text.Encoding]::UTF8
\$baseDir = 'C:\\Users\\Mote\\.claude\\projects'
if (Test-Path \$baseDir) {
    Get-ChildItem \$baseDir -Directory | ForEach-Object {
        \$jsonls = @(Get-ChildItem \$_.FullName -Filter *.jsonl -EA 0)
        \$found = \$false
        foreach (\$jsonl in \$jsonls) {
            if (-not \$found) {
                \$lines = Get-Content \$jsonl.FullName -TotalCount 20 -EA 0
                foreach (\$line in \$lines) {
                    if (-not \$found -and (\$line -match '"cwd"\\s*:\\s*"([^"]+)"')) {
                        \$cwd = \$Matches[1] -replace '\\\\+', '\\'
                        \$name = Split-Path \$cwd -Leaf
                        Write-Output ('PROJECT_MAP:' + \$name + '===>' + \$cwd)
                        \$found = \$true
                    }
                }
            }
        }
    }
}`;
    const res = await psExec(script, 15000);
    const projects = {};
    res.stdout.trim().split(/\r?\n/).filter(Boolean).forEach(line => {
      if (line.startsWith('PROJECT_MAP:')) {
        const kv = line.slice('PROJECT_MAP:'.length);
        const sep = kv.indexOf('===>');
        if (sep > 0) {
          const name = kv.slice(0, sep).trim();
          const cwd = kv.slice(sep + 4).trim();
          if (name && cwd && !projects[name]) projects[name] = cwd;
        }
      }
    });
    if (Object.keys(projects).length === 0) return config.projects || {};
    return projects;
  } catch { return config.projects || {}; }
}

// 项目会话列表
async function listSessions(projectPath) {
  try {
    const encoded = projectPath[0].toLowerCase() + projectPath.slice(1).replace(/[:\\_]/g, '-');
    const dir = `C:\\Users\\Mote\\.claude\\projects\\${encoded}`;
    const script = `Get-ChildItem '${dir}' -Filter *.jsonl | Sort-Object LastWriteTime -Descending | ForEach-Object { Write-Output ('SESSION:' + \$_.Name + '|' + \$_.LastWriteTime.ToString('yyyy-MM-dd HH:mm')) }`;
    const res = await psExec(script, 8000);
    return res.stdout.trim().split(/\r?\n/).filter(l => l.startsWith('SESSION:')).map(line => {
      const parts = line.slice('SESSION:'.length).split('|');
      return { id: parts[0].replace('.jsonl', ''), date: parts[1] || '', summary: '' };
    });
  } catch { return []; }
}

function encodeProject(projectPath) {
  return projectPath[0].toLowerCase() + projectPath.slice(1).replace(/[:\\_]/g, '-');
}

async function findLatestSession(projectPath) {
  try {
    const encoded = encodeProject(projectPath);
    const script = `Get-ChildItem 'C:\\Users\\Mote\\.claude\\projects\\${encoded}' -Filter *.jsonl | Sort-Object LastWriteTime -Descending | Select-Object -First 1 | ForEach-Object { Write-Output \$_.Name }`;
    const res = await psExec(script, 5000);
    const newest = res.stdout.trim().split(/\r?\n/)[0];
    return newest ? newest.replace('.jsonl', '') : null;
  } catch { return null; }
}

async function getSessionIds(projectPath) {
  try {
    const encoded = encodeProject(projectPath);
    const script = `Get-ChildItem 'C:\\Users\\Mote\\.claude\\projects\\${encoded}' -Filter *.jsonl | ForEach-Object { Write-Output \$_.Name }`;
    const res = await psExec(script, 5000);
    return new Set(res.stdout.trim().split(/\r?\n/).filter(Boolean).map(f => f.replace('.jsonl', '')));
  } catch { return new Set(); }
}

module.exports = { execClaude, healthCheck, getProjects, listSessions, findLatestSession, getSessionIds };
