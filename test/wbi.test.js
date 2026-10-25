import test from 'node:test';
import assert from 'node:assert/strict';
import { signQuery, mixinKeyFromUrls } from '../src/bili/wbi.js';

test('mixinKeyFromUrls 还原出与官方一致的 mixin key', () => {
  const key = mixinKeyFromUrls(
    'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
    'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png'
  );
  assert.equal(key, 'ea1db124af3c7062474693fa704f4ff8');
});

test('signQuery 参数排序 + 编码 + md5 结果稳定', () => {
  const q = signQuery({ b: '中文', a: '1' }, 'ea1db124af3c7062474693fa704f4ff8', { wts: 1700000000 });
  assert.equal(q, 'a=1&b=%E4%B8%AD%E6%96%87&wts=1700000000&w_rid=37f63ebe90e444afc2b2b72942dff471');
});

test('signQuery 过滤 !\'()* 字符', () => {
  const q = signQuery({ q: "a!b'c(d)e*f" }, 'k', { wts: 1 });
  assert.ok(q.startsWith('q=abcdef&'));
});
