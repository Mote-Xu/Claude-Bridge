const http = require('http');
const d = JSON.stringify({ projectPath: 'e:\\Desktop\\Claude-Bridge' });
const r = http.request({
  hostname: '127.0.0.1', port: 9877,
  path: '/api/list-sessions', method: 'POST',
  headers: {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d)}
}, res => {
  let b = '';
  res.on('data', c => b += c);
  res.on('end', () => {
    const j = JSON.parse(b);
    console.log('Total:', j.sessions?.length);
    j.sessions?.forEach(s => console.log(s.id.slice(0,8), 'source:', s.source, (s.summary||'').slice(0,25)));
  });
});
r.write(d);
r.end();
