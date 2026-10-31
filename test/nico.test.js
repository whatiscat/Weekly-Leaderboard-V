import test from 'node:test';
import assert from 'node:assert/strict';
import { API } from '../src/bili/endpoints.js';
import { av2bv, bv2av } from '../src/util/av.js';
import { entriesFromBlocks, fetchNicoPost, splitTitleProducer } from '../src/crawler/nico.js';
import { buildNico } from '../src/model/nico.js';

function word(text) {
  return { para_type: 1, text: { nodes: [{ word: { words: text } }] } };
}
function card(oid) {
  return { para_type: 6, link_card: { card: { oid: String(oid) } } };
}

test('av / BV 互转：与官方编码一致，且能转回去', () => {
  assert.equal(av2bv(2386), 'BV1xx411c75e');
  assert.equal(av2bv(170001), 'BV17x411w7KC');
  assert.equal(av2bv(117410497566240), 'BV1ZRpb6qE8x');
  for (const aid of [2386, 1437042, 170001, 28356844, 117410497566240]) {
    assert.equal(bv2av(av2bv(aid)), aid);
  }
  assert.equal(av2bv(0), '');
  assert.equal(av2bv('abc'), '');
  assert.equal(bv2av('nope'), 0);
});

test('曲名 / P 主按最后一个斜杠拆开', () => {
  assert.deepEqual(splitTitleProducer('モニタリング/DECO*27'), { title: 'モニタリング', producer: 'DECO*27' });
  assert.deepEqual(splitTitleProducer('ご主人様、ロックのお時間にございます/Neru'), { title: 'ご主人様、ロックのお時間にございます', producer: 'Neru' });
  // 没有斜杠 / 斜杠在末尾：整段当曲名，不要吞掉字符
  assert.deepEqual(splitTitleProducer('惑星直列'), { title: '惑星直列', producer: '' });
  assert.deepEqual(splitTitleProducer('A/'), { title: 'A/', producer: '' });
});

test('opus 段落：名次行 → 元信息行 → 视频卡片，引导卡片不挂到条目上', () => {
  const vcard = (aid, bvid, cover) => ({ text: '', card: { aid, bvid: bvid || '', cover: cover || '' } });
  const line = (text) => ({ text, card: null });
  const blocks = [
    line('本期统计时段为2026/10/12-2026/10/18，本期视频版可点下方链接查看。'),
    line('上期（第189期）可点下方链接查看。'),
    vcard('117477774461445'),          // 引导卡片：不能被挂到任何条目上
    line('第2位 モニタリング/DECO*27'),
    line('上周： 3     在榜周数：80'),
    vcard('113474931986942'),
    line('第1位 惑星直列/いよわ'),
    line('上周： —（NEW!）   在榜周数：1'),
    // SSR 页的卡片带 bvid 与封面：直接用，不用再算 / 再请求
    vcard('117410497566240', 'BV1ZRpb6qE8x', 'https://i0.hdslb.com/bfs/archive/x.jpg')
  ];
  const entries = entriesFromBlocks(blocks);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].rank, 1);
  assert.equal(entries[0].title, '惑星直列');
  assert.equal(entries[0].lastRank, null);
  assert.equal(entries[0].weeks, 1);
  assert.equal(entries[0].bvid, 'BV1ZRpb6qE8x');
  assert.equal(entries[1].rank, 2);
  assert.equal(entries[1].lastRank, 3);
  assert.equal(entries[1].weeks, 80);
  assert.equal(entries[0].cover, 'https://i0.hdslb.com/bfs/archive/x.jpg');
  // 引导卡片（第 3 个块）不能被挂到任何条目上
  assert.equal(entries[1].aid, '113474931986942');
});

test('同一条目重复出现时以第一次为准，不产生重复名次', () => {
  const entries = entriesFromBlocks([
    { text: '第1位 A/P', card: null }, { text: '上周： 2  在榜周数：5', card: null },
    { text: '第1位 A/P（重复排版）', card: null }, { text: '上周： 2  在榜周数：5', card: null }
  ]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].title, 'A');
});

test('fetchNicoPost：opus 帖解析出条目 / 期号 / 统计时段', async () => {
  const client = {
    // 没有 SSR 页面（返回空 HTML）：走到 opusDetail 接口这条路
    async html() { return ''; },
    async api(url) {
      if (url === API.opusDetail) {
        return { data: { item: { modules: [{ module_type: 'MODULE_TYPE_CONTENT', module_content: { paragraphs: [
          word('本期统计时段为2026/10/12-2026/10/18，本期视频版可点下方链接查看。'),
          word('上期（第189期）可点下方链接查看。'),
          card('117477774461445'),
          word('第1位 惑星直列/いよわ'),
          word('上周： —（NEW!）   在榜周数：1'),
          card('117410497566240')
        ] } }] } } };
      }
      return {};
    }
  };
  const record = await fetchNicoPost(client, { id: '1', title: '【2026/10/21】ニコニコ VOCALOID SONGS TOP20', date: '2026-10-21', issue: null });
  assert.equal(record.source, 'opus');
  assert.equal(record.issue, 190);
  assert.deepEqual(record.period, { from: '2026/10/12', to: '2026/10/18' });
  assert.equal(record.entries.length, 1);
  assert.equal(record.entries[0].bvid, 'BV1ZRpb6qE8x');
  // 只有 1 条：缺第 2–20 名，如实标记，不要假装完整
  assert.equal(record.complete, false);
  assert.equal(record.missing.length, 19);
});

