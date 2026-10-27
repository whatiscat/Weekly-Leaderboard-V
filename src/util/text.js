const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(input) {
  return String(input).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, code) => {
    if (code[0] === '#') {
      const hex = code[1] === 'x' || code[1] === 'X';
      const num = parseInt(code.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(num) ? String.fromCodePoint(num) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

export function stripTags(html) {
  return String(html).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '');
}

export function cleanTitle(input) {
  return decodeEntities(stripTags(input || ''))
    .replace(/[\u200b-\u200f\u202a-\u202e\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeUrl(url) {
  let u = String(url || '').trim().replace(/\\\//g, '/');
  if (!u) return '';
  if (u.startsWith('//')) u = 'https:' + u;
  if (u.startsWith('http://')) u = 'https://' + u.slice(7);
  return u;
}

export function bvOf(url) {
  const m = String(url || '').match(/BV[0-9A-Za-z]{10}/);
  return m ? m[0] : '';
}

const RE_ISSUE = /第\s*(\d+)\s*期/;
const RE_DATE = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/;
const RE_WEEK = /第\s*(\d+)\s*周/;

/**
 * 从帖子标题解析期号 / 日期 / 周次 / 系列
 * 例：Bili_Board术力口周榜第124期2026年10月21日第42周
 */
export function parseTitle(title) {
  const text = String(title || '');
  const issue = RE_ISSUE.exec(text);
  const date = RE_DATE.exec(text);
  const week = RE_WEEK.exec(text);
  return {
    issue: issue ? Number(issue[1]) : null,
    date: date ? date[1] + '-' + String(date[2]).padStart(2, '0') + '-' + String(date[3]).padStart(2, '0') : null,
    week: week ? Number(week[1]) : null,
    series: text.includes('传说曲') ? 'legend' : 'main'
  };
}

/** 标题是否为一期正式榜单（排除招聘、说明、致歉等帖子） */
export function isChartPost(title) {
  const t = String(title || '').trim();
  return RE_ISSUE.test(t) && (t.startsWith('Bili') || t.startsWith('周榜'));
}

export function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}
