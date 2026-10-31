import path from 'node:path';
import { readJson, writeJson } from '../util/fsx.js';
import { sleep } from '../logger.js';
import { API } from '../bili/endpoints.js';
import { bv2av } from '../util/av.js';

const PROXY = 'https://biliboard.uk/api/provider/biliimg/bvid/';

/** 解析失败后的冷却时间：这段时间内不再为同一个 bvid 发请求 */
export const RETRY_AFTER_DAYS = 7;
export const FAIL_FILE = 'covers-failures.json';

export function coverProxy(bvid) {
  return bvid ? PROXY + encodeURIComponent(bvid) : '';
}

/**
 * 失败过的稿件要不要再试。
 *
 * 为什么需要它：有些稿件被删了，图片接口永远 404。每轮同步都去撞一遍，
 * 既慢（12 个超时能拖掉 40 秒）又不礼貌。冷却 7 天后再试一次，
 * 既能自动恢复"临时抽风"的，也不会为"永久没了"的反复付费。
 */
export function shouldRetry(failedAt, now = Date.now(), days = RETRY_AFTER_DAYS) {
  if (!failedAt) return true;
  const t = Date.parse(failedAt);
  if (Number.isNaN(t)) return true;
  return now - t > days * 86400000;
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
  const failFile = path.join(cfg.paths.data, FAIL_FILE);
  const map = readJson(file, {}) || {};
  const failures = readJson(failFile, {}) || {};

  const unresolved = [...new Set(bvids.filter(Boolean))].filter((b) => !map[b]);
  const missing = unresolved.filter((b) => shouldRetry(failures[b]));
  const cooling = unresolved.length - missing.length;

  if (!missing.length) {
    log?.info('封面直链已是最新（' + Object.keys(map).length + ' 条）'
      + (cooling ? '，' + cooling + ' 个失败稿件在冷却中' : ''));
    return map;
  }
  if (cooling) {
    log?.info('跳过 ' + cooling + ' 个最近解析失败的稿件（' + RETRY_AFTER_DAYS + ' 天后再试）');
  }
  log?.info('解析封面直链：' + missing.length + ' 个新稿件');

  const before = Object.keys(map).length;
  let done = 0;        // 已处理数（成功 + 失败）
  let resolved = 0;    // 真正拿到可用直链的数量
  let failed = 0;
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
        // 必须有超时：这里以前是裸 fetch，连接挂住就永远等下去，
        // 一次同步会卡死（实测：12 个封面请求把整轮同步拖过 2 分钟）。
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 15000);
        const res = await fetch(PROXY + encodeURIComponent(bvid), {
          redirect: 'manual',
          signal: ctrl.signal,
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; bbw/1.0)' }
        }).finally(() => clearTimeout(timer));
        const loc = res.headers.get('location');
        if (loc && /i\d\.hdslb\.com/.test(loc)) {
          map[bvid] = normalize(loc);
          delete failures[bvid];
          resolved++;
        } else if (res.status === 200) {
          // 接口直接回图（不是 302）：退回代理地址，至少不是空白
          map[bvid] = PROXY + encodeURIComponent(bvid);
          delete failures[bvid];
          resolved++;
        } else {
          // 404 / 5xx：**不写 map**。写进去等于把一次失败固化成"已解析"，
          // 下次 sync 就不会再试它了（以前确实会这样）。
          failures[bvid] = new Date().toISOString();
          failed++;
        }
      } catch (err) {
        failures[bvid] = new Date().toISOString();
        failed++;
        log?.debug('封面解析失败 ' + bvid + '：' + err.message);
      }
      done++;
      if (done % 50 === 0) {
        writeJson(file, map);
        writeJson(failFile, failures);
        log?.info('封面直链 ' + done + '/' + missing.length + '（成功 ' + resolved + '，失败 ' + failed + '）');
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  writeJson(file, map);
  writeJson(failFile, failures);
  log?.info(
    '封面直链完成：新增 ' + (Object.keys(map).length - before) + '，失败 ' + failed +
    (failed ? '（' + RETRY_AFTER_DAYS + ' 天后再试）' : '') + '，累计 ' + Object.keys(map).length
  );
  return map;
}

