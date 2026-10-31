/**
 * 同步结果的完整性闸门
 *
 * 为什么需要这一层：sync 是**覆盖写**——拉到的列表直接写进 data/boards/*.json。
 * 上游 API 只要抖一下（返回空数组、分页提前结束、只给了一半），旧数据就被
 * 一份残缺数据无声地替换掉：看板少几期、曲目库少几百首，而进程退出码是 0。
 * 这类损坏最坏的地方在于"看起来正常"——页面上仍有数据，只是少了。
 *
 * 所以这里定的规矩是相反的：**宁可同步失败、保留旧数据，也不写一份更差的数据**。
 * 每条规则都对应一个真实故障面，改之前先看注释里的"防的是什么"。
 *
 * 这些函数都是纯函数（输入 → 结论），方便单测，也方便 doctor 复用。
 */

export class DataIntegrityError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = 'DataIntegrityError';
    this.details = details;
  }
}

function isInt(v) {
  return Number.isInteger(v);
}

/**
 * 期次列表：不能为空、不能有重复期号、不能比已有的少。
 *
 * optional=true 的榜单（目前是年榜）允许为空：那条接口可能根本不存在，
 * 或者上游还没发布第一期。此时"空"不是故障，而是事实 —— 曲目库里
 * board 3 的行照样能拼出期次表（见 src/model/build.js 的 buildBoard）。
 */
export function checkIssues(list, prev = [], label = '期次', { optional = false } = {}) {
  const errors = [];
  if (!Array.isArray(list)) {
    return ['上游返回的' + label + '不是数组（实际 ' + typeof list + '）'];
  }
  if (!list.length && !optional) errors.push(label + '为空：上游可能正在维护或接口行为变了');

  const seen = new Set();
  let badRows = 0;
  for (const it of list) {
    if (!it || !isInt(it.issue_id) || it.issue_id <= 0) { badRows++; continue; }
    if (seen.has(it.issue_id)) errors.push(label + '出现重复期号：' + it.issue_id);
    seen.add(it.issue_id);
  }
  if (badRows) errors.push(label + '里有 ' + badRows + ' 条缺少合法的 issue_id');

  const prevLen = Array.isArray(prev) ? prev.length : 0;
  if (prevLen && list.length < prevLen) {
    errors.push(
      label + '从 ' + prevLen + ' 条降到 ' + list.length + ' 条：拒绝用更少的数据覆盖已有文件。' +
      '若上游确实删了数据，请手动确认后再同步'
    );
  }
  return errors;
}

/**
 * 曲目库：结构完整、id 唯一、条数不缩水
 *
 * 名次上限按榜单区分：上游库里除了周榜(1)、传说曲周榜(2)，还有年榜(3)。
 * 年榜名次能到 100，一刀切成 1–20 会把整份曲目库判成"脏数据"（实测踩过：
 * 200 条年榜行直接把同步拦死）。三张榜现在都会展示，上限照样不能共用一套。
 */
const BOARD_RANK_LIMIT = { 1: 20, 2: 20, 3: 100 };
const BOARD_NAME = { 1: '周榜', 2: '传说曲周榜', 3: '年榜' };

function rankHint() {
  return Object.entries(BOARD_RANK_LIMIT)
    .map(([id, limit]) => (BOARD_NAME[id] || 'board ' + id) + ' 1–' + limit)
    .join(' / ');
}

export function checkSongs(songs, { prevCount = 0 } = {}) {
  const errors = [];
  if (!Array.isArray(songs)) return ['曲目库不是数组（实际 ' + typeof songs + '）'];
  if (!songs.length) errors.push('曲目库为空');

  const seen = new Set();
  let noHistory = 0;
  let badRows = 0;
  let badRanks = 0;
  for (const s of songs) {
    if (!s || !isInt(s.id) || s.id <= 0) { badRows++; continue; }
    if (seen.has(s.id)) errors.push('曲目 id 重复：' + s.id);
    seen.add(s.id);
    if (!Array.isArray(s.history) || !s.history.length) { noHistory++; continue; }
    for (const h of s.history) {
      if (!h || !isInt(h.issueId) || h.issueId <= 0 || !isInt(h.boardId)) { badRows++; continue; }
      const limit = BOARD_RANK_LIMIT[h.boardId];
      if (!isInt(h.rank) || h.rank < 1 || (limit && h.rank > limit)) badRanks++;
    }
  }
  if (badRows) errors.push('曲目库里 ' + badRows + ' 条记录缺少合法的 id / issueId');
  if (noHistory) errors.push('曲目库里 ' + noHistory + ' 首没有任何上榜记录（不该出现在曲目库）');
  if (badRanks) errors.push('曲目库里有 ' + badRanks + ' 条名次越界（' + rankHint() + '）');

  // 合并逻辑只会往 byId 里加，条数**不可能**变少；变少说明基线文件被破坏或全量抓取提前中断
  if (prevCount && songs.length < prevCount) {
    errors.push('曲目数从 ' + prevCount + ' 首降到 ' + songs.length + ' 首：拒绝写回，先跑 sync --full');
  }
  return errors;
}

