#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { buildFromRaw, formatReport, runCrawl, runSync, runUpdate } from './run.js';
import { serve } from './server.js';
import { doctor } from './doctor.js';
import { RawStore } from './crawler/store.js';
import { readJson } from './util/fsx.js';

const HELP = [
  '术力口周榜 · 命令行工具',
  '',
  '用法: node src/cli.js <命令> [选项]',
  '',
  '命令:',
  '  update [--force] [--limit N] [--no-crawl]   增量抓取 + 生成看板（默认）',
  '  sync [--full]                              同步 biliboard 曲目库（曲目身份权威来源）',
  '  crawl [--deep] [--force] [--limit N]       只抓取，写入 data/raw（--deep 完整翻页补漏，--force 全部重抓）',
  '  build                                      只用 data/raw 重新生成看板与 CSV',
  '  serve [--port 5173] [--host 127.0.0.1]     本地预览 public/',
  '  schedule [--once]                          按周定时执行 update（常驻）',
  '  report                                     打印数据摘要',
  '  status                                     查看抓取与构建状态',
  '  doctor                                     体检：数据文件、网络连通性、产物新鲜度',
  '',
  '选项:',
  '  --config <file>   使用额外的配置文件（默认 config/default.json + config/local.json）',
  '  --verbose         输出 debug 日志',
  '  --help            显示帮助'
].join('\n');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function nextRunAt({ weekday, hour, minute }) {
  const now = new Date();
  const d = new Date(now);
  d.setHours(hour, minute, 0, 0);
  const delta = (weekday - d.getDay() + 7) % 7;
  d.setDate(d.getDate() + delta);
  if (d <= now) d.setDate(d.getDate() + 7);
  return d;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || 'update';
  if (args.help || command === 'help') {
    console.log(HELP);
    return 0;
  }

  const cfg = loadConfig();
  if (args.port) cfg.server.port = Number(args.port);
  if (args.host) cfg.server.host = String(args.host);

  const log = createLogger({
    level: args.verbose ? 'debug' : 'info',
    file: path.join(cfg.paths.logs, 'update.log')
  });

  try {
    switch (command) {
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
      case 'build': {
        const { dataset, out } = buildFromRaw(cfg, log);
        console.log(formatReport(dataset));
        log.info('输出：' + out.html);
        return 0;
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
        log.info('耗时 ' + (res.ms / 1000).toFixed(1) + 's，输出 ' + res.out.html);
        if (res.crawl?.failed?.length) {
          log.warn('以下条目抓取失败，可稍后重试：');
          for (const f of res.crawl.failed) log.warn('  - ' + f.title + '  (' + f.warnings.join('; ') + ')');
        }
        return res.crawl?.failed?.length ? 2 : 0;
      }
      case 'serve': {
        if (args.build || !fs.existsSync(path.join(cfg.paths.public, cfg.render.htmlName))) {
          buildFromRaw(cfg, log);
        }
        const { server } = await serve(cfg, log, { open: Boolean(args.open) });
        const shutdown = () => server.close(() => process.exit(0));
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
        await new Promise(() => {});
        return 0;
      }
      case 'doctor': {
        const res = await doctor(cfg, log);
        console.log(res.lines);
        return res.ok ? 0 : 1;
      }
      case 'schedule': {
        const run = async () => {
          const at = new Date();
          log.info('开始定时更新（' + at.toLocaleString() + '）');
          try {
            await runUpdate(cfg, log, { force: false });
          } catch (err) {
            log.error('定时更新失败：' + err.message);
          }
        };
        if (args.once) {
          await run();
          return 0;
        }
        for (;;) {
          const next = nextRunAt(cfg.schedule);
          const wait = next.getTime() - Date.now();
          log.info('下一次自动更新：' + next.toLocaleString() + '（' + Math.round(wait / 60000) + ' 分钟后）');
          await new Promise((r) => setTimeout(r, Math.max(1000, wait)));
          await run();
        }
      }
      case 'report': {
        const { dataset } = buildFromRaw(cfg, log);
        console.log(formatReport(dataset));
        return 0;
      }
      case 'status': {
        const store = new RawStore(cfg.paths.raw);
        const state = readJson(cfg.paths.state, {}) || {};
        const html = path.join(cfg.paths.public, cfg.render.htmlName);
        console.log('原始记录: ' + store.ids().length + ' 期  (' + cfg.paths.raw + ')');
        console.log('最近更新: ' + (state.lastRunAt || '从未'));
        console.log('最近构建: ' + (state.lastBuildAt || '从未'));
        if (state.stats) console.log('数据统计: ' + state.stats.issues + ' 期 / ' + state.stats.entries + ' 条 / ' + state.stats.songs + ' 首');
        console.log('看板文件: ' + (fs.existsSync(html) ? html + ' (' + (fs.statSync(html).size / 1024).toFixed(1) + 'KB)' : '未生成'));
        return 0;
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
