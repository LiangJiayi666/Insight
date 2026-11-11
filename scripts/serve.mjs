import http from 'node:http';
import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const routes = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
]);
const port = Number(process.env.PORT || 4173);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须为 1—65535 的整数');
const server = http.createServer(async (req, res) => {
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  let path;
  try { path = new URL(req.url, 'http://localhost').pathname; }
  catch { res.writeHead(400).end(); return; }
  let route = routes.get(path);
  if (/^\/issues\/\d{4}\/\d{2}\/\d{2}\/(index\.html|styles\.css|app\.js)$/.test(path)) {
    const name = path.split('/').at(-1);
    route = [`public${path}`, routes.get('/' + name)[1]];
  } else if (route) {
    try { await access(new URL('public/index.html', root)); route = ['public/' + route[0], route[1]]; } catch { /* Fall back to original trial until the first daily issue is published. */ }
  }
  if (!route) { res.writeHead(404).end('Not found'); return; }
  try {
    const data = await readFile(fileURLToPath(new URL(route[0], root)));
    res.writeHead(200, {
      'Content-Type': route[1],
      'Content-Length': data.length,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch (error) {
    res.writeHead(error.code === 'ENOENT' ? 404 : 500).end('Unable to load page');
  }
});
server.on('error', error => { console.error(`无法启动预览：${error.message}`); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => console.log(`见微预览：http://127.0.0.1:${port}\n按 Ctrl+C 停止。仅本机可访问。`));
