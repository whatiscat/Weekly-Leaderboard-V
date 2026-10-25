import path from 'node:path';
import { writeJson, readJson } from '../util/fsx.js';
import { resolveCovers } from './covers.js';

export const BOARDS = { weekly: 1, legend: 2 };

function slimProducer(p) {
  return { id: p.id, name: p.name };
}

function slimHistory(h) {
  return {
    boardId: h.board_id,
    issueId: h.issue_id,
    year: h.issue_year,
    week: h.issue_week,
    rank: h.rank,
    bvid: h.bvid || '',
    title: h.title || '',
    titleCn: h.title_cn || '',
    producers: (h.producers || []).map(slimProducer),
    vocalists: (h.vocalists || []).map(slimProducer),
    pubtime: h.pubtime || 0,
    stats: h.stats || null,
    score: h.score_ratio_text || h.score || null,
    lastRank: h.last_rank ?? null,
    weeksOnBoard: h.weeks_on_board ?? null,
    peakRank: h.peak_rank ?? null,
    rankChange: h.rank_change || null,
    specialStatus: h.special_status ?? null
  };
}

function slimSong(s) {
  return {
    id: s.id,
    bvid: s.bvid || '',
    title: s.title || '',
    titleCn: s.title_cn || '',
    pubtime: s.pubtime || 0,
    firstRecordedAt: s.first_recorded_at || 0,
    producers: (s.producers || []).map(slimProducer),
    vocalists: (s.vocalists || []).map(slimProducer),
    history: (s.rank_history || []).map(slimHistory)
  };
}

export function boardDir(cfg) {
  return path.join(cfg.paths.data, 'boards');
}

/**
 * 同步 biliboard 公开数据（曲目库 + 期次），作为「曲目身份」的权威来源。
 * 每首歌的 rank_history 记录了它每一期的名次与该期使用的稿件 BV 号，
 * 因此同名不同译名、同曲不同链接都能对齐到同一个 song.id。
 */
export async function syncBoards(client, cfg, log, { full = false } = {}) {
  const dir = boardDir(cfg);
  const metaPath = path.join(dir, 'meta.json');
  const prev = readJson(metaPath, {}) || {};
  const startedAt = new Date().toISOString();

  const issuesByBoard = {};
  for (const [key, id] of Object.entries(BOARDS)) {
    const list = await client.issues(id);
    issuesByBoard[key] = list;
    writeJson(path.join(dir, 'issues-' + id + '.json'), list);
    log?.info('期次 board ' + id + '：' + list.length + ' 期');
  }

  const songsFile = path.join(dir, 'songs.json');
  const existing = full ? [] : readJson(songsFile, []) || [];
  const byId = new Map(existing.map((s) => [s.id, s]));
  const before = byId.size;

  let page = 1;
  let scanned = 0;
  let emptyStreak = 0;
  const maxPages = full ? 400 : 40;
  for (; page <= maxPages; page++) {
    const res = await client.songs(page, 100);
    const list = res?.data || [];
    if (!list.length) break;
    scanned += list.length;
    let added = 0;
    for (const s of list) {
      const slim = slimSong(s);
      if (!slim.history.length) continue;
      if (!byId.has(slim.id)) added++;
      byId.set(slim.id, slim);
    }
    emptyStreak = added === 0 ? emptyStreak + 1 : 0;
    if (page % 10 === 0) log?.info('曲目库 ' + page + ' 页 / 已扫 ' + scanned + ' 首 / 收录 ' + byId.size);
    // 增量：连续若干页没有新上榜曲目即认为已到近期边界
    if (!full && page >= 5 && emptyStreak >= 3) break;
    if (res.total && page * 100 >= res.total) break;
  }

  const songs = [...byId.values()].sort((a, b) => a.id - b.id);
  // 封面直链（页面加载更快，避免每张图都经过 302）
  const bvids = [];
  for (const s of songs) {
    if (s.bvid) bvids.push(s.bvid);
    for (const h of s.history) if (h.bvid) bvids.push(h.bvid);
  }
  try {
    await resolveCovers(bvids, cfg, log);
  } catch (err) {
    log?.warn('封面解析失败（不影响页面，回退到代理地址）：' + err.message);
  }
  writeJson(songsFile, songs);
  writeJson(metaPath, {
    ...prev,
    lastSyncAt: startedAt,
    pagesScanned: page,
    scannedSongs: scanned,
    songs: songs.length,
    added: byId.size - before,
    boards: Object.fromEntries(Object.entries(issuesByBoard).map(([k, v]) => [k, v.length]))
  });

  log?.info('曲目库同步完成：扫描 ' + scanned + ' 首，收录 ' + songs.length + ' 首（新增 ' + (byId.size - before) + '）');
  return { songs, issues: issuesByBoard, scanned, pages: page };
}
