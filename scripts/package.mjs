#!/usr/bin/env node
/**
 * 打便携包：dist/<名称>/ + dist/<名称>.zip
 * 用法：node scripts/package.mjs [--no-zip]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT } from '../src/config.js';

process.on('uncaughtException', (e) => { console.error('[package] ' + (e && e.stack || e)); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('[package] ' + (e && e.stack || e)); process.exit(1); });

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const args = process.argv.slice(2);
const NAME = '术力口周榜-便携版';
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(DIST, NAME);

function rm(p) { fs.rmSync(p, { recursive: true, force: true }); }
function copy(from, to) {
  const src = path.join(ROOT, from);
  if (!fs.existsSync(src)) return;
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(src)) copy(path.join(from, name), path.join(to, name));
    return;
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(src, to);
}

rm(DIST);
fs.mkdirSync(OUT, { recursive: true });

// 程序与配置
for (const item of ['package.json', 'README.md']) copy(item, path.join(OUT, item));
copy('src', path.join(OUT, 'src'));
// ⚠️ 只白名单式地复制配置文件，不要 copy('config', ...)：
// config/local.json 是本机私货（端口、B 站 Cookie），整目录复制会把 Cookie 打进 zip 发出去。
copy('config/default.json', path.join(OUT, 'config/default.json'));
copy('config/local.example.json', path.join(OUT, 'config/local.example.json'));

// 数据（不含运行态）
copy('data/boards', path.join(OUT, 'data/boards'));
copy('data/raw', path.join(OUT, 'data/raw'));
copy('data/nico', path.join(OUT, 'data/nico'));
if (fs.existsSync(path.join(ROOT, 'data/covers.json'))) copy('data/covers.json', path.join(OUT, 'data/covers.json'));

// 计划任务脚本
copy('scripts/register-task.ps1', path.join(OUT, 'scripts/register-task.ps1'));
copy('scripts/serve-bg.ps1', path.join(OUT, 'scripts/serve-bg.ps1'));

// 启动器与说明
for (const f of ['启动.cmd', 'start.cmd', '更新数据.cmd', 'update.cmd', '说明.txt']) {
  copy(path.join('packaging', f), path.join(OUT, f));
}

// 便携版标记
fs.writeFileSync(path.join(OUT, '便携版.txt'), [
  '术力口周榜 - 便携版 ' + pkg.version,
  '打包时间：' + new Date().toLocaleString(),
  '',
  '双击「启动.cmd」开始使用。',
  ''
].join('\r\n'));

// 统计
function size(p) {
  let total = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const fp = path.join(p, e.name);
    total += e.isDirectory() ? size(fp) : fs.statSync(fp).size;
  }
  return total;
}
const bytes = size(OUT);
console.log('已生成目录：' + OUT + '（' + (bytes / 1024 / 1024).toFixed(1) + 'MB）');

if (!args.includes('--no-zip')) {
  const zip = path.join(DIST, NAME + '.zip');
  rm(zip);
  const ps = [
    'Add-Type -AssemblyName System.IO.Compression.FileSystem;',
    '$src=' + JSON.stringify(OUT) + ';',
    '$dst=' + JSON.stringify(zip) + ';',
    '[System.IO.Compression.ZipFile]::CreateFromDirectory($src,$dst,[System.IO.Compression.CompressionLevel]::Optimal,$true,[System.Text.Encoding]::UTF8);'
  ].join(' ');
  execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'inherit' });
  console.log('已打包：' + zip + '（' + (fs.statSync(zip).size / 1024 / 1024).toFixed(1) + 'MB）');
}
