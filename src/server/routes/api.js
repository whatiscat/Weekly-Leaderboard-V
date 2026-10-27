import { json, text, redirect } from '../respond.js';

export function registerApiRoutes(router, repo, cfg) {
  router.get('/api/health', (req, res) => {
    const meta = repo.meta();
    json(req, res, 200, {
      ok: true,
      issues: meta.stats.issues,
      entries: meta.stats.entries,
      generatedAt: meta.generatedAt,
      uptime: Math.round(process.uptime()),
      version: cfg.version || 'dev'
    });
  });

  router.get('/api/meta', (req, res) => json(req, res, 200, repo.meta()));

  router.get('/api/issues', (req, res) => json(req, res, 200, { items: repo.issuesIndex() }));

  router.get('/api/issues/:issue', (req, res, params) => {
    const data = repo.issue(params.issue);
    if (!data) return json(req, res, 404, { error: 'issue_not_found', message: '没有这一期' });
    json(req, res, 200, data);
  });

  router.get('/api/champions', (req, res, params, url) => {
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 24));
    json(req, res, 200, repo.champions(limit));
  });

  router.get('/api/songs', (req, res, params, url) => {
    const q = url.searchParams.get('q') || '';
    const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 200));
    json(req, res, 200, repo.songs(q, limit));
  });

  router.get('/api/songs/:id', (req, res, params) => {
    const data = repo.song(params.id);
    if (!data) return json(req, res, 404, { error: 'song_not_found', message: '没有这首曲子' });
    json(req, res, 200, data);
  });

  router.get('/api/legend', (req, res, params, url) => {
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 8));
    json(req, res, 200, { items: repo.legend(limit) });
  });

  router.get('/api/csv', (req, res) => {
    const body = repo.csv();
    text(res, 200, body, 'text/csv; charset=utf-8', {
      'Content-Disposition': 'attachment; filename="bili-board-weekly.csv"'
    });
  });

  router.post('/api/reload', (req, res) => {
    repo.invalidate();
    repo.ensure();
    json(req, res, 200, { ok: true, issues: repo.meta().stats.issues });
  });

  // 封面：302 到 B 站直链，可带宽度参数
  router.get('/img/:bvid', (req, res, params, url) => {
    const width = Number(url.searchParams.get('w')) || 0;
    const target = repo.coverUrl(params.bvid, width);
    if (!target) return redirect(res, 'data:image/gif;base64,R0lGODlhAQABAAAAACw=', 302);
    redirect(res, target);
  });
}