/**
 * 曲目库与期次表的一致性（只报警告，不拦写）：
 * 这类偏差通常是上游补数据 / 删数据造成的，硬拦会让日常同步直接不可用。
 */
export function describeCoverage(songs, issues, { boardId = 1 } = {}) {
  const issueIds = new Set(issues.map((i) => i.issue_id));
  // 每期收「名次集合」而不是行数：同一期同一个名次出现两次时，
  // 行数会把「满员」算出来，但页面上并不会多出一行 —— 只有去重后的名次才算数。
  const perIssue = new Map();
  let rows = 0;
  let orphanRows = 0;
  const rankSeen = new Map();

  for (const s of songs) {
    for (const h of s.history || []) {
      if (h.boardId !== boardId) continue;
      rows++;
      if (!issueIds.has(h.issueId)) { orphanRows++; continue; }
      if (!perIssue.has(h.issueId)) perIssue.set(h.issueId, new Set());
      perIssue.get(h.issueId).add(h.rank);
      const key = h.issueId + ':' + h.rank;
      rankSeen.set(key, (rankSeen.get(key) || 0) + 1);
    }
  }

  const duplicateRanks = [...rankSeen.entries()]
    .filter(([, n]) => n > 1)
    .map(([key]) => key);

  const incomplete = [];
  for (const it of issues) {
    const count = perIssue.has(it.issue_id) ? perIssue.get(it.issue_id).size : 0;
    const expected = isInt(it.video_count) && it.video_count > 0 ? it.video_count : 20;
    if (count < expected) incomplete.push({ issue: it.issue_id, have: count, expected });
  }

  return {
    rows,
    orphanRows,
    duplicateRanks,
    incomplete,
    completeIssues: issues.length - incomplete.length,
    totalIssues: issues.length
  };
}

/**
 * 曲目库是不是最新的（防"增量翻页提前结束、新歌没进来"）。
 *
 * 增量同步靠"连续 3 页没有新歌就停"来判断边界，这依赖上游"新歌在前"的排序。
 * 排序一旦改动，同步会安静地扫完几页旧歌就收工 —— 本次新增 0 首，退出码 0。
 * 用"曲目库里的最高期号"对一下"榜单最新期号"，就能把这种情况抓出来。
 */
export function checkLatest(songs, issues, { lag = 1 } = {}) {
  const latestIssue = issues.reduce((m, i) => Math.max(m, i.issue_id), 0);
  let latestInSongs = 0;
  for (const s of songs) {
    for (const h of s.history || []) {
      if (h.boardId !== 1) continue;
      if (h.issueId > latestInSongs) latestInSongs = h.issueId;
    }
  }
  return {
    latestIssue,
    latestInSongs,
    stale: latestIssue > 0 && latestInSongs < latestIssue - lag
  };
}

/**
 * 一次性汇总：先跑结构校验，再收集一致性警告。
 * errors 非空时调用方必须**放弃写入**；warnings 只记录，不影响同步成功。
 */
export function inspectSync({ issues, songs, prevIssues = [], prevSongsCount = 0, extraIssues = [] }) {
  const errors = [
    ...checkIssues(issues, prevIssues, '周榜期次'),
    // 附榜（传说曲周榜 / 年榜）是另外两张表，缩水同样要拦 —— 它们比周榜短，但一样是覆盖写。
    // optional 的那张允许为空（接口不存在时由曲目库兜底，不是故障）。
    ...extraIssues.flatMap((x) => checkIssues(x.list, x.prev, x.label, { optional: Boolean(x.optional) })),
    ...checkSongs(songs, { prevCount: prevSongsCount })
  ];
  const coverage = describeCoverage(songs, issues);
  const latest = checkLatest(songs, issues);

  const warnings = [];
  if (coverage.orphanRows) {
    warnings.push(coverage.orphanRows + ' 条上榜记录的期号不在期次表里（上游可能删过期）');
  }
  if (coverage.duplicateRanks.length) {
    warnings.push(coverage.duplicateRanks.length + ' 个「期号+名次」重复（如 ' + coverage.duplicateRanks.slice(0, 3).join('、') + '）');
  }
  if (latest.stale) {
    warnings.push(
      '曲目库最高只到第 ' + latest.latestInSongs + ' 期，榜单已到第 ' + latest.latestIssue +
      ' 期：增量同步可能没翻到新数据，建议 node src/cli.js sync --full'
    );
  }
  return { errors, warnings, coverage, latest };
}
