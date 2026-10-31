import path from 'node:path';
import { writeJson, readJson } from '../util/fsx.js';
import { resolveCovers } from './covers.js';
import { DataIntegrityError, inspectSync } from './validate.js';

/**
 * 上游榜单编号。三条是**彼此独立的期号序列**，不能混用：
 *   1 = 周榜（主榜，本项目的主线数据）
 *   2 = 传说曲周榜（附榜）
 *   3 = 年榜（附榜，名次到 100）
 */
export const BOARDS = { weekly: 1, legend: 2, annual: 3 };

/**
 * 允许"没有期次表"的榜单。
 *
 * 年榜目前只在曲目库里有行（board 3 的 rank_history），独立的
 * /api/public/boards/3/issues 可能并不存在。把它按"必选项"对待的话，
 * 一次 404 会让整轮 sync 失败、连周榜都写不进去 —— 代价和收益完全不对等。
 * 所以这里降级为：取不到就沿用本地的 issues-3.json，再取不到就交给
 * src/model/build.js 用曲目行的 year/week 拼一个最简期次表。
 */
export const OPTIONAL_BOARDS = new Set(['annual']);

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
 * 取可选榜单的期次表：拿不到就退回本地文件，拿到的空数组也当"拿不到"看。
 *
 * 重试次数压到 1：可选接口 404 时默认的 4 次重试要白等 15 秒，
 * 而这里失败是完全可接受的降级路径，不值得为一个"锦上添花"的榜单拖慢整轮同步。
 */
async function optionalIssues(client, boardId, prev, log) {
  try {
    const list = await client.issues(boardId, { retries: 1 });
    if (Array.isArray(list) && list.length) return { list, fetched: true };
    log?.warn('board ' + boardId + ' 的期次表为空，沿用本地 issues-' + boardId + '.json（' + prev.length + ' 期）');
  } catch (err) {
    log?.warn('board ' + boardId + ' 的期次表取不到（' + err.message + '），沿用本地 issues-' + boardId + '.json（' + prev.length + ' 期）');
  }
  // fetched: false —— 没抓到就不要把它写回磁盘：那会平白改一次 mtime（页面以为数据更新了），
  // 还会在"本来就没有这个文件"时凭空造一个 []。
  return { list: prev, fetched: false };
}

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
  const prevByBoard = {};
  const fetchable = new Set();
  for (const [key, id] of Object.entries(BOARDS)) {
    const prev = readJson(path.join(dir, 'issues-' + id + '.json'), []) || [];
    prevByBoard[key] = prev;
    if (OPTIONAL_BOARDS.has(key)) {
      const got = await optionalIssues(client, id, prev, log);
      issuesByBoard[key] = got.list;
      if (got.fetched) fetchable.add(key);
    } else {
      issuesByBoard[key] = await client.issues(id);
      fetchable.add(key);
    }
    log?.info('期次 board ' + id + '：' + (Array.isArray(issuesByBoard[key]) ? issuesByBoard[key].length : '非数组') + ' 期'
      + (fetchable.has(key) ? '' : '（沿用本地文件）'));
  }
  const prevIssues = prevByBoard.weekly || [];
  const prevLegend = prevByBoard.legend || [];
  const prevAnnual = prevByBoard.annual || [];

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
    extraIssues: [
      { list: issuesByBoard.legend || [], prev: prevLegend, label: '传说曲周榜期次' },
      // 年榜的期次表是可选的：为空不是故障，曲目库里的 board 3 行照样能出图
      { list: issuesByBoard.annual || [], prev: prevAnnual, label: '年榜期次', optional: true }
    ]
  });
  for (const w of report.warnings) log?.warn('数据一致性：' + w);

  /* 增量同步只翻前 40 页曲目库，命中"连续 3 页没有新曲目"就收工 —— 这能发现新上榜的歌，
     但**发现不了老歌新添的一期名次**（它们的记录在曲目库更靠后的位置）。
     于是会出现"新一期只进了 9 首、其余 11 首还停在上一期"的状态，而 checkLatest 的
     stale 判定看不出来（曲目库确实已经有这一期了）。这里把它点破，并给出唯一有效的做法。 */
  const shortIssues = report.coverage?.incomplete || [];
  if (shortIssues.length) {
    const last = shortIssues[shortIssues.length - 1];
    log?.warn('曲目库没跟上：' + shortIssues.length + ' 期名次不满（最近的是第 ' + last.issue + ' 期 '
      + last.have + '/' + last.expected + ' 首）。增量同步只扫前 40 页，老歌新添的名次可能捡不到 —— '
      + '跑一次 node src/cli.js sync --full 补齐。');
  }

  if (report.errors.length) {
    throw new DataIntegrityError(
      '同步结果未通过完整性校验，已放弃写入（磁盘上的旧数据保持不变）：\n  - ' + report.errors.join('\n  - '),
      report.errors
    );
  }

  // ---- 4. 落盘 ----
  for (const [key, id] of Object.entries(BOARDS)) {
    if (!fetchable.has(key)) continue;
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
