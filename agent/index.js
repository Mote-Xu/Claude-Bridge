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

    const projectTimes = {}; // name → latest mtime
    for (const dir of dirs) {
      let found = false;
      let jsonls;
      try {
        jsonls = fs.readdirSync(path.join(PROJECTS_DIR, dir.name))
          .filter(f => f.endsWith('.jsonl'));
      } catch { continue; }

      let latestMtime = 0;
      for (const file of jsonls) {
        try {
          const stat = fs.statSync(path.join(PROJECTS_DIR, dir.name, file));
          if (stat.mtimeMs > latestMtime) latestMtime = stat.mtimeMs;
        } catch {}
        if (found) continue;
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
      if (found) {
        const pname = Object.entries(projects).pop()[0];
        projectTimes[pname] = latestMtime;
      }
    }

    // 按最近修改时间排序
    const sorted = {};
    for (const [name, cwd] of Object.entries(projects).sort((a, b) =>
      (projectTimes[b[0]] || 0) - (projectTimes[a[0]] || 0)
    )) { sorted[name] = cwd; }

    res.json({ projects: sorted });
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

    // Step 2.5: 注册会话到 Claude Code 索引（--resume 查索引不查文件）
    if (sessionId) {
      try {
        const sessionsDir = path.join(os.homedir(), '.claude', 'sessions');
        // 检查是否已在索引中
        let alreadyIndexed = false;
        if (fs.existsSync(sessionsDir)) {
          for (const f of fs.readdirSync(sessionsDir)) {
            if (!f.endsWith('.json')) continue;
            try {
              const entry = JSON.parse(fs.readFileSync(path.join(sessionsDir, f), 'utf-8'));
              if (entry.sessionId === sessionId) { alreadyIndexed = true; break; }
            } catch {}
          }
        }
        // 不在索引 → 注册
        if (!alreadyIndexed && cwd) {
          // 从 JSONL 里取元数据
          const encoded = encodeProject(cwd);
          const projDir = path.join(PROJECTS_DIR, encoded);
          let version = '2.1.198', startedAt = Date.now(), entrypoint = 'claude-vscode';
          if (fs.existsSync(projDir)) {
            const jsonlFile = path.join(projDir, `${sessionId}.jsonl`);
            if (fs.existsSync(jsonlFile)) {
              try {
                const content = fs.readFileSync(jsonlFile, 'utf-8');
                const lines = content.split('\n').slice(0, 5);
                for (const line of lines) {
                  try {
                    const j = JSON.parse(line);
                    if (j.version) version = j.version;
                    if (j.timestamp) startedAt = new Date(j.timestamp).getTime();
                    if (j.entrypoint) entrypoint = j.entrypoint;
                  } catch {}
                }
              } catch {}
            }
          }
          // 写入索引
          if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });
          const indexEntry = {
            pid: process.pid,
            sessionId,
            cwd,
            startedAt,
            version,
            peerProtocol: 1,
            kind: 'interactive',
            entrypoint,
            name: `clawd-${sessionId.slice(0, 8)}`,
            nameSource: 'derived',
          };
          const indexFile = path.join(sessionsDir, `${process.pid}.json`);
          fs.writeFileSync(indexFile, JSON.stringify(indexEntry), 'utf-8');
        }
      } catch {} // 索引注册失败不阻塞
    }

    // Step 3: 写 bat 文件执行 Claude（避免 cmd 引号嵌套）
    // CI=true 可能让 Claude CLI 以非交互模式创建会话，VS Code 更可能识别
    const lines = ['@echo off', 'set CI=true', 'set CLAUDE_NO_TUI=1'];
    if (cwd) lines.push(`cd /d "${cwd}"`);
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
    const sessions = [];
    for (const f of files) {
      const stat = fs.statSync(path.join(dir, f));
      const sortTime = stat.birthtimeMs || stat.ctimeMs;
      // 提取摘要：优先 aiTitle（Claude 自动生成），否则找第一条实质用户消息
      let summary = '';
      let aiTitle = '';
      let hasUserMessage = false;
      try {
        const content = fs.readFileSync(path.join(dir, f), 'utf-8');
        const allLines = content.split('\n');
        // 扫描全部行取最后的 aiTitle（标题随对话更新，越后面越新）
        for (const line of allLines) {
          try {
            const j = JSON.parse(line);
            if (j.aiTitle) aiTitle = j.aiTitle; // 不 break，取最后一个
          } catch {}
        }
        const lines = allLines.slice(0, 50);
        for (const line of lines) {
          try {
            const json = JSON.parse(line);
            if (json.type === 'user' && json.message?.content?.[0]?.text) {
              const text = json.message.content[0].text;
              // 跳过 IDE 事件
              if (/^<[a-z_]+>/.test(text)) continue;
              // skill 调用：取 ARGUMENTS
              let displayText = text;
              if (text.startsWith('Base directory for')) {
                const argsMatch = text.match(/\nARGUMENTS:\s*(.+)$/);
                if (argsMatch) { displayText = argsMatch[1]; }
                else { continue; }
              }
              hasUserMessage = true;
              // 优先取第一条实质消息（>= 10 字符），短指令不做摘要
              if (!summary || (summary.length < 10 && displayText.length >= 10)) {
                summary = displayText.replace(/\n/g, ' ').slice(0, 60);
              }
            }
          } catch {} // skip unparseable lines
        }
      } catch {} // 读文件失败不阻塞
      // 跳过空/已删除会话（VS Code 自动创建或用户删了但文件残留）
      if (!hasUserMessage) continue;
      let userMsgCount = 0;
      try {
        const content = fs.readFileSync(path.join(dir, f), 'utf-8');
        for (const line of content.split('\n').slice(0, 200)) {
          try { const j = JSON.parse(line); if (j.type === 'user') userMsgCount++; } catch {}
        }
      } catch {}
      if (userMsgCount < 3) continue; // 至少 3 条用户消息才算真会话
      sessions.push({
        id: f.replace('.jsonl', ''),
        date: stat.mtime.toISOString().slice(0, 16).replace('T', ' '),
        summary: aiTitle || summary,
        sortTime: stat.mtimeMs, // 按最近修改时间排序
      });
    }
    // 从 session index 读取标题
    let sessionNames = {};
    try {
      const sessionsDir = path.join(os.homedir(), '.claude', 'sessions');
      if (fs.existsSync(sessionsDir)) {
        for (const f of fs.readdirSync(sessionsDir)) {
          if (!f.endsWith('.json')) continue;
          try {
            const e = JSON.parse(fs.readFileSync(path.join(sessionsDir, f), 'utf-8'));
            if (e.sessionId && e.name) sessionNames[e.sessionId] = e.name;
          } catch {}
        }
      }
    } catch {}

    for (const s of sessions) {
      if (sessionNames[s.id]) s.name = sessionNames[s.id];
    }
    sessions.sort((a, b) => b.sortTime - a.sortTime); // 降序：新的在前

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

