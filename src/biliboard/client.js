import { sleep } from '../logger.js';

export const BASE = 'https://biliboard.uk';

export class BoardClient {
  constructor(config, logger) {
    this.log = logger;
    this.intervalMs = 350;
    this.lastAt = 0;
    this.stats = { requests: 0, retries: 0 };
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
