// Claude-Bridge Windows Agent
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

// 会话执行状态追踪（覆盖所有路径：VS Code、Bridge、API）
const sessionBusy = new Set(); // claude session UUID → true

const app = express();
app.use(express.json({ limit: '1mb' }));

// ========== 工具函数 ==========

function encodeProject(projectPath) {
  const norm = (projectPath || '').replace(/\//g, '\\');
  // Claude Code 用不同编码算法，不猜。扫描 projects 目录找到匹配 cwd 的目录
  if (fs.existsSync(PROJECTS_DIR)) {
    const dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const d of dirs) {
      try {
        const files = fs.readdirSync(path.join(PROJECTS_DIR, d.name)).filter(f => f.endsWith('.jsonl'));
        if (files.length === 0) continue;
        const content = fs.readFileSync(path.join(PROJECTS_DIR, d.name, files[0]), 'utf-8');
        for (const line of content.split('\n').slice(0, 30)) {
          try {
            const j = JSON.parse(line);
            if (j.cwd) {
              const cwd = j.cwd.replace(/\\\\/g, '\\');
              if (cwd.toLowerCase() === norm.toLowerCase()) return d.name;
              break;
            }
          } catch {}
        }
      } catch {}
    }
  }
  // fallback: 自己算
  return norm[0].toLowerCase() + norm.slice(1).replace(/[:\\_]/g, '-');
}

