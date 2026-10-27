import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldRetry, RETRY_AFTER_DAYS } from '../src/biliboard/covers.js';

test('封面失败退避：冷却期内不再请求，过期后自动重试', () => {
  const now = Date.parse('2026-10-27T00:00:00Z');
  assert.equal(RETRY_AFTER_DAYS, 7);

  // 没失败过 / 时间坏了：都当作可以试
  assert.equal(shouldRetry(undefined, now), true);
  assert.equal(shouldRetry('', now), true);
  assert.equal(shouldRetry('not-a-date', now), true);

  // 昨天失败：还在冷却期
  assert.equal(shouldRetry('2026-10-26T00:00:00Z', now), false);
  // 正好 7 天：仍未过冷却（用 > 而不是 >=，边界行为写成测试钉住）
  assert.equal(shouldRetry('2026-10-20T00:00:00Z', now), false);
  // 8 天前：放行
  assert.equal(shouldRetry('2026-10-19T00:00:00Z', now), true);
});
