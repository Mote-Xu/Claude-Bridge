const { Client } = require('ssh2');
const fs = require('fs');
const config = require('./config');

// SSH 到 Windows，执行 claude --resume，返回输出
async function execClaude(sessionId, message, options = {}) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const { host, username, privateKey } = config.local;
    let stdout = '';
    let stderr = '';

    conn.on('ready', () => {
      const cwd = (options.cwd || '').replace(/\\/g, '\\\\');
      const escaped = message
        .replace(/%/g, '%%')    // cmd.exe 特殊字符
        .replace(/\r?\n/g, ' ');

      // Windows: 用 echo + pipe 把消息喂给 claude --resume
      // claude --resume <id> 进入交互模式，从 stdin 读取
      const claudeBin = 'C:\\Users\\Mote\\AppData\\Roaming\\npm\\claude.cmd';
      const cmd = [
        cwd && cwd.length > 2 ? `${cwd.slice(0,2)}` : '',
        cwd ? `cd /d "${cwd}"` : '',
        sessionId
          ? `echo ${escaped}| "${claudeBin}" --resume "${sessionId}"`
          : `echo ${escaped}| "${claudeBin}"`,
      ].filter(Boolean).join(' && ');

      conn.exec(cmd, { pty: false }, (err, stream) => {
        if (err) {
          conn.end();
          return reject(err);
        }

        stream.on('data', (data) => {
          const text = data.toString();
          stdout += text;
          if (options.onOutput) options.onOutput(text);
        });

        stream.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        stream.on('close', (code) => {
          conn.end();
          resolve({ stdout, stderr, code });
        });
      });
    });

    conn.on('error', (err) => {
      reject(err);
    });

    conn.connect({
      host,
      port: 22,
      username,
      privateKey: fs.readFileSync(privateKey),
      readyTimeout: 10000,
    });
  });
}

// 健康检查
function healthCheck() {
  return new Promise((resolve) => {
    const conn = new Client();
    const { host, username, privateKey } = config.local;
    const t = setTimeout(() => { conn.end(); resolve(false); }, 5000);
    conn.on('ready', () => { clearTimeout(t); conn.end(); resolve(true); });
    conn.on('error', () => { clearTimeout(t); resolve(false); });
    conn.connect({ host, port: 22, username, privateKey: fs.readFileSync(privateKey), readyTimeout: 5000 });
  });
}

module.exports = { execClaude, healthCheck };
