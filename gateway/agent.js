// Agent HTTP Client — 直接调 Windows Agent (Express :9877)

const http = require('http');
const config = require('./config');

const AGENT_HOST = config.agent?.host || '100.80.205.79';
const AGENT_PORT = config.agent?.port || 9877;
const AGENT_TIMEOUT = config.agent?.timeout || 10000;

function agentCall(method, path, body = null, timeout = AGENT_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: AGENT_HOST, port: AGENT_PORT, path, method, timeout,
      headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) },
    };
    const req = http.request(options, (res) => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve(buf); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Agent timeout')); });
    if (data) req.write(data);
    req.end();
  });
}

async function execClaude(sessionId, message, options = {}) {
  const body = { sessionId, message, cwd: options.cwd };
  if (options.platform) body.platform = options.platform;
  if (options.dbSessionId != null) body.dbSessionId = options.dbSessionId;
  // TG 流式模式超时更短（每次里程碑 120s），非 TG 保持 185s
  const timeout = options.platform === 'telegram' ? 185000 : 185000;
  const res = await agentCall('POST', '/api/run-claude', body, timeout);
  return {
    status: res.status || 'completed',
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    code: res.code || 0,
    newSessionId: res.newSessionId || null,
    pendingSessionId: res.pendingSessionId || null,
    prompt: res.prompt || null,
  };
}

// execClaudeStream — TG 流式模式：NDJSON 逐行读到回调，返回 req 对象用于 abort
// 返回 Promise<http.ClientRequest>；流程完成后回调 onDone
function execClaudeStream(sessionId, message, options, callbacks) {
  const { onChunk, onPermission, onDone } = callbacks;
  const body = JSON.stringify({
    sessionId, message, cwd: options.cwd,
    platform: options.platform || 'telegram',
    stream: true,
    ...(options.dbSessionId != null ? { dbSessionId: String(options.dbSessionId) } : {}),
  });
  const timeout = 185000;

  const req = http.request({
    hostname: AGENT_HOST, port: AGENT_PORT,
    path: '/api/run-claude', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    timeout,
  }, (res) => {
    let buf = '';
    let done = false;
    function finish(evt) {
      if (done) return; done = true;
      onDone(evt || { status: 'completed', stdout: '', stderr: '', code: 0, newSessionId: null });
    }
    res.on('data', d => {
      buf += d.toString('utf-8');
      const lines = buf.split('\n');
      buf = lines.pop(); // 保留不完整行
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line);
          switch (evt.type) {
            case 'chunk': onChunk(evt.text); break;
            case 'permission_needed': finish(evt); break;
            case 'done': finish(evt); break;
            case 'error': finish({ status: 'completed', stdout: '', stderr: evt.message, code: 1, newSessionId: null }); break;
          }
        } catch {}
      }
    });
    res.on('end', () => {
      // 处理 buffer 中剩余的最后一个 JSON 对象
      if (!done && buf.trim()) {
        try {
          const evt = JSON.parse(buf);
          if (evt.type === 'done' || evt.type === 'permission_needed') finish(evt);
          else finish();
        } catch { finish(); }
      } else if (!done) { finish(); }
    });
    res.on('error', () => finish({ status: 'completed', stdout: '', stderr: 'Connection error', code: 1, newSessionId: null }));
  });

  req.on('error', (err) => {
    onDone({ status: 'completed', stdout: '', stderr: err.message, code: 1, newSessionId: null });
  });
  req.on('timeout', () => {
    req.destroy();
    onDone({ status: 'completed', stdout: '', stderr: 'Agent timeout', code: 1, newSessionId: null });
  });
  req.write(body);
  req.end();

  return req; // 返回 ClientRequest 用于 abort
}

// writeStdin — TG 权限交互第二阶段：再调一次 execClaude 写 yes/no
// 两阶段模型：每次调 /api/run-claude 都是一次完整的 stdin→stdout 往返
async function writeStdin(sessionId, input, cwd) {
  return execClaude(sessionId, input, { cwd, platform: 'telegram' });
}

async function healthCheck() {
  try { const r = await agentCall('GET', '/api/health', null, 5000); return r.status === 'ok'; }
  catch { return false; }
}

async function getProjects() {
  try {
    const res = await agentCall('POST', '/api/discover', null, 15000);
    if (res.projects && Object.keys(res.projects).length > 0) return res.projects;
  } catch {}
  return config.projects || {};
}

async function listSessions(projectPath) {
  try {
    const res = await agentCall('POST', '/api/list-sessions', { projectPath }, 8000);
    return (res.sessions || []).slice(0, 20);
  } catch { return []; }
}

async function findLatestSession(projectPath) {
  try {
    const res = await agentCall('POST', '/api/find-latest-session', { projectPath }, 5000);
    return res.sessionId || null;
  } catch { return null; }
}

async function getSessionIds(projectPath) {
  try {
    const res = await agentCall('POST', '/api/list-sessions', { projectPath }, 5000);
    return new Set((res.sessions || []).map(s => s.id));
  } catch { return new Set(); }
}

async function recordChronicle(projectPath, sessionName, type, content, source) {
  try {
    await agentCall('POST', '/api/chronicle', { projectPath, sessionName, type, content, source }, 5000);
  } catch {} // 静默失败
}

// 触发 Agent 扫描 JSONL → chronicle（覆盖 VS Code 会话）
async function syncChronicles() {
  try {
    const res = await agentCall('POST', '/api/sync-chronicles', null, 15000);
    return res.synced || 0;
  } catch { return 0; }
}

async function reloadAgent() {
  try { await agentCall('POST', '/api/reload', null, 5000); return true; } catch { return false; }
}

module.exports = { execClaude, execClaudeStream, writeStdin, healthCheck, getProjects, listSessions, findLatestSession, getSessionIds, agentCall, recordChronicle, syncChronicles, reloadAgent };
