import fs from 'node:fs';
import path from 'node:path';
import { BoardClient } from './biliboard/client.js';
import { syncBoards } from './biliboard/sync.js';
import { mergeCoverPairs, resolveVideoCovers } from './biliboard/covers.js';
import { BiliClient } from './bili/client.js';
import { crawl } from './crawler/pipeline.js';
import { crawlNico, harvestNicoCovers } from './crawler/nico.js';
import { FailureTracker } from './crawler/failures.js';
import { RawStore } from './crawler/store.js';
import { Repository } from './server/repository.js';
import { readJson, writeJson } from './util/fsx.js';

const lockPath = (cfg) => path.join(cfg.paths.data, '.lock');

/**
 * state.json 只保留这些键。
 *
 * 它是运行态文件（不入库），但旧版本留下的键会一直被展开运算符带着走：
 * 上一版静态生成器写的 output / lastBuildAt 就这样在盘上躺了很久。
 * 显式白名单比"自然消亡"可靠 —— 加新键要改这里，等于强制想一遍它是不是运行态。
 */
const STATE_KEYS = ['lastSyncAt', 'lastCrawlAt', 'lastCrawl', 'lastNicoAt', 'lastNico', 'lastRunAt', 'lastRunMs', 'stats', 'songs', 'quality'];

function pickState(state) {
  const out = {};
  for (const key of STATE_KEYS) if (state && state[key] !== undefined) out[key] = state[key];
  return out;
}

function withLock(cfg, fn) {
  const lock = lockPath(cfg);
  if (fs.existsSync(lock)) {
    const age = Date.now() - fs.statSync(lock).mtimeMs;
    const pid = Number(fs.readFileSync(lock, 'utf8')) || 0;
    let alive = false;
    try { if (pid) { process.kill(pid, 0); alive = true; } } catch { alive = false; }
    if (alive && age < 2 * 3600 * 1000) {
      throw new Error('已有更新任务在运行（' + lock + '，pid ' + pid + '）');
    }
    fs.rmSync(lock, { force: true });
  }
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, String(process.pid));
  return Promise.resolve()
    .then(fn)
    .finally(() => fs.rmSync(lock, { force: true }));
}

/** 读一遍数据，构出只读数据集（服务端与命令行共用） */
export function loadDataset(cfg) {
  return new Repository(cfg, null).ensure();
}

async function doCrawl(cfg, log, { force = false, deep = false, limit = 0 } = {}) {
  const budget = cfg.crawl?.timeBudgetMs ?? 120000;
  const client = new BiliClient(cfg, log);
  client.deadline = Date.now() + 30000;
  await client.init();
  client.deadline = Date.now() + budget;
  log?.info('B 站会话已就绪（' + (client.isLogin ? '已登录：' + (client.uname || '') : '匿名，若频繁被限流可在 config/local.json 填 bili.cookie') + '），抓帖时间预算 ' + Math.round(budget / 1000) + 's');
  const store = new RawStore(cfg.paths.raw);
  fs.mkdirSync(cfg.paths.raw, { recursive: true });
  const failures = new FailureTracker(path.join(cfg.paths.data, 'failures.json'), { maxAttempts: 3 });
  return crawl(client, cfg, store, { force, deep, limit, logger: log, failures });
}

/**
 * 附榜（ニコニコ VOCALOID SONGS TOP20）的抓取 + 封面解析。
 *
 * 时间预算单独给：主榜的 crawl.timeBudgetMs（默认 120s）是给"每周补几期"设计的，
 * 而附榜第一次要把 190 期历史全部回填，按主榜的预算会在中途收工。
 * 所以这里取两者较大值，并且仍然受 crawl.timeBudgetMs 的**下限**约束 ——
 * 宁可慢一次，也不要每次更新都只抓一半。
 */
