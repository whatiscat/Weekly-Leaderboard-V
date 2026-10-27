import zlib from 'node:zlib';

function acceptsGzip(req) {
  return /\bgzip\b/.test(req.headers['accept-encoding'] || '');
}

export function json(req, res, status, data, headers = {}) {
  const body = Buffer.from(JSON.stringify(data));
  const base = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers
  };
  if (body.length > 1024 && acceptsGzip(req)) {
    const gz = zlib.gzipSync(body);
    res.writeHead(status, { ...base, 'Content-Encoding': 'gzip', 'Content-Length': gz.length, Vary: 'Accept-Encoding' });
    res.end(gz);
    return;
  }
  res.writeHead(status, { ...base, 'Content-Length': body.length });
  res.end(body);
}

export function text(res, status, body, type = 'text/plain; charset=utf-8', headers = {}) {
  const buf = Buffer.from(body);
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': buf.length, ...headers });
  res.end(buf);
}

export function redirect(res, location, status = 302) {
  res.writeHead(status, { Location: location, 'Cache-Control': 'public, max-age=86400' });
  res.end();
}

export function notFound(req, res) {
  json(req, res, 404, { error: 'not_found', message: '资源不存在' });
}

export function fail(req, res, status, message) {
  json(req, res, status, { error: 'server_error', message: String(message || '未知错误') });
}
