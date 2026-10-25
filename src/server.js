import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

export function createServer(root) {
  return http.createServer((req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let pathname = decodeURIComponent(url.pathname);
      if (pathname === '/') pathname = '/index.html';
      const file = path.join(root, pathname);
      if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found');
        return;
      }
      const stat = fs.statSync(file);
      const etag = '"' + stat.size.toString(16) + '-' + stat.mtimeMs.toString(16) + '"';
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304);
        res.end();
        return;
      }
      const body = fs.readFileSync(file); // 一次性读入，避免长时间占用文件句柄
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': body.length,
        'Cache-Control': 'no-cache',
        ETag: etag
      });
      res.end(body);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('500 ' + err.message);
    }
  });
}

export function serve(cfg, log, { open = false, tries = 5 } = {}) {
  const root = cfg.paths.public;
  const { host } = cfg.server;
  let port = cfg.server.port;
  const server = createServer(root);

  return new Promise((resolve, reject) => {
    let attempt = 0;
    function listen() {
      server.listen(port, host);
    }
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE' && attempt < tries) {
        attempt++;
        port++;
        log?.warn('端口被占用，改用 ' + port);
        setTimeout(listen, 120);
        return;
      }
      reject(err);
    });
    server.on('listening', () => {
      const url = 'http://' + host + ':' + port + '/';
      log?.info('看板已启动：' + url + '  （根目录 ' + root + '）');
      if (open) {
        const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
        const args = process.platform === 'win32' ? ['/c', 'start', '""', url] : [url];
        import('node:child_process').then(({ spawn }) => {
          try { spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref(); } catch {}
        });
      }
      resolve({ server, url, port });
    });
    listen();
  });
}
