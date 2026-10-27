import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJson, writeJson } from '../src/util/fsx.js';

test('readJson：文件不存在返回 fallback', () => {
  assert.deepEqual(readJson(path.join(os.tmpdir(), 'bbw-not-exists-' + Date.now() + '.json'), {}), {});
});

test('readJson：坏 JSON 必须报出文件名与位置', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bbw-fsx-'));
  try {
    const file = path.join(dir, 'songs.json');
    fs.writeFileSync(file, '{"a":1,}');
    assert.throws(() => readJson(file), (err) => {
      assert.ok(err.message.includes(file), '错误信息里应有完整路径');
      assert.ok(err.message.includes('JSON 解析失败'));
      assert.ok(/位置 \d+/.test(err.message));
      return true;
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeJson：自动建目录，并能原样读回', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bbw-fsx2-'));
  try {
    const file = path.join(dir, 'deep', 'nested', 'x.json');
    writeJson(file, { hello: '世界' });
    assert.deepEqual(readJson(file), { hello: '世界' });
    // 不留 .tmp 残骸
    assert.equal(fs.existsSync(file + '.tmp'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
