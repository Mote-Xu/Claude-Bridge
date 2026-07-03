// Session Manager — 管理持久 Claude Code 进程
const { Client } = require('ssh2');
const fs = require('fs');
const config = require('./config');

const sessions = new Map(); // sessionId → { conn, stream, stdin, onOutput }

function getOrCreate(sessionId) {
  return sessions.get(sessionId) || null;
}

function hasActive(sessionId) {
  return sessions.has(sessionId);
}

async function createSession(sessionId, projectPath, claudeSessionId, onOutput) {
  if (sessions.has(sessionId)) {
    return; // already exists
  }

  const { host, username, privateKey } = config.ssh || config.local;
  const claudeBin = 'C:\\Users\\Mote\\AppData\\Roaming\\npm\\claude.cmd';
  const resumeFlag = claudeSessionId ? ` --resume "${claudeSessionId}"` : '';

  return new Promise((resolve, reject) => {
    const conn = new Client();
    const connected = () => {
      const cmd = `cmd /c "cd /d \\\"${projectPath}\\\" && \\\"${claudeBin}\\\"${resumeFlag}"`;

      conn.exec(cmd, { pty: true }, (err, stream) => {
        if (err) { conn.end(); return reject(err); }

        let buffer = '';
        const onData = (data) => {
          const text = data.toString();
          buffer += text;
          // 流式推送（批量，避免刷屏）
          if (buffer.length > 200 || text.includes('\n')) {
            onOutput(text);
            buffer = '';
          }
        };

        stream.on('data', onData);
        stream.stderr.on('data', onData);

        stream.on('close', () => {
          // Claude 退出，清理
          sessions.delete(sessionId);
          conn.end();
          if (buffer) onOutput(buffer);
        });

        sessions.set(sessionId, {
          conn,
          stream,
          stdin: stream,
          onOutput,
        });

        resolve();
      });
    };

    conn.on('ready', connected);
    conn.on('error', reject);
    conn.connect({
      host, port: 22, username,
      privateKey: fs.readFileSync(privateKey),
      readyTimeout: 30000,
    });
  });
}

function sendMessage(sessionId, text) {
  const session = sessions.get(sessionId);
  if (!session) return false;

  // 通过 stdin 写入消息（pty 模式支持 write）
  const msgB64 = Buffer.from(text + '\n', 'utf-8').toString('base64');
  // 用 base64 解码后写入 stdin，避免编码问题
  const decoded = Buffer.from(msgB64, 'base64').toString('utf-8');
  session.stdin.write(decoded);
  return true;
}

function stopSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return false;

  // 发送 Ctrl+C
  session.stdin.write('\x03');
  return true;
}

function endSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return false;

  // 发送 exit / Ctrl+D
  session.stdin.write('\x04');
  setTimeout(() => {
    if (sessions.has(sessionId)) {
      session.conn.end();
      sessions.delete(sessionId);
    }
  }, 2000);
  return true;
}

module.exports = { createSession, sendMessage, stopSession, endSession, hasActive, getOrCreate };
