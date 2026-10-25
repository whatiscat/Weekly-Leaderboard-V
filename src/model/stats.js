function idOf(entry) {
  return entry.songId ?? entry.bvid ?? entry.k ?? entry.title;
}

/** 连续夺冠合并为一段（按 songId，不按歌名） */
export function championRuns(issues) {
  const runs = [];
  issues.forEach((it, index) => {
    const top = it.entries.find((e) => e.rank === 1) || it.entries[0];
    if (!top) return;
    const last = runs[runs.length - 1];
    if (last && last.id === idOf(top)) {
      last.end = index;
      last.count += 1;
      last.issueTo = it.issue;
    } else {
      runs.push({
        id: idOf(top),
        title: top.titleCn || top.title,
        titleAlt: top.title,
        start: index,
        end: index,
        count: 1,
        issueFrom: it.issue,
        issueTo: it.issue,
        date: it.date,
        bvid: top.bvid,
        cover: top.cover || ''
      });
    }
  });
  return runs;
}

/** 曲目索引：每首歌在窗口内的走势、稿件变体、制作/演唱 */
export function songIndex(issues) {
  const map = new Map();
  issues.forEach((it, i) => {
    for (const e of it.entries) {
      const id = idOf(e);
      let s = map.get(id);
      if (!s) {
        s = {
          id,
          title: e.titleCn || e.title,
          titleAlt: e.title,
          producers: e.producers || [],
          vocalists: e.vocalists || [],
          appearances: [],
          bvids: new Set(),
          best: e.rank
        };
        map.set(id, s);
      }
      s.title = e.titleCn || e.title || s.title;
      s.titleAlt = e.title || s.titleAlt;
      if (e.producers?.length) s.producers = e.producers;
      if (e.vocalists?.length) s.vocalists = e.vocalists;
      if (e.bvid) s.bvids.add(e.bvid);
      s.appearances.push({ index: i, issue: it.issue, date: it.date, rank: e.rank, weeks: e.weeksOnBoard, peak: e.peakRank });
      if (e.rank < s.best) s.best = e.rank;
    }
  });
  return [...map.values()]
    .map((s) => ({ ...s, weeks: s.appearances.length, variants: [...s.bvids] }))
    .sort((a, b) => b.weeks - a.weeks || a.best - b.best);
}

export function summarize(issues) {
  const entries = issues.reduce((n, it) => n + it.entries.length, 0);
  const songs = songIndex(issues);
  const champions = championRuns(issues);
  const longest = songs[0] || null;
  const mostTitles = champions.slice().sort((a, b) => b.count - a.count)[0] || null;
  const multi = songs.filter((s) => s.variants.length > 1);
  return {
    issues: issues.length,
    entries,
    songs: songs.length,
    firstIssue: issues[0]?.issue ?? null,
    lastIssue: issues.at(-1)?.issue ?? null,
    firstDate: issues[0]?.date ?? null,
    lastDate: issues.at(-1)?.date ?? null,
    championRuns: champions.length,
    multiVideoSongs: multi.length,
    longest: longest ? { title: longest.title, weeks: longest.weeks, best: longest.best } : null,
    mostTitles: mostTitles ? { title: mostTitles.title, count: mostTitles.count } : null
  };
}
