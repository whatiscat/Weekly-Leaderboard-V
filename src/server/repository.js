import fs from 'node:fs';
import path from 'node:path';
import { buildDataset } from '../model/build.js';
import { RawStore } from '../crawler/store.js';
import { readJson } from '../util/fsx.js';

function loadBoards(cfg) {
  const dir = path.join(cfg.paths.data, 'boards');
  return {
    issues: {
      weekly: readJson(path.join(dir, 'issues-1.json'), []) || [],
      legend: readJson(path.join(dir, 'issues-2.json'), []) || []
    },
    songs: readJson(path.join(dir, 'songs.json'), []) || [],
    covers: readJson(path.join(cfg.paths.data, 'covers.json'), {}) || {}
  };
}

function idOf(e) {
  return e.songId ?? e.bvid ?? e.title;
}

function uniq(arr) {
  return [...new Set(arr)];
}

/**
 * 数据访问层：把原始数据编译成「可直接渲染」的视图。
 * 页面只负责画，所有派生逻辑（涨跌、在榜、变体、冠军段）都在服务端算好。
 */
export class Repository {
  constructor(cfg, log) {
    this.cfg = cfg;
    this.log = log;
    this.dataset = null;
    this.builtAt = 0;
  }

  invalidate() {
    this.dataset = null;
    this.builtAt = 0;
  }

  /** 数据版本：取数据文件的最大 mtime，用于「刷新」判断是否有新内容 */
  dataVersion() {
    const dir = path.join(this.cfg.paths.data, 'boards');
    const files = ['issues-1.json', 'issues-2.json', 'songs.json'].map((f) => path.join(dir, f));
    files.push(path.join(this.cfg.paths.data, 'covers.json'));
    let v = 0;
    for (const f of files) {
      try { v = Math.max(v, fs.statSync(f).mtimeMs); } catch { /* 缺文件忽略 */ }
    }
    return Math.round(v);
  }

  ensure() {
    if (this.dataset) return this.dataset;
    const started = Date.now();
    this.version = this.dataVersion();
    // 只读一次磁盘：songs.json 是 4MB 级别，loadBoards 调两次就是白读两遍
    // （以前 ensure() 里确实调了两次，一次建数据集、一次取封面）。
    const boards = loadBoards(this.cfg);
    const ds = buildDataset(new RawStore(this.cfg.paths.raw).all(), boards, this.cfg);
    if (!ds.issues.length) throw new Error('没有可用数据：先运行 node src/cli.js sync');
    ds.covers = boards.covers;
    this.dataset = ds;
    this.builtAt = Date.now();
    this.log?.info('数据集已载入：' + ds.issues.length + ' 期 / ' + ds.stats.entries + ' 条，用时 ' + (this.builtAt - started) + 'ms');
    this.#index();
    return ds;
  }

