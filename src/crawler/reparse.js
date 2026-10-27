import { missingRanks, parseArticleHtml, parseParagraphs, parseSsrArticle } from './parse.js';

/**
 * 重新解析已抓取的原文（不联网）
 *
 * 为什么要保留原文：解析规则一定会变（新的段落结构、新的标题写法、名次里的全角空格…）。
 * 如果只存解析结果，规则一改就只能把帖子全部重抓一遍 —— 那是几百次请求，
 * 还可能碰上风控。data/raw/*.json 里存了 `payload` 原文，就是为了在这种时候
 * 能"离线重算一遍"。
 *
 * 这个模块只做三件事：认出 payload 的种类 → 用当前解析器重算 → 和旧结果比对。
 * 是否落盘由调用方（CLI 的 --write）决定，默认**只报告不写**。
 */
export function reparseRecord(record) {
  const payload = record?.payload;
  if (!payload || !payload.data) {
    return { ok: false, reason: '没有保留原文 payload（迁移数据或早期记录）' };
  }

  let entries = null;
  if (payload.kind === 'paragraphs') {
    entries = parseParagraphs(payload.data);
  } else if (payload.kind === 'html') {
    // 同一份 html 可能是专栏正文，也可能是 SSR 整页 —— 两种解析都试，
    // 顺序无关紧要：能出条目的那个会返回非空。
    entries = parseArticleHtml(payload.data) || parseSsrArticle(payload.data);
  } else {
    return { ok: false, reason: '未知的 payload.kind：' + payload.kind };
  }

  if (!entries || !entries.length) return { ok: false, reason: '原文里没有解析出任何条目' };
  return { ok: true, entries, diff: diffEntries(record.entries || [], entries) };
}

/** 逐名次比对两个条目数组，返回改了什么、改了几处 */
export function diffEntries(before, after) {
  const b = new Map(before.map((e) => [e.rank, e]));
  const a = new Map(after.map((e) => [e.rank, e]));
  const ranks = [...new Set([...b.keys(), ...a.keys()])].sort((x, y) => x - y);

  const counts = { title: 0, url: 0, cover: 0, added: 0, removed: 0 };
  const changes = [];

  for (const rank of ranks) {
    const old = b.get(rank);
    const now = a.get(rank);
    if (!old) {
      counts.added++;
      changes.push({ rank, field: 'added', before: '', after: now.title });
      continue;
    }
    if (!now) {
      counts.removed++;
      changes.push({ rank, field: 'removed', before: old.title, after: '' });
      continue;
    }
    for (const field of ['title', 'url', 'cover']) {
      const x = old[field] || '';
      const y = now[field] || '';
      if (x === y) continue;
      counts[field]++;
      changes.push({ rank, field, before: x, after: y });
    }
  }

  return { changes, counts, same: changes.length === 0 };
}

/**
 * 批量重解析。
 * @param {import('./store.js').RawStore} store
 * @param {{write?: boolean, limit?: number, logger?: object}} opts
 */
export function reparseAll(store, { write = false, limit = 0, logger } = {}) {
  const ids = store.ids();
  const todo = limit > 0 ? ids.slice(0, limit) : ids;
  const summary = {
    scanned: 0,
    parsed: 0,
    unparsable: 0,
    changed: 0,
    written: 0,
    counts: { title: 0, url: 0, cover: 0, added: 0, removed: 0 },
    changedIds: [],
    problems: []
  };

  for (const id of todo) {
    summary.scanned++;
    let record;
    try {
      record = store.read(id);
    } catch (err) {
      summary.unparsable++;
      summary.problems.push({ id, reason: '读取失败：' + err.message });
      continue;
    }
    if (!record) {
      summary.unparsable++;
      summary.problems.push({ id, reason: '文件内容为空' });
      continue;
    }

    const res = reparseRecord(record);
    if (!res.ok) {
      summary.unparsable++;
      summary.problems.push({ id, reason: res.reason });
      logger?.debug('重解析失败 ' + id + '：' + res.reason);
      continue;
    }
    summary.parsed++;
    if (res.diff.same) continue;

    summary.changed++;
    summary.changedIds.push(id);
    for (const key of Object.keys(summary.counts)) summary.counts[key] += res.diff.counts[key];

    if (write) {
      const missing = missingRanks(res.entries);
      store.write({
        ...record,
        entries: res.entries,
        missing,
        complete: missing.length === 0,
        reparsedAt: new Date().toISOString()
      });
      summary.written++;
    }
  }

  return summary;
}
