import { json, text, redirect } from '../respond.js';
import { startUpdate, updateStatus } from '../../run.js';
import { consoleActions, consoleStatus, runConsoleText, startConsoleJob } from '../console.js';

/** 1×1 透明 GIF：封面直链缺失时的占位（见 /img/:bvid） */
const BLANK_GIF = Buffer.from('R0lGODlhAQABAAAAACw=', 'base64');

export function registerApiRoutes(router, repo, cfg, log) {
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

  // ---- 附榜：传说曲周榜(board 2) / 年榜(board 3) ----
  // 两条接口同构：不带期号给目录（含每期冠军），带期号给那一期的完整榜单。
  // limit 可选，取最近 N 期；不传就是全部（传说曲榜 84 期摘要约 12KB）。
  registerBoardRoutes(router, repo);
  registerNicoRoutes(router, repo);

  router.get('/api/csv', (req, res) => {
    const body = repo.csv();
    text(res, 200, body, 'text/csv; charset=utf-8', {
      'Content-Disposition': 'attachment; filename="bili-board-weekly.csv"'
    });
  });

  // 只重读磁盘（命令行跑完 update 之后用这个，或者页面 F5）
  router.post('/api/reload', (req, res) => {
    repo.invalidate();
    repo.ensure();
    json(req, res, 200, { ok: true, issues: repo.meta().stats.issues });
  });

  /* 网页上的「刷新」：真的去 B 站重抓一次。
     更新是几分钟量级的后台任务，所以这里只启动、不等待 —— 返回 202，
     前端拿 GET /api/update 轮询进度。已经在跑就回 409 并带上现状。 */
  router.post('/api/update', (req, res) => {
    const result = startUpdate(cfg, log, {
      onDone: () => {
        repo.invalidate();
        repo.ensure();
        log?.info('网页触发的更新完成，服务端已重载数据');
      }
    });
    json(req, res, result.started ? 202 : 409, result);
  });

  router.get('/api/update', (req, res) => json(req, res, 200, updateStatus()));

  /* ---------- 设置抽屉：命令行那几件事的网页版 ----------
   * 只认白名单里的名字（console.js 的 ACTIONS），不接受任意命令。
   * 长任务启动后返回现状，前端轮询 GET /api/console；短任务直接返回文本。 */
  router.get('/api/console', (req, res) => {
    json(req, res, 200, { actions: consoleActions(), job: consoleStatus() });
  });

  // 参数走 query（这个路由器不解析请求体，POST 一律如此）
  router.post('/api/console/run', async (req, res, params, url) => {
    const name = String(url.searchParams.get('name') || '');
    const flag = (k) => url.searchParams.get(k) === '1';
    const opts = { full: flag('full'), deep: flag('deep'), force: flag('force'), backfill: flag('backfill') };
    const done = () => {
      repo.invalidate();
      repo.ensure();
    };
    if (!consoleActions().some((a) => a.name === name)) {
      return json(req, res, 400, { error: 'unknown_action', message: '没有这个任务：' + name });
    }
    const text = await runConsoleText(cfg, log, name);
    if (text) {
      done();
      return json(req, res, 200, { kind: 'text', ok: text.ok, text: text.text, lines: text.lines });
    }
    const started = startConsoleJob(cfg, log, name, {
      full: Boolean(opts.full),
      deep: Boolean(opts.deep),
      force: Boolean(opts.force),
      backfillCovers: Boolean(opts.backfill),
      covers: opts.covers === undefined ? true : Boolean(opts.covers)
    }, { onDone: done });
    json(req, res, started.started ? 202 : 409, started);
  });

  // 封面：302 到 B 站直链，可带宽度参数
  router.get('/img/:bvid', (req, res, params, url) => {
    const width = Number(url.searchParams.get('w')) || 0;
    const target = repo.coverUrl(params.bvid, width);
    // 没有直链（稿件被删 / 从没解析到）就直接回一张 1×1 透明 GIF。
    // 以前是 302 到 data: URI —— 浏览器会以 ERR_UNSAFE_REDIRECT 拒掉这条跳转，
    // 并在控制台留一条看着像"页面坏了"的错误。删稿件的封面本来就是常态（12 个），
    // 不值得为它伪造一条错误。
    if (!target) {
      res.writeHead(200, {
        'Content-Type': 'image/gif',
        'Content-Length': BLANK_GIF.length,
        'Cache-Control': 'public, max-age=86400'
      });
      return res.end(BLANK_GIF);
    }
    redirect(res, target);
  });
}

