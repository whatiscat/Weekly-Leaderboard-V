#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { formatReport, loadDataset, runCrawl, runNico, runSync, runUpdate } from './run.js';
import { nextRunAt, reportText, scheduleText, statusText } from './commands.js';
import { listen } from './server/index.js';
import { doctor } from './doctor.js';
import { RawStore } from './crawler/store.js';
import { reparseAll } from './crawler/reparse.js';
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
  '  nico [--deep] [--force] [--limit N] [--no-covers] [--backfill]',
  '                                         只抓附榜（ニコニコ VOCALOID TOP20）',
  '                                         --backfill：把老期次缺的封面也重扫一遍（几分钟）',
  '  reparse [--write] [--limit N]            用当前解析器重算已存的原文（默认只报告）',
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
        log.info('抓取完成：发现 ' + res.discovered + ' 条，新增 ' + res.fetched + ' 条，失败 ' + res.failed.length + ' 条'
          + (res.incomplete.length ? '，其中 ' + res.incomplete.length + ' 期不满 20 名（已标记 complete:false）' : ''));
        return res.failed.length ? 2 : 0;
      }
      case 'nico': {
        const res = await runNico(cfg, log, {
          force: Boolean(args.force),
          deep: Boolean(args.deep),
          limit: Number(args.limit || 0),
          covers: !args['no-covers'],
          backfillCovers: Boolean(args.backfill)
        });
        if (!res) { console.log('附榜未启用（config.nico.enabled = false）'); return 0; }
        log.info('附榜完成：扫描 ' + res.scanned + ' 条动态，周榜帖 ' + res.discovered + ' 期'
          + (res.skippedSpecial ? '（跳过非周刊帖 ' + res.skippedSpecial + ' 条）' : '')
          + '，新增 ' + res.fetched + ' 期，失败 ' + res.failed.length + ' 期'
          + (res.incomplete.length ? '，缺名 ' + res.incomplete.length + ' 期' : ''));
        return res.failed.length ? 2 : 0;
      }
      case 'reparse': {
        const store = new RawStore(cfg.paths.raw);
        const write = Boolean(args.write);
        const res = reparseAll(store, { write, limit: Number(args.limit || 0), logger: log });
        console.log('');
        console.log('重解析：扫描 ' + res.scanned + ' 期 · 可解析 ' + res.parsed + ' · 有差异 ' + res.changed + ' · 无法解析 ' + res.unparsable);
        if (res.changed) {
          console.log('差异统计：曲名 ' + res.counts.title + ' · 链接 ' + res.counts.url + ' · 封面 ' + res.counts.cover
            + ' · 新增名次 ' + res.counts.added + ' · 消失名次 ' + res.counts.removed);
          console.log('有差异的期：' + res.changedIds.slice(0, 20).join('、') + (res.changedIds.length > 20 ? ' …（共 ' + res.changedIds.length + ' 期）' : ''));
          console.log(write
            ? '已写回 data/raw；页面点「刷新」（或重启服务）后生效'
            : '这是试运行，什么都没写。确认无误后加 --write');
        }
        if (res.problems.length) {
          console.log('无法重解析 ' + res.problems.length + ' 期：');
          res.problems.slice(0, 10).forEach((x) => console.log('  ' + x.id + '  ' + x.reason));
        }
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
        if (res.crawl) {
          log.info('抓取：发现 ' + res.crawl.discovered + ' 条，新增 ' + res.crawl.fetched + ' 条，失败 ' + res.crawl.failed.length + ' 条'
            + (res.crawl.incomplete && res.crawl.incomplete.length ? '，缺名 ' + res.crawl.incomplete.length + ' 期' : ''));
        }
        if (res.nico) {
          log.info('附榜：新增 ' + res.nico.fetched + ' 期，失败 ' + res.nico.failed.length + ' 期'
            + (res.nico.error ? '（' + res.nico.error + '）' : ''));
        }
        console.log('');
        console.log(formatReport(res.dataset));
        log.info('耗时 ' + (res.ms / 1000).toFixed(1) + 's。服务端会自动重载数据（或点页面右上角刷新）');
        return 0;
      }
      case 'report': {
        console.log(reportText(cfg));
        return 0;
      }
      case 'status': {
        console.log(statusText(cfg));
        return 0;
      }
      case 'doctor': {
        const res = await doctor(cfg, log);
        console.log(res.lines);
        return res.ok ? 0 : 1;
      }
      case 'schedule': {
        if (args.show) { console.log(scheduleText(cfg)); return 0; }
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
