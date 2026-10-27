import http from 'node:http';
import { spawn } from 'node:child_process';
import { createApp } from './app.js';

export function createServer(cfg, log) {
  const app = createApp({ cfg, log });
  const server = http.createServer(app);
  server.app = app;
  return server;
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '""', url] : [url];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* 打不开就算了 */
  }
}

/**
 * 监听端口；被占用时自动顺延。
 * @returns {Promise<{server: import('node:http').Server, url: string, port: number}>}
 */
export function listen(cfg, log, { open = false, tries = 5 } = {}) {
  const server = createServer(cfg, log);
  const host = cfg.server.host;
  let port = cfg.server.port;
  let attempt = 0;

  return new Promise((resolve, reject) => {
    const onError = (err) => {
      if (err.code === 'EADDRINUSE' && attempt < tries) {
        attempt++;
        port++;
        log?.warn('端口 ' + (port - 1) + ' 被占用，改用 ' + port);
        setTimeout(() => server.listen(port, host), 120);
        return;
      }
      server.removeListener('error', onError);
      reject(err);
    };
    server.on('error', onError);
    server.on('listening', () => {
      const url = 'http://' + host + ':' + port + '/';
      log?.info('服务已启动：' + url);
      if (open) openBrowser(url);
      resolve({ server, url, port });
    });
    server.listen(port, host);
  });
}
