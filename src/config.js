import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULT_FILE = 'config/default.json';
const LOCAL_FILE = 'config/local.json';

function readJsonFile(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  const text = fs.readFileSync(file, 'utf8');
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error('配置文件不是合法 JSON：' + file + '（' + err.message + '）');
  }
}

function deepMerge(base, extra) {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return extra === undefined ? base : extra;
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(extra)) {
    out[k] = deepMerge(base?.[k], v);
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * 取值校验
 *
 * 原则与 newBlog 相同：**形状 / 取值写错就拒绝启动，不静默回落**。
 * 静默回落真正的代价不是"少个功能"，而是"看着配了、实际永远不生效"：
 * 比如把 http.minIntervalMs 写成负数，限速就没了、风控概率上升，
 * 而进程照常启动、日志里一个字都不会提。
 *
 * 每条报错都带键名与当前值，能直接定位到 config/default.json。
 * ------------------------------------------------------------------------- */

function fail(message) {
  throw new Error('配置错误：' + message);
}

function pick(obj, dotted) {
  return dotted.split('.').reduce((node, key) => (node == null ? node : node[key]), obj);
}

function describe(value) {
  if (value === undefined) return '未设置';
  if (typeof value === 'string') return JSON.stringify(value);
  return String(value);
}

function requireString(cfg, key, { allowEmpty = false } = {}) {
  const v = pick(cfg, key);
  if (typeof v !== 'string') fail(key + ' 必须是字符串（当前 ' + describe(v) + '）');
  if (!allowEmpty && !v.trim()) fail(key + ' 不能为空（当前 ' + describe(v) + '）');
  return v;
}

function requireBool(cfg, key) {
  const v = pick(cfg, key);
  if (typeof v !== 'boolean') fail(key + ' 必须是 true / false（当前 ' + describe(v) + '）');
  return v;
}

function requireInt(cfg, key, { min, max } = {}) {
  const v = pick(cfg, key);
  if (!Number.isInteger(v)) fail(key + ' 必须是整数（当前 ' + describe(v) + '）');
  if (min !== undefined && v < min) fail(key + ' 不能小于 ' + min + '（当前 ' + v + '）');
  if (max !== undefined && v > max) fail(key + ' 不能大于 ' + max + '（当前 ' + v + '）');
  return v;
}

function validate(cfg) {
  requireString(cfg, 'account.mid');
  requireString(cfg, 'account.name');
  const spaceUrl = requireString(cfg, 'account.spaceUrl');
  if (!/^https?:\/\//i.test(spaceUrl)) fail('account.spaceUrl 必须带 http(s):// 前缀（当前 ' + describe(spaceUrl) + '）');

  for (const key of ['site.title', 'site.brand', 'site.csvName']) requireString(cfg, key);

  for (const key of ['raw', 'data', 'logs', 'state', 'nico']) requireString(cfg, 'paths.' + key);

  requireInt(cfg, 'http.minIntervalMs', { min: 0 });
  requireInt(cfg, 'http.maxRetries', { min: 0, max: 12 });
  const backoffBase = requireInt(cfg, 'http.backoffBaseMs', { min: 1 });
  const backoffMax = requireInt(cfg, 'http.backoffMaxMs', { min: 1 });
  if (backoffMax < backoffBase) {
    fail('http.backoffMaxMs 不能小于 http.backoffBaseMs（' + backoffMax + ' < ' + backoffBase + '）');
  }
  requireInt(cfg, 'http.timeoutMs', { min: 1000 });

  requireInt(cfg, 'crawl.maxPages', { min: 1, max: 200 });
  requireInt(cfg, 'crawl.pageSize', { min: 1, max: 50 });
  requireInt(cfg, 'crawl.timeBudgetMs', { min: 5000 });

  requireInt(cfg, 'schedule.weekday', { min: 0, max: 6 });
  requireInt(cfg, 'schedule.hour', { min: 0, max: 23 });
  requireInt(cfg, 'schedule.minute', { min: 0, max: 59 });

  requireInt(cfg, 'server.port', { min: 1, max: 65535 });
  requireString(cfg, 'server.host');
  requireString(cfg, 'bili.cookie', { allowEmpty: true });

  // 附榜（ニコニコ VOCALOID SONGS TOP20）：另一个 UP 主发布的另一条榜
  requireBool(cfg, 'nico.enabled');
  if (cfg.nico.enabled) {
    requireString(cfg, 'nico.mid');
    requireString(cfg, 'nico.name');
    const spaceUrl = requireString(cfg, 'nico.spaceUrl');
    if (!/^https?:\/\//i.test(spaceUrl)) fail('nico.spaceUrl 必须带 http(s):// 前缀（当前 ' + describe(spaceUrl) + '）');
    requireString(cfg, 'nico.title');
    requireInt(cfg, 'nico.maxPages', { min: 1, max: 100 });
  }
  requireBool(cfg, 'nico.covers');
}

/**
 * 载入配置：default.json ← local.json ← overrides（后者覆盖前者，逐键深合并）。
 *
 * local.json 是本机私货（端口、B 站 Cookie），已被 .gitignore 排除；
 * 只写要改的那几项即可，缺的键从 default 补齐。
 */
export function loadConfig(overrides = {}) {
  const base = readJsonFile(path.join(ROOT, DEFAULT_FILE), null);
  if (!base) throw new Error('缺少 ' + DEFAULT_FILE + '：这是配置的底线，项目无法启动');
  const local = readJsonFile(path.join(ROOT, LOCAL_FILE), {});
  const cfg = deepMerge(deepMerge(base, local), overrides);

  validate(cfg);

  // 相对路径按仓库根解析：从任何工作目录启动，指向的都是同一份数据
  for (const key of ['raw', 'data', 'logs', 'state', 'nico']) {
    const value = cfg.paths[key];
    cfg.paths[key] = path.isAbsolute(value) ? value : path.join(ROOT, value);
  }

  // 内部路径不开放给用户配置：它们跟着代码走，写进 default.json 只会误导
  // （改目录结构时有人以为这里可配，结果改了没生效）。
  cfg.paths.web = path.join(ROOT, 'src/web');

  try {
    cfg.version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  } catch {
    cfg.version = 'dev';
  }
  return cfg;
}