async function doNico(cfg, log, { force = false, deep = false, limit = 0, covers = true, backfillCovers = false } = {}) {
  if (!cfg.nico?.enabled) return null;
  const budget = Math.max(cfg.crawl?.timeBudgetMs ?? 120000, 15 * 60 * 1000);
  // 附榜一次要抓上百期（老帖还要多走一次专栏接口），按主榜的 1.2s 间隔会被风控
  // —— 实测连续 100 期后开始 -509 / -352。给这条请求链单独放慢，
  // 主榜的增量抓取（每周几期）不受影响。
  const slowCfg = { ...cfg, http: { ...cfg.http, minIntervalMs: Math.max(cfg.http.minIntervalMs, 2600) } };
  const client = new BiliClient(slowCfg, log);
  client.deadline = Date.now() + 30000;
  await client.init();
  client.deadline = Date.now() + budget;
  log?.info('附榜：B 站会话就绪（' + (client.isLogin ? '已登录' : '匿名') + '），时间预算 ' + Math.round(budget / 1000) + 's');

  const store = new RawStore(cfg.paths.nico);
  fs.mkdirSync(cfg.paths.nico, { recursive: true });
  const failures = new FailureTracker(path.join(cfg.paths.data, 'nico-failures.json'), { maxAttempts: 3 });
  const result = await crawlNico(client, cfg, store, { force, deep, limit, logger: log, failures });

  if (covers && cfg.nico.covers) {
    try {
      const coverFile = path.join(cfg.paths.data, 'covers.json');
      // 1) 抓正文时白拿的封面，直接并入（零请求）
      const pairs = [];
      for (const record of store.all()) for (const c of record.covers || []) pairs.push(c);
      let added = mergeCoverPairs(pairs, cfg, log);

      // 2) 按页面补封面（一次请求 20 个）。默认**只补这一轮新抓到的期** ——
      //    老记录缺封面多半是稿件被删，每轮重扫 60 多期页面要白跑三分钟，
      //    而网页上的「刷新」不该为此等上五分钟。全量回填走 nico --backfill。
      const has = (bvid) => Boolean((readJson(coverFile, {}) || {})[bvid]);
      const harvestIds = backfillCovers ? null : result.fetchedIds;
      if (!harvestIds || harvestIds.length) {
        const harvested = await harvestNicoCovers(client, store, has, log, { ids: harvestIds });
        if (harvested.pairs) added += mergeCoverPairs(harvested.pairs, cfg, log);
      }

      // 3) 页面也拿不到的（稿件被删 / 懒加载没渲染），最后才逐个问接口 ——
      //    同样只在本轮有新内容（或显式回填）时才跑。
      const known = readJson(coverFile, {}) || {};
      const missing = [];
      // 没有新期次、也没显式要求回填 —— 那就一个请求都不该发。
      // 之前这里写成"没有新期次就扫全部"，正好把"什么都不用做"的刷新又拖了 3 分钟。
      const scope = backfillCovers
        ? store.all()
        : result.fetchedIds.map((id) => store.read(id)).filter(Boolean);
      for (const record of scope) for (const e of record.entries || []) if (e.bvid && !known[e.bvid]) missing.push(e.bvid);
      result.coversMissing = new Set(missing).size;
      if (result.coversMissing) {
        const saved = client.deadline;
        client.deadline = Math.min(saved || Infinity, Date.now() + 3 * 60 * 1000);
        try {
          await resolveVideoCovers(client, missing, cfg, log);
        } finally {
          client.deadline = saved;
        }
      }
      result.covers = Object.keys(readJson(coverFile, {}) || {}).length;
      result.coversAdded = added;
    } catch (err) {
      log?.warn('附榜封面解析失败（不影响榜单）：' + err.message);
    }
  }
  return result;
}

export function runNico(cfg, log, opts = {}) {
  return withLock(cfg, async () => {
    const result = await doNico(cfg, log, opts);
    const state = readJson(cfg.paths.state, {}) || {};
    writeJson(cfg.paths.state, { ...pickState(state), lastNicoAt: new Date().toISOString(), lastNico: result });
    return result;
  });
}

export function runSync(cfg, log, { full = false } = {}) {
  return withLock(cfg, async () => {
    const result = await syncBoards(new BoardClient(cfg, log), cfg, log, { full });
    const state = readJson(cfg.paths.state, {}) || {};
    writeJson(cfg.paths.state, {
      ...pickState(state),
      lastSyncAt: new Date().toISOString(),
      songs: result.songs.length,
      quality: result.quality
    });
    return result;
  });
}

