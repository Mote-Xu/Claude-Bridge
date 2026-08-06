// Claude-Bridge Windows Agent
// 本地 HTTP 服务 (127.0.0.1:9877)，替代 SSH 远程执行
// 开机自启：把 start.bat 快捷方式放到 shell:startup 文件夹

const express = require('express');
const { exec, execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.PORT || 9877;
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const CLAUDE_BIN = path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'claude.cmd');

// 会话执行状态追踪（覆盖所有路径：VS Code、Bridge、API）
const sessionBusy = new Set(); // claude session UUID → true
const runningProcs = new Map(); // sessionId → ChildProcess（用于 /api/stop-claude）

// ── 崩溃日志 + 保活：记录异常但不退出，VBS 看门狗负责重启 ──
const CRASH_LOG = path.join(os.tmpdir(), 'claude-bridge-agent-crash.log');
process.on('uncaughtException', err => {
  try { fs.appendFileSync(CRASH_LOG, `${new Date().toISOString()} UNCAUGHT: ${err.stack || err.message}\n`); } catch {}
  console.error('FATAL uncaughtException:', err.message);
});
process.on('unhandledRejection', (reason) => {
  try { fs.appendFileSync(CRASH_LOG, `${new Date().toISOString()} UNHANDLED_REJECTION: ${reason?.stack || reason}\n`); } catch {}
  console.error('FATAL unhandledRejection:', reason);
});

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

