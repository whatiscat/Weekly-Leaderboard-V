import { WEB } from '../bili/endpoints.js';

/**
 * 附榜（ニコニコ VOCALOID SONGS TOP20）的数据集
 *
 * 与主榜的关系：**完全独立的一张榜**。主榜的名次来自 Biliboard 公开曲目库，
 * 帖子只是旁证；这张榜没有曲目库，帖子正文就是权威 —— 它自带「上周：N」
 * 和「在榜周数：M」，正好是主榜里由服务端算出来的那两个字段。
 *
 * 曲目身份用**曲名**：这是 Billboard 的歌曲榜，同一首歌换一个投稿稿件不该拆成两条。
 * 稿件 BV 跟着每一次上榜记录走（entries[].bvid），点开抽屉看到的是最近一次的那个。
 */

const DAY = 86400000;

function daysBetween(a, b) {
  const ta = Date.parse(a + 'T00:00:00Z');
  const tb = Date.parse(b + 'T00:00:00Z');
  return Number.isFinite(ta) && Number.isFinite(tb) ? Math.round((tb - ta) / DAY) : 0;
}

/**
 * 补齐缺失的期号。
 *
 * 新帖正文只写「上期（第 N 期）」，老帖写「本期为…第 N 期」—— 通常都拿得到。
 * 万一某帖两种都没写，就按「相邻期号 ± 相隔周数」推：这条榜是严格周更的，
 * 相隔 7 天差 1 期。先正向推一遍再反向推一遍，连续几期都缺也能补齐。
 * 两头都没锚点的（例如只有一期）才留 null —— 宁可显示「第 — 期」，也不要瞎编。
 */
function fillIssues(list) {
  for (let i = 1; i < list.length; i++) {
    const prev = list[i - 1];
    if (list[i].issue == null && prev.issue != null) {
      const weeks = Math.round(daysBetween(prev.date, list[i].date) / 7);
      if (weeks >= 1) list[i].issue = prev.issue + weeks;
    }
  }
  for (let i = list.length - 2; i >= 0; i--) {
    const next = list[i + 1];
    if (list[i].issue == null && next.issue != null) {
      const weeks = Math.round(daysBetween(list[i].date, next.date) / 7);
      if (weeks >= 1) list[i].issue = next.issue - weeks;
    }
  }
  return list;
}

export function buildNico(records, cfg) {
  const raw = (records || []).filter((r) => r && r.date && Array.isArray(r.entries) && r.entries.length);

  // 同一天发了两条（重发 / 补发）时留条目更全的那条
  const byDate = new Map();
  for (const r of raw) {
    const old = byDate.get(r.date);
    if (!old || r.entries.length > old.entries.length || (r.entries.length === old.entries.length && r.complete && !old.complete)) {
      byDate.set(r.date, r);
    }
  }

  const list = fillIssues(
    [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  );

  const issues = list.map((r) => {
    const entries = r.entries
      .slice()
      .sort((a, b) => a.rank - b.rank)
      .map((e) => ({
        rank: e.rank,
        // 曲目身份 = 曲名；换稿件不拆条，稿件 BV 跟着每次上榜记录走
        songId: String(e.title || '').trim(),
        title: String(e.title || '').trim(),
        producer: String(e.producer || '').trim(),
        bvid: e.bvid || '',
        lastRank: Number.isInteger(e.lastRank) ? e.lastRank : null,
        weeks: Number.isInteger(e.weeks) ? e.weeks : null
      }))
      .filter((e) => e.rank > 0 && e.songId);
    return {
      issue: r.issue ?? null,
      date: r.date,
      period: r.period || null,
      postUrl: r.cv ? WEB.readPage(r.cv) : 'https://www.bilibili.com/opus/' + r.id,
      source: r.source || '',
      count: entries.length,
      complete: r.complete !== false,
      missing: r.missing || [],
      entries
    };
  }).filter((it) => it.entries.length);

  const meta = {
    title: cfg?.nico?.title || 'ニコニコ VOCALOID SONGS TOP20',
    account: cfg?.nico
      ? { mid: cfg.nico.mid, name: cfg.nico.name, spaceUrl: cfg.nico.spaceUrl }
      : null,
    issues: issues.length,
    entries: issues.reduce((n, it) => n + it.entries.length, 0),
    first: issues[0]?.issue ?? null,
    last: issues.at(-1)?.issue ?? null,
    firstDate: issues[0]?.date ?? null,
    lastDate: issues.at(-1)?.date ?? null,
    // 缺名的期在页面上照实显示，这里只统计
    incomplete: issues.filter((it) => !it.complete).map((it) => ({ issue: it.issue, date: it.date, count: it.count, missing: it.missing }))
  };

  return { issues, meta };
}
