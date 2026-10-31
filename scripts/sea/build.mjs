#!/usr/bin/env node
/*
 * 把整个项目打成一个自带 Node 的 exe（Node SEA）。
 *
 * 产物：dist/术力口周榜.exe —— 双击即用，目标机器不需要装 Node。
 * 它不含第三方依赖，也不改一行应用源码：
 *   exe = node.exe + 一段引导代码 + 项目源码/数据（tar.gz）
 *   ＜运行＞时引导代码把 payload 解到 %LOCALAPPDATA%\术力口周榜\，再按普通项目跑起来。
 *
 * 为什么不用 pkg / nexe：本项目坚持零第三方依赖，而这两个都要装包。
 * 为什么不用 postject：它只是往 PE 资源里写一段字节，PowerShell 调 Win32 就够（见 seal.ps1）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { ROOT } from '../../src/config.js';

const NAME = '术力口周榜';
const WORK = path.join(ROOT, 'dist', 'sea');
const PAYLOAD = path.join(WORK, 'payload');

const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2:0';

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

/* ---------- 最小 tar 写入（ustar） ---------- */
function tarHeader(name, size, isDir) {
  const h = Buffer.alloc(512);
  const put = (str, off, len) => h.write(str, off, Math.min(len, Buffer.byteLength(str)), 'utf8');
  put(name, 0, 100);
  put('0000644\0', 100, 8);
  put('0000000\0', 108, 8);
  put('0000000\0', 116, 8);
  put(size.toString(8).padStart(11, '0') + '\0', 124, 12);
  put(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136, 12);
  put('        ', 148, 8);
  put(isDir ? '5' : '0', 156, 1);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  let sum = 0;
  for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return h;
}

function walkTar(dir, base = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? base + '/' + entry.name : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push({ name: rel + '/', dir: true });
      out.push(...walkTar(full, rel));
    } else {
      out.push({ name: rel, data: fs.readFileSync(full) });
    }
  }
  return out;
}

function makeTar(entries) {
  const chunks = [];
  for (const e of entries) {
    if (e.dir) { chunks.push(tarHeader(e.name, 0, true)); continue; }
    chunks.push(tarHeader(e.name, e.data.length, false));
    chunks.push(e.data);
    const pad = 512 - (e.data.length % 512);
    if (pad < 512) chunks.push(Buffer.alloc(pad));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

/* ---------- 打包 ---------- */
async function main() {
  const started = Date.now();
  rm(WORK);
  fs.mkdirSync(PAYLOAD, { recursive: true });

  // 1) 组装 payload：程序 + 配置 + 数据快照（不含 dist / devtools / logs / node_modules）
  for (const item of ['src', 'config', 'data', 'package.json', 'README.md']) copy(item, path.join(PAYLOAD, item));
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const entries = walkTar(PAYLOAD);
  const tar = makeTar(entries);
  const gz = zlib.gzipSync(tar, { level: 9 });
  fs.writeFileSync(path.join(WORK, 'payload.tgz'), gz);
  console.log('payload：' + entries.length + ' 项 → ' + (gz.length / 1024 / 1024).toFixed(2) + ' MB（原 ' + (tar.length / 1024 / 1024).toFixed(1) + ' MB）');

  // 2) 构建 id 用 payload 的哈希：内容一样就不重新解包
  const id = crypto.createHash('sha256').update(gz).digest('hex').slice(0, 12);
  fs.writeFileSync(path.join(WORK, 'build.json'), JSON.stringify({ id, name: NAME, version }, null, 2));

  // 3) 生成 SEA blob
  fs.writeFileSync(path.join(WORK, 'sea-config.json'), JSON.stringify({
    main: path.join(ROOT, 'scripts', 'sea', 'bootstrap.cjs'),
    output: path.join(WORK, 'sea-prep.blob'),
    disableExperimentalSEAWarning: true,
    assets: {
      'payload.tgz': path.join(WORK, 'payload.tgz'),
      'build.json': path.join(WORK, 'build.json')
    }
  }, null, 2));
  const prep = spawnSync(process.execPath, ['--experimental-sea-config', path.join(WORK, 'sea-config.json')], { encoding: 'utf8' });
  if (prep.status !== 0) { console.error(prep.stderr || prep.stdout); throw new Error('SEA blob 生成失败'); }

  // 4) 复制 node.exe，拨保险丝，注入 blob
  const exe = path.join(ROOT, 'dist', NAME + '.exe');
  fs.copyFileSync(process.execPath, exe);
  const buf = fs.readFileSync(exe);
  const at = buf.indexOf(Buffer.from(FUSE, 'latin1'));
  if (at < 0) throw new Error('找不到 SEA 保险丝，这个 node.exe 不支持单文件应用');
  buf[at + FUSE.length - 1] = 0x31;
  fs.writeFileSync(exe, buf);

  const ps = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'scripts', 'sea', 'seal.ps1'), '-Exe', exe, '-Blob', path.join(WORK, 'sea-prep.blob')], { encoding: 'utf8' });
  if (ps.status !== 0) { console.error((ps.stdout || '') + (ps.stderr || '')); throw new Error('注入失败'); }
  console.log(ps.stdout.trim());

  const size = fs.statSync(exe).size / 1024 / 1024;
  console.log('');
  console.log('已生成：dist/' + NAME + '.exe（' + size.toFixed(1) + ' MB · ' + ((Date.now() - started) / 1000).toFixed(1) + 's）');
  console.log('双击即用，目标机器不需要装 Node；数据目录 %LOCALAPPDATA%\\' + NAME + '\\');
}

main().catch((err) => { console.error('[package:exe] ' + (err?.stack || err)); process.exit(1); });
