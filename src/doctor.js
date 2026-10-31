import fs from 'node:fs';
import path from 'node:path';
import { readJson } from './util/fsx.js';
import { checkLatest, describeCoverage } from './biliboard/validate.js';

const UA = 'Mozilla/5.0 (compatible; bbw/1.0)';

async function probe(name, url, check) {
  const t0 = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' }, signal: ctrl.signal }).finally(() => clearTimeout(timer));
    const ms = Date.now() - t0;
    const ok = check ? check(res) : res.ok;
    return { name, ok, status: res.status, ms, detail: ok ? '' : 'HTTP ' + res.status };
  } catch (err) {
    return { name, ok: false, status: 0, ms: Date.now() - t0, detail: err.message };
  }
}

export async function doctor(cfg, log) {
  const lines = [];
  const issues = [];
  lines.push('Node ' + process.version + ' · ' + (process.platform === 'win32' ? 'Windows' : process.platform));
  lines.push('项目 ' + path.resolve('.'));
  lines.push('');

  // 本地数据
  const rawDir = cfg.paths.raw;
  const boardsDir = path.join(cfg.paths.data, 'boards');
  const rawCount = fs.existsSync(rawDir) ? fs.readdirSync(rawDir).filter((f) => f.endsWith('.json')).length : 0;
  const songs = readJson(path.join(boardsDir, 'songs.json'), []) || [];
  const issuesMeta = readJson(path.join(boardsDir, 'issues-1.json'), []) || [];
  const legendMeta = readJson(path.join(boardsDir, 'issues-2.json'), []) || [];
  const annualMeta = readJson(path.join(boardsDir, 'issues-3.json'), []) || [];
  const covers = readJson(path.join(cfg.paths.data, 'covers.json'), {}) || {};
  const webIndex = path.join(cfg.paths.web, 'index.html');
  const nicoCount = cfg.nico?.enabled && fs.existsSync(cfg.paths.nico)
    ? fs.readdirSync(cfg.paths.nico).filter((f) => f.endsWith('.json')).length
    : 0;
  lines.push('数据：官方期次 ' + issuesMeta.length + ' 期 · 曲目 ' + songs.length + ' 首 · 封面直链 ' + Object.keys(covers).length + ' 条 · 帖子 ' + rawCount + ' 期');
  lines.push('附榜 B：ニコニコ ' + (nicoCount
    ? nicoCount + ' 期（' + cfg.nico.title + '）'
    : (cfg.nico?.enabled ? '还没抓 —— 运行 node src/cli.js nico' : '未启用（config.nico.enabled）')));
  lines.push('前端：' + (fs.existsSync(webIndex) ? 'src/web 就绪' : '缺少 src/web/index.html'));

  // 完整性：缺名次是数据本身的状态（如实报告），曲目库落后于榜单则是"该同步了"
  if (issuesMeta.length && songs.length) {
    const coverage = describeCoverage(songs, issuesMeta);
    const latest = checkLatest(songs, issuesMeta);
    lines.push('完整性：' + coverage.completeIssues + '/' + coverage.totalIssues + ' 期名次齐全'
      + (coverage.orphanRows ? ' · 孤儿行 ' + coverage.orphanRows : '')
      + (coverage.duplicateRanks.length ? ' · 重复名次 ' + coverage.duplicateRanks.length : ''));
    if (coverage.incomplete.length) {
      lines.push('  缺行：' + coverage.incomplete.slice(0, 6).map((x) => '第 ' + x.issue + ' 期 ' + x.have + '/' + x.expected).join('、')
        + (coverage.incomplete.length > 6 ? ' …' : ''));
    }
    if (latest.stale) {
      lines.push('  ⚠ 曲目库最高只到第 ' + latest.latestInSongs + ' 期，榜单已到第 ' + latest.latestIssue + ' 期');
      issues.push('曲目库可能不是最新：运行 node src/cli.js sync --full');
    }

    // 附榜：名次只来自曲目库的 board 2 / 3 行，所以「缺期」意味着曲目库没跟上，
    // 而不是抓取失败。年榜的期次表是可选的（取不到就用曲目行合成），不作问题上报。
    const legendCov = describeCoverage(songs, legendMeta, { boardId: 2 });
    const annualRows = songs.reduce((n, s) => n + (s.history || []).filter((h) => h.boardId === 3).length, 0);
    lines.push('附榜 A：传说曲周榜 ' + legendMeta.length + ' 期（名次齐全 ' + legendCov.completeIssues + '/' + legendCov.totalIssues + '）· 年榜 '
      + (annualMeta.length ? annualMeta.length + ' 期' : '无独立期次表') + ' / 曲目库 ' + annualRows + ' 条');
    if (legendCov.incomplete.length) {
      lines.push('  传说曲周榜缺行：' + legendCov.incomplete.slice(0, 6).map((x) => '第 ' + x.issue + ' 期 ' + x.have + '/' + x.expected).join('、')
        + (legendCov.incomplete.length > 6 ? ' …' : ''));
    }
    if (!annualRows) issues.push('曲目库里没有年榜(board 3)记录：附榜的年榜会是空的');
  }
  if (!songs.length) issues.push('缺少 data/boards/songs.json —— 先运行 node src/cli.js sync --full');
  if (!issuesMeta.length) issues.push('缺少 data/boards/issues-1.json —— 先运行 node src/cli.js sync');
  if (!fs.existsSync(webIndex)) issues.push('前端入口缺失 —— 检查 src/web/index.html');
  if (songs.length && !Object.keys(covers).length) issues.push('封面直链还没解析 —— 运行 node src/cli.js sync（首次约 3 分钟）');

  // 网络
  lines.push('');
  const checks = [];
  const coverSample = Object.values(covers).find((u) => /hdslb\.com/.test(u));
  checks.push({ ...(await probe('biliboard 曲目库', 'https://biliboard.uk/api/public/boards')), hint: '官方期次/曲目库取不到，sync 会失败' });
  checks.push({ ...(await probe('bilibili 导航', 'https://api.bilibili.com/x/web-interface/nav', (r) => r.status === 200)), hint: '帖子抓取与海报链接需要它，失败时看板仍可生成' });
  checks.push({ ...(await probe('bilibili 图片', coverSample || 'https://i0.hdslb.com/bfs/face/5160567186ff7946768bfd4d1b17c694bbc71ee5.jpg', (r) => r.ok)), hint: '封面会加载不出来（浏览器侧网络可能被拦）' });
  for (const c of checks) {
    lines.push((c.ok ? '✓' : '✗') + ' ' + c.name.padEnd(16, ' ') + (c.ok ? c.ms + 'ms' : c.detail + '  → ' + c.hint));
    if (!c.ok) issues.push(c.name + ' 连接失败：' + c.detail + '（' + c.hint + '）');
  }

  // 状态
  const state = readJson(cfg.paths.state, {}) || {};
  lines.push('');
  lines.push('最近同步：' + (state.lastSyncAt || '从未') + ' · 最近抓帖：' + (state.lastCrawlAt || '从未') + ' · 最近更新：' + (state.lastRunAt || '从未'));
  const syncMeta = readJson(path.join(boardsDir, 'meta.json'), {}) || {};
  const syncQuality = syncMeta.quality;
  if (syncQuality && syncQuality.warnings && syncQuality.warnings.length) {
    lines.push('上次同步的一致性告警：');
    syncQuality.warnings.slice(0, 6).forEach((w) => lines.push('  · ' + w));
  }
  if (state.lastCrawl && state.lastCrawl.incomplete && state.lastCrawl.incomplete.length) {
    lines.push('上次抓帖：' + state.lastCrawl.incomplete.length + ' 期不满 20 名（数据本身如此，已如实标记）');
  }
  if (state.stats) lines.push('数据统计：' + state.stats.issues + ' 期 / ' + state.stats.entries + ' 条 / ' + state.stats.songs + ' 首');
  if (state.lastCrawl && state.lastCrawl.error) lines.push('最近一次抓帖失败：' + state.lastCrawl.error);

  lines.push('');
  if (issues.length) {
    lines.push('发现 ' + issues.length + ' 个问题：');
    issues.forEach((x, i) => lines.push('  ' + (i + 1) + '. ' + x));
  } else {
    lines.push('一切正常。');
  }
  return { lines: lines.join('\n'), ok: issues.length === 0, issues };
}
