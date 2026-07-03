const { Client } = require('ssh2');
const fs = require('fs');
const config = require('./config');

function sshExec(cmd, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const { host, username, privateKey } = config.local;
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
async function execClaude(sessionId, message, options = {}) {
  const claudeBin = 'C:\\Users\\Mote\\AppData\\Roaming\\npm\\claude.cmd';
  const msgFile = 'C:\\Users\\Mote\\AppData\\Local\\Temp\\clawd-msg.txt';
  const msgB64 = Buffer.from(message, 'utf-8').toString('base64');
  const writeScript = `$f='${msgFile}'; [System.IO.File]::WriteAllBytes($f,[System.Convert]::FromBase64String('${msgB64}')); $ProgressPreference='SilentlyContinue'`;
  const writeEnc = Buffer.from(writeScript, 'utf16le').toString('base64');
  await sshExec(`powershell -NoProfile -NonInteractive -EncodedCommand ${writeEnc}`, 10000);

  const resumeFlag = sessionId ? ` --resume "${sessionId}"` : '';
  const runCmd = `cmd /c "type ${msgFile} | ${claudeBin}${resumeFlag}"`;
  return sshExec(runCmd, 180000);
}

async function healthCheck() {
  try { await sshExec('echo ok', 5000); return true; } catch { return false; }
}

// 自动发现所有项目（一条 PowerShell -EncodedCommand）
async function getProjects() {
  try {
    // 用 Buffer 构造命令字节，彻底避免 JS 转义问题
    const cmdParts = [
      'for /d %d in (', '"', 'C:\\Users\\Mote\\.claude\\projects\\*', '"', ') do @findstr /c:',
      '"', '\\"', 'cwd', '\\"', '"', ' ', '"', '%d\\*.jsonl', '"', ' 2>nul'
    ];
    const cmdStr = cmdParts.join('');
    const grepAll = await sshExec(cmdStr, 15000);
    const projects = {};
    grepAll.stdout.trim().split(/\r?\n/).filter(Boolean).forEach(line => {
      const m = line.match(/"cwd"\s*:\s*"([^"]+)"/);
      if (m) {
        const cwd = m[1].replace(/\\\\/g, '\\');
        const name = cwd.split('\\').filter(Boolean).pop();
        if (name && !projects[name]) projects[name] = cwd;
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