export function runCrawl(cfg, log, opts = {}) {
  return withLock(cfg, async () => {
    const result = await doCrawl(cfg, log, opts);
    const state = readJson(cfg.paths.state, {}) || {};
    writeJson(cfg.paths.state, { ...pickState(state), lastCrawlAt: new Date().toISOString(), lastCrawl: result });
    return result;
  });
}

/**
 * 同步官方库 + 增量抓帖；服务端会自动重载数据，无需重新生成页面。
 *
 * resilient：某一段失败时继续跑后面的段（网页上的「刷新」用）。
 * 命令行不行 —— 定时任务失败要能被看见，而不是"少了一半数据但退出码 0"。
 */
export function runUpdate(cfg, log, { force = false, deep = false, limit = 0, skipCrawl = false, skipSync = false, full = false, resilient = false, onStage = null } = {}) {
  return withLock(cfg, async () => {
    const started = Date.now();
    let crawlResult = null;
    let syncResult = null;
    let nicoResult = null;
    let syncError = null;
    onStage?.('sync');
    if (!skipSync) {
      try {
        syncResult = await syncBoards(new BoardClient(cfg, log), cfg, log, { full });
      } catch (err) {
        if (!resilient) throw err;
        syncError = err.message;
        log?.warn('同步官方库失败，继续抓帖（曲目库保持原样）：' + err.message);
      }
    }
    if (!skipCrawl) {
      onStage?.('crawl');
      try {
        crawlResult = await doCrawl(cfg, log, { force, deep, limit });
      } catch (err) {
        log?.warn('B 站帖子抓取失败，已跳过（不影响看板）：' + err.message);
        crawlResult = { error: err.message, discovered: 0, fetched: 0, failed: [], skipped: 0, skippedReasons: {} };
      }
      // 附榜是另一条榜、另一个 UP 主：它失败不该让主榜的更新一起失败
      onStage?.('nico');
      try {
        nicoResult = await doNico(cfg, log, { force, deep, limit: 0 });
      } catch (err) {
        log?.warn('附榜抓取失败，已跳过（不影响主榜）：' + err.message);
        nicoResult = { error: err.message, discovered: 0, fetched: 0, failed: [] };
      }
    }
    onStage?.('reload');
    const dataset = loadDataset(cfg);
    const state = readJson(cfg.paths.state, {}) || {};
    writeJson(cfg.paths.state, {
      ...pickState(state),
      lastRunAt: new Date().toISOString(),
      lastRunMs: Date.now() - started,
      lastCrawl: crawlResult,
      lastNico: nicoResult,
      lastNicoAt: nicoResult ? new Date().toISOString() : state.lastNicoAt,
      lastSyncAt: syncResult ? new Date().toISOString() : state.lastSyncAt,
      stats: dataset.stats,
      quality: syncResult ? syncResult.quality : state.quality
    });
    return { crawl: crawlResult, nico: nicoResult, sync: syncResult, syncError, dataset, ms: Date.now() - started };
  });
}

/* ---------------------------------------------------------------------------
 * 网页上的「刷新」：后台跑一次 update，前端轮询进度
 *
 * 为什么要做成后台任务 + 轮询：一次更新要同步官方库、抓帖、抓附榜，几分钟起步。
 * 把它挂在 HTTP 请求里，用户只能看着按钮转圈，中途刷新页面就断了（而且浏览器
 * 未必等得到响应）。所以这里只负责"启动"，进度用 GET 查。
 * ------------------------------------------------------------------------- */
const STAGE_LABEL = { sync: '同步中', crawl: '抓帖中', nico: '附榜中', reload: '载入中' };

let updateJob = null;

function summarize(res) {
  return {
    ms: res.ms,
    sync: res.sync ? { issues: res.sync.issues?.weekly?.length ?? null } : null,
    syncError: res.syncError || null,
    crawl: res.crawl ? { fetched: res.crawl.fetched, failed: res.crawl.failed?.length ?? 0 } : null,
    nico: res.nico ? { fetched: res.nico.fetched, failed: res.nico.failed?.length ?? 0, error: res.nico.error || null } : null,
    stats: res.dataset?.stats || null
  };
}

