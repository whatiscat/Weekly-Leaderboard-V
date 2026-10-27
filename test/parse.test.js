import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTitle, isChartPost, normalizeUrl, bvOf } from '../src/util/text.js';
import { parseParagraphs, parseArticleHtml, extractParagraphsFromHtml, missingRanks } from '../src/crawler/parse.js';

test('parseTitle 解析期号/日期/周次', () => {
  assert.deepEqual(parseTitle('Bili_Board术力口周榜第124期2026年10月21日第42周'), {
    issue: 124, date: '2026-10-21', week: 42, series: 'main'
  });
});

test('parseTitle 兼容缺日期的笔误与原帖系列名', () => {
  assert.deepEqual(parseTitle('Bili_Board术力口周榜第109期2026年7月日第27周'), {
    issue: 109, date: null, week: 27, series: 'main'
  });
  assert.equal(parseTitle('BiliBoard术力口传说曲周榜第14期2025年6月20日第14周').series, 'legend');
});

test('isChartPost 只认正式榜单帖', () => {
  assert.equal(isChartPost('Bili_Board术力口周榜第124期2026年10月21日第42周'), true);
  assert.equal(isChartPost('BiliBoard术力口传说曲周榜第18期2025年7月18日第18周'), true);
  assert.equal(isChartPost('周榜第95期2026年4月1日第13周'), true);
  assert.equal(isChartPost('视频更新预告'), false);
  assert.equal(isChartPost('关于最近盗搬视频行为的声明'), false);
  assert.equal(isChartPost('各位关注 Bili-Board_atel 的小伙伴：'), false);
});

test('normalizeUrl 统一协议', () => {
  assert.equal(normalizeUrl('//i0.hdslb.com/a.jpg'), 'https://i0.hdslb.com/a.jpg');
  assert.equal(normalizeUrl('http://i0.hdslb.com/a.jpg'), 'https://i0.hdslb.com/a.jpg');
  assert.equal(bvOf('https://www.bilibili.com/video/BV1rjJq6REW9'), 'BV1rjJq6REW9');
});

const paragraphs = [
  { para_type: 1, text: { nodes: [{ word: { words: '第 1 名 - ' } }, { rich: { text: '向修女忏悔吧', jump_url: 'https://www.bilibili.com/video/BV1rjJq6REW9' } }] } },
  { para_type: 2, pic: { pics: [{ url: 'http://i0.hdslb.com/bfs/x1.jpg' }] } },
  { para_type: 1, text: { nodes: [{ word: { words: '第 2 名 - ' } }, { rich: { text: '0好感度', jump_url: '//www.bilibili.com/video/BV1z4JX6PE5h' } }] } },
  { para_type: 2, pic: { pics: [{ url: '//i0.hdslb.com/bfs/x2.jpg' }] } }
];

test('parseParagraphs 提取名次/曲名/链接/封面', () => {
  const entries = parseParagraphs(paragraphs);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], {
    rank: 1, title: '向修女忏悔吧', url: 'https://www.bilibili.com/video/BV1rjJq6REW9', cover: 'https://i0.hdslb.com/bfs/x1.jpg'
  });
  assert.equal(entries[1].rank, 2);
});

test('parseArticleHtml 提取 h1 + a + img', () => {
  const html = '<h1 style="x">第 1 名 - <a href="https://www.bilibili.com/video/BV1rjJq6REW9/" target="_blank">向修女忏悔吧</a></h1>'
    + '<p><br></p><figure class="img-box"><img alt="" src="//i0.hdslb.com/bfs/archive/a.jpg"></figure>'
    + '<h1>第 2 名 - <a href="https://www.bilibili.com/video/BV1z4JX6PE5h/">0好感度</a></h1>'
    + '<figure><img src="//i0.hdslb.com/bfs/archive/b.jpg"></figure>';
  const entries = parseArticleHtml(html);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].title, '向修女忏悔吧');
  assert.equal(entries[0].cover, 'https://i0.hdslb.com/bfs/archive/a.jpg');
  assert.equal(entries[1].url, 'https://www.bilibili.com/video/BV1z4JX6PE5h/');
});

test('extractParagraphsFromHtml 能从 SSR 页里取出 JSON 数组', () => {
  const html = '<script>window.__INITIAL_STATE__={"a":1};</script>'
    + '"module_content":{"paragraphs":' + JSON.stringify(paragraphs) + '}';
  const got = extractParagraphsFromHtml(html);
  assert.equal(got.length, 4);
  assert.equal(missingRanks(parseParagraphs(got)).length, 18);
});
