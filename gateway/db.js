const Database = require('better-sqlite3');
const path = require('path');

let db;

function init(dbPath) {
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    -- 群组 → 项目映射
    CREATE TABLE IF NOT EXISTS groups (
      chat_id TEXT PRIMARY KEY,
      project_name TEXT NOT NULL,
      project_path TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- 活跃会话（群内的 @会话名）
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      session_name TEXT NOT NULL,       -- @会话名（用户第一次说的话）
      session_slug TEXT NOT NULL,       -- 机器可读的标识（用于 tmux window 名）
      claude_session_id TEXT,          -- Claude Code 的 session ID（--resume）
      tmux_window TEXT NOT NULL,       -- tmux window 名称
      pipe_file TEXT NOT NULL,         -- 输出管道文件路径
      status TEXT DEFAULT 'active',    -- active | idle | ended
      last_active TEXT DEFAULT (datetime('now')),
      message_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(chat_id, session_slug)
    );

    -- 任务队列（本地离线时的缓存）
    CREATE TABLE IF NOT EXISTS task_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      session_id INTEGER REFERENCES sessions(id),
      message TEXT NOT NULL,
      sender TEXT,
      status TEXT DEFAULT 'pending',   -- pending | processing | done | failed
      created_at TEXT DEFAULT (datetime('now')),
      processed_at TEXT
    );

    -- 审计日志
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT,
      session_id INTEGER,
      direction TEXT NOT NULL,          -- 'in' (用户→Claude) | 'out' (Claude→用户)
      content TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- 初始化已存在的记录的状态
    UPDATE sessions SET status = 'ended' WHERE status = 'active';
  `);

  return db;
}

// === Groups ===
function getGroup(chatId) {
  return db.prepare('SELECT * FROM groups WHERE chat_id = ?').get(chatId);
}

function addGroup(chatId, projectName, projectPath) {
  return db.prepare(
    'INSERT OR REPLACE INTO groups (chat_id, project_name, project_path) VALUES (?, ?, ?)'
  ).run(chatId, projectName, projectPath);
}

function removeGroup(chatId) {
  db.prepare('DELETE FROM groups WHERE chat_id = ?').run(chatId);
  db.prepare('DELETE FROM sessions WHERE chat_id = ?').run(chatId);
}

// === Sessions ===
function getSession(chatId, sessionSlug) {
  return db.prepare('SELECT * FROM sessions WHERE chat_id = ? AND session_slug = ?')
    .get(chatId, sessionSlug);
}

function getActiveSessions(chatId) {
  return db.prepare(
    "SELECT * FROM sessions WHERE chat_id = ? AND status != 'ended' ORDER BY last_active DESC"
  ).all(chatId);
}

function createSession(chatId, sessionName, sessionSlug, claudeSessionId, tmuxWindow, pipeFile) {
  return db.prepare(`
    INSERT INTO sessions (chat_id, session_name, session_slug, claude_session_id, tmux_window, pipe_file, status)
    VALUES (?, ?, ?, ?, ?, ?, 'active')
  `).run(chatId, sessionName, sessionSlug, claudeSessionId, tmuxWindow, pipeFile);
}

function updateSessionStatus(id, status) {
  return db.prepare(
    "UPDATE sessions SET status = ?, last_active = datetime('now') WHERE id = ?"
  ).run(status, id);
}

function touchSession(id) {
  return db.prepare(
    "UPDATE sessions SET last_active = datetime('now'), message_count = message_count + 1 WHERE id = ?"
  ).run(id);
}

function getIdleSessions(hours) {
  return db.prepare(
    `SELECT * FROM sessions WHERE status = 'active'
     AND last_active < datetime('now', '-' || ? || ' hours')`
  ).all(hours);
}

function endSession(id) {
  return db.prepare(
    "UPDATE sessions SET status = 'ended', last_active = datetime('now') WHERE id = ?"
  ).run(id);
}

function listSessions(chatId) {
  return db.prepare(
    'SELECT * FROM sessions WHERE chat_id = ? ORDER BY last_active DESC'
  ).all(chatId);
}

// === Task Queue ===
function enqueueTask(chatId, sessionId, message, sender) {
  return db.prepare(
    'INSERT INTO task_queue (chat_id, session_id, message, sender) VALUES (?, ?, ?, ?)'
  ).run(chatId, sessionId, message, sender);
}

function getPendingTasks(chatId) {
  return db.prepare(
    "SELECT * FROM task_queue WHERE chat_id = ? AND status = 'pending' ORDER BY created_at ASC"
  ).all(chatId);
}

function markTaskStatus(id, status) {
  return db.prepare(
    "UPDATE task_queue SET status = ?, processed_at = datetime('now') WHERE id = ?"
  ).run(status, id);
}

// === Audit ===
function auditLog(chatId, sessionId, direction, content) {
  return db.prepare(
    'INSERT INTO audit_log (chat_id, session_id, direction, content) VALUES (?, ?, ?, ?)'
  ).run(chatId, sessionId, direction, content);
}

module.exports = {
  init,
  getGroup, addGroup, removeGroup,
  getSession, getActiveSessions, createSession,
  updateSessionStatus, touchSession, getIdleSessions, endSession,
  listSessions,
  enqueueTask, getPendingTasks, markTaskStatus,
  auditLog,
};
