// Clawd Windows Agent
// 本地 HTTP 服务 (127.0.0.1:9877)，替代 SSH 远程执行
// 开机自启：把 start.bat 快捷方式放到 shell:startup 文件夹

const express = require('express');
const { exec, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.PORT || 9877;
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const CLAUDE_BIN = path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'claude.cmd');

const app = express();
app.use(express.json({ limit: '1mb' }));

// ========== 工具函数 ==========

function encodeProject(projectPath) {
  return projectPath[0].toLowerCase() + projectPath.slice(1).replace(/[:\\_]/g, '-');
}

// ========== API ==========

// GET /api/health
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', hostname: os.hostname(), uptime: process.uptime() });
});

// POST /api/discover — 扫描本地 projects 目录，返回 {项目名: 路径}
app.post('/api/discover', (req, res) => {
  try {
    const projects = {};
    if (!fs.existsSync(PROJECTS_DIR)) {
      return res.json({ projects });
    }

    const dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory());

    for (const dir of dirs) {
      let found = false;
      let jsonls;
      try {
        jsonls = fs.readdirSync(path.join(PROJECTS_DIR, dir.name))
          .filter(f => f.endsWith('.jsonl'));
      } catch { continue; }

      for (const file of jsonls) {
        if (found) break;
        try {
          const content = fs.readFileSync(path.join(PROJECTS_DIR, dir.name, file), 'utf-8');
          const lines = content.split('\n').slice(0, 30);
          for (const line of lines) {
            const m = line.match(/"cwd"\s*:\s*"([^"]+)"/);
            if (m) {
              const cwd = m[1].replace(/\\\\/g, '\\');
              const name = cwd.split('\\').filter(Boolean).pop();
              if (name && !projects[name]) projects[name] = cwd;
              found = true;
              break;
            }
          }
        } catch { continue; }
      }
    }

    res.json({ projects });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/run-claude — 执行 Claude Code
app.post('/api/run-claude', (req, res) => {
  const { sessionId, message, cwd } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });

  const msgFile = path.join(os.tmpdir(), 'clawd-msg.txt');
  const batFile = path.join(os.tmpdir(), 'clawd-run.bat');

  try {
    // Step 1: 直接写文件（本地无编码问题）
    fs.writeFileSync(msgFile, message, 'utf-8');

    // Step 2: 续接会话时杀残留进程，防止 session lock
    // MainWindowTitle 对 CLI 进程无效 → 改用 Get-CimInstance 查命令行
    if (sessionId) {
      try {
        const killScript = [
          `$procs = Get-CimInstance Win32_Process -Filter "name='node.exe'" -ErrorAction SilentlyContinue`,
          `foreach ($p in $procs) {`,
          `  if ($p.CommandLine -and $p.CommandLine -like '*claude*') {`,
          `    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue`,
          `  }`,
          `}`,
          `exit 0`
        ].join('\n');
        const killFile = path.join(os.tmpdir(), 'clawd-kill.ps1');
        fs.writeFileSync(killFile, killScript, 'utf-8');
        execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${killFile}"`, { timeout: 5000, windowsHide: true });
        try { fs.unlinkSync(killFile); } catch {}
      } catch {} // 杀进程失败不阻塞
    }

    // Step 3: 写 bat 文件执行 Claude（避免 cmd 引号嵌套）
    // CI=true 可能让 Claude CLI 以非交互模式创建会话，VS Code 更可能识别
    const lines = ['@echo off', 'set CI=true', 'set CLAUDE_NO_TUI=1'];
    if (cwd && !sessionId) lines.push(`cd /d "${cwd}"`);
    lines.push(`type "${msgFile}" | "${CLAUDE_BIN}"${sessionId ? ` --resume "${sessionId}"` : ''}`);
    fs.writeFileSync(batFile, lines.join('\r\n') + '\r\n', 'utf-8');

    exec(batFile, { timeout: 180000, maxBuffer: 10 * 1024 * 1024, encoding: 'utf-8' }, (err, stdout, stderr) => {
      // 清理临时文件
      try { fs.unlinkSync(msgFile); } catch {}
      try { fs.unlinkSync(batFile); } catch {}

      // Step 4: 新会话时找到刚创建的 session ID
      let newSessionId = null;
      if (!sessionId && cwd) {
        try {
          const encoded = encodeProject(cwd);
          const projDir = path.join(PROJECTS_DIR, encoded);
          if (fs.existsSync(projDir)) {
            const files = fs.readdirSync(projDir).filter(f => f.endsWith('.jsonl'));
            if (files.length > 0) {
              // 取最新修改的文件
              let latest = null, latestTime = 0;
              for (const f of files) {
                const stat = fs.statSync(path.join(projDir, f));
                if (stat.mtimeMs > latestTime) {
                  latestTime = stat.mtimeMs;
                  latest = f;
                }
              }
              newSessionId = latest ? latest.replace('.jsonl', '') : null;
            }
          }
        } catch {} // 找不到不影响主流程
      }

      if (err && !stdout) {
        res.json({ stdout: '', stderr: err.message, code: err.code || 1, newSessionId });
      } else {
        res.json({ stdout: stdout || '', stderr: stderr || '', code: err?.code || 0, newSessionId });
      }
    });

  } catch (err) {
    // 同步部分出错（写文件失败等）
    try { fs.unlinkSync(msgFile); } catch {}
    try { fs.unlinkSync(batFile); } catch {}
    res.status(500).json({ stdout: '', stderr: err.message, code: 1 });
  }
});