/**
 * 附榜：ニコニコ VOCALOID SONGS TOP20（另一个 UP 主发布的另一条榜）
 *
 * 数据结构与 /api/issues 同构，但曲目身份是**曲名**而不是 Biliboard ID ——
 * 这条榜没有官方曲目库，正文就是唯一来源。所以它不与 /api/songs 共用 id 空间，
 * 单曲详情走 /api/nico/song/:id。
 */
function registerNicoRoutes(router, repo) {
  router.get('/api/nico', (req, res) => {
    const data = repo.nicoIndex();
    if (!data.total) return json(req, res, 200, { board: 'nico', total: 0, items: [] });
    json(req, res, 200, data);
  });

  // ⚠️ 顺序有意义：/api/nico/:issue 会把 "champions" / "songs" 当成期号吃掉，
  // 所以具体路径必须排在通配之前（路由是按注册顺序匹配的）。
  registerBoardParts(router, repo, '/api/nico', 'nico');
  router.get('/api/nico/song/:id', (req, res, params) => {
    const data = repo.boardSong('nico', params.id);
    if (!data) return json(req, res, 404, { error: 'song_not_found', message: '附榜上没有这首曲子' });
    json(req, res, 200, data);
  });

  router.get('/api/nico/:issue', (req, res, params) => {
    const data = repo.nicoIssue(params.issue);
    if (!data) return json(req, res, 404, { error: 'issue_not_found', message: '没有这一期附榜' });
    json(req, res, 200, data);
  });
}

/** 附榜的两个同构端点：/api/legend、/api/annual */
const EXTRA_BOARDS = [
  { path: '/api/legend', name: 'legend', label: '传说曲周榜' },
  { path: '/api/annual', name: 'annual', label: '年榜' }
];

/**
 * 每条榜都要的三件套：冠军段、曲目索引、单曲详情。
 * ⚠️ 必须注册在「/:issue」之前 —— 路由按注册顺序匹配，
 * 否则 /api/legend/champions 会被当成"期号 champions"。
 */
function registerBoardParts(router, repo, base, name) {
  router.get(base + '/champions', (req, res, params, url) => {
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 24));
    json(req, res, 200, repo.boardChampions(name, limit));
  });
  router.get(base + '/songs', (req, res, params, url) => {
    const q = url.searchParams.get('q') || '';
    const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 200));
    json(req, res, 200, repo.boardSongs(name, q, limit));
  });
}

function registerBoardRoutes(router, repo) {
  for (const b of EXTRA_BOARDS) {
    registerBoardParts(router, repo, b.path, b.name);
    router.get(b.path + '/song/:id', (req, res, params) => {
      const data = repo.boardSong(b.name, params.id);
      if (!data) return json(req, res, 404, { error: 'song_not_found', message: b.label + ' 上没有这首曲子' });
      json(req, res, 200, data);
    });
    router.get(b.path, (req, res, params, url) => {
      const raw = Number(url.searchParams.get('limit'));
      const limit = Number.isFinite(raw) && raw > 0 ? Math.min(200, Math.floor(raw)) : 0;
      json(req, res, 200, repo.boardIndex(b.name, limit));
    });
    router.get(b.path + '/:issue', (req, res, params) => {
      const data = repo.boardIssue(b.name, params.issue);
      if (!data) return json(req, res, 404, { error: 'issue_not_found', message: '没有这一期（' + b.label + '）' });
      json(req, res, 200, data);
    });
  }
}