test('fetchNicoPost：老帖是专栏文章，走 cv → 正文 HTML 这条降级路径', async () => {
  const html = '<p><span class="font-size-20">第1位 ラヴィ(Lavie)/すりぃ</span></p>'
    + '<p><span>上周：3   在榜周数：4</span></p>'
    + '<figure><img src="//i0.hdslb.com/x.jpg" aid="219595806" class="video-card"></figure>';
  const client = {
    async html() { return ''; },
    async api(url) {
      if (url === API.opusDetail) return {};
      if (url === API.dynamicDetail) {
        return { data: { item: { type: 'DYNAMIC_TYPE_ARTICLE', basic: { rid_str: '21395877' }, modules: { module_dynamic: { major: { article: { id: 21395877, title: '【2022/12/28 第4期】Billboard JAPAN「NICONICO VOCALOID歌曲TOP20」' } } } } } } };
      }
      if (url === API.articleView) return { data: { content: html, title: '【2022/12/28 第4期】…' } };
      return {};
    }
  };
  const record = await fetchNicoPost(client, { id: '2', title: '【2022/12/28 第4期】…', date: '2022-12-28', issue: 4 });
  assert.equal(record.source, 'article');
  assert.equal(record.cv, 21395877);
  assert.equal(record.issue, 4);
  assert.equal(record.entries.length, 1);
  assert.equal(record.entries[0].title, 'ラヴィ(Lavie)');
  assert.equal(record.entries[0].producer, 'すりぃ');
  assert.equal(record.entries[0].lastRank, 3);
  assert.equal(record.entries[0].aid, '219595806');
});

test('fetchNicoPost：opus 页面优先，UGC 卡片也能取出 bvid 与封面', async () => {
  // 正文里混着两种卡片：eva3_video（有 info）与 ugc（id_str + jump_url + cover）
  const paras = [];
  for (let r = 15; r >= 1; r--) {
    paras.push({ para_type: 1, text: { nodes: [{ word: { words: '第' + r + '位 曲' + r + '/P' + r } }] } });
    paras.push({ para_type: 1, text: { nodes: [{ word: { words: '上周： ' + (r === 1 ? '—' : '3') + '   在榜周数：' + r } }] } });
    if (r === 1) {
      paras.push({ para_type: 6, link_card: { card: { type: 'LINK_CARD_TYPE_UGC', oid: '115614362372418', ugc: { id_str: '115614362372418', jump_url: '//www.bilibili.com/video/BV1dBUhBqE1x', cover: 'http://i1.hdslb.com/bfs/archive/x.jpg' } } } });
    } else {
      paras.push({ para_type: 6, link_card: { card: { type: 'LINK_CARD_TYPE_EVA3_VIDEO', eva3_video: { info: { avid: String(1000 + r), bvid: 'BV1xx411c7' + (r < 10 ? '0' + r : r), cover: 'http://i0.hdslb.com/bfs/archive/y' + r + '.jpg' } } } } });
    }
  }
  const page = '{"module_content":{"paragraphs":' + JSON.stringify(paras) + '}}';
  const client = {
    async html() { return '<html>' + page + '</html>'; },
    async api() { throw new Error('不该走接口：页面上已经有完整正文'); }
  };
  const record = await fetchNicoPost(client, { id: '3', title: '【2026/10/21】…', date: '2026-10-21', issue: 190 });

  assert.equal(record.source, 'opus-ssr');
  assert.equal(record.entries.length, 15);
  const top = record.entries.find((e) => e.rank === 1);
  assert.equal(top.bvid, 'BV1dBUhBqE1x');   // 来自 UGC 卡片的 jump_url
  assert.equal(top.cover, 'https://i1.hdslb.com/bfs/archive/x.jpg');
  assert.equal(top.lastRank, null);
  assert.equal(top.weeks, 1);
  const second = record.entries.find((e) => e.rank === 2);
  assert.equal(second.aid, '1002');
  // 封面顺手带回去，之后并进 covers.json —— 不用再逐个问稿件接口
  assert.ok(record.covers.some((c) => c.bvid === 'BV1dBUhBqE1x'));
});

test('buildNico：按日期排序、去重、补期号，曲目身份是曲名', () => {
  const rec = (date, issue, entries) => ({ id: date, date, issue, cv: 0, entries, complete: true, missing: [], postUrl: '' });
  const entry = (rank, title, producer) => ({ rank, title, producer, bvid: 'BV' + rank, lastRank: null, weeks: 1 });
  const ds = buildNico([
    rec('2026-10-14', null, [entry(1, 'B', 'P2'), entry(2, 'A', 'P1')]),
    rec('2026-10-21', 190, [entry(1, 'A', 'P1')]),
    rec('2026-10-14', null, [entry(1, 'B', 'P2'), entry(2, 'A', 'P1'), entry(3, 'C', 'P3')]),
    rec('2026-11-01', null, [])
  ], null);

  // 同一天两条：留条目更全的那条；空条目那条整条丢掉
  assert.equal(ds.issues.length, 2);
  assert.deepEqual(ds.issues.map((x) => x.date), ['2026-10-14', '2026-10-21']);
  assert.equal(ds.issues[0].count, 3);

  // 缺期号时按「相邻期号 ± 相隔周数」反推：10-14 比 10-21 早一周，就是第 189 期
  assert.equal(ds.issues[0].issue, 189);
  assert.equal(ds.issues[1].issue, 190);

  assert.equal(ds.issues[0].entries[0].rank, 1);
  assert.equal(ds.issues[0].entries[0].songId, 'B');
  assert.deepEqual(ds.meta.account, null);
  assert.equal(ds.meta.issues, 2);
  assert.equal(ds.meta.entries, 4);
});
