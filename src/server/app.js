import { createRouter } from './router.js';
import { Repository } from './repository.js';
import { registerApiRoutes } from './routes/api.js';
import { registerStaticRoutes } from './routes/static.js';
import { fail, notFound } from './respond.js';

export function createApp({ cfg, log }) {
  const repo = new Repository(cfg, log);
  const router = createRouter();

  registerApiRoutes(router, repo, cfg);
  registerStaticRoutes(router, cfg, repo);

  // 启动时预热，避免首个请求等太久
  try {
    repo.ensure();
  } catch (err) {
    log?.warn('数据预热失败：' + err.message);
  }

  async function handler(req, res) {
    const started = Date.now();
    let url;
    try {
      url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    } catch {
      return fail(req, res, 400, '非法请求地址');
    }

    res.on('finish', () => {
      const ms = Date.now() - started;
      const line = req.method + ' ' + url.pathname + ' → ' + res.statusCode + ' (' + ms + 'ms)';
      if (res.statusCode >= 500) log?.error(line);
      else if (res.statusCode >= 400) log?.warn(line);
      else log?.debug(line);
    });

    try {
      const hit = router.match(req.method, url.pathname);
      if (!hit) return notFound(req, res);
      await hit.route.handler(req, res, hit.params, url);
    } catch (err) {
      log?.error('请求处理失败 ' + url.pathname + '：' + (err.stack || err.message));
      if (!res.headersSent) fail(req, res, 500, err.message);
    }
  }

  handler.repo = repo;
  handler.routes = router.list();
  return handler;
}