// POST /api/session-preview — 预览会话详情
app.post('/api/session-preview', (req, res) => {
  const { projectPath, sessionId } = req.body;
  if (!projectPath || !sessionId) return res.status(400).json({ error: 'projectPath + sessionId required' });

  try {
    const encoded = encodeProject(projectPath);
    const file = path.join(PROJECTS_DIR, encoded, `${sessionId}.jsonl`);
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'session not found' });

    const stat = fs.statSync(file);
    const content = fs.readFileSync(file, 'utf-8');
    const lines = content.split('\n').filter(Boolean);

    let userCount = 0, assistantCount = 0;
    const allUserMsgs = []; // 所有有效用户消息
    const rounds = [];
    let currentUser = null;

    for (const line of lines) {
      try {
        const j = JSON.parse(line);
        if (j.type === 'user' && j.message?.content?.[0]?.text) {
          const text = j.message.content[0].text;
          if (/^<[a-z_]+>/.test(text)) continue; // IDE 事件
          let displayText = text;
          if (text.startsWith('Base directory for')) {
            const m = text.match(/\nARGUMENTS:\s*(.+)$/);
            if (m) displayText = m[1]; else continue;
          }
          userCount++;
          if (displayText.length >= 10) allUserMsgs.push(displayText);
          if (currentUser) rounds.push({ user: currentUser, assistant: '' });
          currentUser = displayText;
        }
        if (j.type === 'assistant' && j.message?.content?.[0]?.text && currentUser) {
          assistantCount++;
          const text = j.message.content[0].text;
          if (rounds.length > 0 && !rounds[rounds.length - 1].assistant) {
            rounds[rounds.length - 1].assistant = text;
          }
        }
      } catch {}
    }
    // 最后一条未完成的 user 消息（没有 assistant 回复）
    if (currentUser && rounds.length === 0) {
      rounds.push({ user: currentUser, assistant: '' });
    }

    // 取最近 3 轮
    const recentRounds = rounds.slice(-3).map(r => ({
      user: r.user.slice(0, 100),
      assistant: r.assistant ? r.assistant.slice(0, 100) : '(未回复)',
    }));

    // 尝试从 session index 读取标题
    let sessionName = '';
    try {
      const sessionsDir = path.join(os.homedir(), '.claude', 'sessions');
      if (fs.existsSync(sessionsDir)) {
        for (const f of fs.readdirSync(sessionsDir)) {
          if (!f.endsWith('.json')) continue;
          try {
            const e = JSON.parse(fs.readFileSync(path.join(sessionsDir, f), 'utf-8'));
            if (e.sessionId === sessionId) { sessionName = e.name || ''; break; }
          } catch {}
        }
      }
    } catch {}

    res.json({
      sessionId,
      sessionName,
      date: stat.mtime.toISOString().slice(0, 16).replace('T', ' '),
      size: stat.size,
      userCount,
      assistantCount,
      totalLines: lines.length,
      topicMsgs: allUserMsgs.slice(0, 3),
      recentRounds,
    });
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