// POST /api/list-sessions — 列出项目会话
app.post('/api/list-sessions', (req, res) => {
  const { projectPath } = req.body;
  if (!projectPath) return res.status(400).json({ error: 'projectPath required' });

  try {
    const encoded = encodeProject(projectPath);
    const dir = path.join(PROJECTS_DIR, encoded);
    if (!fs.existsSync(dir)) return res.json({ sessions: [] });

    const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
    const sessions = files.map(f => {
      const stat = fs.statSync(path.join(dir, f));
      // 提取摘要：读前 50 行，找第一条用户消息
      let summary = '';
      try {
        const content = fs.readFileSync(path.join(dir, f), 'utf-8');
        const lines = content.split('\n').slice(0, 50);
        for (const line of lines) {
          try {
            const json = JSON.parse(line);
            if (json.type === 'user' && json.message?.content?.[0]?.text) {
              summary = json.message.content[0].text.replace(/\n/g, ' ').slice(0, 60);
              break;
            }
          } catch {} // skip unparseable lines
        }
      } catch {} // 读文件失败不阻塞
      return {
        id: f.replace('.jsonl', ''),
        date: stat.mtime.toISOString().slice(0, 16).replace('T', ' '),
        summary,
      };
    }).sort((a, b) => b.date.localeCompare(a.date));

    res.json({ sessions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/find-latest-session — 找最新会话
app.post('/api/find-latest-session', (req, res) => {
  const { projectPath } = req.body;
  if (!projectPath) return res.status(400).json({ error: 'projectPath required' });

  try {
    const encoded = encodeProject(projectPath);
    const dir = path.join(PROJECTS_DIR, encoded);
    if (!fs.existsSync(dir)) return res.json({ sessionId: null });

    const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
    if (files.length === 0) return res.json({ sessionId: null });

    let latest = null, latestTime = 0;
    for (const f of files) {
      const stat = fs.statSync(path.join(dir, f));
      if (stat.mtimeMs > latestTime) {
        latestTime = stat.mtimeMs;
        latest = f;
      }
    }
    res.json({ sessionId: latest ? latest.replace('.jsonl', '') : null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== 启动 ==========
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Clawd Agent v1.0 — http://0.0.0.0:${PORT}`);
  console.log(`Projects dir: ${PROJECTS_DIR}`);
  console.log(`Claude bin: ${CLAUDE_BIN}`);
  console.log(`Ready.`);
});
