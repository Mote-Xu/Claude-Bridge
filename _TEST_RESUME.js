const { spawn, execSync } = require('child_process');
const path = require('path');
const os = require('os');

const cmdExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
const sys32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const CLAUDE_BIN = path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'claude.cmd');

const uuid = '546f7618-698c-4e20-aaca-b6438532b0a4';
const cmdLine = CLAUDE_BIN + ' --resume ' + uuid;
console.log('Spawning --resume ' + uuid);

const execEnv = { ...process.env, CI: 'true', CLAUDE_NO_TUI: '1' };
execEnv.PATH = sys32 + ';' + (process.env.PATH || '');

const child = spawn(cmdExe, ['/d', '/s', '/c', cmdLine], {
    env: execEnv,
    cwd: 'E:/Desktop/Claude-Bridge',
    stdio: ['pipe', 'pipe', 'pipe'],
});

let out = '', err = '';
child.stdout.on('data', d => {
    out += d.toString();
    const now = ((Date.now()-start)/1000).toFixed(1);
    console.log('[' + now + 's] STDOUT:', d.toString().slice(0, 150));
});
child.stderr.on('data', d => {
    err += d.toString();
    const now = ((Date.now()-start)/1000).toFixed(1);
    console.log('[' + now + 's] STDERR:', d.toString().slice(0, 150));
});
child.on('error', e => console.error('ERROR EVENT:', e.message));
const start = Date.now();

child.on('exit', code => {
    console.log('\n=== EXIT code=' + code + ' time=' + (Date.now()-start) + 'ms ===');
    console.log('stdout=' + out.length + 'B  stderr=' + err.length + 'B');
});

child.stdin.write('回复hello\n');
child.stdin.end();

// Kill at 15s (longer)
setTimeout(() => {
    console.log('\n=== FORCE KILL at ' + ((Date.now()-start)/1000).toFixed(1) + 's ===');
    try { execSync('taskkill /f /t /pid ' + child.pid, { windowsHide: true }); }
    catch (e) { console.log('KILL failed'); }
}, 15000);
