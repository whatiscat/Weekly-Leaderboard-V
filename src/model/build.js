import { isChartPost, parseTitle } from '../util/text.js';
import { summarize } from './stats.js';

function dateFromTs(ts) {
  if (!ts) return null;
  return new Date(Number(ts) * 1000).toISOString().slice(0, 10);
}

function names(list) {
  return (list || []).map((x) => (typeof x === 'string' ? x : x?.name)).filter(Boolean);
}

function slimStats(s) {
  if (!s) return null;
  return { views: s.views ?? 0, likes: s.likes ?? 0, coins: s.coins ?? 0, favorites: s.favorites ?? 0 };
}

function entryOf(row) {
  return {
    rank: row.rank,
    songId: row.songId,
    bvid: row.bvid || '',
    title: row.title || '',
    titleCn: row.titleCn || '',
    producers: names(row.producers),
    vocalists: names(row.vocalists),
    score: row.score ?? null,
    stats: slimStats(row.stats),
    weeksOnBoard: row.weeksOnBoard ?? null,
    peakRank: row.peakRank ?? null,
    lastRank: row.lastRank ?? null,
    change: row.rankChange ? { kind: row.rankChange.kind, diff: row.rankChange.diff } : null,
    special: row.specialStatus ?? null
  };
}

/**
 * 用 biliboard 公开库构建数据集：
 * 曲目身份 = song.id（与译名、稿件 BV 无关），
 * 每期每行保留该期实际使用的 BV，便于「同一首歌多个稿件」的追溯。
 */
