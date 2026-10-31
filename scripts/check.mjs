#!/usr/bin/env node
/**
 * 零依赖自检：语法 + JSON 有效性。
 *
 * 为什么不用 ESLint：本项目坚持零第三方依赖（装不了 Node 的机器也要能跑）。
 * 这里覆盖两类最容易在提交前漏掉、又必然在运行时炸掉的问题：
 *   1. .js / .mjs 的语法错误（node --check，ESM 也认）
 *   2. 配置文件 / 数据索引的 JSON 语法错误（JSON.parse）
 *
 * 用法：npm run check
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'logs', 'devtools', 'data']);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, out);
      continue;
    }
    out.push(full);
  }
  return out;
}

const files = walk(ROOT);
// .cjs 也要查：打进单文件 exe 的引导代码就是 .cjs，它坏了 exe 一启动就崩
const scripts = files.filter((f) => /\.(js|mjs|cjs)$/.test(f));
const jsonFiles = files.filter((f) => f.endsWith('.json') && !f.includes(path.join('data', '')));

let failed = 0;
for (const file of scripts) {
  const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (res.status !== 0) {
    failed++;
    console.error('✗ ' + path.relative(ROOT, file));
    console.error((res.stderr || '').trim().split('\n').slice(0, 4).join('\n'));
  }
}
for (const file of jsonFiles) {
  try {
    JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    failed++;
    console.error('✗ ' + path.relative(ROOT, file) + '：' + err.message);
  }
}

console.log((failed ? '✗ ' : '✓ ') + '语法检查：' + scripts.length + ' 个脚本 / ' + jsonFiles.length + ' 个 JSON，' + (failed ? failed + ' 处失败' : '全部通过'));
process.exit(failed ? 1 : 0);
