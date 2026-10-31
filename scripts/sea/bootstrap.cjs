'use strict';
/*
 * 打进 exe 里的入口（Node SEA）。它只做三件事：
 *   1. 把 exe 自带的 payload 解到 %LOCALAPPDATA%\术力口周榜\；
 *   2. chdir 过去（这样 src/config.js 算出来的 ROOT 就是那个目录，data/ 留在那里）；
 *   3. 把 src/cli.js 当成 ESM 跑起来。
 *
 * 应用源码一行都不为它改动 —— 解出来的目录就是一个普通的项目根目录。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const { pathToFileURL } = require('node:url');
const sea = require('node:sea');

let BUILD;
try { BUILD = JSON.parse(sea.getAsset('build.json', 'utf8')); }
catch { BUILD = { id: 'dev', name: '术力口周榜', version: '0' }; }

const BASE = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const ROOT = path.join(BASE, BUILD.name);
const STAMP = path.join(ROOT, '.build');

function readStr(buf, off, len) {
  return buf.toString('utf8', off, off + len).replace(/\0.*$/s, '');
}

function safeJoin(rel) {
  const parts = rel.split('/').filter((x) => x && x !== '.' && x !== '..');
  return path.join(ROOT, ...parts);
}

/** 最小 tar 解包：只认普通文件与目录，够我们自己打出来的包用 */
function untar(buf) {
  const out = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const hdr = buf.subarray(off, off + 512);
    if (hdr[0] === 0) break;
    const name = readStr(hdr, 0, 100);
    const size = parseInt(readStr(hdr, 124, 12).trim() || '0', 8);
    const flag = String.fromCharCode(hdr[156] || 48);
    const prefix = readStr(hdr, 345, 155);
    const full = prefix ? prefix + '/' + name : name;
    const start = off + 512;
    out.push({ name: full, dir: flag === '5', data: buf.subarray(start, start + size) });
    off = start + Math.ceil(size / 512) * 512;
  }
  return out;
}

function writeEntries(entries, keep) {
  if (!keep) fs.rmSync(path.join(ROOT, 'src'), { recursive: true, force: true });
  for (const e of entries) {
    const target = safeJoin(e.name);
    if (e.dir) { fs.mkdirSync(target, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, e.data);
  }
}

function prepare() {
  const need = (p) => !fs.existsSync(path.join(ROOT, p));
  const stamp = fs.existsSync(STAMP) ? fs.readFileSync(STAMP, 'utf8').trim() : '';
  const fresh = stamp !== BUILD.id;
  const cold = need('data/boards') || need('src/cli.js');
  if (!fresh && !cold) return;

  process.stdout.write('首次启动，正在解包（约 30MB，只需一次）…');
  // getAsset 的第二个参数是 TextDecoder 的编码名，二进制就直接不传（拿到 ArrayBuffer）
  const tar = zlib.gunzipSync(Buffer.from(sea.getAsset('payload.tgz')));
  const entries = untar(tar);

  // 代码每次换构建都重建（旧文件不该残留）；data / config 只补缺的，绝不覆盖用户的数据
  writeEntries(entries.filter((e) => e.name.startsWith('src/') || e.name === 'package.json' || e.name === 'README.md'), false);
  writeEntries(entries.filter((e) => e.name.startsWith('config/')), true);
  const dataEntries = entries.filter((e) => e.name.startsWith('data/'));
  if (need('data/boards')) writeEntries(dataEntries, true);
  fs.writeFileSync(STAMP, BUILD.id);
  process.stdout.write(' 完成\n');
}

function boot() {
  prepare();
  process.chdir(ROOT);
  const entry = path.join(ROOT, 'src', 'cli.js');
  const args = process.argv.slice(2);
  // 双击打开时没有参数：起服务并开浏览器（有参数就原样透传，行为与命令行一致）
  const argv = args.length ? args : ['serve', '--open'];
  process.argv = [process.execPath, entry, ...argv];
  console.log('数据目录：' + ROOT);
  return import(pathToFileURL(entry).href);
}

boot().catch((err) => {
  console.error('');
  console.error('[启动失败] ' + ((err && err.stack) || err));
  process.exitCode = 1;
  if (process.stdin.isTTY) {
    console.error('按回车退出…');
    process.stdin.resume();
    process.stdin.once('data', () => process.exit(1));
  }
});
