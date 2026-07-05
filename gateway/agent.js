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
  const res = await agentCall('POST', '/api/run-claude', { sessionId, message, cwd: options.cwd }, 185000);
  return { stdout: res.stdout || '', stderr: res.stderr || '', code: res.code || 0, newSessionId: res.newSessionId || null };
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
  } catch {} // 静默失败，不阻塞主流程
}

async function reloadAgent() {
  try { await agentCall('POST', '/api/reload', null, 5000); return true; } catch { return false; }
}

module.exports = { execClaude, healthCheck, getProjects, listSessions, findLatestSession, getSessionIds, agentCall, recordChronicle, reloadAgent };
