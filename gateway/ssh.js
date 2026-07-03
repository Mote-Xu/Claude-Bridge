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

// 执行 Claude Code
// sessionId: 续接已有会话（null = 新建）
// message: 用户消息
// options.cwd: 项目工作目录（新建会话时设置初始目录）
async function execClaude(sessionId, message, options = {}) {
  const claudeBin = 'C:\\Users\\Mote\\AppData\\Roaming\\npm\\claude.cmd';
  const msgFile = 'C:\\Users\\Mote\\AppData\\Local\\Temp\\clawd-msg.txt';

  // Step 1: 通过 PowerShell Base64 写入消息文件（避开所有转义）
  const msgB64 = Buffer.from(message, 'utf-8').toString('base64');
  const writeScript = `$f='${msgFile}'; [System.IO.File]::WriteAllBytes($f,[System.Convert]::FromBase64String('${msgB64}')); $ProgressPreference='SilentlyContinue'`;
  const writeEnc = Buffer.from(writeScript, 'utf16le').toString('base64');
  await sshExec(`powershell -NoProfile -NonInteractive -EncodedCommand ${writeEnc}`, 10000);

  // Step 2: 续接会话时先杀掉桌面端残留 Claude 进程，防止 session lock 冲突
  // 手机发消息 = 人不在电脑前，安全杀掉桌面端 Claude
  // 用 Get-CimInstance 查命令行而非 MainWindowTitle（CLI 进程无窗口标题）
  if (sessionId) {
    try {
      const killPsScript = `$procs = Get-CimInstance Win32_Process -Filter "name='node.exe'" -EA 0
foreach ($p in $procs) {
  if ($p.CommandLine -and $p.CommandLine -like '*claude*') {
    Stop-Process -Id $p.ProcessId -Force -EA 0
  }
}
exit 0`;
      const killEnc = Buffer.from(killPsScript, 'utf16le').toString('base64');
      await sshExec(`powershell -NoProfile -EncodedCommand ${killEnc}`, 5000);
    } catch {} // 杀进程失败不阻塞
  }

  // Step 3: pipe 消息到 Claude Code
  // CI=true 可能让 Claude CLI 以非交互模式创建会话，VS Code 更可能识别
  const resumeFlag = sessionId ? ` --resume "${sessionId}"` : '';
  const cdFlag = options.cwd ? `cd /d "${options.cwd}" && ` : '';
  const runCmd = `cmd /c "${cdFlag}set CI=true && set CLAUDE_NO_TUI=1 && type ${msgFile} | ${claudeBin}${resumeFlag}"`;
  return sshExec(runCmd, 180000);
}

async function healthCheck() {
  try { await sshExec('echo ok', 5000); return true; } catch { return false; }
}

// 自动发现所有项目（PowerShell -EncodedCommand，彻底避免 cmd.exe 转义地狱）
async function getProjects() {
  try {
    // PowerShell 脚本：遍历 projects 目录 → 读每个项目首个 jsonl 前 20 行 → 正则提取 cwd
    // 全程只用单引号 + Base64 编码，Node.js 侧无任何转义
    const psScript = `[Console]::OutputEncoding = [Text.Encoding]::UTF8
$baseDir = 'C:\\Users\\Mote\\.claude\\projects'
if (Test-Path $baseDir) {
    Get-ChildItem $baseDir -Directory | ForEach-Object {
        $jsonls = @(Get-ChildItem $_.FullName -Filter *.jsonl -ErrorAction SilentlyContinue)
        $found = $false
        foreach ($jsonl in $jsonls) {
            if (-not $found) {
                $lines = Get-Content $jsonl.FullName -TotalCount 20 -ErrorAction SilentlyContinue
                foreach ($line in $lines) {
                    if (-not $found -and ($line -match '"cwd"\\s*:\\s*"([^"]+)"')) {
                        $cwd = $Matches[1] -replace '\\\\+', '\\'
                        $name = Split-Path $cwd -Leaf
                        Write-Output ('PROJECT_MAP:' + $name + '===>' + $cwd)
                        $found = $true
                    }
                }
            }
        }
    }
}`;
    const psEnc = Buffer.from(psScript, 'utf16le').toString('base64');
    const res = await sshExec(`powershell -NoProfile -NonInteractive -EncodedCommand ${psEnc}`, 15000);

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
  } catch {
    return config.projects || {};
  }
}

// 项目会话列表
async function listSessions(projectPath) {
  try {
    const encoded = projectPath[0].toLowerCase() + projectPath.slice(1).replace(/[:\\_]/g, '-');
    const dir = `C:\\Users\\Mote\\.claude\\projects\\${encoded}`;
    const res = await sshExec(`dir /o-d /tc "${dir}\\*.jsonl"`, 8000);
    const sessions = [];
    res.stdout.trim().split(/\r?\n/).filter(l => l.includes('.jsonl')).forEach(line => {
      const parts = line.trim().split(/\s+/);
      const fn = parts[parts.length - 1];
      if (fn.endsWith('.jsonl')) {
        sessions.push({ id: fn.replace('.jsonl', ''), date: `${parts[0]} ${parts[1] || ''}`, summary: '' });
      }
    });
    return sessions;
  } catch { return []; }
}

// 找到项目目录对应的编码名
function encodeProject(projectPath) {
  return projectPath[0].toLowerCase() + projectPath.slice(1).replace(/[:\\_]/g, '-');
}

// 执行前后比对找新 session ID
async function findLatestSession(projectPath) {
  try {
    const encoded = encodeProject(projectPath);
    const res = await sshExec(`dir /b /o-d "C:\\Users\\Mote\\.claude\\projects\\${encoded}\\*.jsonl"`, 5000);
    const newest = res.stdout.trim().split(/\r?\n/)[0];
    return newest ? newest.replace('.jsonl', '') : null;
  } catch { return null; }
}

// 比对执行前后的文件列表找新 session
async function getSessionIds(projectPath) {
  try {
    const encoded = encodeProject(projectPath);
    const res = await sshExec(`dir /b "C:\\Users\\Mote\\.claude\\projects\\${encoded}\\*.jsonl"`, 5000);
    return new Set(res.stdout.trim().split(/\r?\n/).filter(Boolean).map(f => f.replace('.jsonl', '')));
  } catch { return new Set(); }
}

module.exports = { execClaude, healthCheck, getProjects, listSessions, findLatestSession, getSessionIds };
