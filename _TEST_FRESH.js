const { spawn, execSync } = require('child_process');
const path = require('path');
const os = require('os');

const cmdExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
const sys32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const CLAUDE_BIN = path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'claude.cmd');

// NO --resume = fresh claude
const cmdLine = CLAUDE_BIN;
console.log('Spawning fresh claude: ' + cmdExe + ' /d /s /c ' + cmdLine);

const execEnv = { ...process.env, CI: 'true', CLAUDE_NO_TUI: '1' };
execEnv.PATH = sys32 + ';' + (process.env.PATH || '');

const child = spawn(cmdExe, ['/d', '/s', '/c', cmdLine], {
    env: execEnv,
    cwd: 'E:/Desktop/Claude-Bridge',
    stdio: ['pipe', 'pipe', 'pipe'],
});

let out = '', err = '';
child.stdout.on('data', d => { out += d.toString(); console.log('STDOUT:', d.toString().slice(0, 100)); });
child.stderr.on('data', d => { err += d.toString(); console.log('STDERR:', d.toString().slice(0, 100)); });
child.on('error', e => console.error('ERROR EVENT:', e.message));
const start = Date.now();

child.on('exit', code => {
    console.log('\n=== EXIT code=' + code + ' time=' + (Date.now()-start) + 'ms ===');
    console.log('stdout=' + out.length + 'B  stderr=' + err.length + 'B');
});

child.stdin.write('回复hello\n');
child.stdin.end();

setTimeout(() => process.exit(0), 20000);
