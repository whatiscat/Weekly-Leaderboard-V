import path from 'node:path';
import { writeJson, readJson } from '../util/fsx.js';
import { resolveCovers } from './covers.js';
import { DataIntegrityError, inspectSync } from './validate.js';

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

/** 一轮同步的总预算：兜住"每页都慢一点"把定时任务拖到十几分钟的情况 */
const SYNC_BUDGET_MS = 5 * 60 * 1000;

/**
 * 同步 biliboard 公开数据（曲目库 + 期次），作为「曲目身份」的权威来源。
 *
 * 每首歌的 rank_history 记录了它每一期的名次与该期使用的稿件 BV 号，
 * 因此同名不同译名、同曲不同链接都能对齐到同一个 song.id。
 *
 * 写入顺序是刻意的：**先把两次请求都拉完、校验通过，再落盘**。
 * 以前是"拉到一份写一份"，于是曲目库请求失败时，期次文件已经被新数据覆盖，
 * 磁盘上留下一半新一半旧的组合（而且没有任何提示）。
 */
export async function syncBoards(client, cfg, log, { full = false } = {}) {
  const dir = boardDir(cfg);
  const metaPath = path.join(dir, 'meta.json');
  const prev = readJson(metaPath, {}) || {};
  const startedAt = new Date().toISOString();
  client.deadline = Date.now() + SYNC_BUDGET_MS;

  // ---- 1. 拉期次（先放内存，不写盘） ----
  const issuesByBoard = {};
  for (const [key, id] of Object.entries(BOARDS)) {
    issuesByBoard[key] = await client.issues(id);
    log?.info('期次 board ' + id + '：' + (Array.isArray(issuesByBoard[key]) ? issuesByBoard[key].length : '非数组') + ' 期');
  }
  const prevIssues = readJson(path.join(dir, 'issues-1.json'), []) || [];
  const prevLegend = readJson(path.join(dir, 'issues-2.json'), []) || [];

  // ---- 2. 拉曲目库（合并到已有基线） ----
  const songsFile = path.join(dir, 'songs.json');
  const existing = readJson(songsFile, []) || [];
  const prevCount = existing.length;

  if (!full && !prevCount) {
    throw new DataIntegrityError(
      '缺少曲目库基线（data/boards/songs.json 不存在或为空）。' +
      '增量同步只会扫最近几页，从零开始会得到一份残缺的曲目库，因此拒绝执行；请先运行 sync --full。'
    );
  }

  const byId = new Map((full ? [] : existing).map((s) => [s.id, s]));
  const before = byId.size;
  let page = 1;
  let pages = 0;      // 实际翻过的页数（page 在 break 时的值就是它，但循环自然结束时 page 会多 1）
  let scanned = 0;
  let emptyStreak = 0;
  const maxPages = full ? 400 : 40;

  for (; page <= maxPages; page++) {
    pages++;
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
    // 增量：连续 3 页没有新上榜曲目即认为已到近期边界。
    // ⚠️ 这依赖上游"新歌在前"的排序；排序一改就会静默漏数据，
    //    所以下面还有 checkLatest() 用"曲目库最高期号 vs 榜单最新期号"兜一层。
    if (!full && page >= 5 && emptyStreak >= 3) break;
    if (res.total && page * 100 >= res.total) break;
  }

  const songs = [...byId.values()].sort((a, b) => a.id - b.id);

  // ---- 3. 闸门：结构、条数、一致性 ----
  const report = inspectSync({
    issues: issuesByBoard.weekly || [],
    songs,
    prevIssues,
    prevSongsCount: prevCount,
    extraIssues: [{ list: issuesByBoard.legend || [], prev: prevLegend, label: '传说曲周榜期次' }]
  });
  for (const w of report.warnings) log?.warn('数据一致性：' + w);
  if (report.errors.length) {
    throw new DataIntegrityError(
      '同步结果未通过完整性校验，已放弃写入（磁盘上的旧数据保持不变）：\n  - ' + report.errors.join('\n  - '),
      report.errors
    );
  }

  // ---- 4. 落盘 ----
  for (const [key, id] of Object.entries(BOARDS)) {
    writeJson(path.join(dir, 'issues-' + id + '.json'), issuesByBoard[key]);
  }
  writeJson(songsFile, songs);

  // 封面直链（页面加载更快，避免每张图都经过 302）。失败不影响榜单数据。
  const bvids = [];
  for (const s of songs) {
    if (s.bvid) bvids.push(s.bvid);
    for (const h of s.history) if (h.bvid) bvids.push(h.bvid);
  }
  let covers = null;
  try {
    covers = await resolveCovers(bvids, cfg, log);
  } catch (err) {
    log?.warn('封面解析失败（不影响页面，回退到代理地址）：' + err.message);
  }

  const coverage = report.coverage;
  const quality = {
    completeIssues: coverage.completeIssues,
    totalIssues: coverage.totalIssues,
    incomplete: coverage.incomplete.slice(0, 20),
    orphanRows: coverage.orphanRows,
    duplicateRanks: coverage.duplicateRanks.slice(0, 20).length,
    latestIssue: report.latest.latestIssue,
    latestInSongs: report.latest.latestInSongs,
    stale: report.latest.stale,
    warnings: report.warnings
  };
  writeJson(metaPath, {
    ...prev,
    lastSyncAt: startedAt,
    pagesScanned: pages,
    scannedSongs: scanned,
    full,
    songs: songs.length,
    added: byId.size - before,
    covers: covers ? Object.keys(covers).length : null,
    boards: Object.fromEntries(Object.entries(issuesByBoard).map(([k, v]) => [k, Array.isArray(v) ? v.length : 0])),
    quality
  });

  if (report.warnings.length) {
    log?.warn('数据一致性有 ' + report.warnings.length + ' 条警告（已写入 data/boards/meta.json）');
  }
  log?.info(
    '曲目库同步完成：扫描 ' + scanned + ' 首，收录 ' + songs.length + ' 首（新增 ' + (byId.size - before) + '）' +
    ' · 满员期次 ' + coverage.completeIssues + '/' + coverage.totalIssues
  );
  return { songs, issues: issuesByBoard, scanned, pages, quality };
}
