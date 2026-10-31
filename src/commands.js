import fs from 'node:fs';
import path from 'node:path';
import { formatReport, loadDataset } from './run.js';
import { RawStore } from './crawler/store.js';
import { readJson } from './util/fsx.js';

/* ---------------------------------------------------------------------------
 * 三个"只看不写"的命令：report / status / doctor。
 *
 * 它们原本直接写在 cli.js 的 switch 里，靠 console.log 输出。搬到 WebUI 之后
 * 需要同一份文本既进终端、又进设置抽屉的输出框，所以抽成返回字符串的函数 ——
 * 一份实现，两个出口。doctor 本来就是这个形状（返回 { ok, lines }）。
 * ------------------------------------------------------------------------- */

/** 下一次自动更新时刻（与 cli 的 schedule 共用同一份算法） */
export function nextRunAt({ weekday, hour, minute }) {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  let add = (weekday - next.getDay() + 7) % 7;
  if (add === 0 && next <= now) add = 7;
  next.setDate(next.getDate() + add);
  return next;
}

/** schedule：定时配置 + 下次运行时间（只读） */
export function scheduleText(cfg) {
  const s = cfg.schedule || {};
  const names = ['日', '一', '二', '三', '四', '五', '六'];
  const pad = (n) => String(n).padStart(2, '0');
  const next = nextRunAt(s);
  return [
    '定时更新：每周' + names[s.weekday] + ' ' + pad(s.hour) + ':' + pad(s.minute),
    '下一次：' + next.toLocaleString() + '（' + Math.round((next - Date.now()) / 60000) + ' 分钟后）',
    '',
    '这个时间是给操作系统层面的计划任务用的（scripts/register-task.ps1），',
    '由它调 node src/cli.js schedule --once。网页里不复刻调度器 ——',
    '两个调度器同时跑会重复更新、还会互相抢 data/.lock。',
    '想现在就跑一次，用上面的「更新数据」。'
  ].join('\n');
}

/** report：数据摘要（期数、曲目、冠军段、附榜、覆盖） */
export function reportText(cfg) {
  return formatReport(loadDataset(cfg));
}

/** status：数据文件与最近一次跑批的时间 */
export function statusText(cfg) {
  const lines = [];
  const store = new RawStore(cfg.paths.raw);
  const state = readJson(cfg.paths.state, {}) || {};
  lines.push('数据：官方曲目库 ' + (fs.existsSync(path.join(cfg.paths.data, 'boards', 'songs.json')) ? '已同步' : '缺失')
    + ' · 帖子原始记录 ' + store.ids().length + ' 期');

  const covers = readJson(path.join(cfg.paths.data, 'covers.json'), {}) || {};
  const failures = readJson(path.join(cfg.paths.data, 'failures.json'), {}) || {};
  lines.push('封面直链 ' + Object.keys(covers).length + ' 条 · 抓帖失败记录 ' + Object.keys(failures).length + ' 条');

  const syncMeta = readJson(path.join(cfg.paths.data, 'boards', 'meta.json'), {}) || {};
  // 三张榜的期数以**数据集**为准而不是 meta.json：年榜没有独立期次表时，
  // 期次是从曲目库的 board 3 行推出来的，meta 里只记了抓到的条数（可能是 0）。
  try {
    const b = loadDataset(cfg).meta.boards;
    lines.push('期次：周榜 ' + b.weekly.issues + ' 期 · 传说曲周榜 ' + b.legend.issues + ' 期 · 年榜 ' + b.annual.issues + ' 期');
  } catch (err) {
    lines.push('期次：载入数据集失败（' + err.message + '）');
  }

  if (syncMeta.quality) {
    const q = syncMeta.quality;
    lines.push('数据质量：满员 ' + q.completeIssues + '/' + q.totalIssues + ' 期'
      + (q.stale ? ' · ⚠ 曲目库可能不是最新（建议 sync --full）' : '')
      + (q.warnings && q.warnings.length ? ' · 一致性告警 ' + q.warnings.length + ' 条' : ''));
  }
  lines.push('最近同步: ' + (state.lastSyncAt || '从未') + ' · 最近抓帖: ' + (state.lastCrawlAt || '从未')
    + ' · 最近更新: ' + (state.lastRunAt || '从未'));
  if (cfg.nico?.enabled) {
    const nicoStore = new RawStore(cfg.paths.nico);
    lines.push('附榜（' + cfg.nico.title + '）：' + nicoStore.ids().length + ' 期已抓 · 最近抓取 ' + (state.lastNicoAt || '从未'));
  }
  if (state.stats) lines.push('数据统计: ' + state.stats.issues + ' 期 / ' + state.stats.entries + ' 条 / ' + state.stats.songs + ' 首');
  lines.push('前端目录: ' + (fs.existsSync(path.join(cfg.paths.web, 'index.html')) ? 'ok' : '缺失'));
  lines.push('启动服务: node src/cli.js serve --open');
  return lines.join('\n');
}