// ── 权限检测 ──────────────────────────────────────────────
// Claude Code 权限提示特征：⏺ Do you want to proceed? (y/n)
// 检测末尾出现的权限提示（先剥离 ANSI 序列再匹配）
function detectPermissionPrompt(text) {
  if (!text) return false;
  // 剥离 ANSI 转义序列（Claude Code 用它们做粗体/颜色）
  const clean = text.replace(/\x1b\[[0-9;]*m/g, '');
  // 只检查末尾 500 字符
  const tail = clean.slice(-500);
  return /\?\s*\(y\/n\)\s*$/im.test(tail) || /\bproceed\?\s*$/im.test(tail);
}

// 构建完成响应
function buildCompletedResponse(procState, cwd, originalSessionId, preFiles) {
  let newSessionId = null;
  // 新会话：用差集找新创建的 JSONL
  if (!originalSessionId && cwd && preFiles && preFiles.size > 0) {
    try {
      for (const d of fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        for (const f of fs.readdirSync(path.join(PROJECTS_DIR, d.name))) {
          if (!f.endsWith('.jsonl')) continue;
          const key = `${d.name}/${f}`;
          if (!preFiles.has(key)) {
            newSessionId = f.replace('.jsonl', '');
            upsertCastBridge(cwd, newSessionId);
            break; // 只注册第一个新文件（新会话只有一个）
          }
        }
      }
    } catch {}
  } else if (originalSessionId) {
    try { upsertCastBridge(cwd, originalSessionId); } catch {}
  }
  return {
    status: 'completed',
    stdout: procState.stdoutBuf || '',
    stderr: procState.stderrBuf || '',
    code: procState.exitCode || 0,
    newSessionId,
  };
}

// POST /api/run-claude — 执行 Claude Code（stdin 直连，不经过 bat 文件）
// platform=telegram 时使用 spawn + 权限检测；否则使用 exec（向后兼容）
app.post('/api/run-claude', async (req, res) => {
  let { sessionId, message, cwd, projectPath, platform } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  // 兼容：支持 cwd 和 projectPath 两种字段名
  if (!cwd && projectPath) cwd = projectPath;
  if (cwd) cwd = cwd.replace(/\//g, '\\').replace(/\\\\/g, '\\'); // 标准化路径分隔符

  // ── 会话索引注册（TG 和非 TG 共用） ──
  if (sessionId && cwd) {
    try {
      const sessionsDir2 = path.join(os.homedir(), '.claude', 'sessions');
      if (fs.existsSync(sessionsDir2)) {
        for (const f of fs.readdirSync(sessionsDir2)) {
          if (!f.endsWith('.json')) continue;
          try {
            const entry = JSON.parse(fs.readFileSync(path.join(sessionsDir2, f), 'utf-8'));
            if (entry.sessionId === sessionId) fs.unlinkSync(path.join(sessionsDir2, f));
          } catch {}
        }
      }
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
    } catch {}
  }

  // ── 非 TG：显式 spawn cmd.exe（不用 exec），避免 Node 24 cwd 跨盘符 ENOENT ──
  if (platform !== 'telegram') {
    try {
      const cmdExe2 = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'cmd.exe') : 'C:\\Windows\\System32\\cmd.exe';
      const sys322 = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32') : 'C:\\Windows\\System32';
      const execEnv = { ...process.env, CI: 'true', CLAUDE_NO_TUI: '1' };
      execEnv.PATH = sys322 + ';' + (process.env.PATH || '');
      const cmdLine2 = sessionId
        ? `${CLAUDE_BIN} --resume ${sessionId}`
        : CLAUDE_BIN;

      // Node 24 spawn bug: cwd 跨盘符会 ENOENT。先 chdir 再 spawn
      const prevCwd2 = process.cwd();
      if (cwd) { try { process.chdir(cwd); } catch {} }
      const child = spawn(cmdExe2, ['/d', '/s', '/c', cmdLine2], {
        env: execEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      if (cwd) { try { process.chdir(prevCwd2); } catch {} }

      let stdout2 = '', stderr2 = '';
      child.stdout.on('data', d => stdout2 += d.toString('utf-8'));
      child.stderr.on('data', d => stderr2 += d.toString('utf-8'));
      child.on('error', err => {
        if (sessionId) { sessionBusy.delete(sessionId); runningProcs.delete(sessionId); }
        res.json({ status: 'completed', stdout: '', stderr: err.message, code: 1, newSessionId: null });
      });
      child.on('exit', code => {
        if (sessionId) { sessionBusy.delete(sessionId); runningProcs.delete(sessionId); }
        let newSessionId = null;
        if (!sessionId && cwd) {
          try {
            const encoded = encodeProject(cwd);
            const projDir = path.join(PROJECTS_DIR, encoded);
            if (fs.existsSync(projDir)) {
              const files = fs.readdirSync(projDir).filter(f => f.endsWith('.jsonl'));
              if (files.length > 0) {
                let latest = null, latestTime = 0;
                for (const f of files) {
                  const stat = fs.statSync(path.join(projDir, f));
                  if (stat.mtimeMs > latestTime) { latestTime = stat.mtimeMs; latest = f; }
                }
                newSessionId = latest ? latest.replace('.jsonl', '') : null;
              }
            }
          } catch {}
        }
        try { upsertCastBridge(cwd, sessionId || newSessionId); } catch {}
        res.json({ status: 'completed', stdout: stdout2, stderr: stderr2, code: code || 0, newSessionId });
      });

      child.stdin.write(message);
      child.stdin.end();
      if (sessionId) { sessionBusy.add(sessionId); runningProcs.set(sessionId, child); }
    } catch (err) {
      res.status(500).json({ status: 'completed', stdout: '', stderr: err.message, code: 1 });
    }
    return;
  }

  // ── TG：spawn + stdout 实时权限检测 + 流式输出 ──
  const trackId = sessionId || `tg-${Date.now()}`;
  // 新会话：spawn 前记录所有项目所有 JSONL，exit 后用差集找新建的会话文件
  const preFiles = new Set();
  if (!sessionId) {
    try {
      for (const d of fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        for (const f of fs.readdirSync(path.join(PROJECTS_DIR, d.name))) {
          if (f.endsWith('.jsonl')) preFiles.add(`${d.name}/${f}`);
        }
      }
    } catch {}
  }
  try {
    const cmdExe = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'cmd.exe') : 'C:\\Windows\\System32\\cmd.exe';
    const sys32 = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32') : 'C:\\Windows\\System32';
    const execEnv = { ...process.env, CI: 'true', CLAUDE_NO_TUI: '1' };
    execEnv.PATH = sys32 + ';' + (process.env.PATH || '');
    const cmdLine = sessionId
      ? `${CLAUDE_BIN} --resume ${sessionId}`
      : `${CLAUDE_BIN} -p`;

    const prevCwd = process.cwd();
    if (cwd) { try { process.chdir(cwd); } catch {} }
    const child = spawn(cmdExe, ['/d', '/s', '/c', cmdLine], {
      env: execEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (cwd) { try { process.chdir(prevCwd); } catch {} }

    const procState = {
      child, stdoutBuf: '', stderrBuf: '',
      state: 'running', exitCode: null, waitResolve: null,
    };
    runningProcs.set(trackId, procState);
    if (sessionId) sessionBusy.add(sessionId);

    // ── 流式模式：NDJSON 逐行写 HTTP 响应 ──
    const useStream = req.body.stream === true;
    if (useStream) {
      res.setHeader('Content-Type', 'application/x-ndjson');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      let streamEnded = false;
      function writeLine(obj) { if (!streamEnded) { try { res.write(JSON.stringify(obj) + '\n'); } catch {} } }
      function endStream(obj) { if (!streamEnded) { streamEnded = true; try { res.end(JSON.stringify(obj || {}) + '\n'); } catch {} } }
      const cleanup = () => { setTimeout(() => { runningProcs.delete(trackId); if (sessionId) sessionBusy.delete(sessionId); }, 30000); };

      child.stdout.on('data', d => {
        const text = d.toString('utf-8');
        procState.stdoutBuf += text;
        if (procState.state === 'running' && detectPermissionPrompt(procState.stdoutBuf)) {
          procState.state = 'waiting_permission';
          endStream({ type: 'permission_needed', pendingSessionId: trackId, stdout: procState.stdoutBuf, stderr: procState.stderrBuf });
          return;
        }
        writeLine({ type: 'chunk', text });
      });
      child.stderr.on('data', d => { procState.stderrBuf += d.toString('utf-8'); });
      child.on('error', err => {
        procState.state = 'exited'; procState.exitCode = 1; procState.stderrBuf += err.message;
        endStream({ type: 'error', message: err.message });
        cleanup();
      });
      child.on('exit', code => {
        procState.state = 'exited'; procState.exitCode = code;
        const completed = buildCompletedResponse(procState, cwd, sessionId, preFiles);
        endStream({ type: 'done', ...completed });
        cleanup();
      });

      // Gateway 断开 → 杀 Claude 进程
      res.on('close', () => {
        if (procState.state !== 'exited') {
          try { execSync(`taskkill /f /pid ${child.pid}`, { timeout: 3000, windowsHide: true }); } catch {}
          procState.state = 'exited'; procState.exitCode = 1;
        }
      });

      // 180s 超时
      const streamTimeout = setTimeout(() => {
        if (procState.state !== 'exited') {
          try { execSync(`taskkill /f /pid ${child.pid}`, { timeout: 3000, windowsHide: true }); } catch {}
          procState.state = 'exited'; procState.exitCode = 1;
          endStream({ type: 'done', status: 'completed', stdout: procState.stdoutBuf, stderr: 'Timeout', code: 1, newSessionId: null });
        }
      }, 180000);
      res.on('close', () => clearTimeout(streamTimeout));

      child.stdin.write(message + '\n');
      child.stdin.end();
      return; // 不执行下面的 await Promise 路径
    }

    // ── 非流式（企微）：积累全部 stdout 后一次返回 ──
    child.stdout.on('data', d => {
      procState.stdoutBuf += d.toString('utf-8');
      if (procState.state === 'running' && detectPermissionPrompt(procState.stdoutBuf)) {
        procState.state = 'waiting_permission';
        if (procState.waitResolve) { const r = procState.waitResolve; procState.waitResolve = null; r({ status: 'permission_needed', stdout: procState.stdoutBuf, stderr: procState.stderrBuf, pendingSessionId: trackId }); }
      }
    });
    child.stderr.on('data', d => { procState.stderrBuf += d.toString('utf-8'); });
    child.on('error', err => { procState.state = 'exited'; procState.exitCode = 1; procState.stderrBuf += err.message; if (procState.waitResolve) { const r = procState.waitResolve; procState.waitResolve = null; r(buildCompletedResponse(procState, cwd, sessionId, preFiles)); } setTimeout(() => { runningProcs.delete(trackId); if (sessionId) sessionBusy.delete(sessionId); }, 30000); });
    child.on('exit', code => {
      procState.state = 'exited'; procState.exitCode = code;
      if (procState.waitResolve) { const r = procState.waitResolve; procState.waitResolve = null; r(buildCompletedResponse(procState, cwd, sessionId, preFiles)); }
      setTimeout(() => { runningProcs.delete(trackId); if (sessionId) sessionBusy.delete(sessionId); }, 30000);
    });

    // 180s 超时
    const timeout = setTimeout(() => {
      if (procState.state !== 'exited') { try { execSync(`taskkill /f /pid ${child.pid}`, { timeout: 3000, windowsHide: true }); } catch {} procState.state = 'exited'; procState.exitCode = 1; if (procState.waitResolve) { const r = procState.waitResolve; procState.waitResolve = null; r({ status: 'completed', stdout: procState.stdoutBuf, stderr: 'Timeout', code: 1 }); } }
    }, 180000);

    child.stdin.write(message + '\n');
    child.stdin.end();

    const result = await new Promise(resolve => {
      if (procState.state === 'exited') resolve(buildCompletedResponse(procState, cwd, sessionId, preFiles));
      else if (procState.state === 'waiting_permission') resolve({ status: 'permission_needed', stdout: procState.stdoutBuf, stderr: procState.stderrBuf, pendingSessionId: trackId });
      else procState.waitResolve = resolve;
    });
    clearTimeout(timeout);
    res.json(result);
  } catch (err) {
    runningProcs.delete(trackId);
    if (sessionId) sessionBusy.delete(sessionId);
    res.status(500).json({ status: 'completed', stdout: '', stderr: err.message, code: 1 });
  }
});

// POST /api/list-sessions — 列出项目会话
app.post('/api/list-sessions', (req, res) => {
  let { projectPath } = req.body;
  if (!projectPath) return res.status(400).json({ error: 'projectPath required' });
  if (projectPath) projectPath = projectPath.replace(/\\\\/g, '\\');

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
      if (!bestSummary || bestSummary.length < 2) continue; // 空/单字乱码
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

    // 读 Agent 维护的 Bridge 会话注册表（.bridge/bridge-sessions.json）
    let bridgeSessions = new Set();
    try {
      const regPath = path.join(projectPath, '.bridge', 'bridge-sessions.json');
      if (fs.existsSync(regPath)) {
        bridgeSessions = new Set(JSON.parse(fs.readFileSync(regPath, 'utf-8')));
      }
    } catch {}

    for (const s of sessions) {
      if (sessionNames[s.id]) s.name = sessionNames[s.id];
      // 优先 Agent 注册表（Bridge 创建的 vscode 会话），其次 entrypoint（旧 sdk-cli 会话）
      if (bridgeSessions.has(s.id)) s.source = 'bridge';
      else if (s.entrypoint && s.entrypoint !== 'claude-vscode') s.source = 'bridge';
      else s.source = 'vscode';
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

    // 最近 3 轮（摘要用，截断到 100 字）
    const recentRounds = rounds.slice(-3).map(r => ({
      user: r.user.slice(0, 100),
      assistant: r.assistant ? r.assistant.slice(0, 100) : '(未回复)',
    }));
    // 全部轮次（TG 分页预览用，截断到 500 字/条）
    const allRounds = rounds.map(r => ({
      user: r.user.slice(0, 500),
      assistant: r.assistant ? r.assistant.slice(0, 500) : '(未回复)',
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
      allRounds,
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

// 幂等 upsert 一行：按 UUID8 匹配；已存在则保留「来源/角色/在做」，只刷新 名称/时间
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
      const src = c[3] || row.source; // 保留已有来源（SessionStart hook 设为「交互」时不被 Agent 覆写）
      const role = c[4] || '(未标注)';
      const doing = c[5] || '';
      lines[idx] = `| ${row.name} | ${row.uuid8} | ${src} | ${role} | ${doing} | ${ts} |`;
      text = lines.join('\n');
    } else {
      text = text.replace(/\s*$/, '') + `\n| ${row.name} | ${row.uuid8} | ${row.source} | (未标注) |  | ${ts} |\n`;
    }
    fs.writeFileSync(rosterPath, text, 'utf-8');
  } catch {}
}

// 把一个 Bridge 会话登记进项目根 CAST_OF_SESSIONS.md（标 🌉 Bridge）
// 同时写 .bridge/bridge-sessions.json，供 list-sessions 判断 source
function registerBridgeSession(projectPath, sessionId) {
  if (!projectPath || !sessionId) return;
  if (!fs.existsSync(projectPath)) return;
  try {
    const bridgeDir = path.join(projectPath, '.bridge');
    if (!fs.existsSync(bridgeDir)) fs.mkdirSync(bridgeDir, { recursive: true });
    const regPath = path.join(bridgeDir, 'bridge-sessions.json');
    let ids = [];
    try { ids = JSON.parse(fs.readFileSync(regPath, 'utf-8')); } catch {}
    if (!ids.includes(sessionId)) {
      ids.push(sessionId);
      fs.writeFileSync(regPath, JSON.stringify(ids), 'utf-8');
    }
  } catch {}
}
function upsertCastBridge(projectPath, sessionId) {
  if (!projectPath || !sessionId) return;
  if (!fs.existsSync(projectPath)) return; // 🛡️ 项目已被删除就跳过，别复活它
  registerBridgeSession(projectPath, sessionId);
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

// GET /api/busy-sessions — 三信号判断会话是否正在执行
const BUSY_MTIME_MS = 10000;
app.get('/api/busy-sessions', (req, res) => {
  try {
    const now = Date.now();
    const busySet = new Map(); // sid → { name, project, why }

    // 信号1: Agent 自己驱动的（Bridge/API 路径，精确）
    for (const sid of sessionBusy) {
      busySet.set(sid, { name: sid.slice(0, 8), project: '', why: 'agent' });
    }

    if (fs.existsSync(PROJECTS_DIR)) {
      for (const d of fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        try {
          for (const f of fs.readdirSync(path.join(PROJECTS_DIR, d.name))) {
            if (!f.endsWith('.jsonl')) continue;
            const sid = f.replace('.jsonl', '');
            const jsonlPath = path.join(PROJECTS_DIR, d.name, f);
            let stat;
            try { stat = fs.statSync(jsonlPath); } catch { continue; }

            const meta = getSessionMeta(jsonlPath, sid);
            const info = { name: meta.sessionName || sid.slice(0, 8),
              project: meta.projectPath ? meta.projectPath.split('\\').filter(Boolean).pop() : '',
              why: '' };

            // 信号2: JSONL 最近 30 秒内有写入
            if (now - stat.mtimeMs <= BUSY_MTIME_MS) {
              info.why = 'writing';
              busySet.set(sid, info);
              continue;
            }

            // 信号3: 最后一行是 user + 文件最近 5 分钟有写入 = 收到消息正在处理中
            if (!busySet.has(sid) && (now - stat.mtimeMs <= 300000)) {
              try {
                const content = fs.readFileSync(jsonlPath, 'utf-8');
                const lines = content.split('\n').filter(Boolean);
                if (lines.length > 0) {
                  const last = JSON.parse(lines[lines.length - 1]);
                  if (last.type === 'user') {
                    info.why = 'pending';
                    busySet.set(sid, info);
                  }
                }
              } catch {}
            }
          }
        } catch {}
      }
    }

    const busyList = [];
    for (const [id, info] of busySet) {
      busyList.push({ id, name: info.name, project: info.project });
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

// POST /api/stop-claude — 强制终止正在运行的 Claude 进程
app.post('/api/stop-claude', (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  const entry = runningProcs.get(sessionId);
  // entry 可能是 ChildProcess（非 TG exec 模式）或 procState 对象（TG spawn 模式）
  const child = entry?.child || entry; // procState 对象有 .child 属性；旧格式直接是 ChildProcess
  if (child && typeof child.pid === 'number') {
    try { execSync(`taskkill /f /pid ${child.pid}`, { timeout: 5000, windowsHide: true }); } catch {}
    // 清理 procState
    if (entry?.state) entry.state = 'exited';
    runningProcs.delete(sessionId);
    sessionBusy.delete(sessionId);
    res.json({ status: 'killed', pid: child.pid });
  } else {
    // fallback: 按 session UUID 搜 claude 命令行
    try {
      const result = execSync(
        `wmic process where "name='claude.exe' and commandline like '%${sessionId}%'" get processid`,
        { timeout: 5000, windowsHide: true, encoding: 'utf-8' }
      );
      const pids = result.split('\n').map(l => l.trim()).filter(l => /^\d+$/.test(l));
      for (const pid of pids) {
        try { execSync(`taskkill /f /pid ${pid}`, { timeout: 3000, windowsHide: true }); } catch {}
      }
      res.json({ status: 'killed_by_search', count: pids.length });
    } catch {
      res.json({ status: 'not_found' });
    }
  }
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
