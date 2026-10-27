import { API, detailParams, feedParams, WEB } from '../bili/endpoints.js';
import { isChartPost, normalizeUrl, parseTitle } from '../util/text.js';
import { missingRanks, parseArticleHtml, parseOpusItem, parseSsrArticle } from './parse.js';

const FEED_REFERER = (mid) => 'https://space.bilibili.com/' + mid + '/dynamic';

/**
 * 拉取账号的动态列表，筛出周榜帖（增量更新时用于发现新帖）
 * 说明：opus 列表接口按 offset 游标翻页，offset 为空表示第一页
 */
export async function listChartPosts(client, mid, { maxPages = 40, logger, knownIds = new Set(), force = false } = {}) {
  const posts = [];
  const seen = new Set();
  let offset = '';
  for (let page = 1; page <= maxPages; page++) {
    if (client.deadline && Date.now() > client.deadline) {
      logger?.warn('抓取超时，停止翻页（已发现 ' + posts.length + ' 条）');
      break;
    }
    const res = await client.api(API.opusFeed, feedParams(mid, offset), { referer: FEED_REFERER(mid) });
    const items = res?.data?.items || [];
    for (const it of items) {
      const id = it.opus_id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const title = it.content || '';
      // 只认正式榜单帖：招聘、致歉、预告这类动态不算。
      // 这里判一次就够了 —— 以前进循环判 isChartPost、出循环又 filter 一遍，
      // 中间那个 "|| /周榜/" 永远不会让多出来的东西活到最后。
      if (isChartPost(title)) posts.push({ id, title, cover: normalizeUrl(it.cover?.url || '') });
    }
    logger?.debug('feed page ' + page + ': +' + items.length + ' (total seen ' + seen.size + ')');
    if (!res?.data?.has_more || items.length === 0) break;
    // 增量：翻到已抓过的帖子就停（动态列表按时间倒序），每周更新通常只需 1 页
    if (!force && items.some((it) => knownIds.has(it.opus_id))) {
      logger?.debug('遇到已抓取内容，停止翻页');
      break;
    }
    offset = res.data.offset;
  }
  return posts.filter((p) => isChartPost(p.title));
}

async function metaOf(client, id) {
  const res = await client.api(API.dynamicDetail, detailParams(id));
  const item = res?.data?.item;
  if (!item) return null;
  const md = item.modules?.module_dynamic || {};
  const article = md.major?.article;
  const author = item.modules?.module_author || {};
  return {
    type: item.type || '',
    cv: article?.id ? Number(article.id) : item.basic?.rid_str && item.type === 'DYNAMIC_TYPE_ARTICLE' ? Number(item.basic.rid_str) : null,
    title: article?.title || md.desc?.text || author.pub_time || '',
    pubTs: Number(author.pub_ts || 0),
    pubTime: author.pub_time || ''
  };
}

/**
 * 把某一层解析结果记进 record，并算出"缺哪几名"。
 *
 * 20 条的榜单里缺 3 条，以前和"完整抓到"一样算成功：页面上那三名凭空消失，
 * 抓取侧却以为自己干完了。missingRanks() 是 parse.js 里现成的，之前没人用；
 * 接上之后，缺名的记录会带 complete:false 与 missing:[...]，抓取汇总里也会单独计数。
 */
function applyEntries(record, entries, source, payload) {
  record.entries = entries;
  record.source = source;
  record.payload = payload;
  record.missing = missingRanks(entries);
  record.complete = record.missing.length === 0;
  if (!record.complete) {
    record.warnings.push('解析到 ' + entries.length + ' 条，缺第 ' + record.missing.join('、') + ' 名');
  }
  return record;
}

/**
 * 抓单期内容。按「opus 段落 → 专栏接口 → 专栏 SSR 页」依次降级，
 * 任一成功即返回，并保留原文 payload 以便重新解析（见 src/crawler/reparse.js）。
 */
