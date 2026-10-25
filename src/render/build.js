import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, writeText } from '../util/fsx.js';

const TOKEN = /\{\{([A-Z_]+)\}\}/g;
function fill(template, vars) {
  return template.replace(TOKEN, (m, key) => (key in vars ? vars[key] : m));
}
function inlineJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function monthLabel(date) {
  return String(date || '').slice(0, 7).replace('-', '.');
}

export function renderLegend(legend) {
  if (!legend.length) return '';
  const rows = legend
    .slice(-8)
    .reverse()
    .map((it) => '<tr><td>第 ' + it.issue + ' 期</td><td>' + esc(it.date) + '</td><td>' + esc(it.champion) + '</td>'
      + '<td>' + (it.videoBvid ? '<a href="https://www.bilibili.com/video/' + esc(it.videoBvid) + '" target="_blank" rel="noopener">榜单视频 ↗</a>' : '') + '</td></tr>')
    .join('');
  return '<section>\n'
    + '  <div class="sec-head"><h3>附：传说曲周榜</h3><div class="desc">同账号发布的另一条榜单（期号独立），展示最近 8 期冠军</div></div>\n'
    + '  <div class="board"><table class="ltable"><thead><tr><th>期号</th><th>日期</th><th>本期冠军</th><th>链接</th></tr></thead><tbody>' + rows + '</tbody></table></div>\n'
    + '</section>';
}

export function renderFooter(meta, stats, totalEntries) {
  const gapText = meta.gaps.length
    ? meta.gaps.map((g) => '第 ' + g.issue + ' 期缺第 ' + g.miss.join('、') + ' 名').join('；') + '。'
    : '';
  const stamp = String(meta.generatedAt || '').slice(0, 10);
  const al = meta.alignment;
  return [
    '<div><b>曲目对齐</b>：以 Biliboard 公开曲目库的歌曲 ID 为准，同一首歌的不同译名、不同投稿稿件（BV 号）会归为同一条记录；每行显示该期实际使用的稿件。已核对 ' + al.issues + ' 期 / ' + al.ranks + ' 个名次，稿件差异 ' + al.bvidMismatch + ' 处。</div>',
    '<div><b>统计口径</b>：每期统计上周周二 0 点至本周周二 0 点的数据；得分 = 播放基数 + 新增收藏 × 15 + 新增点赞 × 3 + 新增硬币 × 30（播放基数 = 新增播放 × 时间修正）。</div>',
    '<div><b>数据来源</b>：Biliboard 公开数据（' + esc(meta.sources.board) + '）+ ' + esc(meta.account.name) + ' 的文字版周榜帖；共 ' + meta.charts.first + '–' + meta.charts.last + ' 期、' + totalEntries + ' 条记录，整理于 ' + stamp + '。</div>',
    '<div><b>说明</b>：' + gapText + '名次不完全等同于歌曲质量，请理性看待。</div>'
  ].join('\n');
}

export function renderHtml(dataset, cfg, { template, css, app }) {
  const { meta, issues, legend, stats } = dataset;
  const totalEntries = issues.reduce((n, it) => n + it.entries.length, 0);
  const subtitle = '术力口周榜 · 第 ' + meta.charts.first + '–' + meta.charts.last + ' 期（'
    + monthLabel(issues[0].date) + ' – ' + monthLabel(issues.at(-1).date) + '）· 共 ' + totalEntries
    + ' 条 · 曲目按 Biliboard ID 对齐 · 来源 ' + meta.account.name;

  const data = { meta, issues, legend, stats, covers: dataset.covers || {} };
  const vars = {
    TITLE: esc(cfg.render.title) + ' | ' + esc(meta.account.name),
    CSS: css,
    BRAND: esc(cfg.render.brand),
    HEADING: esc(cfg.render.title),
    SUBTITLE: esc(subtitle),
    SPACE_URL: esc(meta.sources.space),
    READ_LIST: esc(meta.sources.readList),
    CSV_NAME: esc(cfg.render.csvName),
    LEGEND_SECTION: renderLegend(legend),
    FOOTER: renderFooter(meta, stats, totalEntries),
    DATA: inlineJson(data),
    APP: app
  };
  return fill(template, vars);
}

function q(s) {
  return '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';
}

export function renderCsv(issues) {
  const rows = ['期号,日期,名次,曲名,原名,P主,歌手,BV号'];
  for (const it of issues) {
    for (const e of it.entries) {
      rows.push([
        it.issue,
        it.date,
        e.rank,
        q(e.titleCn || e.title),
        q(e.title || ''),
        q((e.producers || []).join(' / ')),
        q((e.vocalists || []).join(' / ')),
        e.bvid || ''
      ].join(','));
    }
  }
  return '\ufeff' + rows.join('\r\n') + '\r\n';
}

export function renderSite(dataset, cfg) {
  const template = fs.readFileSync(cfg.paths.template, 'utf8');
  const css = fs.readFileSync(path.join(cfg.paths.assets, 'styles.css'), 'utf8');
  const app = fs.readFileSync(path.join(cfg.paths.assets, 'app.js'), 'utf8');

  ensureDir(cfg.paths.public);
  const html = renderHtml(dataset, cfg, { template, css, app });
  const htmlPath = path.join(cfg.paths.public, cfg.render.htmlName);
  const csvPath = path.join(cfg.paths.public, cfg.render.csvName);
  const jsonPath = path.join(cfg.paths.public, cfg.render.jsonName);

  writeText(htmlPath, html);
  writeText(csvPath, renderCsv(dataset.issues));
  writeText(jsonPath, JSON.stringify({ meta: dataset.meta, stats: dataset.stats, issues: dataset.issues, legend: dataset.legend }));

  return { html: htmlPath, csv: csvPath, json: jsonPath, bytes: Buffer.byteLength(html) };
}
