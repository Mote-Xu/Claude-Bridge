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
      // Base64 编码避免特殊字符问题
      const msgB64 = Buffer.from(message, 'utf-8').toString('base64');
      const cmd = [
        cwd ? `cd /d "${cwd}"` : '',
        `powershell -Command "[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${msgB64}')) | & '${claudeBin}'${sessionId ? ' --resume ' + sessionId : ''}"`,
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

// 自动发现 Claude Code 项目（读 %APPDATA%\claude\projects\）
async function getProjects() {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const { host, username, privateKey } = config.local;

    conn.on('ready', () => {
      // PowerShell: 输出每行一个项目，格式为 cwd|dirname
      const psCmd = 'powershell -Command "' +
        '$d=dir C:\\Users\\Mote\\.claude\\projects -Directory; ' +
        'foreach($p in $d){' +
          '$f=dir \\\"$($p.FullName)\\*.jsonl\\\" -EA 0|select -First 1; ' +
          'if($f){' +
            '$l=gc $f.FullName -First 20|%{if($_ -match \\\"cwd\\\"){$_}}|select -First 1; ' +
            'if($l -and $l -match \\\"\\\\u0022cwd\\\\u0022:\\\\u0022([^\\\\u0022]+)\\\\"\\\"){' +
              '$c=$matches[1] -replace \\\"\\\\\\\\\\\\\\\\\\\",\\\"\\\\\\\";' +
              'Write-Output \\\"$c`t$($p.Name)\\\"' +
            '}' +
          '}' +
        }"';
      conn.exec(psCmd, (err, stream) => {
        if (err) { conn.end(); return resolve({}); }
        let data = '';
        stream.on('data', (d) => data += d.toString());
        stream.on('close', () => {
          conn.end();
          const projects = {};
          data.trim().split(/\r?\n/).filter(Boolean).forEach(line => {
            const [cwd, ...rest] = line.split('\t');
             if (cwd) {
              const name = cwd.split('\\').filter(Boolean).pop() || rest[0] || '';
              if (name) projects[name] = cwd;
            }
          });
          resolve(projects);
        });
      });
    });
    conn.on('error', () => resolve({}));
    conn.connect({ host, port: 22, username, privateKey: fs.readFileSync(privateKey), readyTimeout: 10000 });
  });
}

module.exports = { execClaude, healthCheck, getProjects };
