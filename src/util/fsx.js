import fs from 'node:fs';
import path from 'node:path';

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

export function writeJson(file, value, { pretty = true } = {}) {
  writeText(file, JSON.stringify(value, null, pretty ? 2 : 0) + '\n');
}

export function writeText(file, text) {
  ensureDir(path.dirname(file));
  const tmp = file + '.tmp';
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch (err) {
    // Windows 上目标文件被服务/浏览器占用时 rename 会 EPERM，退化为直接覆盖
    if (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES') {
      fs.writeFileSync(file, text);
      try { fs.rmSync(tmp, { force: true }); } catch {}
      return;
    }
    throw err;
  }
}

export function exists(file) {
  return fs.existsSync(file);
}

export function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
}

export function sizeOf(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}
