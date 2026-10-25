import path from 'node:path';
import { readJson, writeJson } from '../util/fsx.js';
import { sleep } from '../logger.js';

const PROXY = 'https://biliboard.uk/api/provider/biliimg/bvid/';

export function coverProxy(bvid) {
  return bvid ? PROXY + encodeURIComponent(bvid) : '';
}

function normalize(url) {
  if (!url) return '';
  return url.startsWith('http://') ? 'https://' + url.slice(7) : url;
}

/**
 * 把 bvid 解析成 hdslb 直链（biliboard 的图片接口是 302）。
 * 直链可以加 @320w_180h_1c.webp 之类的缩放后缀，首屏快很多。
 * 结果缓存在 data/covers.json，只解析新增的 bvid。
 */
export async function resolveCovers(bvids, cfg, log, { concurrency = 3, intervalMs = 220 } = {}) {
  const file = path.join(cfg.paths.data, 'covers.json');
  const map = readJson(file, {}) || {};
  const missing = [...new Set(bvids.filter(Boolean))].filter((b) => !map[b]);
  if (!missing.length) {
    log?.info('封面直链已是最新（' + Object.keys(map).length + ' 条）');
    return map;
  }
  log?.info('解析封面直链：' + missing.length + ' 个新稿件');

  let done = 0;
  let cursor = 0;
  let lastAt = 0;
  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= missing.length) return;
      const bvid = missing[i];
      const wait = intervalMs - (Date.now() - lastAt);
      if (wait > 0) await sleep(wait);
      lastAt = Date.now();
      try {
        const res = await fetch(PROXY + encodeURIComponent(bvid), {
          redirect: 'manual',
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; bbw/1.0)' }
        });
        const loc = res.headers.get('location');
        if (loc && /i\d\.hdslb\.com/.test(loc)) {
          map[bvid] = normalize(loc);
        } else if (res.status === 200) {
          map[bvid] = PROXY + encodeURIComponent(bvid);
        }
      } catch (err) {
        log?.debug('封面解析失败 ' + bvid + '：' + err.message);
      }
      done++;
      if (done % 50 === 0) {
        writeJson(file, map);
        log?.info('封面直链 ' + done + '/' + missing.length);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  writeJson(file, map);
  log?.info('封面直链完成：新增 ' + (Object.keys(map).length - (Object.keys(map).length - done)) + '，累计 ' + Object.keys(map).length);
  return map;
}

/** 给直链加缩放后缀（hdslb 支持的图片处理参数） */
export function sized(url, spec) {
  if (!url || !/hdslb\.com\//.test(url)) return url || '';
  if (url.includes('@')) return url;
  return url + '@' + spec;
}
