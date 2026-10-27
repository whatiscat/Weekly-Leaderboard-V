import fs from 'node:fs';
import path from 'node:path';

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 读 JSON。文件不存在返回 fallback；**语法错误必须抛出，而且要说清是哪个文件**。
 *
 * 默认的 JSON.parse 报错只有 "Unexpected token } in JSON at position 12345"——
 * 在 data/boards/songs.json（4MB）这种文件上等于什么都没说。这里把路径、字节数、
 * 出错位置附近的一小段原文一起带上，坏文件能直接定位。
 */
export function readJson(file, fallback = null) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    const m = /position (\d+)/.exec(err.message);
    const at = m ? Number(m[1]) : -1;
    const around = at >= 0
      ? text.slice(Math.max(0, at - 40), at + 40).replace(/\n/g, '⏎')
      : text.slice(0, 80).replace(/\n/g, '⏎');
    throw new Error(
      'JSON 解析失败：' + file + '（' + Buffer.byteLength(text) + ' 字节，位置 ' + at + '）\n' +
      '  ' + err.message + '\n' +
      '  附近内容：…' + around + '…\n' +
      '  修复方式：重新运行 node src/cli.js sync --full（曲目库），或从备份恢复该文件。'
    );
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
