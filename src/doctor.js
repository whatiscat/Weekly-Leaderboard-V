import fs from 'node:fs';
import path from 'node:path';
import { readJson } from './util/fsx.js';

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
  const covers = readJson(path.join(cfg.paths.data, 'covers.json'), {}) || {};
  const webIndex = path.join(cfg.paths.web, 'index.html');
  lines.push('数据：官方期次 ' + issuesMeta.length + ' 期 · 曲目 ' + songs.length + ' 首 · 封面直链 ' + Object.keys(covers).length + ' 条 · 帖子 ' + rawCount + ' 期');
  lines.push('前端：' + (fs.existsSync(webIndex) ? 'src/web 就绪' : '缺少 src/web/index.html'));
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
  lines.push('最近同步：' + (state.lastSyncAt || '从未') + ' · 最近抓帖：' + (state.lastCrawlAt || '从未') + ' · 最近构建：' + (state.lastBuildAt || '从未'));
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
