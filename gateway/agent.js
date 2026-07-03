// Agent HTTP Client — 替代 SSH 远程执行
// 调用 Windows Agent (Express 9877)，SSH 作为 fallback

const http = require('http');
const config = require('./config');
const ssh = require('./ssh');

const AGENT_HOST = config.agent?.host || '100.80.205.79';
const AGENT_PORT = config.agent?.port || 9877;
const AGENT_TIMEOUT = config.agent?.timeout || 10000;

// 通用 HTTP 请求
function agentCall(method, path, body = null, timeout = AGENT_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: AGENT_HOST,
      port: AGENT_PORT,
      path,
      method,
      timeout,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    };

    const req = http.request(options, (res) => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); }
        catch { resolve(buf); }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Agent timeout')); });

    if (data) req.write(data);
    req.end();
  });
}

// ========== 对外接口（与 ssh.js 同名同参，可直接替换 require） ==========

// 执行 Claude Code
async function execClaude(sessionId, message, options = {}) {
  try {
    const res = await agentCall('POST', '/api/run-claude',
      { sessionId, message, cwd: options.cwd }, 185000);
    return {
      stdout: res.stdout || '',
      stderr: res.stderr || '',
      code: res.code || 0,
      newSessionId: res.newSessionId || null,
    };
  } catch (err) {
    console.log(`Agent /api/run-claude failed: ${err.message}, falling back to SSH`);
    return ssh.execClaude(sessionId, message, options);
  }
}

// 健康检查
async function healthCheck() {
  try {
    const res = await agentCall('GET', '/api/health', null, 5000);
    return res.status === 'ok';
  } catch {
    // Agent 不通，尝试 SSH fallback
    return ssh.healthCheck();
  }
}

// 自动发现项目
async function getProjects() {
  try {
    const res = await agentCall('POST', '/api/discover', null, 15000);
    if (res.projects && Object.keys(res.projects).length > 0) return res.projects;
    return config.projects || {};
  } catch (err) {
    console.log(`Agent /api/discover failed: ${err.message}, falling back to SSH`);
    return ssh.getProjects();
  }
}

// 项目会话列表
async function listSessions(projectPath) {
  try {
    const res = await agentCall('POST', '/api/list-sessions', { projectPath }, 8000);
    return (res.sessions || []).slice(0, 20);
  } catch (err) {
    console.log(`Agent /api/list-sessions failed: ${err.message}, falling back to SSH`);
    return ssh.listSessions(projectPath);
  }
}

// 找最新会话
async function findLatestSession(projectPath) {
  try {
    const res = await agentCall('POST', '/api/find-latest-session', { projectPath }, 5000);
    return res.sessionId || null;
  } catch (err) {
    console.log(`Agent /api/find-latest-session failed: ${err.message}, falling back to SSH`);
    return ssh.findLatestSession(projectPath);
  }
}

// 获取会话 ID 集合（用于比对新会话）
async function getSessionIds(projectPath) {
  try {
    const res = await agentCall('POST', '/api/list-sessions', { projectPath }, 5000);
    return new Set((res.sessions || []).map(s => s.id));
  } catch {
    return ssh.getSessionIds(projectPath);
  }
}

module.exports = { execClaude, healthCheck, getProjects, listSessions, findLatestSession, getSessionIds, agentCall };
