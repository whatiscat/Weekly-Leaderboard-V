import { API, detailParams, feedParams, WEB } from '../bili/endpoints.js';
import { av2bv } from '../util/av.js';
import { bvOf, cleanTitle, normalizeUrl, pad2 } from '../util/text.js';
import { missingRanks, sliceBalanced } from './parse.js';

/**
 * 附榜抓取：ニコニコ VOCALOID SONGS TOP20（Billboard JAPAN × ニコニコ）
 *
 * 和主榜最大的不同：**这条榜没有官方曲目库**。Biliboard 那边名次来自公开的
 * songs.json，帖子只是旁证；这里反过来 —— 帖子本身就是唯一来源。
 * 好在正文自带「上周：N / 在榜周数：M」，涨跌与我们自己算的一致，可以互相校验。
 *
 * 两种时期的排版（都要支持，不然历史只剩一半）：
 *   1) 2024 年之后是 opus 动态：段落 → 链接卡片（卡片 oid 是视频 aid）
 *   2) 2024 年之前是专栏文章：<p>第N位 曲名/P主</p> + <p>上周…</p> + <figure><img aid="…">
 * 两者都归约成同一个「文本块 + aid」序列，再走同一套解析 —— 一份规则喂两种排版。
 *
 * 期号也不在标题里（新帖标题只有日期）：正文写「上期（第189期）」，所以本期是 190。
 * 老帖标题里有「第91期」，那是更可靠的来源，优先用。
 */

/** 标题前缀：【2026/10/21】… 或 【2024/11/27 第91期】… */
const TITLE_HEAD = /^【\s*(\d{4})\/(\d{1,2})\/(\d{1,2})([^】]*)】/;
/** 榜单帖：标题里带 TOP20 或中文全称（年榜 / 半年榜也带，靠日期前缀再筛一层） */
const CHART_HEAD = /TOP20|NICONICO VOCALOID/i;
/** 名次行：第20位 熱異常/いよわ */
const RANK_LINE = /^第\s*(\d+)\s*[位名]\s+([\s\S]+)$/;
/** 名次下一行：上周： —     在榜周数：36 */
const META_LINE = /上周[：:]\s*([^\s]*)[\s\S]*?在榜周数[：:]\s*(\d+)/;
const ISSUE_NOW = /本期为[^。\n]{0,40}?第\s*(\d+)\s*期/;
const ISSUE_PREV = /上期[（(]第\s*(\d+)\s*期[)）]/;
const PERIOD = /统计时段为\s*(\d{4}\/\d{1,2}\/\d{1,2})\s*[-~—～至]\s*(\d{4}\/\d{1,2}\/\d{1,2})/;
const TITLE_ISSUE = /第\s*(\d+)\s*期/;

function textOfParagraph(p) {
  return (p?.text?.nodes || []).map((n) => n?.word?.words ?? n?.rich?.text ?? '').join('');
}

/**
 * 视频卡片有三种形态，全部要认（同一条榜里混着用，不是年代差异）：
 *   · eva3_video.info —— avid / bvid / cover（「视频卡片」）
 *   · ugc             —— id_str(=aid) / jump_url(带 BV) / cover（普通 ugc 卡片）
 *   · 只有 oid        —— opusDetail 接口返回的就是这样，连 bvid 都没有
 * 统一成一个 card 对象，后面的解析对来源一视同仁。
 */
function cardInfo(card) {
  if (!card) return null;
  const eva = card.eva3_video?.info;
  if (eva && (eva.bvid || eva.avid)) {
    return {
      aid: eva.avid ? String(eva.avid) : '',
      bvid: eva.bvid || '',
      cover: normalizeUrl(eva.cover || '')
    };
  }
  const ugc = card.ugc || card.archive || card.common || null;
  if (ugc && (ugc.id_str || ugc.avid || ugc.aid || ugc.jump_url)) {
    const aid = ugc.id_str || ugc.avid || ugc.aid || '';
    return {
      aid: aid ? String(aid) : '',
      bvid: ugc.bvid || bvOf(ugc.jump_url || ''),
      cover: normalizeUrl(ugc.cover || ugc.pic || '')
    };
  }
  const oid = card.oid;
  if (oid != null && /^\d+$/.test(String(oid)) && Number(oid) > 0) {
    return { aid: String(oid), bvid: '', cover: '' };
  }
  return null;
}