export function updateStatus() {
  if (!updateJob) return { running: false, stage: null, stageLabel: '', startedAt: null, elapsedMs: 0, last: null };
  return {
    running: updateJob.running,
    stage: updateJob.stage,
    stageLabel: updateJob.running ? (STAGE_LABEL[updateJob.stage] || '更新中') : '',
    startedAt: updateJob.startedAt,
    elapsedMs: Date.now() - updateJob.startedAt,
    last: updateJob.last
  };
}

/**
 * 启动一次后台更新。已经在跑就直接返回现状（不排队、不并发 ——
 * 并发更新会撞上 data/.lock，而且对上游也不礼貌）。
 * onDone 在成功与失败时都会调用，让服务端把新数据载进来。
 */
export function startUpdate(cfg, log, { onDone = null, ...opts } = {}) {
  if (updateJob && updateJob.running) return { started: false, ...updateStatus() };

  const job = { running: true, startedAt: Date.now(), stage: 'sync', last: null };
  updateJob = job;

  runUpdate(cfg, log, {
    ...opts,
    // 网页刷新不该因为"官方库暂时连不上"就整轮放弃：
    // 帖子与附榜还能更新，曲目库保持原样即可
    resilient: true,
    onStage: (stage) => { job.stage = stage; }
  })
    .then((res) => {
      job.last = { ok: true, finishedAt: new Date().toISOString(), ...summarize(res) };
    })
    .catch((err) => {
      job.last = { ok: false, finishedAt: new Date().toISOString(), error: err.message };
      log?.error('网页触发的更新失败：' + err.message);
    })
    .finally(() => {
      job.running = false;
      job.stage = 'done';
      try { onDone?.(); } catch (err) { log?.warn('更新后重载数据失败：' + err.message); }
    });

  return { started: true, ...updateStatus() };
}

export function formatReport(dataset) {
  const s = dataset.stats;
  const lines = [];
  lines.push('术力口周榜 · ' + dataset.meta.account.name);
  lines.push('期数 ' + s.firstIssue + '–' + s.lastIssue + '（' + s.firstDate + ' ~ ' + s.lastDate + '），共 ' + s.issues + ' 期 / ' + s.entries + ' 条 / ' + s.songs + ' 首曲目');
  lines.push('冠军段数 ' + s.championRuns + (s.longest ? '，最长在榜 ' + s.longest.title + '（' + s.longest.weeks + ' 期）' : ''));
  const b = dataset.meta.boards;
  if (b) {
    lines.push('附榜：传说曲周榜 ' + b.legend.issues + ' 期 / ' + b.legend.entries + ' 条 · 年榜 '
      + b.annual.issues + ' 期 / ' + b.annual.entries + ' 条');
  }
  const n = dataset.nico?.meta;
  if (n && n.issues) {
    lines.push('附榜：' + (n.title || 'ニコニコ VOCALOID SONGS TOP20') + ' ' + n.issues + ' 期（第 '
      + (n.first ?? '—') + '–' + (n.last ?? '—') + ' 期，' + (n.firstDate || '') + ' ~ ' + (n.lastDate || '') + '）/ '
      + n.entries + ' 条' + (n.incomplete.length ? '，缺名 ' + n.incomplete.length + ' 期' : ''));
  }
  const q = dataset.meta.quality;
  if (q) {
    lines.push('数据质量：' + q.completeIssues + '/' + q.totalIssues + ' 期名次齐全'
      + (q.missingRanks ? '（缺 ' + q.missingRanks + ' 个名次）' : '')
      + ' · 有文字版原帖 ' + q.posts.aligned + '/' + q.posts.total + ' 期');
  }
  const last = dataset.issues.at(-1);
  if (last) {
    lines.push('');
    lines.push('最新一期：第 ' + last.issue + ' 期 · ' + last.date + (last.week ? ' · 第 ' + last.week + ' 周' : ''));
    last.entries.slice(0, 10).forEach((e) => lines.push('  ' + String(e.rank).padStart(2, '0') + '. ' + (e.titleCn || e.title) + '  ·  ' + (e.producers || []).join(' / ')));
  }
  return lines.join('\n');
}
