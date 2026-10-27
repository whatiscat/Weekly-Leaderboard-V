import { sleep } from '../logger.js';

export const BASE = 'https://biliboard.uk';

export class BoardClient {
  constructor(config, logger) {
    this.log = logger;
    this.intervalMs = 350;
    this.lastAt = 0;
    this.stats = { requests: 0, retries: 0 };
    /** 整轮截止时间戳（0 = 不限）。由 syncBoards 设置。 */
    this.deadline = 0;
  }

  async #throttle() {
    const wait = this.intervalMs - (Date.now() - this.lastAt);
    if (wait > 0) await sleep(wait);
    this.lastAt = Date.now();
  }

  async json(pathname, { retries = 4 } = {}) {
    let attempt = 0;
    for (;;) {
      attempt++;
      // 整轮预算：单请求有 20s 超时 + 重试，但"每页都慢一点"能把一次同步拖到十几分钟。
      // 到点直接失败，比让定时任务叠着跑好 —— 叠跑会互相抢锁、还会加倍请求上游。
      if (this.deadline && Date.now() > this.deadline) {
        throw new Error('同步超时（已超过本轮时间预算），已中止：' + pathname);
      }
      await this.#throttle();
      try {
        this.stats.requests++;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 20000);
        const res = await fetch(BASE + pathname, {
          headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; bbw/1.0)' },
          signal: ctrl.signal
        }).finally(() => clearTimeout(timer));
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await res.json();
      } catch (err) {
        this.stats.retries++;
        if (attempt > retries) throw err;
        const backoff = 1000 * 2 ** (attempt - 1);
        this.log?.debug('biliboard retry ' + attempt + ' ' + pathname + ' ' + err.message);
        await sleep(backoff);
      }
    }
  }

  boards() {
    return this.json('/api/public/boards');
  }

  issues(boardId) {
    return this.json('/api/public/boards/' + boardId + '/issues');
  }

  rankings(boardId, issueId) {
    return this.json('/api/public/boards/' + boardId + '/issues/' + issueId + '/rankings');
  }

  songs(page, perPage = 100) {
    return this.json('/api/public/songs?page=' + page + '&per_page=' + perPage);
  }
}