/** opus 段落 → [{text, card}] */
function blocksFromParagraphs(paragraphs) {
  return (paragraphs || []).map((p) => {
    if (p?.para_type === 6) return { text: '', card: cardInfo(p?.link_card?.card) };
    return { text: textOfParagraph(p), card: null };
  });
}

/** 专栏 HTML → [{text, aid}]，顺序与正文一致 */
function blocksFromHtml(html) {
  const blocks = [];
  // <p> 里的文字 + 视频卡片（<img ... aid="123">）交替出现
  const re = /<p[^>]*>([\s\S]*?)<\/p>|<img[^>]*\said="(\d+)"/g;
  let m;
  while ((m = re.exec(String(html || '')))) {
    if (m[1] !== undefined) blocks.push({ text: cleanTitle(m[1]), card: null });
    else blocks.push({ text: '', card: { aid: m[2], bvid: '', cover: '' } });
  }
  return blocks;
}

/**
 * 曲名 / P 主拆分：「モニタリング/DECO*27」按**最后一个**斜杠切。
 * 曲名里偶尔也带斜杠，按第一个切会把曲名截断；P 主名里几乎不会有斜杠。
 */
export function splitTitleProducer(raw) {
  const s = String(raw || '').replace(/\u3000/g, ' ').trim();
  const i = s.lastIndexOf('/');
  if (i <= 0 || i >= s.length - 1) return { title: s, producer: '' };
  return { title: s.slice(0, i).trim(), producer: s.slice(i + 1).trim() };
}

/**
 * 「文本块 + aid」序列 → 榜单条目。
 *
 * 判据只有三条，都来自正文本身的排版约定：名次行 → 元信息行 → 视频卡片。
 * 卡片挂在**上一个还没拿到 aid 的条目**上：正文开头还有几个引导卡片
 * （本期视频版、上期链接），那时还没有条目，自然会被忽略。
 */
export function entriesFromBlocks(blocks) {
  const out = [];
  const byRank = new Map();
  let cur = null;
  for (const b of blocks || []) {
    if (b.card) {
      if (cur && !cur.aid) {
        cur.aid = b.card.aid || '';
        cur.bvid = b.card.bvid || av2bv(cur.aid);
        cur.cover = b.card.cover || '';
      }
      continue;
    }
    const text = String(b.text || '').replace(/\u3000/g, ' ').trim();
    if (!text) continue;

    const rk = RANK_LINE.exec(text);
    if (rk) {
      const rank = Number(rk[1]);
      // 正文偶尔会把同一名次出现两次（分页 / 排版重复），以第一次为准
      if (byRank.has(rank)) { cur = byRank.get(rank); continue; }
      const { title, producer } = splitTitleProducer(rk[2]);
      cur = { rank, title, producer, lastRank: null, weeks: null, aid: '', bvid: '', cover: '' };
      byRank.set(rank, cur);
      out.push(cur);
      continue;
    }

    const meta = META_LINE.exec(text);
    if (meta && cur) {
      cur.lastRank = /^\d+$/.test(meta[1]) ? Number(meta[1]) : null;
      cur.weeks = Number(meta[2]);
    }
  }
  return out
    .filter((e) => e.title)
    .sort((a, b) => a.rank - b.rank)
    .filter((e, i, arr) => i === 0 || arr[i - 1].rank !== e.rank);
}

function issueFromText(text) {
  const now = ISSUE_NOW.exec(text);
  if (now) return Number(now[1]);
  const prev = ISSUE_PREV.exec(text);
  if (prev) return Number(prev[1]) + 1;
  return null;
}

function periodFromText(text) {
  const m = PERIOD.exec(text);
  return m ? { from: m[1], to: m[2] } : null;
}

/**
 * 拉动态列表，挑出周刊帖。
 * 年榜 / 半年榜（标题没有日期前缀）一律跳过：它们没有期号、没有统计时段，
 * 混进周序列会把「上一期」算错。跳过数量会写进抓取汇总，不静默吞掉。
 */
