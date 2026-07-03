const Database = require('better-sqlite3');

let db;

function init(dbPath) {
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS groups (
      chat_id TEXT PRIMARY KEY,
      project_name TEXT NOT NULL,
      project_path TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      session_name TEXT NOT NULL,
      claude_session_id TEXT,
      status TEXT DEFAULT 'active',
      last_active TEXT DEFAULT (datetime('now')),
      message_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS task_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      session_id INTEGER,
      message TEXT NOT NULL,
      sender TEXT,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now')),
      processed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT,
      session_id INTEGER,
      direction TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  return db;
}

// === Groups ===
function getGroup(chatId) {
  return db.prepare('SELECT * FROM groups WHERE chat_id = ?').get(chatId);
}
function addGroup(chatId, projectName, projectPath) {
  return db.prepare('INSERT OR REPLACE INTO groups (chat_id, project_name, project_path) VALUES (?, ?, ?)')
    .run(chatId, projectName, projectPath);
}

// === Sessions ===
function getSessionByName(chatId, sessionName) {
  return db.prepare(
    "SELECT * FROM sessions WHERE chat_id = ? AND session_name = ? AND status != 'ended'"
  ).get(chatId, sessionName);
}
function getActiveSessions(chatId) {
  return db.prepare(
    "SELECT * FROM sessions WHERE chat_id = ? AND status != 'ended' ORDER BY last_active DESC"
  ).all(chatId);
}
function listSessions(chatId) {
  return db.prepare(
    'SELECT * FROM sessions WHERE chat_id = ? ORDER BY last_active DESC'
  ).all(chatId);
}
function createSession(chatId, sessionName, firstMessage) {
  return db.prepare(
    "INSERT INTO sessions (chat_id, session_name, status) VALUES (?, ?, 'active')"
  ).run(chatId, sessionName);
}
function updateClaudeSessionId(id, claudeSessionId) {
  return db.prepare('UPDATE sessions SET claude_session_id = ? WHERE id = ?')
    .run(claudeSessionId, id);
}
function touchSession(id) {
  return db.prepare(
    "UPDATE sessions SET last_active = datetime('now'), message_count = message_count + 1 WHERE id = ?"
  ).run(id);
}
function updateSessionStatus(id, status) {
  return db.prepare("UPDATE sessions SET status = ?, last_active = datetime('now') WHERE id = ?")
    .run(status, id);
}

// === Tasks ===
function enqueueTask(chatId, sessionId, message, sender) {
  return db.prepare('INSERT INTO task_queue (chat_id, session_id, message, sender) VALUES (?, ?, ?, ?)')
    .run(chatId, sessionId, message, sender);
}
function getPendingTasks(chatId) {
  return db.prepare(
    "SELECT * FROM task_queue WHERE chat_id = ? AND status = 'pending' ORDER BY created_at"
  ).all(chatId);
}
// 获取所有待处理任务（跨群），用于自动 drain
function getAllPendingTasks() {
  return db.prepare(
    "SELECT * FROM task_queue WHERE status = 'pending' ORDER BY created_at"
  ).all();
}
function markTaskProcessed(id) {
  return db.prepare(
    "UPDATE task_queue SET status = 'processed', processed_at = datetime('now') WHERE id = ?"
  ).run(id);
}

// === Audit ===
function auditLog(chatId, sessionId, direction, content) {
  return db.prepare('INSERT INTO audit_log (chat_id, session_id, direction, content) VALUES (?, ?, ?, ?)')
    .run(chatId, sessionId, direction, content);
}

// === Remove ===
function removeGroup(chatId) {
  db.prepare('DELETE FROM sessions WHERE chat_id = ?').run(chatId);
  return db.prepare('DELETE FROM groups WHERE chat_id = ?').run(chatId);
}

module.exports = {
  init,
  getGroup, addGroup, removeGroup,
  getSessionByName, getActiveSessions, listSessions,
  createSession, updateClaudeSessionId, touchSession, updateSessionStatus,
  enqueueTask, getPendingTasks, getAllPendingTasks, markTaskProcessed,
  auditLog,
};
