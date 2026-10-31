#!/usr/bin/env node
/**
 * 前端验收探针（真浏览器，headless Edge + CDP）
 *
 * 做的事：起一个无头浏览器 → 打开看板 → 量出"动效到底有没有在动 / 主题换没换 /
 * 移动端有没有横向溢出 / 控制台有没有报错" → 按主题各截一张图 → 打印 JSON。
 *
 * 用法（先另起一个端口的服务，别动正在用的那个实例）：
 *   node src/cli.js serve --port 5199
 *   node devtools/tools/probe-ui.cjs --port 5199
 *
 * 退出码：0 = 全部通过；1 = 有断言失败或控制台报错。
 *
 * ⚠️ 两个容易踩的坑（都实测过）：
 *   1. --headless=new 的 Edge 默认 prefers-reduced-motion: reduce。
 *      不显式模拟 no-preference，入场与描线永远测不到（看起来像"动效坏了"）。
 *   2. 只截图不量值等于没测：动画结束后的最终样子和"从来没有动画"完全一样，
 *      必须抓动画进行中的 stroke-dashoffset / animation-delay。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const ROOT = path.resolve(__dirname, '../..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function freePort() {
  return new Promise((res, rej) => {
    const srv = net.createServer();
    srv.on('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => res(p));
    });
  });
}

async function main() {
  const port = Number(arg('port', 5173));
  const base = 'http://127.0.0.1:' + port + '/';
  const outDir = path.resolve(ROOT, arg('out', 'devtools/tmp'));
  fs.mkdirSync(outDir, { recursive: true });

  const ok = await fetch(base).then((r) => r.ok).catch(() => false);
  if (!ok) throw new Error('服务没有在 ' + base + ' 上响应。先运行：node src/cli.js serve --port ' + port);

  const debuggingPort = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bbw-probe-'));
  const edge = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions',
    '--user-data-dir=' + profile, '--remote-debugging-port=' + debuggingPort, 'about:blank'
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + debuggingPort + '/json/new?url=about:blank', { method: 'PUT' });
      target = await r.json();
      if (target.webSocketDebuggerUrl) break;
    } catch (e) { /* 浏览器还没起来 */ }
    await sleep(200);
  }
  if (!target) throw new Error('连不上无头浏览器，检查 Edge 路径（可用 EDGE_PATH 覆盖）');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  const logs = [];
  let nextId = 0;

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      logs.push('exception: ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      logs.push('log: ' + msg.params.entry.text);
    }
  });
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });

  const send = (method, params) => {
    const id = ++nextId;
    ws.send(JSON.stringify({ id, method, params: params || {} }));
    return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej }));
  };
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  };
  const shot = async (name) => {
    const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(outDir, name), Buffer.from(s.data, 'base64'));
  };
  const key = async (k, code) => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
  };

  /* 等条件成立，别用固定 sleep 赌加载速度。
     实测：服务端刚 reload 完时，页面可能 3 秒后连 <body> 都还没解析完，
     固定 sleep 会把"还没加载好"伪装成"功能坏了"。 */
  const waitFor = async (expr, timeout = 20000) => {
    const t0 = Date.now();
    for (;;) {
      const ok = await evaluate('(function(){try{return !!(' + expr + ')}catch(e){return false}})()');
      if (ok) return true;
      if (Date.now() - t0 > timeout) return false;
      await sleep(200);
    }
  };

  const checks = [];
  const check = (name, pass, detail) => checks.push({ name, pass: !!pass, detail });

  try {
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Log.enable');
    // 坑 1：不显式设成 no-preference，无头环境默认是 reduce
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: base });
    const ready = await waitFor("document.querySelectorAll('#rows .row').length > 0 && document.querySelector('.song-item')");
    check('页面在 20s 内渲染出主榜', ready, ready ? 'ok' : '超时');
    await sleep(300);

    const desk = await evaluate(`(function(){
      var rows = [].slice.call(document.querySelectorAll('#rows .row')).slice(0, 4);
      return {
        reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
        rows: document.querySelectorAll('#rows .row').length,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        delays: rows.map(function (r) { return parseFloat(getComputedStyle(r).animationDelay) * 1000; }),
        theme: document.documentElement.getAttribute('data-theme'),
        bg: getComputedStyle(document.body).backgroundColor,
        markFill: getComputedStyle(document.querySelector('.brand-mark rect')).fill
      };
    })()`);
    check('桌面端渲染出榜单', desk.rows > 0, desk.rows + ' 行');
    check('桌面端无横向溢出', desk.overflow === 0, '溢出 ' + desk.overflow + 'px');
    check('入场按 --i 递增延迟', desk.delays.every((v, i) => i === 0 || v > desk.delays[i - 1]), JSON.stringify(desk.delays));
    check('像素徽标跟随文字色', desk.markFill !== 'rgb(0, 0, 0)', desk.markFill);
    await shot('shot-dark.png');

    // 走势图：描线只有几百毫秒，固定 sleep 会踩空（快机器上已经画完、慢机器上还没开始）。
    // 正确做法是**轮询中间态**：抓到 0 < dashoffset < 1 就算真的在画。
    await evaluate("document.querySelector('.song-item').click()");
    let chart = null;
    for (let i = 0; i < 30; i++) {
      chart = await evaluate(`(function(){
        var line = document.querySelector('.trend-line');
        var svg = document.querySelector('svg.chart');
        return { drawing: svg ? svg.classList.contains('is-drawing') : false,
          dasharray: line ? getComputedStyle(line).strokeDasharray : null,
          dashoffset: line ? getComputedStyle(line).strokeDashoffset : null,
          dots: document.querySelectorAll('.trend-dot').length };
      })()`);
      const off = parseFloat(chart.dashoffset);
      if (off > 0 && off < 1) break;
      await sleep(35);
    }
    check('走势图在描线', parseFloat(chart.dashoffset) > 0 && parseFloat(chart.dashoffset) < 1, 'dashoffset=' + chart.dashoffset);
    check('走势图圆点已生成', chart.dots > 0, chart.dots + ' 个');
    await sleep(800);
    await shot('shot-chart.png');

    // 抽屉：点开 → Esc → 焦点回到来处
    // 抽屉是点开之后才异步取单曲详情的，固定 sleep 会抓到"还没打开"的那一刻
    await evaluate("document.querySelector('#rows .row').focus(); document.querySelector('#rows .row').click()");
    await waitFor("document.getElementById('drawer') && document.getElementById('drawer').classList.contains('on') && document.body.classList.contains('is-locked')");
    const open = await evaluate("(function(){ var d=document.getElementById('drawer'); return { on: d.classList.contains('on'), locked: document.body.classList.contains('is-locked'), focus: document.activeElement.id }; })()");
    check('抽屉打开并锁滚动', open.on && open.locked, JSON.stringify(open));
    await key('Escape', 27);
    await waitFor("!document.getElementById('drawer').classList.contains('on')");
    const closed = await evaluate("(function(){ return { on: document.getElementById('drawer').classList.contains('on'), back: document.activeElement.classList.contains('row') }; })()");
    check('Esc 关闭并把焦点还回原行', !closed.on && closed.back, JSON.stringify(closed));

    // 主题：浅色下图表线必须是浅色档的强调色
    const beforeStroke = await evaluate("getComputedStyle(document.querySelector('.trend-line')).stroke");
    await evaluate("window.setTheme('light')");
    await sleep(400);
    const light = await evaluate("(function(){ return { theme: document.documentElement.getAttribute('data-theme'), bg: getComputedStyle(document.body).backgroundColor, stroke: getComputedStyle(document.querySelector('.trend-line')).stroke }; })()");
    check('切到浅色主题', light.theme === 'light' && light.bg === 'rgb(247, 248, 250)', light.bg);
    check('图表颜色跟着主题走', light.stroke !== beforeStroke, beforeStroke + ' → ' + light.stroke);
    await evaluate("window.scrollTo(0, 0)");
    await sleep(200);
    await shot('shot-light.png');

    await evaluate("window.setTheme('OLED')");
    await sleep(300);
    const oled = await evaluate("(function(){ return { theme: document.documentElement.getAttribute('data-theme'), bg: getComputedStyle(document.body).backgroundColor }; })()");
    check('OLED 是纯黑底', oled.bg === 'rgb(0, 0, 0)', oled.bg);
    await shot('shot-oled.png');
    await evaluate("window.setTheme('system')");

    // 移动端
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await send('Page.navigate', { url: base });
    await waitFor("document.querySelectorAll('#rows .row').length > 0 && document.querySelector('.sel')");
    await sleep(300);
    const mobile = await evaluate(`(function(){
      var sel = document.querySelector('.sel');
      return { rows: document.querySelectorAll('#rows .row').length,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        selWidth: Math.round(sel.getBoundingClientRect().width),
        visibleActions: [].filter.call(document.querySelectorAll('.actions .btn'), function (b) { return getComputedStyle(b).display !== 'none'; }).length };
    })()`);
    check('移动端无横向溢出', mobile.overflow === 0, '溢出 ' + mobile.overflow + 'px');
    check('移动端期次下拉可读', mobile.selWidth > 180, mobile.selWidth + 'px');
    await shot('shot-mobile.png');

    // 减少动效：动画应被压到近乎瞬时，且内容照常显示
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
    await send('Page.reload');
    await waitFor("document.querySelectorAll('#rows .row').length > 0");
    await sleep(300);
    const reduced = await evaluate(`(function(){
      var row = document.querySelector('#rows .row');
      var cs = row ? getComputedStyle(row) : null;
      return { rows: document.querySelectorAll('#rows .row').length, dur: cs ? parseFloat(cs.animationDuration) : null, delay: cs ? cs.animationDelay : null };
    })()`);
    check('减少动效时内容照常渲染', reduced.rows > 0, reduced.rows + ' 行');
    check('减少动效时动画被压到近乎瞬时', reduced.dur !== null && reduced.dur < 0.001, 'duration=' + reduced.dur + 's');
  } finally {
    ws.close();
    edge.kill();
    await sleep(400);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* 临时目录清不掉就算了 */ }
  }

  const failed = checks.filter((c) => !c.pass);
  console.log(JSON.stringify({ checks, consoleErrors: logs, screenshots: outDir }, null, 2));
  if (failed.length || logs.length) {
    console.error('\n✗ ' + (failed.length + logs.length) + ' 项未通过');
    process.exit(1);
  }
  console.log('\n✓ 全部通过（截图在 ' + outDir + '）');
}

main().catch((err) => {
  console.error('[probe] ' + (err && err.stack || err));
  process.exit(1);
});
