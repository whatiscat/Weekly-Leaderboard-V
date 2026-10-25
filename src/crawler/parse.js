import { cleanTitle, normalizeUrl } from '../util/text.js';

/** 从任意文本中截取配对的 JSON 数组 / 对象（跳过字符串内的括号） */
export function sliceBalanced(text, start, open = '[', close = ']') {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

const RANK_RE = /^第\s*(\d+)\s*名\s*-\s*([\s\S]*)$/;

function textOfNodes(nodes = []) {
  return nodes.map((n) => n?.word?.words ?? n?.rich?.text ?? '').join('');
}

/** opus / 专栏段落结构 → 榜单条目 */
export function parseParagraphs(paragraphs = []) {
  const entries = [];
  for (const p of paragraphs) {
    if (p?.para_type === 1 && p.text?.nodes) {
      const text = textOfNodes(p.text.nodes);
      const m = text.match(RANK_RE);
      if (m) {
        const rich = p.text.nodes.find((n) => n.rich);
        entries.push({
          rank: Number(m[1]),
          title: cleanTitle(m[2] || rich?.rich?.text || ''),
          url: normalizeUrl(rich?.rich?.jump_url || ''),
          cover: ''
        });
        continue;
      }
    }
    if (p?.para_type === 2 && p.pic?.pics?.length && entries.length && !entries[entries.length - 1].cover) {
      entries[entries.length - 1].cover = normalizeUrl(p.pic.pics[0].url);
    }
  }
  return finalize(entries);
}

/** 专栏正文 HTML（x/article/view 的 content 或 SSR 渲染后的 h1 结构）→ 榜单条目 */
export function parseArticleHtml(html = '') {
  const entries = [];
  const h1 = /<h1[^>]*>\s*第\s*(\d+)\s*名\s*-\s*([\s\S]*?)<\/h1>/g;
  const marks = [];
  let m;
  while ((m = h1.exec(html))) marks.push({ rank: Number(m[1]), body: m[2], start: m.index });
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].start : html.length;
    const seg = html.slice(marks[i].start, end);
    const a = seg.match(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
    const img = seg.match(/<img[^>]*src="([^"]*)"/);
    let title = cleanTitle(marks[i].body);
    let url = '';
    if (a) {
      title = cleanTitle(a[2]) || title;
      url = normalizeUrl(a[1]);
    }
    entries.push({ rank: marks[i].rank, title, url, cover: img ? normalizeUrl(img[1]) : '' });
  }
  return finalize(entries);
}

/** 从 SSR 页面里取出内嵌的 paragraphs 数组 */
export function extractParagraphsFromHtml(html = '') {
  const key = '"module_content":{"paragraphs":[';
  const idx = html.indexOf(key);
  if (idx < 0) return null;
  const start = html.indexOf('[', idx);
  const raw = sliceBalanced(html, start, '[', ']');
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function parseSsrArticle(html = '') {
  const paragraphs = extractParagraphsFromHtml(html);
  if (!paragraphs) return null;
  const entries = parseParagraphs(paragraphs);
  return entries.length ? entries : null;
}

/** opus/detail 返回的 item → 元信息 + 条目 */
export function parseOpusItem(item) {
  if (!item) return null;
  const mods = item.modules || [];
  const author = mods.find((m) => m.module_type === 'MODULE_TYPE_AUTHOR')?.module_author || {};
  const content = mods.find((m) => m.module_type === 'MODULE_TYPE_CONTENT')?.module_content;
  const paragraphs = content?.paragraphs || null;
  const entries = paragraphs ? parseParagraphs(paragraphs) : [];
  return {
    id: item.id_str || String(item.id || ''),
    type: item.type || '',
    title: author.pub_time || '',
    pubTime: author.pub_time || '',
    pubTs: Number(author.pub_ts || 0),
    paragraphs,
    entries
  };
}

/** 排序 + 去重（同名义曲目保留各自条目）+ 补齐 cover */
function finalize(entries) {
  const seen = new Set();
  const out = [];
  for (const e of entries.slice().sort((a, b) => a.rank - b.rank)) {
    if (!e.title || seen.has(e.rank)) continue;
    seen.add(e.rank);
    out.push(e);
  }
  return out;
}

export function missingRanks(entries, max = 20) {
  const have = new Set(entries.map((e) => e.rank));
  const miss = [];
  for (let r = 1; r <= max; r++) if (!have.has(r)) miss.push(r);
  return miss;
}
