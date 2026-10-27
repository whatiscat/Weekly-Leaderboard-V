import fs from 'node:fs';
import path from 'node:path';
import { text } from '../respond.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

export function registerStaticRoutes(router, cfg, repo) {
  const root = cfg.paths.web;

  router.get('/', (req, res) => {
    const file = path.join(root, 'index.html');
    const html = fs.readFileSync(file);
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Content-Length': html.length, 'Cache-Control': 'no-cache' });
    res.end(html);
  });

  router.get('/:file', (req, res, params) => {
    const name = params.file;
    if (name.includes('..') || name.includes('\\') || name.includes('/')) return text(res, 404, '404');
    const file = path.join(root, name);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return text(res, 404, '404 Not Found');
    const stat = fs.statSync(file);
    const body = fs.readFileSync(file);
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
      ETag: '"' + stat.size.toString(16) + '-' + stat.mtimeMs.toString(16) + '"'
    });
    res.end(body);
  });
}
