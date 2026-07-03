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
  const claudeBin = 'C:/Users/Mote/AppData/Roaming/npm/claude.cmd';
  const msgFile = 'C:/Users/Mote/AppData/Local/Temp/clawd-msg.txt';
  const msgB64 = Buffer.from(message, 'utf-8').toString('base64');

  // Step 1: 写消息文件
  const writeScript = `$f='${msgFile}'; [System.IO.File]::WriteAllBytes($f,[System.Convert]::FromBase64String('${msgB64}')); $ProgressPreference='SilentlyContinue'`;
  const writeEncoded = Buffer.from(writeScript, 'utf16le').toString('base64');
  await sshExec(`powershell -NoProfile -NonInteractive -EncodedCommand ${writeEncoded}`, 10000);

  // Step 2: type 文件 pipe 给 claude
  const resumeFlag = sessionId ? ` --resume "${sessionId}"` : '';
  const runCmd = `cmd /c "type ${msgFile} | ${claudeBin}${resumeFlag}"`;

  return sshExec(runCmd, 180000);
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

// 找到指定项目下最新创建的 Claude session ID
async function findLatestSession(projectPath) {
  try {
    const encoded = projectPath[0].toLowerCase() + projectPath.slice(1).replace(/[:\\_]/g, '-');
    // 用 PowerShell 确保路径处理正确
    const res = await sshExec(
      `powershell -NoProfile -Command "(Get-ChildItem 'C:\\Users\\Mote\\.claude\\projects\\${encoded}\\*.jsonl' -EA 0 | Sort-Object LastWriteTime -Desc)[0].BaseName"`,
      10000
    );
    const id = res.stdout.trim();
    return id || null;
  } catch {
    return null;
  }
}

// 获取指定项目的所有 Claude 会话列表
async function listSessions(projectPath) {
  try {
    const encoded = projectPath[0].toLowerCase() + projectPath.slice(1).replace(/[:\\_]/g, '-');
    const res = await sshExec(
      `powershell -NoProfile -Command "Get-ChildItem 'C:\\Users\\Mote\\.claude\\projects\\${encoded}\\*.jsonl' -EA 0 | Sort-Object LastWriteTime -Desc | ForEach-Object { $l=Get-Content $_.FullName -First 50 | Select-String '\\\"text\\\"' | Select-Object -First 2; $last=$l[-1] -replace '.*\\\"text\\\"\\s*:\\s*\\\"','' -replace '\\\".*',''; $id=$_.BaseName; Write-Output \\\"$id|$last\\\" }"`,
      10000
    );
    const sessions = res.stdout.trim().split(/\r?\n/).filter(Boolean).map(line => {
      const [id, ...summary] = line.split('|');
      return { id, summary: summary.join('|').slice(0, 60) || '(空)' };
    });
    return sessions;
  } catch {
    return [];
  }
}

module.exports = { execClaude, healthCheck, getProjects, findLatestSession, listSessions };