// 兼容两种消息格式：VS Code 的数组格式和 pipe 模式的字符串格式
function getMessageText(msg) {
  if (!msg || !msg.content) return null;
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content) && msg.content[0]?.text) return msg.content[0].text;
  return null;
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
      let projectName = null;
      let jsonls;
      try {
        jsonls = fs.readdirSync(path.join(PROJECTS_DIR, dir.name))
          .filter(f => f.endsWith('.jsonl'));
      } catch { continue; }

      let latestMtime = 0;
      for (const file of jsonls) {
        // 取文件修改时间——即使 VS Code 碰过，最近活跃的项目 mtime 也最靠前
        try {
          const stat = fs.statSync(path.join(PROJECTS_DIR, dir.name, file));
          if (stat.mtimeMs > latestMtime) latestMtime = stat.mtimeMs;
        } catch {}
        if (projectName) continue;
        try {
          const content = fs.readFileSync(path.join(PROJECTS_DIR, dir.name, file), 'utf-8');
          const lines = content.split('\n').slice(0, 30);
          for (const line of lines) {
            const m = line.match(/"cwd"\s*:\s*"([^"]+)"/);
            if (m) {
              const cwd = m[1].replace(/\\\\/g, '\\');
              const name = cwd.split('\\').filter(Boolean).pop();
              if (name && !projects[name]) projects[name] = cwd;
              projectName = name;
              break;
            }
          }
        } catch { continue; }
      }
      if (projectName) {
        
        projectTimes[projectName] = latestMtime;
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

  const msgFile = path.join(os.tmpdir(), 'bridge-msg.txt');
  const batFile = path.join(os.tmpdir(), 'bridge-run.bat');

  try {
    // Step 1: 直接写文件（本地无编码问题）
    fs.writeFileSync(msgFile, message, 'utf-8');

    // Step 2: 注册会话到 Claude Code 索引（--resume 查索引不查文件）
    if (sessionId) {
      try {
        if (cwd) {
          const sessionsDir2 = path.join(os.homedir(), '.claude', 'sessions');
          // 删掉该会话的旧索引条目（避免重复）
          if (fs.existsSync(sessionsDir2)) {
            for (const f of fs.readdirSync(sessionsDir2)) {
              if (!f.endsWith('.json')) continue;
              try {
                const entry = JSON.parse(fs.readFileSync(path.join(sessionsDir2, f), 'utf-8'));
                if (entry.sessionId === sessionId) fs.unlinkSync(path.join(sessionsDir2, f));
              } catch {}
            }
          }
          // 从 JSONL 里取元数据
          const encoded = encodeProject(cwd);
          const projDir = path.join(PROJECTS_DIR, encoded);
          let version = '2.1.198', startedAt = Date.now(), entrypoint = 'claude-vscode', aiTitle = '';
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
                    if (j.aiTitle) aiTitle = j.aiTitle;
                  } catch {}
                }
              } catch {}
            }
          }
          // 写入索引（唯一文件名：agentPID-sessionShort）
          if (!fs.existsSync(sessionsDir2)) fs.mkdirSync(sessionsDir2, { recursive: true });
          const indexEntry = {
            pid: process.pid,
            sessionId,
            cwd,
            startedAt,
            version,
            peerProtocol: 1,
            kind: 'interactive',
            entrypoint,
            name: aiTitle ? `bridge-${aiTitle.slice(0, 30)}` : `bridge-${sessionId.slice(0, 8)}`,
            nameSource: 'derived',
          };
          const indexFile = path.join(sessionsDir2, `${process.pid}-${sessionId.slice(0, 8)}.json`);
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

    if (sessionId) sessionBusy.add(sessionId);

    exec(batFile, { timeout: 180000, maxBuffer: 10 * 1024 * 1024, encoding: 'utf-8' }, (err, stdout, stderr) => {
      if (sessionId) sessionBusy.delete(sessionId);
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

      // 把这次 Bridge 会话登记进项目根 CAST_OF_SESSIONS.md（标 🌉 Bridge）
      try { upsertCastBridge(cwd, sessionId || newSessionId); } catch {}

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
      // 提取摘要 + 最后活跃时间
      let summary = '';
      let aiTitle = '';
      let hasUserMessage = false;
      let entrypoint = '';
      let lastActivity = stat.mtimeMs; // 默认用 mtime，之后用 JSONL 里最后时间戳覆盖
      try {
        const content = fs.readFileSync(path.join(dir, f), 'utf-8');
        const allLines = content.split('\n');
        for (const line of allLines) {
          try {
            const j = JSON.parse(line);
            if (j.aiTitle) aiTitle = j.aiTitle;
            if (j.entrypoint && !entrypoint) entrypoint = j.entrypoint;
            if (j.timestamp) {
              const ts = new Date(j.timestamp).getTime();
              if (!isNaN(ts)) lastActivity = ts;
            }
            // 搜索第一条有效用户消息（不限行数，前面的 IDE 事件会跳过）
            if (!hasUserMessage && j.type === 'user') {
              const text = getMessageText(j.message);
              if (!text) continue;
              if (/^<[a-z_]+>/.test(text)) continue; // 跳过 IDE 事件
              let displayText = text;
              if (text.startsWith('Base directory for')) {
                const argsMatch = text.match(/\nARGUMENTS:\s*(.+)$/);
                if (argsMatch) { displayText = argsMatch[1]; }
                else { continue; } // skill 调用但没有参数，跳过
              }
              hasUserMessage = true;
              summary = displayText.replace(/\n/g, ' ').slice(0, 60);
            }
          } catch {}
        }
      } catch {} // 读文件失败不阻塞
      // 跳过空会话或无意义短消息
      if (!hasUserMessage) continue;
      const bestSummary = aiTitle || summary;
      if (!bestSummary || bestSummary.length < 5) continue; // hello / 乱码 等
      const sid = f.replace('.jsonl', '');
      sessions.push({
        id: sid,
        date: stat.mtime.toISOString().slice(0, 16).replace('T', ' '),
        summary: aiTitle || summary,
        sortTime: lastActivity,
        entrypoint: entrypoint,
        busy: sessionBusy.has(sid),
      });
    }
    // 从 session index 读取标题
    let sessionNames = {};
  let sessionSources = {};
    try {
      const sessionsDir = path.join(os.homedir(), '.claude', 'sessions');
      if (fs.existsSync(sessionsDir)) {
        for (const f of fs.readdirSync(sessionsDir)) {
          if (!f.endsWith('.json')) continue;
          try {
            const e = JSON.parse(fs.readFileSync(path.join(sessionsDir, f), 'utf-8'));
            if (e.sessionId && e.name) sessionNames[e.sessionId] = e.name;
              sessionSources[e.sessionId] = e.name.startsWith('bridge-') ? 'bridge' : 'vscode';
          } catch {}
        }
      }
    } catch {}

    for (const s of sessions) {
      if (sessionNames[s.id]) s.name = sessionNames[s.id];
      // sdk-cli → Bridge pipe 模式创建；claude-vscode → VS Code 原生
      s.source = (s.entrypoint && s.entrypoint !== 'claude-vscode') ? 'bridge' : 'vscode';
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

    for (const line of lines) {
      try {
        const j = JSON.parse(line);
        if (j.type === 'user') {
          const text = getMessageText(j.message);
          if (!text) continue;
          if (/^<[a-z_]+>/.test(text)) continue; // IDE 事件
          let displayText = text;
          if (text.startsWith('Base directory for')) {
            const m = text.match(/\nARGUMENTS:\s*(.+)$/);
            if (m) displayText = m[1]; else continue;
          }
          userCount++;
          if (displayText.length >= 10) allUserMsgs.push(displayText);
          rounds.push({ user: displayText, assistant: '' }); // 用户消息立即建轮次
        }
        if (j.type === 'assistant') {
          const text = getMessageText(j.message);
          if (!text) continue;
          assistantCount++;
          // 填入最后一个未配对的轮次
          for (let i = rounds.length - 1; i >= 0; i--) {
            if (!rounds[i].assistant) { rounds[i].assistant = text; break; }
          }
        }
      } catch {}
    }
    // 去掉最后一轮如果即没 assistant 也是空 user 的（不太可能但防御）
    if (rounds.length > 0 && !rounds[rounds.length - 1].assistant && !rounds[rounds.length - 1].user) {
      rounds.pop();
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

// POST /api/reload — 重启 Agent（Gateway 部署后调，看门狗自动拉起）
app.post('/api/reload', (req, res) => {
  res.json({ status: 'restarting' });
  setTimeout(() => process.exit(0), 100);
});

// POST /api/chronicle — 写会话公开记录到项目目录
app.post('/api/chronicle', (req, res) => {
  const { projectPath, sessionName, type, content, source } = req.body;
  if (!projectPath || !sessionName || !content) return res.status(400).json({ error: 'projectPath, sessionName, content required' });

  try {
    writeChronicle(projectPath, sessionName, type, content, source);
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 写入 chronicle 文件（也供 sync 使用）
function writeChronicle(projectPath, sessionName, type, content, source) {
  // 🛡️ 项目文件夹已被用户删除就跳过 —— 否则 mkdir recursive 会把已删文件夹整条诈尸重建
  if (!projectPath || !fs.existsSync(projectPath)) return;
  const chronicleDir = path.join(projectPath, '.bridge', 'sessions');
  if (!fs.existsSync(chronicleDir)) fs.mkdirSync(chronicleDir, { recursive: true });

  const file = path.join(chronicleDir, `@${sessionName}.md`);
  const ts = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const sourceLabel = source ? ` [${source}]` : '';
  const typeIcon = type === 'in' ? '👤' : '🤖';

  const entry = `\n## ${ts}${sourceLabel}\n${typeIcon}: ${content.slice(0, 2000)}\n`;
  fs.appendFileSync(file, entry, 'utf-8');
}

// ── CAST_OF_SESSIONS.md 会话角色名册 ──────────────────────────────
// 交互会话由 SessionStart hook 提醒自登记；Bridge 会话在此由 Agent 机械登记（标 🌉 Bridge）
function castRosterHeader(project) {
  return (
    `# CAST OF SESSIONS — ${project}\n\n` +
    `> 本项目会话角色名册。交互会话自己登记；Bridge 会话由 Agent 自动登记（标 🌉 Bridge）。\n` +
    `> 机器只知道进程活没活；谁是主线、谁留档、谁是墓碑，只有会话自己知道 —— 所以写在这。\n` +
    `> 来源：交互(VS Code) / 🌉 Bridge(企微)　角色：🔧 worker(当前主线) / 📋 auditor(留档备查,可 ask 勿派活) / 🪦 retired(墓碑,可删)\n\n` +
    `| 会话 | UUID8 | 来源 | 角色 | 在做/负责 | 最后更新 |\n` +
    `|------|-------|------|------|-----------|----------|\n`
  );
}

// 幂等 upsert 一行：按 UUID8 匹配；已存在则保留「角色/在做」，只刷新 名称/来源/时间
function upsertRoster(rosterPath, projectName, row) {
  try {
    let text = '';
    try { text = fs.readFileSync(rosterPath, 'utf-8'); } catch {}
    if (!text.trim()) text = castRosterHeader(projectName);

    const ts = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const lines = text.split('\n');
    const idx = lines.findIndex(l => l.startsWith('|') && l.includes(`| ${row.uuid8} `));
    if (idx >= 0) {
      const c = lines[idx].split('|').map(s => s.trim()); // ['',会话,UUID8,来源,角色,在做,最后更新,'']
      const role = c[4] || '(未标注)';
      const doing = c[5] || '';
      lines[idx] = `| ${row.name} | ${row.uuid8} | ${row.source} | ${role} | ${doing} | ${ts} |`;
      text = lines.join('\n');
    } else {
      text = text.replace(/\s*$/, '') + `\n| ${row.name} | ${row.uuid8} | ${row.source} | (未标注) |  | ${ts} |\n`;
    }
    fs.writeFileSync(rosterPath, text, 'utf-8');
  } catch {}
}

// 把一个 Bridge 会话登记进项目根 CAST_OF_SESSIONS.md（标 🌉 Bridge）
function upsertCastBridge(projectPath, sessionId) {
  if (!projectPath || !sessionId) return;
  if (!fs.existsSync(projectPath)) return; // 🛡️ 项目已被删除就跳过，别复活它
  try {
    const jsonlPath = path.join(PROJECTS_DIR, encodeProject(projectPath), `${sessionId}.jsonl`);
    const meta = getSessionMeta(jsonlPath, sessionId);
    const name = meta.sessionName || sessionId.slice(0, 8);
    upsertRoster(
      path.join(projectPath, 'CAST_OF_SESSIONS.md'),
      path.basename(projectPath),
      { name, uuid8: sessionId.slice(0, 8), source: '🌉 Bridge' }
    );
  } catch {}
}

// 从 JSONL 读取会话名和项目路径
function getSessionMeta(jsonlPath, sessionId) {
  let projectPath = null, sessionName = null;
  try {
    const content = fs.readFileSync(jsonlPath, 'utf-8');
    // 从后往前：最后一个 aiTitle 才是当前名字（和企微列表一致），cwd 从前往后取
    const lines = content.split('\n');
    for (const line of lines) {
      try {
        const j = JSON.parse(line);
        if (j.cwd && !projectPath) projectPath = j.cwd.replace(/\\\\/g, '\\');
      } catch {}
    }
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const j = JSON.parse(lines[i]);
        if (j.aiTitle) { sessionName = j.aiTitle; break; }
      } catch {}
    }
  } catch {}
  return { projectPath, sessionName: sessionName || sessionId.slice(0, 8) };
}

// 同步所有项目的 JSONL → chronicle（覆盖 VS Code 和 Bridge 会话）
const TRACK_FILE = path.join(os.homedir(), '.claude', '.chronicle-sync.json');
// 异步 + 按文件大小跳过：静止的会话直接不读，只有涨了的才异步读新行，避免阻塞事件循环
async function syncChronicles() {
  if (!fs.existsSync(PROJECTS_DIR)) return { synced: 0 };

  let track = {};
  try { track = JSON.parse(fs.readFileSync(TRACK_FILE, 'utf-8')); } catch {}
  // 兼容旧格式：track[sid] 曾是纯数字(lineCount)，现升级为 {lines, size}
  const getRec = (sid) => {
    const r = track[sid];
    return typeof r === 'number' ? { lines: r, size: 0 } : (r || { lines: 0, size: 0 });
  };

  let synced = 0;
  const dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter(d => d.isDirectory());

  for (const dir of dirs) {
    let jsonls;
    try { jsonls = fs.readdirSync(path.join(PROJECTS_DIR, dir.name)).filter(f => f.endsWith('.jsonl')); }
    catch { continue; }

    for (const f of jsonls) {
      const sessionId = f.replace('.jsonl', '');
      const jsonlPath = path.join(PROJECTS_DIR, dir.name, f);
      const rec = getRec(sessionId);

      // 🚀 先 stat（廉价）：JSONL 只追加，大小没变=无新内容，直接跳过，绝不读大文件
      let stat;
      try { stat = fs.statSync(jsonlPath); } catch { continue; }
      if (rec.size > 0 && stat.size === rec.size) continue;

      // 🚀 异步读，让出事件循环，读大文件时不卡其他 HTTP 请求
      let content;
      try { content = await fs.promises.readFile(jsonlPath, 'utf-8'); } catch { continue; }
      const lines = content.split('\n').filter(Boolean);
      const currentLineCount = lines.length;
      if (currentLineCount <= rec.lines) { track[sessionId] = { lines: currentLineCount, size: stat.size }; continue; }

      const meta = getSessionMeta(jsonlPath, sessionId);
      if (!meta.projectPath) { track[sessionId] = { lines: currentLineCount, size: stat.size }; continue; }

      // 处理新行
      for (let i = rec.lines; i < currentLineCount; i++) {
        try {
          const j = JSON.parse(lines[i]);
          const text = getMessageText(j.message);
          if (!text) continue;
          if (j.type === 'user' && /^<[a-z_]+>/.test(text)) continue; // IDE 事件跳过

          const type = j.type === 'user' ? 'in' : (j.type === 'assistant' ? 'out' : null);
          if (!type) continue;

          writeChronicle(meta.projectPath, meta.sessionName, type, text, '');
          synced++;
        } catch {}
      }

      track[sessionId] = { lines: currentLineCount, size: stat.size };
    }
  }

  try { fs.writeFileSync(TRACK_FILE, JSON.stringify(track), 'utf-8'); } catch {}
  return { synced };
}

// POST /api/sync-chronicles — 扫描并同步所有会话
app.post('/api/sync-chronicles', async (req, res) => {
  try {
    const result = await syncChronicles();
    res.json({ status: 'ok', ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/busy-sessions — 通过 JSONL 修改时间判断会话是否正在执行
// JSONL 持续写入 = 正在干活；超过 30 秒没写入 = 空闲
const BUSY_THRESHOLD_MS = 30000;
app.get('/api/busy-sessions', (req, res) => {
  try {
    const now = Date.now();
    const allSids = new Set();
    for (const sid of sessionBusy) allSids.add(sid); // Agent 自己驱动的

    const busyList = [];
    if (fs.existsSync(PROJECTS_DIR)) {
      for (const d of fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        try {
          for (const f of fs.readdirSync(path.join(PROJECTS_DIR, d.name))) {
            if (!f.endsWith('.jsonl')) continue;
            const sid = f.replace('.jsonl', '');
            const jsonlPath = path.join(PROJECTS_DIR, d.name, f);
            // JSONL 最近 30 秒内被修改 = 正在写入 = 忙
            const stat = fs.statSync(jsonlPath);
            if (now - stat.mtimeMs > BUSY_THRESHOLD_MS) continue;
            const meta = getSessionMeta(jsonlPath, sid);
            busyList.push({ id: sid, name: meta.sessionName || sid.slice(0, 8) });
          }
        } catch {}
      }
    }
    res.json({ busy: busyList, count: busyList.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/bridge/ask — 会话给会话发消息的标准入口
// Agent 先解析目标会话 UUID，再转发给 Gateway
app.post('/api/bridge/ask', (req, res) => {
  const { projectPath, sourceName, targetName, message } = req.body;
  if (!projectPath || !sourceName || !targetName || !message) {
    return res.status(400).json({ error: 'projectPath, sourceName, targetName, message required' });
  }

  // 从 JSONL 文件找 source 和 target 的 sessionId
  const encoded = encodeProject(projectPath);
  const projDir = path.join(PROJECTS_DIR, encoded);
  let targetSessionId = null, sourceId = null;
  if (fs.existsSync(projDir)) {
    for (const f of fs.readdirSync(projDir)) {
      if (!f.endsWith('.jsonl')) continue;
      try {
        const content = fs.readFileSync(path.join(projDir, f), 'utf-8');
        // 从后往前扫：aiTitle 会变，最后一条才是当前名字（和企微列表一致）
        for (const line of content.split('\n').reverse()) {
          try {
            const j = JSON.parse(line);
            if (j.aiTitle) {
              if (j.aiTitle.includes(targetName)) { targetSessionId = f.replace('.jsonl', ''); break; }
              if (j.aiTitle.includes(sourceName)) { sourceId = f.replace('.jsonl', ''); break; }
            }
          } catch {}
        }
      } catch {}
    }
  }
  if (!targetSessionId) {
    return res.status(404).json({ error: `target session not found: "${targetName}"` });
  }

  // 转发给 Gateway（Tailscale 内网直连）
  const http = require('http');
  const data = JSON.stringify({ projectPath, sourceName, sourceId, targetName, targetSessionId, message });

  const gwReq = http.request({
    hostname: '100.118.10.0', port: 8933, path: '/api/bridge/ask',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    timeout: 10000,
  }, gwRes => {
    let buf = ''; gwRes.on('data', d => buf += d);
    gwRes.on('end', () => { try { res.json(JSON.parse(buf)); } catch { res.json({ status: 'error', detail: buf.slice(0, 200) }); } });
  });
  gwReq.on('error', err => res.status(502).json({ error: 'Gateway unreachable: ' + err.message }));
  gwReq.write(data);
  gwReq.end();
});

// POST /api/kill-vscode — 手动关闭 VS Code
app.post('/api/kill-vscode', (req, res) => {
  try {
    execSync('taskkill /f /im code.exe', { timeout: 5000, windowsHide: true });
    res.json({ status: 'ok' });
  } catch {
    res.json({ status: 'not_running' });
  }
});

// GET /api/hidden-sessions — 从 VS Code 状态读取被隐藏的会话 ID
// 零依赖：直接读 SQLite DB 文件，正则提取 JSON
app.get('/api/hidden-sessions', (req, res) => {
  try {
    const dbPath = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
      'Code', 'User', 'globalStorage', 'state.vscdb');
    if (!fs.existsSync(dbPath)) return res.json({ hiddenSessionIds: [] });

    const buf = fs.readFileSync(dbPath);
    // SQLite 小值存在 inline，直接搜 JSON pattern
    const str = buf.toString('utf-8');
    const match = str.match(/"hiddenSessionIds"\s*:\s*(\[[^\]]*\])/);
    if (match) {
      const ids = JSON.parse(match[1]);
      return res.json({ hiddenSessionIds: ids });
    }
    res.json({ hiddenSessionIds: [] });
  } catch {
    res.json({ hiddenSessionIds: [] });
  }
});

// ========== 启动 ==========
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Claude-Bridge Agent — http://0.0.0.0:${PORT}`);
  console.log(`Projects dir: ${PROJECTS_DIR}`);
  console.log(`Claude bin: ${CLAUDE_BIN}`);
  console.log(`Ready.`);
});
