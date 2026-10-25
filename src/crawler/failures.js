import { readJson, writeJson } from '../util/fsx.js';

/**
 * 记录反复失败的帖子，避免定时任务每次都重试同一批（加 --force 可强制重试）
 */
export class FailureTracker {
  constructor(file, { maxAttempts = 3 } = {}) {
    this.file = file;
    this.maxAttempts = maxAttempts;
    this.data = readJson(file, {}) || {};
  }

  shouldSkip(id) {
    const item = this.data[id];
    return Boolean(item && item.count >= this.maxAttempts);
  }

  record(id, message) {
    const prev = this.data[id] || { count: 0 };
    this.data[id] = {
      count: prev.count + 1,
      message: String(message || '').slice(0, 500),
      lastAt: new Date().toISOString()
    };
    this.save();
  }

  clear(id) {
    if (this.data[id]) {
      delete this.data[id];
      this.save();
    }
  }

  save() {
    writeJson(this.file, this.data);
  }

  list() {
    return Object.entries(this.data).map(([id, v]) => ({ id, ...v }));
  }
}
