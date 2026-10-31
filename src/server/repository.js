import fs from 'node:fs';
import path from 'node:path';
import { buildDataset } from '../model/build.js';
import { buildNico } from '../model/nico.js';
import { RawStore } from '../crawler/store.js';
import { readJson } from '../util/fsx.js';

/** 三张榜各自的期次文件。缺文件一律当空表处理，不当错误 —— 附榜可以没有。 */
const BOARD_FILES = { weekly: 'issues-1.json', legend: 'issues-2.json', annual: 'issues-3.json' };
export const BOARD_NAMES = Object.keys(BOARD_FILES);

function loadBoards(cfg) {
  const dir = path.join(cfg.paths.data, 'boards');
  const issues = {};
  for (const [key, file] of Object.entries(BOARD_FILES)) {
    issues[key] = readJson(path.join(dir, file), []) || [];
  }
  return {
    issues,
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
 * 曲名的归一化形式，只用来**跨榜匹配**（Biliboard 的 song.id 与 ニコニコ 的曲名是两套 id 空间）。
 *
 * 只丢掉确定不影响身份的差异：大小写、空白、各种引号/括号/波浪线/句读。
 * 不去汉字、不去假名 —— 那是把不同的歌匹配到一起去的最快方式。
 */
function normTitle(t) {
  return String(t || '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[~〜～!！?？.,、。·・:：;；'"`"'""()（）\[\]【】<>《》「」『』-]/g, '');
}

/**
 * 一张榜的索引：期号 → 位置、曲目 → 在这张榜上的每次上榜。
 *
 * 三张榜各有一份，**绝不共用**：传说曲榜第 84 期和周榜第 84 期不是同一周，
 * 拿周榜的 history 去算附榜的「在榜期数」会得到一串看着合理、实则全错的数字。
 */
function indexBoard(list) {
  const byIssue = new Map();
  const history = new Map();
  list.forEach((it, i) => {
    byIssue.set(it.issue, { issue: it, index: i });
    for (const e of it.entries) {
      const id = idOf(e);
      if (!history.has(id)) history.set(id, []);
      history.get(id).push({ i, rank: e.rank, bvid: e.bvid, issue: it.issue, date: it.date });
    }
  });
  return { list, byIssue, history };
}

/**
 * 附榜索引。和 indexBoard 同一套结构，但曲目身份是**曲名**（见 src/model/nico.js），
 * 并且额外把「上周名次 / 在榜周数」一起存进 history —— 这两个值是帖子正文里
 * 官方给的，比我们自己数出来的更可信，展示时优先用它们。
 */
function indexNico(ds) {
  const list = ds?.issues || [];
  const byIssue = new Map();
  const history = new Map();
  list.forEach((it, i) => {
    if (it.issue != null) byIssue.set(it.issue, { issue: it, index: i });
    for (const e of it.entries) {
      if (!history.has(e.songId)) history.set(e.songId, []);
      history.get(e.songId).push({
        i,
        rank: e.rank,
        bvid: e.bvid,
        issue: it.issue,
        date: it.date,
        weeks: e.weeks,
        producer: e.producer,
        lastRank: e.lastRank
      });
    }
  });
  return { list, byIssue, history, meta: ds?.meta || null };
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
    const files = Object.values(BOARD_FILES).map((f) => path.join(dir, f));
    files.push(path.join(this.cfg.paths.data, 'covers.json'));
    let v = 0;
    for (const f of files) {
      try { v = Math.max(v, fs.statSync(f).mtimeMs); } catch { /* 缺文件忽略 */ }
    }
    // 附榜：一期一个文件，取目录里最新的那个 mtime
    if (this.cfg.nico?.enabled) {
      try {
        for (const name of fs.readdirSync(this.cfg.paths.nico)) {
          if (!name.endsWith('.json')) continue;
          try { v = Math.max(v, fs.statSync(path.join(this.cfg.paths.nico, name)).mtimeMs); } catch { /* 并发删除 */ }
        }
      } catch { /* 目录还没建：附榜还没抓过 */ }
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
    // 附榜是另一条榜（另一个 UP 主、另一套期号）：抓不到就是空，不影响主榜出图
    ds.nico = this.cfg.nico?.enabled ? buildNico(new RawStore(this.cfg.paths.nico).all(), this.cfg) : null;
    this.dataset = ds;
    this.builtAt = Date.now();
    this.log?.info('数据集已载入：' + ds.issues.length + ' 期 / ' + ds.stats.entries + ' 条'
      + (ds.nico?.issues.length ? ' · 附榜 ' + ds.nico.issues.length + ' 期' : '') + '，用时 ' + (this.builtAt - started) + 'ms');
    this.#index();
    return ds;
  }

  #index() {
    const ds = this.dataset;
    this.boards = {
      weekly: indexBoard(ds.issues),
      legend: indexBoard(ds.legend || []),
      annual: indexBoard(ds.annual || [])
    };
    // 兼容既有调用点：主榜的两个索引就是 dataset 层面的索引
    this.history = this.boards.weekly.history;
    this.byIssue = this.boards.weekly.byIssue;
    this.nico = indexNico(this.dataset.nico);

    // 曲目基础信息（标题 / P 主 / 歌手）：周榜最权威，附榜只补周榜没有的曲子。
    // 迭代顺序是反的 —— 后写入的覆盖前面的，所以 weekly 放最后。
    this.songInfo = new Map();
    for (const name of ['annual', 'legend', 'weekly']) {
      for (const it of this.boards[name].list) {
        for (const e of it.entries) {
          this.songInfo.set(idOf(e), {
            title: e.titleCn || e.title || '',
            titleAlt: e.title && e.title !== (e.titleCn || e.title) ? e.title : '',
            producers: e.producers || [],
            vocalists: e.vocalists || []
          });
        }
      }
    }

    // ニコニコ 那条榜的曲目身份是曲名：建一张"归一化曲名 → 曲名"的表，
    // 用来把 Biliboard 的曲子对到 ニコニコ 上（同一首歌、两个 id 空间）。
    this.nicoByTitle = new Map();
    for (const key of this.nico.history.keys()) {
      const k = normTitle(key);
      if (k && !this.nicoByTitle.has(k)) this.nicoByTitle.set(k, key);
    }
    // 反向：ニコニコ 每条曲名归一化后对应哪首 B 榜曲子（用来在搜索里去掉重复项）
    this.nicoToB = new Map();
    for (const [id, info] of this.songInfo) {
      const k = normTitle(info.titleAlt || info.title);
      if (k && !this.nicoToB.has(k)) this.nicoToB.set(k, id);
    }
  }

  /** 取一张榜的索引；名字不认识时返回 null（由路由转成 404） */
  #board(name) {
    this.ensure();
    return this.boards[name] || null;
  }

  meta() {
    const ds = this.ensure();
    return {
      account: ds.meta.account,
      charts: ds.meta.charts,
      boards: ds.meta.boards,
      nico: ds.nico ? ds.nico.meta : null,
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

  /**
   * 给一期的每一行补上「相对上一期」的涨跌、在榜期数、历史最高与近 30 期走势。
   *
   * board 参数是必须的：三种榜的「上一期」是三份不同的列表。以前这里写死
   * this.dataset.issues，加附榜时如果忘了传，附榜的涨跌会按周榜算出来 ——
   * 看起来一切正常，只是全是错的。
   */
  #decorate(board, it, index) {
    const prev = index > 0 ? board.list[index - 1] : null;
    const prevMap = new Map((prev?.entries || []).map((e) => [idOf(e), e.rank]));
    return it.entries
      .map((e) => {
        const id = idOf(e);
        const hist = (board.history.get(id) || []).filter((h) => h.i <= index);
        const prevRank = prevMap.has(id) ? prevMap.get(id) : null;
        const isNew = hist.length === 1 && prevRank === null;
        const state = isNew ? 'new' : prevRank === null ? 're' : prevRank - e.rank > 0 ? 'up' : prevRank - e.rank < 0 ? 'down' : 'same';
        const best = hist.reduce((m, h) => Math.min(m, h.rank), e.rank);
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
    const board = this.boards.weekly;
    const hit = board.byIssue.get(Number(n));
    if (!hit) return null;
    const it = hit.issue;
    const rows = this.#decorate(board, it, hit.index);
    const prev = hit.index > 0 ? board.list[hit.index - 1] : null;
    const curIds = new Set(rows.map((r) => r.songId));

    let streak = 1;
    const champ = rows[0];
    for (let i = hit.index - 1; i >= 0; i--) {
      const top = board.list[i].entries.find((e) => e.rank === 1);
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
      board: 'weekly',
      index: hit.index,
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

  /**
   * 附榜（传说曲周榜 / 年榜）的期次目录。
   *
   * 只返回摘要（冠军 + 元信息）：84 期 × 20 行整包下发是几百 KB 的无用载荷，
   * 页面真正需要的只有"有哪些期、每期冠军是谁"；具体某期的 20 行走 boardIssue()。
   * limit > 0 时取**最近** N 期（老接口 /api/legend?limit=8 的语义）。
   */
  boardIndex(name, limit = 0) {
    const board = this.#board(name);
    if (!board) return null;
    const items = board.list.map((it) => {
      const top = it.entries.find((e) => e.rank === 1) || it.entries[0] || null;
      return {
        issue: it.issue,
        date: it.date,
        year: it.year,
        week: it.week,
        count: it.count,
        declared: it.declared ?? null,
        videoBvid: it.videoBvid || '',
        champion: top ? { songId: idOf(top), title: top.titleCn || top.title, bvid: top.bvid } : null
      };
    });
    return {
      board: name,
      total: items.length,
      first: items[0]?.issue ?? null,
      last: items.at(-1)?.issue ?? null,
      entries: items.reduce((n, it) => n + it.count, 0),
      items: limit > 0 ? items.slice(-limit) : items
    };
  }

  /**
   * 一期榜单的派生信息：冠军 / 连冠 / 侧栏 / 看点。
   *
   * 四条榜（周榜、传说曲、年榜、ニコニコ）的这几件事定义完全一样，所以只写一遍：
   * 冠军是第 1 名；连冠往回数同一个 songId；侧栏是"上期冠军这一期第几"和"在榜最久"；
   * 看点里的"跌出榜单"只能靠"上期有、这期没有"算 —— 正文里没有这个信息。
   */
  #issueExtras(board, hit, rows) {
    const prev = hit.index > 0 ? board.list[hit.index - 1] : null;
    const top = rows[0] || null;

    let streak = 0;
    if (top) {
      streak = 1;
      for (let i = hit.index - 1; i >= 0; i--) {
        const prevTop = board.list[i].entries.find((e) => e.rank === 1);
        if (prevTop && prevTop.songId === top.songId) streak++;
        else break;
      }
    }

    const prevTop = prev ? prev.entries.find((e) => e.rank === 1) || prev.entries[0] : null;
    const prevChampion = prevTop
      ? (() => {
          const now = rows.find((r) => r.songId === prevTop.songId);
          return { title: prevTop.title, rank: now ? now.rank : null };
        })()
      : null;

    const news = rows.filter((r) => r.state === 'new');
    const ups = rows.filter((r) => r.state === 'up').sort((a, b) => b.delta - a.delta);
    const downs = rows.filter((r) => r.state === 'down').sort((a, b) => a.delta - b.delta);
    const curIds = new Set(rows.map((r) => r.songId));
    const outs = (prev?.entries || [])
      .filter((e) => !curIds.has(e.songId))
      .map((e) => ({ songId: e.songId, title: e.title, rank: e.rank }))
      .sort((a, b) => a.rank - b.rank);

    const longest = rows.slice().sort((a, b) => b.weeks - a.weeks)[0] || null;

    return {
      champStreak: streak,
      champion: top
        ? {
            rank: top.rank,
            songId: top.songId,
            title: top.title,
            bvid: top.bvid,
            weeks: top.weeks,
            best: top.best,
            prev: top.prev,
            producers: top.producers || [],
            producer: (top.producers || [])[0] || ''
          }
        : null,
      kpi: {
        news: news.length,
        ups: ups.length,
        downs: downs.length,
        streak,
        count: rows.length
      },
      insights: {
        news: news.slice(0, 6).map((r) => ({ rank: r.rank, title: r.title })),
        ups: ups.slice(0, 6).map((r) => ({ title: r.title, delta: r.delta })),
        outs: outs.slice(0, 6)
      },
      sidebar: {
        prevChampion,
        longest: longest ? { songId: longest.songId, title: longest.title, weeks: longest.weeks, best: longest.best } : null
      }
    };
  }

  /** 某条 Biliboard 榜的一期（行已带涨跌/在榜/走势，与主榜同构） */
  boardIssue(name, n) {
    const board = this.#board(name);
    if (!board) return null;
    const hit = board.byIssue.get(Number(n));
    if (!hit) return null;
    const it = hit.issue;
    const rows = this.#decorate(board, it, hit.index);
    const next = hit.index < board.list.length - 1 ? board.list[hit.index + 1] : null;
    return {
      board: name,
      index: hit.index,
      issue: it.issue,
      date: it.date,
      year: it.year,
      week: it.week,
      declared: it.declared ?? null,
      videoBvid: it.videoBvid || '',
      postUrl: '',
      count: rows.length,
      rows,
      ...this.#issueExtras(board, hit, rows),
      siblings: { prev: hit.index > 0 ? board.list[hit.index - 1].issue : null, next: next?.issue ?? null }
    };
  }

  /* ---------- 附榜：ニコニコ VOCALOID SONGS TOP20 ---------- */

  /** 附榜总览：没有数据时返回 null，前端据此不渲染这一块 */
  nicoMeta() {
    this.ensure();
    return this.nico.meta;
  }

  nicoIndex() {
    this.ensure();
    const items = this.nico.list.map((it) => {
      const top = it.entries.find((e) => e.rank === 1) || it.entries[0] || null;
      return {
        issue: it.issue,
        date: it.date,
        period: it.period,
        count: it.count,
        complete: it.complete,
        postUrl: it.postUrl || '',
        champion: top ? { songId: top.songId, title: top.title, producer: top.producer, bvid: top.bvid } : null
      };
    });
    const meta = this.nico.meta || {};
    return {
      board: 'nico',
      title: meta.title || 'ニコニコ VOCALOID SONGS TOP20',
      account: meta.account || null,
      total: items.length,
      first: meta.first ?? null,
      last: meta.last ?? null,
      firstDate: meta.firstDate ?? null,
      lastDate: meta.lastDate ?? null,
      entries: items.reduce((n, it) => n + it.count, 0),
      incomplete: meta.incomplete || [],
      items
    };
  }

  /**
   * 附榜某一期。涨跌优先用帖子里的「上周名次」——那是官方给的；
   * 我们自己的上一期只在帖子没写时兜底（历史不完整时也不会算错）。
   */
  #decorateNico(it, index) {
    const board = this.nico;
    const prev = index > 0 ? board.list[index - 1] : null;
    const prevMap = new Map((prev?.entries || []).map((e) => [e.songId, e.rank]));
    return it.entries
      .map((e) => {
        const hist = (board.history.get(e.songId) || []).filter((h) => h.i <= index);
        const prevRank = e.lastRank != null ? e.lastRank : prevMap.has(e.songId) ? prevMap.get(e.songId) : null;
        const weeks = e.weeks != null ? e.weeks : hist.length;
        const state = prevRank === null ? (weeks <= 1 ? 'new' : 're') : prevRank - e.rank > 0 ? 'up' : prevRank - e.rank < 0 ? 'down' : 'same';
        const best = hist.reduce((m, h) => Math.min(m, h.rank), e.rank);
        return {
          rank: e.rank,
          songId: e.songId,
          bvid: e.bvid,
          title: e.title,
          titleAlt: '',
          producers: e.producer ? [e.producer] : [],
          vocalists: [],
          prev: prevRank,
          delta: prevRank === null ? null : prevRank - e.rank,
          state,
          weeks,
          best,
          spark: hist.slice(-30).map((h) => ({ i: h.i, rank: h.rank })),
          variants: 1
        };
      })
      .sort((a, b) => a.rank - b.rank);
  }

  nicoIssue(n) {
    const board = this.#nicoBoard();
    if (!board) return null;
    const hit = board.byIssue.get(Number(n));
    if (!hit) return null;
    const it = hit.issue;
    const rows = this.#decorateNico(it, hit.index);
    const prev = hit.index > 0 ? board.list[hit.index - 1] : null;
    const next = hit.index < board.list.length - 1 ? board.list[hit.index + 1] : null;
    return {
      board: 'nico',
      title: board.meta?.title || '',
      index: hit.index,
      issue: it.issue,
      date: it.date,
      period: it.period,
      postUrl: it.postUrl || '',
      videoBvid: '',
      count: rows.length,
      complete: it.complete,
      missing: it.missing || [],
      rows,
      ...this.#issueExtras(board, hit, rows),
      siblings: {
        prev: prev ? prev.issue : null,
        next: next ? next.issue : null,
        prevDate: prev ? prev.date : null,
        nextDate: next ? next.date : null
      }
    };
  }

  /**
   * 附榜的冠军段：连续夺冠合并为一段。
   * 和主榜的 champions() 是同一套算法、同一套口径，只是数据源换成附榜的期次表。
   */
  boardChampions(name, limit = 24) {
    const board = this.#anyBoard(name);
    if (!board) return { total: 0, runs: [] };
    const runs = [];
    board.list.forEach((it, i) => {
      const top = it.entries.find((e) => e.rank === 1);
      if (!top) return;
      const last = runs[runs.length - 1];
      if (last && last.id === top.songId) {
        last.end = i;
        last.count++;
        last.issueTo = it.issue;
        if (top.bvid) last.bvid = top.bvid;
      } else {
        runs.push({
          id: top.songId,
          title: top.title,
          bvid: top.bvid,
          start: i,
          end: i,
          count: 1,
          issueFrom: it.issue,
          issueTo: it.issue,
          date: it.date
        });
      }
    });
    return { total: runs.length, runs: runs.slice(-limit).reverse() };
  }

  /**
   * 附榜的曲目索引（走势图左栏）。
   * weeks 是**本项目收录范围内**上榜的期数，不是正文里的「在榜周数」——
   * 它要和右边的折线点数对得上，否则"写着 142 期、图上只有 12 个点"更让人困惑。
   */
  boardSongs(name, q = '', limit = 200) {
    const board = this.#anyBoard(name);
    if (!board) return { total: 0, items: [] };
    const needle = String(q).trim().toLowerCase();
    // 昵称（曲名 / 译名）取最近一次上榜时的那一行 —— 译名会变，以最新的为准
    const items = [];
    for (const [id, hist] of board.history) {
      if (!hist.length) continue;
      const last = hist[hist.length - 1];
      const entry = board.list[last.i].entries.find((e) => idOf(e) === id) || {};
      const title = entry.titleCn || entry.title || String(id);
      const alt = entry.title && entry.title !== (entry.titleCn || entry.title) ? entry.title : '';
      if (needle && !(title + ' ' + alt).toLowerCase().includes(needle)) continue;
      const best = hist.reduce((m, h) => Math.min(m, h.rank), 99);
      items.push({ id, title, titleAlt: alt, weeks: hist.length, best, lastIssue: last.issue });
    }
    items.sort((a, b) => b.weeks - a.weeks || a.best - b.best);
    return { total: items.length, items: items.slice(0, limit) };
  }

  /** 四条榜里的一条（nico 用的是另一份索引，但结构相同） */
  #anyBoard(name) {
    this.ensure();
    if (name === 'nico') return this.nico.list.length ? this.nico : null;
    return this.boards[name] || null;
  }

  #nicoBoard() {
    this.ensure();
    return this.nico.list.length ? this.nico : null;
  }

  /**
   * 单曲在**某条榜**上的历次上榜（抽屉用）。
   * 另外三条榜的汇总也一起带上：抽屉里那句"另外两张榜 / 周榜 27 期"就靠它。
   */
  boardSong(name, id) {
    const board = this.#anyBoard(name);
    if (!board) return null;
    const key = name === 'nico'
      ? String(id || '').trim()
      : (/^\d+$/.test(String(id)) ? Number(id) : id);
    const hist = board.history.get(key);
    if (!hist || !hist.length) return null;

    const last = hist[hist.length - 1];
    const entry = board.list[last.i].entries.find((e) => idOf(e) === key) || {};
    const byBvid = new Map();
    for (const h of hist) {
      if (!h.bvid) continue;
      if (!byBvid.has(h.bvid)) byBvid.set(h.bvid, []);
      byBvid.get(h.bvid).push(h.issue);
    }

    const boards = {};
    for (const n of ['weekly', 'legend', 'annual']) {
      if (n === name) continue;
      const other = this.boards[n]?.history.get(key) || [];
      boards[n] = {
        weeks: other.length,
        best: other.length ? other.reduce((m, h) => Math.min(m, h.rank), 99) : null,
        appearances: other.map((h) => ({ issue: h.issue, date: h.date, rank: h.rank, bvid: h.bvid }))
      };
    }

    return {
      id: key,
      title: name === 'nico' ? String(key) : (entry.titleCn || entry.title || String(key)),
      titleAlt: name === 'nico' ? '' : (entry.title && entry.title !== (entry.titleCn || entry.title) ? entry.title : ''),
      producers: name === 'nico'
        ? (entry.producer ? [entry.producer] : [])
        : (entry.producers || []),
      vocalists: name === 'nico' ? [] : (entry.vocalists || []),
      // ニコニコ 的在榜周数以正文为准（我们只抓到 188 期里的这一段）
      weeks: name === 'nico' && last.weeks != null ? last.weeks : hist.length,
      best: hist.reduce((m, h) => Math.min(m, h.rank), 99),
      appearances: hist.map((h) => ({ issue: h.issue, date: h.date, rank: h.rank, bvid: h.bvid })),
      variants: [...byBvid.entries()].map(([bvid, issues]) => ({ bvid, issues })),
      boards
    };
  }

  /* ---------- 单曲档案：一首曲子跨四条榜的全部记录 ---------- */

  /**
   * 一首曲子在四条榜上的档案。
   *
   * B 站那三条榜共用 Biliboard 的 song.id，所以直接查 history；
   * ニコニコ 那条用的是曲名，只能靠**日文原名**归一化后匹配 —— 匹配不到的诚实写 null，
   * 不要用"看起来像"去凑，那会把两首不同的歌黏在一起。
   */
  songCard(id) {
    this.ensure();
    const key = /^\d+$/.test(String(id)) ? Number(id) : String(id);
    // 不认识的 id 要回 404：给一张全 0 的卡片等于告诉前端"这本书存在但没有上榜"
    const known = this.songInfo.has(key) || ['weekly', 'legend', 'annual'].some((n) => this.boards[n].history.has(key));
    if (!known) return null;
    return this.#cardOf('b', String(key), () => {
      const info = this.songInfo.get(key) || {};
      const boards = {};
      let total = 0;
      for (const name of ['weekly', 'legend', 'annual']) {
        boards[name] = this.#boardStats(name, key);
        total += boards[name].weeks;
      }
      // ニコニコ：拿日文原名去匹配（有译名时 titleAlt 才是原名）
      const jp = info.titleAlt || info.title || '';
      const nk = this.nicoByTitle.get(normTitle(jp));
      boards.nico = nk ? this.#nicoStats(nk) : null;
      return { info, boards, total, jp };
    });
  }

  /** 只在 ニコニコ 榜上出现的曲子（搜索时点到的那些） */
  nicoCard(title) {
    this.ensure();
    const key = String(title || '').trim();
    if (!this.nico.history.has(key)) return null;
    return this.#cardOf('n', key, () => {
      const boards = { weekly: null, legend: null, annual: null, nico: this.#nicoStats(key) };
      const last = this.nico.history.get(key).at(-1);
      const entry = this.nico.list[last.i].entries.find((e) => e.songId === key) || {};
      return {
        info: { title: key, titleAlt: '', producers: entry.producer ? [entry.producer] : [], vocalists: [] },
        boards,
        total: boards.nico.weeks,
        jp: key
      };
    });
  }

  /** 卡片外壳：把两种来源整理成同一个形状 */
  #cardOf(kind, id, build) {
    const { info, boards, total, jp } = build();
    const variants = new Map();
    for (const name of ['weekly', 'legend', 'annual', 'nico']) {
      for (const a of boards[name]?.appearances || []) {
        if (!a.bvid) continue;
        if (!variants.has(a.bvid)) variants.set(a.bvid, []);
        variants.get(a.bvid).push({ board: name, issue: a.issue });
      }
    }
    return {
      kind,
      id,
      title: info.title || '',
      titleAlt: info.titleAlt || '',
      producers: info.producers || [],
      vocalists: info.vocalists || [],
      boards,
      totalWeeks: total,
      matchedTitle: jp,
      variants: [...variants.entries()].map(([bvid, at]) => ({ bvid, at }))
    };
  }

  #boardStats(name, key) {
    const board = this.boards[name];
    const hist = board?.history.get(key) || [];
    if (!hist.length) return { weeks: 0, best: null, first: null, last: null, appearances: [] };
    return {
      weeks: hist.length,
      best: hist.reduce((m, h) => Math.min(m, h.rank), 99),
      first: hist[0].issue,
      last: hist[hist.length - 1].issue,
      appearances: hist.map((h) => ({ issue: h.issue, date: h.date, rank: h.rank, bvid: h.bvid }))
    };
  }

  #nicoStats(key) {
    const hist = this.nico.history.get(key) || [];
    if (!hist.length) return { weeks: 0, best: null, first: null, last: null, appearances: [] };
    return {
      weeks: hist.length,
      // 正文自报的在榜周数可能比我们抓到的历史更久（188 期之外还有）
      reported: hist[hist.length - 1].weeks ?? null,
      best: hist.reduce((m, h) => Math.min(m, h.rank), 99),
      first: hist[0].issue,
      last: hist[hist.length - 1].issue,
      appearances: hist.map((h) => ({ issue: h.issue, date: h.date, rank: h.rank, bvid: h.bvid }))
    };
  }

  /**
   * 跨榜搜索：曲名 / 译名 / P 主 都能搜。
   * 同名的 ニコニコ 曲目如果已经对上了 B 榜曲子就不重复出现 —— 那本来就是同一首歌。
   */
  findSongs(q, limit = 40) {
    this.ensure();
    const needle = normTitle(q);
    const head = String(q || '').trim().toLowerCase();
    const items = [];

    for (const [id, info] of this.songInfo) {
      const hay = normTitle(info.title) + ' ' + normTitle(info.titleAlt);
      const prod = (info.producers || []).map((x) => x.name || x).join(' ').toLowerCase();
      if (head && hay.indexOf(needle) < 0 && prod.indexOf(head) < 0) continue;
      const counts = {};
      let total = 0;
      for (const name of ['weekly', 'legend', 'annual']) {
        counts[name] = (this.boards[name].history.get(id) || []).length;
        total += counts[name];
      }
      const jp = info.titleAlt || info.title;
      const nk = this.nicoByTitle.get(normTitle(jp));
      counts.nico = nk ? (this.nico.history.get(nk) || []).length : 0;
      items.push({
        kind: 'b', id, title: info.title, titleAlt: info.titleAlt,
        producers: info.producers || [], counts, total: total + counts.nico
      });
    }

    // 只在 ニコニコ 榜上有的曲子
    const seen = new Set(items.map((x) => normTitle(x.titleAlt || x.title)));
    for (const [key, hist] of this.nico.history) {
      const nk = normTitle(key);
      if (!nk || seen.has(nk) || this.nicoToB.has(nk)) continue;
      if (needle && nk.indexOf(needle) < 0) continue;
      if (!hist.length) continue;
      const last = hist[hist.length - 1];
      items.push({
        kind: 'n', id: key, title: key, titleAlt: '',
        producers: [], counts: { weekly: 0, legend: 0, annual: 0, nico: hist.length }, total: hist.length
      });
      seen.add(nk);
      void last;
    }

    items.sort((a, b) => b.total - a.total || a.title.localeCompare(b.title));
    return { total: items.length, items: items.slice(0, limit) };
  }

  /** 某张榜的曲目上榜记录（曲目详情页与抽屉用） */
  #appearancesOf(board, id) {
    const hist = board.history.get(id) || [];
    return {
      weeks: hist.length,
      best: hist.length ? hist.reduce((m, h) => Math.min(m, h.rank), 99) : null,
      appearances: hist.map((h) => ({ issue: h.issue, date: h.date, rank: h.rank, bvid: h.bvid }))
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

  /**
   * 单曲详情。
   *
   * 曲目可能只上过附榜、从没上周榜（数据里各 7–8 首）：以前这种情况返回 null，
   * 前端拿 404，点开抽屉就是一片"没有这首曲子"。现在三张榜的上榜记录都带上，
   * 标题与 P 主从 songInfo（三张榜合并出的曲目信息）里取 —— 抽屉里仍然有东西可看。
   */
  song(id) {
    this.ensure();
    const key = /^\d+$/.test(String(id)) ? Number(id) : id;
    const weekly = this.#appearancesOf(this.boards.weekly, key);
    const legend = this.#appearancesOf(this.boards.legend, key);
    const annual = this.#appearancesOf(this.boards.annual, key);
    if (!weekly.weeks && !legend.weeks && !annual.weeks) return null;

    const info = this.songInfo.get(key) || {};
    const byBvid = new Map();
    for (const a of weekly.appearances) {
      if (!a.bvid) continue;
      if (!byBvid.has(a.bvid)) byBvid.set(a.bvid, []);
      byBvid.get(a.bvid).push(a.issue);
    }
    return {
      id: key,
      title: info.title || '',
      titleAlt: info.titleAlt || '',
      producers: info.producers || [],
      vocalists: info.vocalists || [],
      weeks: weekly.weeks,
      best: weekly.best,
      appearances: weekly.appearances,
      variants: [...byBvid.entries()].map(([bvid, issues]) => ({ bvid, issues })),
      boards: {
        legend: { weeks: legend.weeks, best: legend.best, appearances: legend.appearances },
        annual: { weeks: annual.weeks, best: annual.best, appearances: annual.appearances }
      }
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
