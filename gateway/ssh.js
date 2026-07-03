const { Client } = require('ssh2');
const fs = require('fs');
const config = require('./config');

function sshExec(cmd, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const { host, username, privateKey } = config.local;
    let stdout = '', stderr = '';

    const timer = setTimeout(() => {
      conn.end();
      reject(new Error('SSH timeout'));
    }, timeout);

    conn.on('ready', () => {
      conn.exec(cmd, { pty: false }, (err, stream) => {
        if (err) { clearTimeout(timer); conn.end(); return reject(err); }
        stream.on('data', (d) => stdout += d.toString());
        stream.stderr.on('data', (d) => stderr += d.toString());
        stream.on('close', (code) => {
          clearTimeout(timer);
          conn.end();
          resolve({ stdout, stderr, code });
        });
      });
    });
    conn.on('error', (err) => { clearTimeout(timer); reject(err); });
    conn.connect({ host, port: 22, username, privateKey: fs.readFileSync(privateKey), readyTimeout: 10000 });
  });
}

// 执行 Claude Code
async function execClaude(sessionId, message, options = {}) {
  const claudeBin = 'C:\\Users\\Mote\\AppData\\Roaming\\npm\\claude.cmd';
  const msgFile = 'C:\\Users\\Mote\\AppData\\Local\\Temp\\clawd-msg.txt';
  const msgB64 = Buffer.from(message, 'utf-8').toString('base64');

  // Step 1: 写消息到 UTF-8 文件（PowerShell base64 避免转义问题）
  const writeScript = `$f='${msgFile}'; [System.IO.File]::WriteAllBytes($f,[System.Convert]::FromBase64String('${msgB64}')); $ProgressPreference='SilentlyContinue'`;
  const writeEncoded = Buffer.from(writeScript, 'utf16le').toString('base64');
  const writeCmd = `powershell -EncodedCommand ${writeEncoded}`;

  await sshExec(writeCmd, 10000);

  // Step 2: type 文件 pipe 给 claude
  const resumeFlag = sessionId ? ` --resume "${sessionId}"` : '';
  const runCmd = `cmd /c "type ${msgFile} | ${claudeBin}${resumeFlag}"`;

  return sshExec(runCmd, 120000);
}

// 健康检查
async function healthCheck() {
  try { await sshExec('echo ok', 5000); return true; }
  catch { return false; }
}

// 自动发现 Claude Code 项目
async function getProjects() {
  try {
    const res = await sshExec('dir /b "C:\\Users\\Mote\\.claude\\projects"', 10000);
    const dirs = res.stdout.trim().split(/\r?\n/).filter(Boolean);
    if (dirs.length === 0) return {};

    // 每条 dir 对应一个项目，读取第一个 JSONL 的 cwd
    const projects = {};
    for (const dir of dirs) {
      try {
        const jsonlRes = await sshExec(
          `powershell -Command "dir 'C:\\Users\\Mote\\.claude\\projects\\${dir}\\*.jsonl' -EA 0 | select -First 1 | %% { gc $_.FullName -First 20 | ? { $_ -match 'cwd' } | select -First 1 }"`,
          10000
        );
        const m = jsonlRes.stdout.match(/"cwd"\s*:\s*"([^"]+)"/);
        if (m) {
          const cwd = m[1].replace(/\\\\/g, '\\');
          const name = cwd.split('\\').filter(Boolean).pop() || dir;
          if (name) projects[name] = cwd;
        }
      } catch { /* skip this dir */ }
    }
    return projects;
  } catch {
    return {};
  }
}

// 找到最近创建的 Claude session ID（在所有项目中扫描最新修改的 JSONL）
async function findLatestSession(projectPath) {
  try {
    // 直接找所有 project 目录下最新修改的 JSONL 作为结果
    const res = await sshExec(
      'powershell -Command "dir C:\\Users\\Mote\\.claude\\projects\\*\\*.jsonl -EA 0 | Sort-Object LastWriteTime -Desc | Select-Object -First 1 | ForEach-Object { Write-Output $_.BaseName }"',
      10000
    );
    const id = res.stdout.trim();
    return id || null;
  } catch {
    return null;
  }
}

module.exports = { execClaude, healthCheck, getProjects, findLatestSession };
