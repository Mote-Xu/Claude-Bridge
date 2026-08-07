const { spawn, execSync } = require('child_process');
const path = require('path');
const os = require('os');

const cmdExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
const sys32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const CLAUDE_BIN = path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'claude.cmd');

// Fresh session (no --resume) with project directory set
const cmdLine = CLAUDE_BIN + ' --resume 546f7618-698c-4e20-aaca-b6438532b0a4';
console.log('Spawning: ' + cmdExe + ' /d /s /c ' + cmdLine);

const execEnv = { ...process.env, CI: 'true', CLAUDE_NO_TUI: '1' };
execEnv.PATH = sys32 + ';' + (process.env.PATH || '');

const child = spawn(cmdExe, ['/d', '/s', '/c', cmdLine], {
    env: execEnv,
    cwd: 'E:/Desktop/Claude-Bridge',
    stdio: ['pipe', 'pipe', 'pipe'],
});

let out = '', err = '';
child.stdout.on('data', d => { out += d.toString(); process.stdout.write('S:' + d.toString().slice(0, 80) + '\n'); });
child.stderr.on('data', d => { err += d.toString(); process.stderr.write('E:' + d.toString().slice(0, 80) + '\n'); });
child.on('error', e => console.error('ERROR EVENT:', e.message));
const start = Date.now();

child.on('exit', code => {
    console.log('\n=== EXIT code=' + code + ' time=' + (Date.now() - start) + 'ms ===');
    console.log('stdout=' + out.length + 'B  stderr=' + err.length + 'B');
    if (out) console.log('STDOUT:', out.slice(0, 300));
    if (err) console.log('STDERR:', err.slice(0, 500));
});

child.stdin.write('hello\n');
child.stdin.end();

setTimeout(() => {
    console.log('\n=== FORCE KILL ===');
    try { execSync('taskkill /f /t /pid ' + child.pid, { windowsHide: true }); }
    catch (e) { console.log('KILL failed:', e.message.slice(0, 100)); }
}, 8000);
