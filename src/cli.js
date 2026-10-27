#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { formatReport, loadDataset, runCrawl, runSync, runUpdate } from './run.js';
import { listen } from './server/index.js';
import { doctor } from './doctor.js';
import { RawStore } from './crawler/store.js';
import { readJson } from './util/fsx.js';

const HELP = [
  '术力口周榜 · 命令行',
  '',
  '用法: node src/cli.js <命令> [选项]',
  '',
  '命令:',
  '  serve [--port 5173] [--open]            启动 HTTP 服务（默认命令）',
  '  update [--force] [--limit N] [--no-crawl] [--no-sync]   同步数据 + 增量抓帖',
  '  sync [--full]                           同步 Biliboard 期次与曲目库',
  '  crawl [--deep] [--force] [--limit N]    只抓 B 站帖子',
  '  report                                  终端打印数据摘要',
  '  status                                  查看数据与服务状态',
  '  doctor                                  体检：数据文件、网络、目录',
  '  schedule [--once]                       按周定时执行 update',
  '',
  '选项:',
  '  --port <n>   指定端口（被占用时自动顺延）',
  '  --open       启动后自动打开浏览器',
  '  --verbose    输出 debug 日志',
  '  --help       显示帮助'
].join('\n');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { args[key] = next; i++; }
      else args[key] = true;
    } else args._.push(a);
  }
  return args;
}

function nextRunAt({ weekday, hour, minute }) {
  const now = new Date();
  const d = new Date(now);
  d.setHours(hour, minute, 0, 0);
  d.setDate(d.getDate() + ((weekday - d.getDay() + 7) % 7));
  if (d <= now) d.setDate(d.getDate() + 7);
  return d;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || 'serve';
  if (args.help || command === 'help') { console.log(HELP); return 0; }

  const cfg = loadConfig();
  if (args.port) cfg.server.port = Number(args.port);

  const log = createLogger({
    level: args.verbose ? 'debug' : 'info',
    file: path.join(cfg.paths.logs, 'app.log')
  });

  try {
    switch (command) {
      case 'serve': {
        const { server, url } = await listen(cfg, log, { open: Boolean(args.open) });
        log.info('API: ' + url + 'api/meta');
        const shutdown = () => server.close(() => process.exit(0));
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
        await new Promise(() => {});
        return 0;
      }
      case 'sync': {
        const res = await runSync(cfg, log, { full: Boolean(args.full) });
        log.info('同步完成：曲目 ' + res.songs.length + ' 首，扫描 ' + res.scanned + ' 条');
        return 0;
      }
      case 'crawl': {
        const res = await runCrawl(cfg, log, { force: Boolean(args.force), deep: Boolean(args.deep), limit: Number(args.limit || 0) });
        log.info('抓取完成：发现 ' + res.discovered + ' 条，新增 ' + res.fetched + ' 条，失败 ' + res.failed.length + ' 条');
        return res.failed.length ? 2 : 0;
      }
      case 'update': {
        const res = await runUpdate(cfg, log, {
          force: Boolean(args.force),
          limit: Number(args.limit || 0),
          skipCrawl: Boolean(args['no-crawl']) || Boolean(args['no-bili']),
          skipSync: Boolean(args['no-sync']),
          full: Boolean(args.full)
        });
        if (res.crawl) log.info('抓取：发现 ' + res.crawl.discovered + ' 条，新增 ' + res.crawl.fetched + ' 条，失败 ' + res.crawl.failed.length + ' 条');
        console.log('');
        console.log(formatReport(res.dataset));
        log.info('耗时 ' + (res.ms / 1000).toFixed(1) + 's。服务端会自动重载数据（或点页面右上角刷新）');
        return 0;
      }
      case 'report': {
        console.log(formatReport(loadDataset(cfg)));
        return 0;
      }
      case 'status': {
        const store = new RawStore(cfg.paths.raw);
        const state = readJson(cfg.paths.state, {}) || {};
        console.log('数据：官方曲目库 ' + (fs.existsSync(path.join(cfg.paths.data, 'boards', 'songs.json')) ? '已同步' : '缺失') + ' · 帖子原始记录 ' + store.ids().length + ' 期');
        console.log('最近同步: ' + (state.lastSyncAt || '从未') + ' · 最近抓帖: ' + (state.lastCrawlAt || '从未') + ' · 最近更新: ' + (state.lastRunAt || '从未'));
        if (state.stats) console.log('数据统计: ' + state.stats.issues + ' 期 / ' + state.stats.entries + ' 条 / ' + state.stats.songs + ' 首');
        console.log('前端目录: ' + (fs.existsSync(path.join(cfg.paths.web, 'index.html')) ? 'ok' : '缺失'));
        console.log('启动服务: node src/cli.js serve --open');
        return 0;
      }
      case 'doctor': {
        const res = await doctor(cfg, log);
        console.log(res.lines);
        return res.ok ? 0 : 1;
      }
      case 'schedule': {
        const run = async () => {
          log.info('开始定时更新（' + new Date().toLocaleString() + '）');
          try { await runUpdate(cfg, log, {}); }
          catch (err) { log.error('定时更新失败：' + err.message); }
        };
        if (args.once) { await run(); return 0; }
        for (;;) {
          const next = nextRunAt(cfg.schedule);
          log.info('下一次自动更新：' + next.toLocaleString() + '（' + Math.round((next - Date.now()) / 60000) + ' 分钟后）');
          await new Promise((r) => setTimeout(r, Math.max(1000, next - Date.now())));
          await run();
        }
      }
      default:
        console.error('未知命令：' + command + '\n');
        console.log(HELP);
        return 1;
    }
  } finally {
    await log.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[fatal] ' + (err?.stack || err));
    process.exit(1);
  });
