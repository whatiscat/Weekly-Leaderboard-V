import { API } from './endpoints.js';
import { mixinKeyFromUrls, signQuery } from './wbi.js';
import { sleep } from '../logger.js';

export class BiliError extends Error {
  constructor(message, { code = null, stage = null, cause = null } = {}) {
    super(message);
    this.name = 'BiliError';
    this.code = code;
    this.stage = stage;
    if (cause) this.cause = cause;
  }
}

const RETRYABLE_CODES = new Set([-1, -352, -412, -509, -799, -504]);
const REFRESH_CODES = new Set([-352, -412]);

export class BiliClient {
  constructor(config, logger) {
    this.cfg = config;
    this.log = logger;
    this.cookies = '';
    this.mixinKey = '';
    this.isLogin = false;
    this.lastRequestAt = 0;
    this.stats = { requests: 0, retries: 0, errors: 0 };
    this.deadline = 0;
  }

  async init() {
    const spi = await this.#json(API.spi, { params: {}, sign: false, referer: 'https://www.bilibili.com/' });
    const b3 = spi?.data?.b_3;
    const b4 = spi?.data?.b_4;
    this.cookies = 'buvid3=' + b3 + '; buvid4=' + b4 + ';';
    const extra = String(this.cfg.bili?.cookie || '').trim().replace(/;?\s*$/, '');
    if (extra) this.cookies += ' ' + extra + ';';
    await this.refreshWbi();
    return this;
  }

  async refreshWbi() {
    const nav = await this.#json(API.nav, { params: {}, sign: false, referer: 'https://www.bilibili.com/', allow: [-101] });
    const img = nav?.data?.wbi_img?.img_url;
    const sub = nav?.data?.wbi_img?.sub_url;
    if (!img || !sub) throw new BiliError('nav 未返回 wbi_img', { stage: 'wbi' });
    this.mixinKey = mixinKeyFromUrls(img, sub);
    this.isLogin = Boolean(nav?.data?.isLogin);
    if (this.isLogin && nav?.data?.uname) this.uname = nav.data.uname;
    return this.mixinKey;
  }

  async #throttle() {
    const wait = this.cfg.http.minIntervalMs - (Date.now() - this.lastRequestAt);
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();
  }

  async #fetch(url, { headers = {}, timeoutMs } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs ?? this.cfg.http.timeoutMs);
    try {
      return await fetch(url, { headers, signal: ctrl.signal, redirect: 'follow' });
    } finally {
      clearTimeout(timer);
    }
  }

  headers({ mobile = false, referer = 'https://www.bilibili.com/', accept = 'application/json, text/plain, */*' } = {}) {
    const ua = mobile ? this.cfg.http.userAgentMobile : this.cfg.http.userAgentDesktop;
    const h = {
      'User-Agent': ua,
      Accept: accept,
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      Referer: referer
    };
    if (this.cookies) h.Cookie = this.cookies;
    return h;
  }

  async #json(url, { params = {}, sign = true, referer, retries, allow = [] } = {}) {
    const maxRetries = retries ?? this.cfg.http.maxRetries;
    let attempt = 0;
    for (;;) {
      attempt++;
      await this.#throttle();
      const query = sign ? signQuery(params, this.mixinKey) : new URLSearchParams(params).toString();
      const full = query ? url + (url.includes('?') ? '&' : '?') + query : url;
      try {
        this.stats.requests++;
        const res = await this.#fetch(full, { headers: this.headers({ referer }) });
        if (res.status === 412) throw new BiliError('HTTP 412 风控', { code: -412, stage: 'http' });
        if (!res.ok) throw new BiliError('HTTP ' + res.status, { code: res.status, stage: 'http' });
        const body = await res.json().catch(() => null);
        if (!body) throw new BiliError('响应非 JSON', { stage: 'parse' });
        if (body.code === 0 || allow.includes(body.code)) return body;
        throw new BiliError('接口 ' + body.code + ' ' + (body.message || ''), { code: body.code, stage: 'api' });
      } catch (err) {
        const code = err instanceof BiliError ? err.code : null;
        const retryable = !(err instanceof BiliError) || RETRYABLE_CODES.has(code) || code >= 500;
        this.stats.errors++;
        if (this.deadline && Date.now() > this.deadline) {
          throw new BiliError('抓取超时（已超过时间预算）', { code, stage: 'deadline' });
        }
        if (!retryable || attempt > maxRetries) throw err;
        this.stats.retries++;
        const backoff = Math.min(this.cfg.http.backoffMaxMs, this.cfg.http.backoffBaseMs * 2 ** (attempt - 1));
        const jitter = Math.round(Math.random() * 800);
        this.log.debug('retry(' + attempt + '/' + maxRetries + ') in ' + (backoff + jitter) + 'ms: ' + err.message);
        if (code && REFRESH_CODES.has(code)) {
          await this.refreshWbi().catch(() => {});
        }
        await sleep(backoff + jitter);
      }
    }
  }

  /** 调 JSON 接口（默认带 wbi 签名） */
  async api(url, params = {}, opts = {}) {
    return this.#json(url, { ...opts, params });
  }

  /** 抓 SSR / 普通 HTML 页面，返回文本 */
  async html(url, { mobile = true, referer = 'https://www.bilibili.com/', retries } = {}) {
    const maxRetries = retries ?? this.cfg.http.maxRetries;
    let attempt = 0;
    for (;;) {
      attempt++;
      await this.#throttle();
      try {
        this.stats.requests++;
        const res = await this.#fetch(url, { headers: this.headers({ mobile, referer, accept: 'text/html,application/xhtml+xml' }) });
        if (!res.ok) throw new BiliError('HTTP ' + res.status, { code: res.status, stage: 'http' });
        return await res.text();
      } catch (err) {
        this.stats.errors++;
        if (this.deadline && Date.now() > this.deadline) throw new BiliError('抓取超时（已超过时间预算）', { stage: 'deadline' });
        if (attempt > maxRetries) throw err;
        this.stats.retries++;
        const backoff = Math.min(this.cfg.http.backoffMaxMs, this.cfg.http.backoffBaseMs * 2 ** (attempt - 1));
        this.log.debug('retry html(' + attempt + ') in ' + backoff + 'ms: ' + err.message);
        await sleep(backoff);
      }
    }
  }
}
