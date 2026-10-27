import fs from 'node:fs';
import path from 'node:path';
import { BoardClient } from './biliboard/client.js';
import { syncBoards } from './biliboard/sync.js';
import { BiliClient } from './bili/client.js';
import { crawl } from './crawler/pipeline.js';
import { FailureTracker } from './crawler/failures.js';
import { RawStore } from './crawler/store.js';
import { Repository } from './server/repository.js';
import { readJson, writeJson } from './util/fsx.js';

const lockPath = (cfg) => path.join(cfg.paths.data, '.lock');

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

export function runSync(cfg, log, { full = false } = {}) {
  return withLock(cfg, async () => {
    const result = await syncBoards(new BoardClient(cfg, log), cfg, log, { full });
    const state = readJson(cfg.paths.state, {}) || {};
    writeJson(cfg.paths.state, { ...state, lastSyncAt: new Date().toISOString(), songs: result.songs.length });
    return result;
  });
}

export function runCrawl(cfg, log, opts = {}) {
  return withLock(cfg, async () => {
    const result = await doCrawl(cfg, log, opts);
    const state = readJson(cfg.paths.state, {}) || {};
    writeJson(cfg.paths.state, { ...state, lastCrawlAt: new Date().toISOString(), lastCrawl: result });
    return result;
  });
}

/** 同步官方库 + 增量抓帖；服务端会自动重载数据，无需重新生成页面 */
export function runUpdate(cfg, log, { force = false, deep = false, limit = 0, skipCrawl = false, skipSync = false, full = false } = {}) {
  return withLock(cfg, async () => {
    const started = Date.now();
    let crawlResult = null;
    let syncResult = null;
    if (!skipSync) syncResult = await syncBoards(new BoardClient(cfg, log), cfg, log, { full });
    if (!skipCrawl) {
      try {
        crawlResult = await doCrawl(cfg, log, { force, deep, limit });
      } catch (err) {
        log?.warn('B 站帖子抓取失败，已跳过（不影响看板）：' + err.message);
        crawlResult = { error: err.message, discovered: 0, fetched: 0, failed: [], skipped: 0, skippedReasons: {} };
      }
    }
    const dataset = loadDataset(cfg);
    const state = readJson(cfg.paths.state, {}) || {};
    writeJson(cfg.paths.state, {
      ...state,
      lastRunAt: new Date().toISOString(),
      lastRunMs: Date.now() - started,
      lastCrawl: crawlResult,
      lastSyncAt: syncResult ? new Date().toISOString() : state.lastSyncAt,
      stats: dataset.stats
    });
    return { crawl: crawlResult, sync: syncResult, dataset, ms: Date.now() - started };
  });
}

export function formatReport(dataset) {
  const s = dataset.stats;
  const lines = [];
  lines.push('术力口周榜 · ' + dataset.meta.account.name);
  lines.push('期数 ' + s.firstIssue + '–' + s.lastIssue + '（' + s.firstDate + ' ~ ' + s.lastDate + '），共 ' + s.issues + ' 期 / ' + s.entries + ' 条 / ' + s.songs + ' 首曲目');
  lines.push('冠军段数 ' + s.championRuns + (s.longest ? '，最长在榜 ' + s.longest.title + '（' + s.longest.weeks + ' 期）' : ''));
  const last = dataset.issues.at(-1);
  if (last) {
    lines.push('');
    lines.push('最新一期：第 ' + last.issue + ' 期 · ' + last.date + (last.week ? ' · 第 ' + last.week + ' 周' : ''));
    last.entries.slice(0, 10).forEach((e) => lines.push('  ' + String(e.rank).padStart(2, '0') + '. ' + (e.titleCn || e.title) + '  ·  ' + (e.producers || []).join(' / ')));
  }
  return lines.join('\n');
}
