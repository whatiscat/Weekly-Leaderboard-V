import { spawn } from 'node:child_process';
import path from 'node:path';
import { doctor } from '../doctor.js';
import { reportText, scheduleText, statusText } from '../commands.js';
import { ROOT } from '../config.js';
import { runCrawl, runNico, runSync, runUpdate } from '../run.js';

/* ---------------------------------------------------------------------------
 * 设置抽屉的后端：把命令行那几件事搬到网页上
 *
 * 两条硬规矩：
 *   1. **白名单**。这里不是一个"执行任意命令"的接口，只认下面这张表里的名字 ——
 *      一个能 POST 任意字符串给 spawn 的接口就是半个 shell。
 *   2. **单槽**。同一时刻只跑一个任务。两个同步叠着跑会互相抢 data/.lock、
 *      还会向 biliboard 发双倍请求（那是会被封的）。
 *
 * 长任务（同步/抓帖/附榜）走后台 + 轮询；短任务（报告/状态/体检）同步返回文本。
 * 两者的输出都进同一个缓冲区，前端只管往 <pre> 里贴。
 * ------------------------------------------------------------------------- */

const MAX_LINES = 400;

/** 往任务缓冲里追加一行（超长就丢最老的） */
function pushLine(sink, level, text) {
  sink.push({ level, text: String(text), at: Date.now() });
  if (sink.length > MAX_LINES) sink.splice(0, sink.length - MAX_LINES);
}

/** 把日志既写进正式 logger，也收进任务缓冲 */
function captureLogger(base, sink) {
  const put = (level) => (msg) => {
    pushLine(sink, level, msg);
    base?.[level]?.(msg);
  };
  return {
    info: put('info'),
    warn: put('warn'),
    error: put('error'),
    // debug 只进文件，不进抽屉：那是给排查用的，塞进界面只会淹掉有用的行
    debug: (msg) => base?.debug?.(msg),
    close: async () => {}
  };
}

/** 动作表：名字 → 干什么、要多久、能不能带选项 */
const ACTIONS = {
  update: {
    label: '更新数据',
    long: true,
    run: (cfg, log, o) => runUpdate(cfg, log, { ...o, resilient: true })
  },
  sync: {
    label: '同步官方库',
    long: true,
    run: (cfg, log, o) => runSync(cfg, log, o)
  },
  crawl: {
    label: '抓取帖子',
    long: true,
    run: (cfg, log, o) => runCrawl(cfg, log, o)
  },
  nico: {
    label: '抓取附榜',
    long: true,
    run: (cfg, log, o) => runNico(cfg, log, o)
  },
  report: {
    label: '数据报告',
    long: false,
    text: (cfg) => reportText(cfg)
  },
  status: {
    label: '运行状态',
    long: false,
    text: (cfg) => statusText(cfg)
  },
  doctor: {
    label: '体检',
    long: false,
    text: async (cfg, log) => (await doctor(cfg, log)).lines
  },
  schedule: {
    label: '定时任务',
    long: false,
    text: (cfg) => scheduleText(cfg)
  },
  // 开发/运维三件套：直接跑仓库里的脚本，输出原样搬进抽屉。
  // 它们不改数据，所以不进 DATA_ACTIONS，跑完也不用重载。
  check: { label: '语法自检', long: true, spawn: ['scripts/check.mjs'] },
  test: { label: '跑测试', long: true, spawn: ['--test'] },
  package: { label: '打便携包', long: true, spawn: ['scripts/package.mjs'] }
};

/** 跑一个仓库脚本（子进程），stdout/stderr 逐行进缓冲 */
function runSpawn(args, sink) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args.map((a) => (a.startsWith('--') ? a : path.join(ROOT, a))), {
      cwd: ROOT,
      env: process.env
    });
    const eat = (level) => (buf) => {
      String(buf).split(/\r?\n/).forEach((line) => { if (line.trim()) pushLine(sink, level, line); });
    };
    child.stdout.on('data', eat('info'));
    child.stderr.on('data', eat('warn'));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve('退出码 0') : reject(new Error('退出码 ' + code))));
  });
}

export function consoleActions() {
  return Object.entries(ACTIONS).map(([name, a]) => ({ name, label: a.label, long: Boolean(a.long) }));
}

let job = null;

export function consoleStatus() {
  if (!job) return { running: false, name: null, lines: [], done: true };
  return {
    running: job.running,
    name: job.name,
    label: job.label,
    startedAt: job.startedAt,
    elapsedMs: Date.now() - job.startedAt,
    lines: job.lines,
    done: !job.running,
    ok: job.ok,
    summary: job.summary
  };
}

/** 同步动作（报告 / 状态 / 体检）：一次请求拿全部输出，不用轮询 */
export async function runConsoleText(cfg, log, name) {
  const action = ACTIONS[name];
  if (!action || action.long) return null;
  const lines = [];
  const sink = captureLogger(log, lines);
  try {
    const text = await action.text(cfg, sink);
    return { ok: true, text, lines };
  } catch (err) {
    return { ok: false, text: '失败：' + err.message, lines };
  }
}

export function startConsoleJob(cfg, log, name, opts = {}, { onDone = null } = {}) {
  const action = ACTIONS[name];
  if (!action || !action.long) return { started: false, error: 'unknown_action', ...consoleStatus() };
  if (job && job.running) return { started: false, error: 'busy', ...consoleStatus() };

  const lines = [];
  job = { running: true, name, label: action.label, startedAt: Date.now(), lines, ok: null, summary: null };
  const sink = captureLogger(log, lines);
  const exec = action.spawn
    ? () => runSpawn(action.spawn, lines)
    : () => action.run(cfg, sink, opts);

  Promise.resolve()
    .then(exec)
    .then((res) => {
      job.ok = true;
      job.summary = summarize(name, res);
      lines.push({ level: 'ok', text: job.summary, at: Date.now() });
    })
    .catch((err) => {
      job.ok = false;
      job.summary = '失败：' + err.message;
      lines.push({ level: 'error', text: job.summary, at: Date.now() });
      log?.error('网页控制台任务失败（' + name + '）：' + err.message);
    })
    .finally(() => {
      job.running = false;
      try { onDone?.(name); } catch (err) { log?.warn('任务结束后的重载失败：' + err.message); }
    });

  return { started: true, ...consoleStatus() };
}

function summarize(name, res) {
  if (!res) return '完成';

  if (name === 'sync') return '同步完成：' + (res.songs ? res.songs.length : '?') + ' 首曲目';
  if (name === 'crawl') return '抓帖完成：新增 ' + (res.fetched ?? 0) + ' 条，失败 ' + (res.failed?.length ?? 0) + ' 条';
  if (name === 'nico' && res) return '附榜完成：新增 ' + (res.fetched ?? 0) + ' 期，失败 ' + (res.failed?.length ?? 0) + ' 期';
  if (name === 'update') {
    const bits = [];
    if (res.crawl) bits.push('帖子 +' + (res.crawl.fetched ?? 0));
    if (res.nico) bits.push('附榜 +' + (res.nico.fetched ?? 0));
    bits.push(Math.round((res.ms || 0) / 1000) + 's');
    return '更新完成：' + bits.join(' · ');
  }
  return '完成';
}
