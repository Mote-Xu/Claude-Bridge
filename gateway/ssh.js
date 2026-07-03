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

// 执行 Claude Code，返回 session ID + 输出
async function execClaude(sessionId, message, options = {}) {
  const claudeBin = 'C:\\Users\\Mote\\AppData\\Roaming\\npm\\claude.cmd';
  const msgFile = 'C:\\Users\\Mote\\AppData\\Local\\Temp\\clawd-msg.txt';
  const msgB64 = Buffer.from(message, 'utf-8').toString('base64');

  // Step 1: 写消息文件
  const writeScript = `$f='${msgFile}'; [System.IO.File]::WriteAllBytes($f,[System.Convert]::FromBase64String('${msgB64}')); $ProgressPreference='SilentlyContinue'`;
  const writeEncoded = Buffer.from(writeScript, 'utf16le').toString('base64');
  await sshExec(`powershell -NoProfile -NonInteractive -EncodedCommand ${writeEncoded}`, 10000);

  // 如果是新会话，记录创建前的文件列表
  let beforeFiles = new Set();
  if (!sessionId && options.cwd) {
    const encoded = options.cwd[0].toLowerCase() + options.cwd.slice(1).replace(/[:\\_]/g, '-');
    const before = await sshExec(`dir /b "C:\\Users\\Mote\\.claude\\projects\\${encoded}\\*.jsonl"`, 5000);
    beforeFiles = new Set(before.stdout.trim().split(/\r?\n/).filter(Boolean));
  }

  // Step 2: type 文件 pipe 给 claude
  const resumeFlag = sessionId ? ` --resume "${sessionId}"` : '';
  const runCmd = `cmd /c "type ${msgFile} | ${claudeBin}${resumeFlag}"`;
  const result = await sshExec(runCmd, 180000);

  // 如果是新会话，找新增的文件作为 session ID
  if (!sessionId && options.cwd && beforeFiles.size > 0) {
    const encoded = options.cwd[0].toLowerCase() + options.cwd.slice(1).replace(/[:\\_]/g, '-');
    const after = await sshExec(`dir /b "C:\\Users\\Mote\\.claude\\projects\\${encoded}\\*.jsonl"`, 5000);
    const afterFiles = after.stdout.trim().split(/\r?\n/).filter(Boolean);
    const newFile = afterFiles.find(f => !beforeFiles.has(f));
    if (newFile) result.newSessionId = newFile.replace('.jsonl', '');
  }

  return result;
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

// 获取某个项目的所有 session ID
async function getSessionIds(projectPath) {
  try {
    const encoded = projectPath[0].toLowerCase() + projectPath.slice(1).replace(/[:\\_]/g, '-');
    const res = await sshExec(
      `dir /b "C:\\Users\\Mote\\.claude\\projects\\${encoded}\\*.jsonl"`,
      5000
    );
    return new Set(res.stdout.trim().split(/\r?\n/).filter(Boolean).map(f => f.replace('.jsonl', '')));
  } catch {
    return new Set();
  }
}

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