export async function listNicoPosts(client, cfg, { logger, knownIds = new Set(), force = false, deep = false } = {}) {
  const mid = cfg.nico.mid;
  const referer = 'https://space.bilibili.com/' + mid + '/dynamic';
  const maxPages = cfg.nico.maxPages || 20;
  const posts = [];
  const seen = new Set();
  const special = [];
  let offset = '';

  for (let page = 1; page <= maxPages; page++) {
    if (client.deadline && Date.now() > client.deadline) {
      logger?.warn('附榜抓取超时，停止翻页（已发现 ' + posts.length + ' 期）');
      break;
    }
    const res = await client.api(API.opusFeed, feedParams(mid, offset), { referer });
    const items = res?.data?.items || [];
    for (const it of items) {
      const id = it.opus_id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const title = String(it.content || '').trim();
      if (!CHART_HEAD.test(title)) continue;
      const head = TITLE_HEAD.exec(title);
      if (!head) { special.push(title); continue; }
      const found = TITLE_ISSUE.exec(title);
      posts.push({
        id: String(id),
        title,
        // pad2 收数字：标题里的月份是 "09"，直接传进去会拼成 "009"
        date: head[1] + '-' + pad2(Number(head[2])) + '-' + pad2(Number(head[3])),
        issue: found ? Number(found[1]) : null
      });
    }
    logger?.debug('附榜 feed page ' + page + ': ' + items.length + ' 条 / 累计 ' + seen.size);
    if (!res?.data?.has_more || !items.length) break;
    // 增量：翻到已抓过的帖子就停（动态按时间倒序）。
    // deep 例外：第一次回填是**从新往旧**补，第一页全是已知的，按增量规则会立刻收工，
    // 于是老的那一半永远补不上来。deep 时一直翻到底，仍然只抓缺的那些。
    if (!force && !deep && items.some((it) => knownIds.has(String(it.opus_id)))) break;
    offset = res.data.offset;
  }

  posts.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return { posts, special, scanned: seen.size };
}

const OPUS_PAGE = (id) => 'https://www.bilibili.com/opus/' + id;

/**
 * 从 opus 页面里抠出内嵌的段落 JSON。
 *
 * 这是一条**普通页面请求**，不是 x/ 接口 —— 老帖（专栏时代的动态）在页面上
 * 会被渲染成一整段正文，且链接卡片里连 bvid 与封面都带着，一次请求拿全。
 * 新帖的页面只渲染前几段（正文是懒加载的），所以它只能当兜底。
 */
function extractOpusParagraphs(html) {
  const key = '"module_content":{"paragraphs":[';
  const at = String(html || '').indexOf(key);
  if (at < 0) return null;
  const raw = sliceBalanced(html, html.indexOf('[', at), '[', ']');
  if (!raw) return null;
  try {
    const paragraphs = JSON.parse(raw);
    return Array.isArray(paragraphs) && paragraphs.length ? paragraphs : null;
  } catch {
    return null;
  }
}

async function fetchOpusSsr(client, id) {
  const html = await client.html(OPUS_PAGE(id), { mobile: false, referer: 'https://space.bilibili.com/' });
  const paragraphs = extractOpusParagraphs(html);
  if (!paragraphs) return null;
  // 顺手把每个视频卡片的封面收起来：并进 covers.json 之后就不用再逐个问稿件接口了
  const videos = [];
  for (const p of paragraphs) {
    if (p?.para_type !== 6) continue;
    const card = cardInfo(p?.link_card?.card);
    if (card?.bvid) videos.push({ bvid: card.bvid, cover: card.cover });
  }
  return { paragraphs, videos, text: paragraphs.map(textOfParagraph).join('\n') };
}

function finish(record, entries, source, payload, text) {
  record.entries = entries;
  record.source = source;
  record.payload = payload;
  if (!record.issue) record.issue = issueFromText(text);
  if (!record.period) record.period = periodFromText(text);
  record.missing = missingRanks(entries, 20);
  record.complete = record.missing.length === 0;
  if (!record.complete) record.warnings.push('解析到 ' + entries.length + ' 条，缺第 ' + record.missing.join('、') + ' 名');
  return record;
}

async function articleIdOf(client, id, record) {
  try {
    const res = await client.api(API.dynamicDetail, detailParams(id));
    const item = res?.data?.item;
    if (!item) { record.warnings.push('meta: 动态详情为空'); return 0; }
    record.type = item.type || '';
    const art = item.modules?.module_dynamic?.major?.article;
    if (art?.title && !record.issue) {
      const m = TITLE_ISSUE.exec(art.title);
      if (m) record.issue = Number(m[1]);
    }
    if (art?.id) return Number(art.id);
    if (item.type === 'DYNAMIC_TYPE_ARTICLE' && item.basic?.rid_str) return Number(item.basic.rid_str);
    return 0;
  } catch (err) {
    record.warnings.push('meta: ' + err.message);
    return 0;
  }
}