  #index() {
    const ds = this.dataset;
    this.history = new Map();
    ds.issues.forEach((it, i) => {
      for (const e of it.entries) {
        const id = idOf(e);
        if (!this.history.has(id)) this.history.set(id, []);
        this.history.get(id).push({ i, rank: e.rank, bvid: e.bvid, issue: it.issue, date: it.date });
      }
    });
    this.byIssue = new Map(ds.issues.map((it, i) => [it.issue, { issue: it, index: i }]));
  }

  meta() {
    const ds = this.ensure();
    return {
      account: ds.meta.account,
      charts: ds.meta.charts,
      sources: ds.meta.sources,
      alignment: ds.meta.alignment,
      gaps: ds.meta.gaps,
      quality: ds.meta.quality,
      stats: ds.stats,
      generatedAt: new Date(this.version || Date.now()).toISOString(),
      dataVersion: this.version,
      builtAt: new Date(this.builtAt).toISOString()
    };
  }

  issuesIndex() {
    const ds = this.ensure();
    return ds.issues.map((it) => {
      const top = it.entries.find((e) => e.rank === 1) || it.entries[0] || {};
      return {
        issue: it.issue,
        date: it.date,
        week: it.week,
        count: it.entries.length,
        postUrl: it.postUrl || '',
        champion: top ? { title: top.titleCn || top.title, bvid: top.bvid } : null
      };
    });
  }

  #decorate(it, index) {
    const prev = index > 0 ? this.dataset.issues[index - 1] : null;
    const prevMap = new Map((prev?.entries || []).map((e) => [idOf(e), e.rank]));
    return it.entries
      .map((e) => {
        const id = idOf(e);
        const hist = (this.history.get(id) || []).filter((h) => h.i <= index);
        const prevRank = prevMap.has(id) ? prevMap.get(id) : null;
        const isNew = hist.length === 1 && prevRank === null;
        const state = isNew ? 'new' : prevRank === null ? 're' : prevRank - e.rank > 0 ? 'up' : prevRank - e.rank < 0 ? 'down' : 'same';
        const best = hist.reduce((m, h) => Math.min(m, h.rank), 99);
        return {
          rank: e.rank,
          songId: id,
          bvid: e.bvid,
          title: e.titleCn || e.title,
          titleAlt: e.title !== (e.titleCn || e.title) ? e.title : '',
          producers: e.producers || [],
          vocalists: e.vocalists || [],
          prev: prevRank,
          delta: prevRank === null ? null : prevRank - e.rank,
          state,
          weeks: hist.length,
          best,
          spark: hist.slice(-30).map((h) => ({ i: h.i, rank: h.rank })),
          variants: uniq(hist.map((h) => h.bvid).filter(Boolean)).length
        };
      })
      .sort((a, b) => a.rank - b.rank);
  }

  issue(n) {
    const ds = this.ensure();
    const hit = this.byIssue.get(Number(n));
    if (!hit) return null;
    const it = hit.issue;
    const rows = this.#decorate(it, hit.index);
    const prev = hit.index > 0 ? this.dataset.issues[hit.index - 1] : null;
    const prevIds = new Set((prev?.entries || []).map(idOf));
    const curIds = new Set(rows.map((r) => r.songId));

    let streak = 1;
    const champ = rows[0];
    for (let i = hit.index - 1; i >= 0; i--) {
      const top = this.dataset.issues[i].entries.find((e) => e.rank === 1);
      if (top && idOf(top) === champ?.songId) streak++;
      else break;
    }

    const news = rows.filter((r) => r.state === 'new');
    const ups = rows.filter((r) => r.state === 'up').sort((a, b) => b.delta - a.delta);
    const downs = rows.filter((r) => r.state === 'down').sort((a, b) => a.delta - b.delta);
    const outs = (prev?.entries || [])
      .filter((e) => !curIds.has(idOf(e)))
      .map((e) => ({ title: e.titleCn || e.title, rank: e.rank, songId: idOf(e) }))
      .sort((a, b) => a.rank - b.rank);

    return {
      issue: it.issue,
      date: it.date,
      week: it.week,
      year: it.year,
      postUrl: it.postUrl || '',
      count: rows.length,
      rows,
      champStreak: champ ? streak : 0,
      kpi: {
        news: news.length,
        ups: ups.length,
        downs: downs.length,
        streak: champ ? streak : 0,
        count: rows.length
      },
      insights: {
        news: news.slice(0, 6).map((r) => ({ rank: r.rank, title: r.title })),
        ups: ups.slice(0, 6).map((r) => ({ title: r.title, delta: r.delta })),
        outs: outs.slice(0, 6)
      },
      sidebar: {
        prevChampion: prev ? (() => {
          const top = prev.entries.find((e) => e.rank === 1) || prev.entries[0];
          const now = rows.find((r) => r.songId === idOf(top));
          return top ? { title: top.titleCn || top.title, rank: now ? now.rank : null } : null;
        })() : null,
        longest: rows.slice().sort((a, b) => b.weeks - a.weeks)[0] || null
      }
    };
  }

  champions(limit = 24) {
    const ds = this.ensure();
    const runs = [];
    ds.issues.forEach((it, i) => {
      const top = it.entries.find((e) => e.rank === 1);
      if (!top) return;
      const id = idOf(top);
      const last = runs[runs.length - 1];
      if (last && last.id === id) {
        last.end = i;
        last.count++;
        last.issueTo = it.issue;
      } else {
        runs.push({ id, title: top.titleCn || top.title, bvid: top.bvid, start: i, end: i, count: 1, issueFrom: it.issue, issueTo: it.issue, date: it.date });
      }
    });
    return { total: runs.length, runs: runs.slice(-limit).reverse() };
  }

  legend(limit = 8) {
    const ds = this.ensure();
    return (ds.legend || []).slice(-limit).reverse();
  }

  songs(q = '', limit = 200) {
    const ds = this.ensure();
    const needle = String(q).trim().toLowerCase();
    const items = [];
    for (const [id, hist] of this.history) {
      const last = hist[hist.length - 1];
      const issue = this.dataset.issues[last.i];
      const entry = issue.entries.find((e) => idOf(e) === id) || {};
      const title = entry.titleCn || entry.title || '';
      const alt = entry.title || '';
      if (needle && !(title + ' ' + alt).toLowerCase().includes(needle)) continue;
      const best = hist.reduce((m, h) => Math.min(m, h.rank), 99);
      items.push({ id, title, titleAlt: alt === title ? '' : alt, weeks: hist.length, best, lastIssue: issue.issue });
    }
    items.sort((a, b) => b.weeks - a.weeks || a.best - b.best);
    return { total: items.length, items: items.slice(0, limit) };
  }

  song(id) {
    const ds = this.ensure();
    const key = /^\d+$/.test(String(id)) ? Number(id) : id;
    const hist = this.history.get(key) || this.history.get(String(key));
    if (!hist || !hist.length) return null;
    const last = hist[hist.length - 1];
    const lastIssue = ds.issues[last.i];
    const entry = lastIssue.entries.find((e) => idOf(e) === key) || {};
    const byBvid = new Map();
    for (const h of hist) {
      if (!h.bvid) continue;
      if (!byBvid.has(h.bvid)) byBvid.set(h.bvid, []);
      byBvid.get(h.bvid).push(h.issue);
    }
    return {
      id: key,
      title: entry.titleCn || entry.title || '',
      titleAlt: entry.title !== (entry.titleCn || entry.title) ? entry.title : '',
      producers: entry.producers || [],
      vocalists: entry.vocalists || [],
      weeks: hist.length,
      best: hist.reduce((m, h) => Math.min(m, h.rank), 99),
      appearances: hist.map((h) => ({ issue: h.issue, date: h.date, rank: h.rank, bvid: h.bvid })),
      variants: [...byBvid.entries()].map(([bvid, issues]) => ({ bvid, issues }))
    };
  }

  csv() {
    const ds = this.ensure();
    const rows = ['期号,日期,名次,曲名,原名,P主,歌手,BV号'];
    for (const it of ds.issues) {
      for (const e of it.entries) {
        rows.push([
          it.issue,
          it.date,
          e.rank,
          '"' + String(e.titleCn || e.title || '').replace(/"/g, '""') + '"',
          '"' + String(e.title || '').replace(/"/g, '""') + '"',
          '"' + (e.producers || []).join(' / ') + '"',
          '"' + (e.vocalists || []).join(' / ') + '"',
          e.bvid || ''
        ].join(','));
      }
    }
    return '\ufeff' + rows.join('\r\n') + '\r\n';
  }

  coverUrl(bvid, width) {
    this.ensure();
    const covers = this.dataset.covers || {};
    const base = covers[bvid];
    if (!base) return '';
    if (width && !base.includes('@')) {
      const h = Math.round((Number(width) * 9) / 16);
      return base + '@' + width + 'w_' + h + 'h_1c.webp';
    }
    return base;
  }
}
