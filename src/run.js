import fs from 'node:fs';
import path from 'node:path';
import { BoardClient } from './biliboard/client.js';
import { syncBoards } from './biliboard/sync.js';
import { BiliClient } from './bili/client.js';
import { crawl } from './crawler/pipeline.js';
import { FailureTracker } from './crawler/failures.js';
import { RawStore } from './crawler/store.js';
import { buildDataset } from './model/build.js';
import { renderSite } from './render/build.js';
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

export function loadBoards(cfg) {
  const dir = path.join(cfg.paths.data, 'boards');
  const weekly = readJson(path.join(dir, 'issues-1.json'), []) || [];
  const legend = readJson(path.join(dir, 'issues-2.json'), []) || [];
  const songs = readJson(path.join(dir, 'songs.json'), []) || [];
  const covers = readJson(path.join(cfg.paths.data, 'covers.json'), {}) || {};
  return { issues: { weekly, legend }, songs, covers };
}

export function loadDataset(cfg) {
  const boards = loadBoards(cfg);
  const dataset = buildDataset(new RawStore(cfg.paths.raw).all(), boards, cfg);
  dataset.covers = boards.covers || {};
  return dataset;
}

export function buildFromRaw(cfg, log) {
  const dataset = loadDataset(cfg);
  if (!dataset.issues.length) throw new Error('data/raw 下没有可用的榜单数据，请先执行 crawl');
  const out = renderSite(dataset, cfg);
  const state = readJson(cfg.paths.state, {}) || {};
  writeJson(cfg.paths.state, { ...state, lastBuildAt: new Date().toISOString(), stats: dataset.stats, output: out });
  log?.info('已生成 ' + out.html + ' (' + (out.bytes / 1024).toFixed(1) + 'KB) 与 ' + out.csv);
  return { dataset, out };
}

async function doCrawl(cfg, log, { force = false, deep = false, limit = 0 } = {}) {
  const budget = cfg.crawl?.timeBudgetMs ?? 120000;
  const client = new BiliClient(cfg, log);
  // 初始化（spi/nav）单独限时，避免被风控拖住整条流水线
  client.deadline = Date.now() + 30000;
  await client.init();
  client.deadline = Date.now() + budget;
  log?.info('B 站会话已就绪（' + (client.isLogin ? '已登录：' + (client.uname || '') : '匿名，若频繁被限流可在 config/local.json 填 bili.cookie') + '），抓帖时间预算 ' + Math.round(budget / 1000) + 's');
  const store = new RawStore(cfg.paths.raw);
  fs.mkdirSync(cfg.paths.raw, { recursive: true });
  const failures = new FailureTracker(path.join(cfg.paths.data, 'failures.json'), { maxAttempts: 3 });
  return crawl(client, cfg, store, { force, deep, limit, logger: log, failures });
}

/** 同步 biliboard 曲目库（曲目身份与逐期稿件的权威来源） */
export function runSync(cfg, log, { full = false } = {}) {
  return withLock(cfg, async () => {
    const result = await syncBoards(new BoardClient(cfg, log), cfg, log, { full });
    const state = readJson(cfg.paths.state, {}) || {};
    writeJson(cfg.paths.state, { ...state, lastSyncAt: new Date().toISOString(), songs: result.songs.length });
    return result;
  });
}

/** 只抓取（增量），写 data/raw */
export function runCrawl(cfg, log, opts = {}) {
  return withLock(cfg, async () => {
    const result = await doCrawl(cfg, log, opts);
    const state = readJson(cfg.paths.state, {}) || {};
    writeJson(cfg.paths.state, { ...state, lastCrawlAt: new Date().toISOString(), lastCrawl: result });
    return result;
  });
}

/** 抓取 + 构建（定时任务与 update 命令使用） */
export function runUpdate(cfg, log, { force = false, deep = false, limit = 0, skipCrawl = false, skipSync = false, full = false } = {}) {
  return withLock(cfg, async () => {
    const started = Date.now();
    let crawlResult = null;
    let syncResult = null;
    if (!skipSync) {
      syncResult = await syncBoards(new BoardClient(cfg, log), cfg, log, { full });
    }
    if (!skipCrawl) {
      try {
        crawlResult = await doCrawl(cfg, log, { force, deep, limit });
      } catch (err) {
        // B 站接口不可用（限流/风控/断网）不应阻塞看板生成：页面主体来自 biliboard 数据
        log?.warn('B 站帖子抓取失败，已跳过（不影响看板）：' + err.message);
        crawlResult = { error: err.message, discovered: 0, fetched: 0, failed: [], skipped: 0, skippedReasons: {} };
      }
    }
    const { dataset, out } = buildFromRaw(cfg, log);
    const state = readJson(cfg.paths.state, {}) || {};
    writeJson(cfg.paths.state, {
      ...state,
      lastRunAt: new Date().toISOString(),
      lastRunMs: Date.now() - started,
      lastCrawl: crawlResult,
      lastSyncAt: syncResult ? new Date().toISOString() : state.lastSyncAt,
      stats: dataset.stats,
      output: out
    });
    return { crawl: crawlResult, sync: syncResult, dataset, out, ms: Date.now() - started };
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