/**
 * 把「已经拿到的封面」并进缓存（零请求）。
 *
 * 附榜的 opus 页面内嵌段落 JSON 里，每个视频卡片都带 cover 直链 —— 抓正文时
 * 封面是白捡的。没有理由把这些扔掉，再回头一个一个去问稿件接口。
 */
export function mergeCoverPairs(pairs, cfg, log) {
  const file = path.join(cfg.paths.data, 'covers.json');
  const map = readJson(file, {}) || {};
  let added = 0;
  for (const p of pairs || []) {
    if (!p || !p.bvid || !p.cover || map[p.bvid]) continue;
    map[p.bvid] = normalize(p.cover);
    added++;
  }
  if (added) {
    writeJson(file, map);
    log?.info('附榜封面：从正文里直接收录 ' + added + ' 条（未发请求）');
  }
  return added;
}

/**
 * 用 B 站稿件接口解析封面（附榜用）。
 *
 * 主榜的封面走 biliboard 的图片代理（一次 302 拿到直链）；附榜的视频不在
 * 那个曲目库里，只能问 B 站自己：x/web-interface/view 返回 pic，格式与
 * 直链完全一致，仍然写进同一个 data/covers.json，页面侧不需要区分来源。
 *
 * 请求走调用方的 BiliClient：那里有全局最小间隔、退避和 Cookie，
 * 不必为封面另写一套限流（另写一套就等于把风控概率翻倍）。
 */
export async function resolveVideoCovers(client, bvids, cfg, log) {
  const file = path.join(cfg.paths.data, 'covers.json');
  const failFile = path.join(cfg.paths.data, FAIL_FILE);
  const map = readJson(file, {}) || {};
  const failures = readJson(failFile, {}) || {};

  const unresolved = [...new Set(bvids.filter(Boolean))].filter((b) => !map[b]);
  const missing = unresolved.filter((b) => shouldRetry(failures[b]));
  if (!missing.length) {
    log?.info('附榜封面已是最新' + (unresolved.length ? '（' + unresolved.length + ' 个在冷却中）' : ''));
    return map;
  }
  log?.info('解析附榜封面：' + missing.length + ' 个新稿件');

  let done = 0;
  let ok = 0;
  let stopped = 0;
  for (const bvid of missing) {
    // 被删稿件会一路重试（每次 20s 超时 + 退避），几十个就能把一轮跑上半小时。
    // 到点收工，剩下的留到下次 —— 反正失败已经记进冷却表了。
    if (client.deadline && Date.now() > client.deadline) { stopped = missing.length - done; break; }
    const aid = bv2av(bvid);
    done++;
    if (!aid) { failures[bvid] = new Date().toISOString(); continue; }
    try {
      const res = await client.api(API.videoView, { aid: String(aid) }, { sign: false, referer: 'https://www.bilibili.com/video/' + bvid });
      const pic = res?.data?.pic;
      if (pic) {
        map[bvid] = normalize(pic);
        delete failures[bvid];
        ok++;
      } else {
        failures[bvid] = new Date().toISOString();
      }
    } catch (err) {
      // 稿件被删 / 私有：记进冷却，7 天内不再撞它（和主榜共用一个失败表）
      failures[bvid] = new Date().toISOString();
      log?.debug('附榜封面失败 ' + bvid + '：' + err.message);
    }
    if (done % 100 === 0) {
      writeJson(file, map);
      writeJson(failFile, failures);
      log?.info('附榜封面 ' + done + '/' + missing.length + '（成功 ' + ok + '）');
    }
  }
  writeJson(file, map);
  writeJson(failFile, failures);
  log?.info('附榜封面完成：新增 ' + ok + ' / ' + missing.length + (stopped ? '（超时，剩余 ' + stopped + ' 个留待下次）' : ''));
  return map;
}

/** 给直链加缩放后缀（hdslb 支持的图片处理参数） */
export function sized(url, spec) {
  if (!url || !/hdslb\.com\//.test(url)) return url || '';
  if (url.includes('@')) return url;
  return url + '@' + spec;
}