export async function fetchPost(client, post, { logger } = {}) {
  const record = {
    id: post.id,
    title: post.title,
    cv: null,
    type: '',
    pubTs: 0,
    pubTime: '',
    entries: [],
    source: '',
    payload: null,
    missing: [],
    complete: false,
    warnings: [],
    fetchedAt: new Date().toISOString()
  };

  try {
    const meta = await metaOf(client, post.id);
    if (meta) {
      record.cv = meta.cv;
      record.type = meta.type;
      record.pubTs = meta.pubTs;
      record.pubTime = meta.pubTime;
      if (meta.title && meta.title.includes('期')) record.title = meta.title;
    } else {
      // 没有详情就拿不到 cv，后面两个专栏分支都会走空；必须留痕，否则
      // 只看 warnings 的人会以为"三条路都试过了、只是没解析出来"
      record.warnings.push('meta: 动态详情为空');
    }
  } catch (err) {
    record.warnings.push('meta: ' + err.message);
  }

  // 1) opus 段落（新帖通常可用）
  try {
    const res = await client.api(API.opusDetail, detailParams(post.id));
    const parsed = parseOpusItem(res?.data?.item);
    if (parsed?.entries?.length) {
      applyEntries(record, parsed.entries, 'opus', { kind: 'paragraphs', data: parsed.paragraphs });
      if (!record.pubTs && parsed.pubTs) record.pubTs = parsed.pubTs;
      return record;
    }
  } catch (err) {
    record.warnings.push('opus: ' + err.message);
  }

  const cv = record.cv;
  if (!cv) {
    record.warnings.push('缺少 cv 号，无法取专栏正文');
    return record;
  }

  // 2) 专栏接口
  try {
    const res = await client.api(API.articleView, { id: String(cv) }, { referer: WEB.readPage(cv) });
    const content = res?.data?.content || '';
    const entries = parseArticleHtml(content);
    if (entries.length) {
      applyEntries(record, entries, 'article', { kind: 'html', data: content });
      if (!record.title || !record.title.includes('期')) record.title = res.data.title || record.title;
      return record;
    }
  } catch (err) {
    record.warnings.push('article: ' + err.message);
  }

  // 3) 专栏 SSR 页
  try {
    const html = await client.html(WEB.readPage(cv) + '?r=' + Math.random().toString(36).slice(2));
    const entries = parseSsrArticle(html);
    if (entries && entries.length) {
      applyEntries(record, entries, 'ssr', { kind: 'html', data: html });
      return record;
    }
    record.warnings.push('ssr: 页面未返回正文');
  } catch (err) {
    record.warnings.push('ssr: ' + err.message);
  }

  return record;
}

/**
 * 增量抓取：只抓缺失的期（force=true 时全量重抓）
 */
export async function crawl(client, cfg, store, { force = false, deep = false, limit = 0, logger, failures = null } = {}) {
  const known = new Set(store.ids());
  // deep: 完整翻页（用于补抓历史遗漏）；force: 完整翻页 + 全部重抓
  const posts = await listChartPosts(client, cfg.account.mid, { maxPages: cfg.crawl.maxPages, logger, knownIds: known, force: force || deep });
  const knownIssues = new Set(
    store.all().map((r) => {
      const p = parseTitle(r.title);
      return p.issue + ':' + p.series;
    })
  );

  const skippedReasons = { exists: 0, repost: 0, failed: 0 };
  const plan = [];
  for (const post of posts) {
    if (!force && known.has(post.id)) { skippedReasons.exists++; continue; }
    const p = parseTitle(post.title);
    if (!force && knownIssues.has(p.issue + ':' + p.series)) {
      skippedReasons.repost++;
      logger?.debug('跳过重复期号：' + post.title);
      continue;
    }
    if (!force && failures?.shouldSkip(post.id)) {
      skippedReasons.failed++;
      logger?.warn('跳过多次失败的帖子：' + post.title + '（加 --force 可重试）');
      continue;
    }
    plan.push(post);
  }
  let todo = plan;
  if (limit > 0) todo = todo.slice(0, limit);

  logger?.info('发现周榜帖 ' + posts.length + ' 条，待抓取 ' + todo.length + ' 条');

  const result = {
    discovered: posts.length,
    fetched: 0,
    failed: [],
    incomplete: [],
    skipped: posts.length - todo.length,
    skippedReasons
  };
  let i = 0;
  for (const post of todo) {
    i++;
    if (client.deadline && Date.now() > client.deadline) {
      logger?.warn('抓取超时，剩余 ' + (todo.length - i + 1) + ' 条留待下次');
      result.failed.push({ id: post.id, title: post.title, warnings: ['超时跳过'] });
      continue;
    }
    try {
      const record = await fetchPost(client, post, { logger });
      if (record.entries.length) {
        store.write(record);
        failures?.clear(post.id);
        result.fetched++;
        if (!record.complete) {
          result.incomplete.push({ id: post.id, title: record.title, missing: record.missing });
          logger?.warn('[' + i + '/' + todo.length + '] ' + record.title + ' 缺第 ' + record.missing.join('、') + ' 名（已存，页面会如实显示空缺）');
        } else {
          logger?.info('[' + i + '/' + todo.length + '] ' + record.title + ' → ' + record.entries.length + ' 条 (' + record.source + ')');
        }
      } else {
        failures?.record(post.id, record.warnings.join('; ') || '无条目');
        result.failed.push({ id: post.id, title: post.title, warnings: record.warnings });
        logger?.warn('[' + i + '/' + todo.length + '] 解析失败 ' + post.title + ' ' + record.warnings.join('; '));
      }
    } catch (err) {
      failures?.record(post.id, err.message);
      result.failed.push({ id: post.id, title: post.title, warnings: [err.message] });
      logger?.error('抓取异常 ' + post.id + ': ' + err.message);
    }
  }
  if (result.incomplete.length) {
    logger?.warn('本轮有 ' + result.incomplete.length + ' 期不满 20 名，已在 data/raw 里标记 complete:false');
  }
  return result;
}