/**
 * 排版切换的时间点：2024 年 11 月之前的帖子是**专栏文章**，之后是 opus 动态。
 *
 * 这个日期只用来**决定先试哪条路**，不决定能不能解析：判错了最多多花一次请求
 * （两条路互为兜底），不会解析错。之所以要判，是因为老帖走 opus 接口必然是空响应，
 * 一百多期加起来就是一百多次白打的请求 —— 而无 Cookie 时配额很紧。
 */
const OPUS_FROM = '2024-11-01';

/** 抓一期：opus 段落 → 专栏正文，任一解析出条目即成功 */
export async function fetchNicoPost(client, post, { logger } = {}) {
  const record = {
    id: post.id,
    title: post.title,
    date: post.date,
    issue: post.issue ?? null,
    period: null,
    cv: 0,
    type: '',
    entries: [],
    source: '',
    payload: null,
    missing: [],
    complete: false,
    warnings: [],
    fetchedAt: new Date().toISOString()
  };

  const preferArticle = Boolean(post.date && post.date < OPUS_FROM);
  record.covers = [];

  // 0) opus 页面（SSR）：一次普通页面请求，老帖能拿到完整正文 + bvid + 封面。
  //    新帖的正文是懒加载的，页面上只有前几段，所以只用它取视频信息当兜底。
  let ssr = null;
  try {
    ssr = await fetchOpusSsr(client, post.id);
    if (ssr) {
      record.covers = ssr.videos;
      const entries = entriesFromBlocks(blocksFromParagraphs(ssr.paragraphs));
      if (entries.length >= 15) {
        finish(record, entries, 'opus-ssr', { kind: 'paragraphs', data: ssr.paragraphs }, ssr.text);
        return record;
      }
    }
  } catch (err) {
    record.warnings.push('ssr: ' + err.message);
  }

  // 1) opus 段落（新帖）。老帖直接跳过 —— 那条路上必然是空响应
  if (!preferArticle) {
    try {
      const res = await client.api(API.opusDetail, detailParams(post.id));
      const paragraphs = res?.data?.item?.modules
        ?.find((m) => m.module_type === 'MODULE_TYPE_CONTENT')?.module_content?.paragraphs;
      if (paragraphs && paragraphs.length) {
        const text = paragraphs.map(textOfParagraph).join('\n');
        finish(record, entriesFromBlocks(blocksFromParagraphs(paragraphs)), 'opus', { kind: 'paragraphs', data: paragraphs }, text);
        if (record.entries.length) return record;
      }
    } catch (err) {
      record.warnings.push('opus: ' + err.message);
    }
  }

  // 2) 专栏正文（老帖）
  const cv = await articleIdOf(client, post.id, record);
  if (cv) {
    record.cv = cv;
    try {
      const res = await client.api(API.articleView, { id: String(cv) }, { referer: WEB.readPage(cv) });
      const html = res?.data?.content || '';
      finish(record, entriesFromBlocks(blocksFromHtml(html)), 'article', { kind: 'html', data: html }, cleanTitle(html));
      if (!record.title || !TITLE_HEAD.test(record.title)) record.title = res?.data?.title || record.title;
      if (record.entries.length) return record;
    } catch (err) {
      record.warnings.push('article: ' + err.message);
    }
  } else if (!record.warnings.length) {
    record.warnings.push('缺少 cv 号，无法取专栏正文');
  }

  // 3) 兜底：SSR 页上解析到的那几条（可能不全，但比一条都没有强）
  if (!record.entries.length && ssr) {
    const entries = entriesFromBlocks(blocksFromParagraphs(ssr.paragraphs));
    if (entries.length) {
      finish(record, entries, 'opus-ssr', { kind: 'paragraphs', data: ssr.paragraphs }, ssr.text);
      record.warnings.push('SSR 只渲染出 ' + entries.length + ' 条（新帖正文懒加载）');
      return record;
    }
  }

  // 4) 判错年代时的兜底：老帖其实已经是 opus 动态（切换初期可能两种都有）
  if (preferArticle && !record.entries.length) {
    try {
      const res = await client.api(API.opusDetail, detailParams(post.id));
      const paragraphs = res?.data?.item?.modules
        ?.find((m) => m.module_type === 'MODULE_TYPE_CONTENT')?.module_content?.paragraphs;
      if (paragraphs && paragraphs.length) {
        const text = paragraphs.map(textOfParagraph).join('\n');
        finish(record, entriesFromBlocks(blocksFromParagraphs(paragraphs)), 'opus', { kind: 'paragraphs', data: paragraphs }, text);
      }
    } catch (err) {
      record.warnings.push('opus(兜底): ' + err.message);
    }
  }

  return record;
}