export function buildDataset(rawRecords, boards, config) {
  const songs = boards?.songs || [];
  const issueMeta = boards?.issues?.weekly || [];
  const legendMeta = boards?.issues?.legend || [];

  // 期次 → 行
  const rowsByIssue = new Map();
  for (const song of songs) {
    for (const h of song.history || []) {
      if (h.boardId !== 1) continue;
      const row = { ...h, songId: song.id, producers: h.producers?.length ? h.producers : song.producers, vocalists: h.vocalists?.length ? h.vocalists : song.vocalists };
      if (!rowsByIssue.has(h.issueId)) rowsByIssue.set(h.issueId, []);
      rowsByIssue.get(h.issueId).push(row);
    }
  }

  // 帖子（B 站周榜帖）→ 按「发布日期」匹配官方期次
  // 原帖标题偶有期号笔误（如把第 65 期写成第 25 期），用日期对齐更可靠
  const postsByDate = new Map();
  for (const r of rawRecords) {
    if (!r?.entries?.length || !isChartPost(r.title)) continue;
    const p = parseTitle(r.title);
    const day = dateFromTs(r.pubTs) || p.date;
    if (!day) continue;
    const rec = {
      url: r.cv ? 'https://www.bilibili.com/read/cv' + r.cv + '/' : 'https://www.bilibili.com/opus/' + r.id,
      title: r.title,
      date: day,
      week: p.week,
      issueInTitle: p.issue,
      entries: r.entries.map((e) => ({ rank: e.rank, bvid: (e.url || '').match(/BV[0-9A-Za-z]+/)?.[0] || '', title: e.title }))
    };
    if (!postsByDate.has(day)) postsByDate.set(day, []);
    postsByDate.get(day).push(rec);
  }
  /**
   * 给一期找文字版原帖：优先同一天，否则取 ±4 天内日期最近的一条。
   * 返回的 diffDays 是**配对偏差**，不是装饰：原帖期号有笔误（第 65 期写成第 25 期），
   * 所以配对只能靠日期；而日期一旦配错，BV 核对会整片飘红。把偏差记下来，
   * 偏差 >1 天的期数进 alignment，让人一眼看出"这期是不是配歪了"。
   */
  function postFor(issueDate) {
    if (!issueDate) return null;
    if (postsByDate.has(issueDate)) return { post: postsByDate.get(issueDate)[0], diffDays: 0 };
    const t = new Date(issueDate + 'T00:00:00Z').getTime();
    let best = null;
    let bestDiff = 4;
    for (const [day, list] of postsByDate) {
      const diff = Math.abs(new Date(day + 'T00:00:00Z').getTime() - t) / 86400000;
      if (diff < bestDiff) { bestDiff = diff; best = list[0]; }
    }
    return best ? { post: best, diffDays: Math.round(bestDiff * 10) / 10 } : null;
  }

  const issues = [];
  for (const m of issueMeta) {
    const rows = (rowsByIssue.get(m.issue_id) || []).sort((a, b) => a.rank - b.rank);
    if (!rows.length) continue;
    const date = dateFromTs(m.video_pubdate || m.end_date);
    const pair = postFor(date);
    const post = pair?.post || null;
    issues.push({
      issue: m.issue_id,
      year: m.year,
      week: post?.week ?? m.week,
      date,
      endDate: dateFromTs(m.end_date),
      videoBvid: m.video_bvid || '',
      postUrl: post?.url || '',
      postTitle: post?.title || '',
      postDateDiff: pair ? pair.diffDays : null,
      postedWeek: post?.week ?? null,
      entries: rows.map(entryOf)
    });
  }
  issues.sort((a, b) => a.issue - b.issue);

  // 对齐校验：官方行 vs 帖子行（同名义曲目/改译名/换稿件都会在这里体现）
  const alignment = { issues: 0, ranks: 0, bvidMismatch: 0, maxPostDiffDays: 0, looseMatches: 0, rows: [] };
  for (const it of issues) {
    const pair = postFor(it.date);
    if (!pair) continue;
    const post = pair.post;
    alignment.maxPostDiffDays = Math.max(alignment.maxPostDiffDays, pair.diffDays);
    // 超过 1 天就算"松配对"：原帖通常在榜单发布当天或前一天出现，
    // 差到 2 天以上多半是某一期没有原帖、被邻期顶上了。
    if (pair.diffDays > 1) alignment.looseMatches++;
    alignment.issues++;
    const byRank = new Map(post.entries.map((e) => [e.rank, e]));
    for (const e of it.entries) {
      const p = byRank.get(e.rank);
      if (!p) continue;
      alignment.ranks++;
      if (p.bvid && e.bvid && p.bvid !== e.bvid) {
        alignment.bvidMismatch++;
        alignment.rows.push({ issue: it.issue, rank: e.rank, official: e.bvid, post: p.bvid, title: p.title });
      }
    }
  }

  // 传说曲附榜：最近若干期
  const legendRows = new Map();
  for (const song of songs) {
    for (const h of song.history || []) {
      if (h.boardId !== 2) continue;
      if (!legendRows.has(h.issueId)) legendRows.set(h.issueId, []);
      legendRows.get(h.issueId).push({ ...h, songId: song.id });
    }
  }
  const legend = legendMeta
    .slice()
    .sort((a, b) => a.issue_id - b.issue_id)
    .map((m) => {
      const rows = (legendRows.get(m.issue_id) || []).sort((a, b) => a.rank - b.rank);
      return rows.length
        ? { issue: m.issue_id, date: dateFromTs(m.video_pubdate || m.end_date), champion: rows[0].titleCn || rows[0].title, championId: rows[0].songId, videoBvid: m.video_bvid, count: rows.length }
        : null;
    })
    .filter(Boolean);

  // 缺名：以官方声明的 video_count 为准，**不要写死 20**。
  // 有两期（第 63、73 期）官方就只有 19 首，写死 20 会把它们误报成缺一名，
  // 于是页脚的「数据完整性」永远停在 121/123 —— 假警报比没有警报更糟。
  const expectedOf = (issue) => {
    const board = issueMeta.find((m) => m.issue_id === issue);
    return Number.isInteger(board?.video_count) && board.video_count > 0 ? board.video_count : 20;
  };

  const gaps = [];
  const numberingGaps = [];
  for (const it of issues) {
    const expected = expectedOf(it.issue);
    const have = new Set(it.entries.map((e) => e.rank));
    const missingFromList = [];
    for (let r = 1; r <= expected; r++) if (!have.has(r)) missingFromList.push(r);
    const short = Math.max(0, expected - have.size);
    if (short > 0) {
      gaps.push({ issue: it.issue, date: it.date, expected, have: have.size, miss: missingFromList });
    } else if (missingFromList.length) {
      // 条数够了但名次不连续（例如 19 首里没有 #18、却有 #20）：
      // 这是原榜的编号习惯，不是缺歌，单独记一笔、不进 gaps。
      numberingGaps.push({ issue: it.issue, miss: missingFromList });
    }
  }

  const expectedEntries = issues.reduce((n, it) => {
    const board = issueMeta.find((m) => m.issue_id === it.issue);
    return n + (Number.isInteger(board?.video_count) && board.video_count > 0 ? board.video_count : 20);
  }, 0);
  const actualEntries = issues.reduce((n, it) => n + it.entries.length, 0);

  const meta = {
    account: config.account,
    generatedAt: new Date().toISOString(),
    title: config.site.title,
    brand: config.site.brand,
    csvName: config.site.csvName,
    sources: {
      board: 'https://biliboard.uk',
      space: config.account.spaceUrl,
      readList: 'https://www.bilibili.com/read/readlist/rl954223'
    },
    charts: { first: issues[0]?.issue ?? null, last: issues.at(-1)?.issue ?? null },
    alignment: {
      issues: alignment.issues,
      ranks: alignment.ranks,
      bvidMismatch: alignment.bvidMismatch,
      maxPostDiffDays: alignment.maxPostDiffDays,
      looseMatches: alignment.looseMatches
    },
    gaps,
    quality: {
      completeIssues: issues.length - gaps.length,
      totalIssues: issues.length,
      missingRanks: gaps.reduce((n, g) => n + (g.expected - g.have), 0),
      numberingGaps: numberingGaps.length,
      entries: { actual: actualEntries, expected: expectedEntries },
      // 有文字版原帖的期数：原帖只是旁证（用于核对 BV 与期号），
      // 缺了它不影响榜单数据本身。
      posts: {
        aligned: issues.filter((it) => it.postUrl).length,
        total: issues.length
      }
    }
  };

  return { meta, issues, legend, stats: summarize(issues), alignment: alignment.rows };
}
