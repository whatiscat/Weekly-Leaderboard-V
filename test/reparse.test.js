import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { diffEntries, reparseRecord, reparseAll } from '../src/crawler/reparse.js';
import { RawStore } from '../src/crawler/store.js';

const paragraphs = [
  { para_type: 1, text: { nodes: [{ word: { words: '第 1 名 - ' } }, { rich: { text: '向修女忏悔吧', jump_url: 'https://www.bilibili.com/video/BV1rjJq6REW9' } }] } },
  { para_type: 2, pic: { pics: [{ url: '//i0.hdslb.com/bfs/x1.jpg' }] } }
];

const articleHtml = '<h1>第 1 名 - <a href="https://www.bilibili.com/video/BV1rjJq6REW9/">向修女忏悔吧</a></h1>'
  + '<figure><img src="//i0.hdslb.com/bfs/x1.jpg"></figure>';

test('reparseRecord：opus 段落 payload 能重算', () => {
  const record = { id: '1', payload: { kind: 'paragraphs', data: paragraphs }, entries: [] };
  const res = reparseRecord(record);
  assert.equal(res.ok, true);
  assert.equal(res.entries.length, 1);
  assert.equal(res.entries[0].title, '向修女忏悔吧');
  assert.equal(res.diff.counts.added, 1); // 旧结果是空的 → 全部算新增
});

test('reparseRecord：html payload 走专栏解析', () => {
  const res = reparseRecord({ id: '2', payload: { kind: 'html', data: articleHtml }, entries: [] });
  assert.equal(res.ok, true);
  assert.equal(res.entries[0].url, 'https://www.bilibili.com/video/BV1rjJq6REW9/');
});

test('reparseRecord：没有原文 / 未知类型 / 原文解析不出条目，都要说清原因', () => {
  assert.equal(reparseRecord({ id: '3', entries: [] }).ok, false);
  assert.match(reparseRecord({ id: '3', entries: [] }).reason, /没有保留原文/);
  assert.match(reparseRecord({ payload: { kind: 'weird', data: {} } }).reason, /未知的 payload.kind/);
  assert.match(reparseRecord({ payload: { kind: 'html', data: '<p>没有榜单</p>' } }).reason, /没有解析出任何条目/);
});

test('diffEntries：只报告真的变了的字段', () => {
  const before = [{ rank: 1, title: '旧名', url: 'u1', cover: 'c1' }];
  const after = [
    { rank: 1, title: '新名', url: 'u1', cover: 'c1' },
    { rank: 2, title: '新增', url: 'u2', cover: '' }
  ];
  const diff = diffEntries(before, after);
  assert.equal(diff.same, false);
  assert.equal(diff.counts.title, 1);
  assert.equal(diff.counts.url, 0);
  assert.equal(diff.counts.cover, 0);
  assert.equal(diff.counts.added, 1);
  assert.deepEqual(diff.changes.map((c) => c.rank + ':' + c.field), ['1:title', '2:added']);

  assert.equal(diffEntries(before, before).same, true);
});

test('reparseAll：默认只报告，--write 才落盘', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bbw-reparse-'));
  try {
    const store = new RawStore(dir);
    // 故意写一份"旧解析结果"：曲名与当前解析器不一致
    store.write({
      id: '1001',
      payload: { kind: 'paragraphs', data: paragraphs },
      entries: [{ rank: 1, title: '旧曲名', url: '', cover: '' }],
      complete: false
    });
    // 没有原文的老记录：应计入 unparsable，而不是崩掉
    store.write({ id: '1002', entries: [{ rank: 1, title: '迁移数据', url: '', cover: '' }] });

    const dry = reparseAll(store);
    assert.equal(dry.scanned, 2);
    assert.equal(dry.parsed, 1);
    assert.equal(dry.unparsable, 1);
    assert.equal(dry.changed, 1);
    assert.equal(dry.written, 0);
    // 默认不写：磁盘上仍是旧曲名
    assert.equal(store.read('1001').entries[0].title, '旧曲名');

    const wet = reparseAll(store, { write: true });
    assert.equal(wet.written, 1);
    const updated = store.read('1001');
    assert.equal(updated.entries[0].title, '向修女忏悔吧');
    assert.equal(updated.complete, false); // 只解析到 1 条，缺 19 名
    assert.deepEqual(updated.missing.length, 19);
    assert.ok(updated.reparsedAt);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