/**
 * 给**已经存过的**期次补封面（零接口请求）。
 *
 * 背景：早期抓下来的记录只有 bvid（aid 换算来的），没有封面。给它们补封面时
 * 有两条路 —— 逐个问稿件接口（一个视频一次请求），或者重新打开那一期的 opus
 * 页面（一次请求 20 个封面）。后者便宜二十倍，而且走的是普通页面，不进接口配额。
 */
export async function harvestNicoCovers(client, store, hasCover, log, { ids = null } = {}) {
  // ids 为空 = 全量回填（命令行显式要求时才这么做）。默认只补这一轮新抓到的期：
  // 老记录缺封面多半是稿件被删，每轮都去重扫 60 多期页面纯属白跑（实测一次 3 分钟）。
  const todo = [];
  for (const id of (ids || store.ids())) {
    const rec = store.read(id);
    if (!rec?.entries?.length) continue;
    if (rec.entries.some((e) => e.bvid && !hasCover(e.bvid))) todo.push(id);
  }
  if (!todo.length) return { pages: 0, found: 0 };

  log?.info('附榜封面：' + todo.length + ' 期缺少封面，按页面补（每页 20 个）');
  const pairs = [];
  let pages = 0;
  for (const id of todo) {
    if (client.deadline && Date.now() > client.deadline) {
      log?.warn('附榜封面补抓超时，剩余 ' + (todo.length - pages) + ' 期留待下次');
      break;
    }
    try {
      const ssr = await fetchOpusSsr(client, id);
      if (ssr?.videos?.length) pairs.push(...ssr.videos);
      pages++;
    } catch (err) {
      log?.debug('封面补抓失败 ' + id + '：' + err.message);
    }
  }
  return { pages, pairs };
}

/** 增量抓取附榜 */
export async function crawlNico(client, cfg, store, { force = false, deep = false, limit = 0, logger, failures = null } = {}) {
  const known = new Set(store.ids());
  const { posts, special, scanned } = await listNicoPosts(client, cfg, { logger, knownIds: known, force, deep });
  let todo = force ? posts : posts.filter((p) => !known.has(p.id));
  if (limit > 0) todo = todo.slice(0, limit);

  logger?.info('附榜：扫描 ' + scanned + ' 条动态，周榜帖 ' + posts.length + ' 期'
    + (special.length ? '，跳过非周刊帖 ' + special.length + ' 条' : '') + '，待抓取 ' + todo.length + ' 期');

  const result = {
    discovered: posts.length,
    scanned,
    skippedSpecial: special.length,
    special: special.slice(0, 5),
    fetched: 0,
    fetchedIds: [],
    failed: [],
    incomplete: [],
    incompleteIssues: [],
    skipped: posts.length - todo.length
  };

  let i = 0;
  for (const post of todo) {
    i++;
    if (client.deadline && Date.now() > client.deadline) {
      logger?.warn('附榜抓取超时，剩余 ' + (todo.length - i + 1) + ' 期留待下次');
      result.failed.push({ id: post.id, title: post.title, warnings: ['超时跳过'] });
      continue;
    }
    try {
      const record = await fetchNicoPost(client, post, { logger });
      if (record.entries.length) {
        store.write(record);
        failures?.clear(post.id);
        result.fetched++;
        result.fetchedIds.push(record.id);
        if (!record.complete) {
          result.incomplete.push({ id: post.id, title: record.title, missing: record.missing });
          result.incompleteIssues.push(record.date);
          logger?.warn('[' + i + '/' + todo.length + '] ' + record.date + ' 缺第 ' + record.missing.join('、') + ' 名');
        } else if (i % 10 === 0 || limit) {
          logger?.info('[' + i + '/' + todo.length + '] ' + record.date + ' → ' + record.entries.length + ' 条 (' + record.source + ')');
        }
      } else {
        failures?.record(post.id, record.warnings.join('; ') || '无条目');
        result.failed.push({ id: post.id, title: post.title, warnings: record.warnings });
        logger?.warn('[' + i + '/' + todo.length + '] 解析失败 ' + post.date + ' ' + record.warnings.join('; '));
      }
    } catch (err) {
      failures?.record(post.id, err.message);
      result.failed.push({ id: post.id, title: post.title, warnings: [err.message] });
      logger?.error('附榜抓取异常 ' + post.id + ': ' + err.message);
    }
  }
  return result;
}
