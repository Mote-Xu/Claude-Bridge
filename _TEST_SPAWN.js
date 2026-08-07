const { spawn, execSync } = require('child_process');
const path = require('path');
const os = require('os');

const cmdExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
const sys32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const CLAUDE_BIN = path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'claude.cmd');

const cmdLine = CLAUDE_BIN + ' --resume ee8abbf4-643c-467f-9231-5d4321a64d45';
console.log('Spawning: ' + cmdExe + ' /d /s /c ' + cmdLine);

const execEnv = { ...process.env, CI: 'true', CLAUDE_NO_TUI: '1' };
execEnv.PATH = sys32 + ';' + (process.env.PATH || '');

const child = spawn(cmdExe, ['/d', '/s', '/c', cmdLine], {
    env: execEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
});

let out = '', err = '';
child.stdout.on('data', d => { out += d.toString(); process.stdout.write(d.toString()); });
child.stderr.on('data', d => { err += d.toString(); });
child.on('error', e => console.error('ERROR EVENT:', e.message));
const start = Date.now();

child.on('exit', code => {
    console.log('\nEXIT code=' + code + ' time=' + (Date.now() - start) + 'ms stdout=' + out.length + 'B stderr=' + err.length + 'B');
    if (err) console.log('STDERR:', err);
});

// Write to stdin like Agent does
child.stdin.write('从1到10，逐行输出\n');
child.stdin.end();

// Kill after 10s
setTimeout(() => {
    console.log('\nKILLING at ' + (Date.now() - start) + 'ms');
    try { execSync('taskkill /f /pid ' + child.pid, { windowsHide: true }); }
    catch (e) { console.log('KILL failed:', e.message.slice(0, 200)); }
}, 10000);
