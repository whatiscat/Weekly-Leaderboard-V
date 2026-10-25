import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from './util/fsx.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger({ level = 'info', file = null } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  let stream = null;
  if (file) {
    ensureDir(path.dirname(file));
    stream = fs.createWriteStream(file, { flags: 'a' });
  }

  function emit(lvl, args) {
    if (LEVELS[lvl] < threshold) return;
    const time = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const line = time + '  ' + lvl.toUpperCase().padEnd(5) + ' ' + args.map(fmt).join(' ');
    const consoleFn = lvl === 'error' ? console.error : lvl === 'warn' ? console.warn : console.log;
    consoleFn(line);
    if (stream) stream.write(line + '\n');
  }
  function fmt(v) {
    if (v instanceof Error) return v.stack || v.message;
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return {
    debug: (...a) => emit('debug', a),
    info: (...a) => emit('info', a),
    warn: (...a) => emit('warn', a),
    error: (...a) => emit('error', a),
    close: () => new Promise((res) => (stream ? stream.end(res) : res()))
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
